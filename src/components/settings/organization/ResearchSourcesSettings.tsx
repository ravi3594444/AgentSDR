"use client";

import { useCallback, useEffect, useState } from "react";
import * as Button from "@/components/alignui/button";
import { Frame, FrameFooter, FrameHeader, FramePanel } from "@/components/analytics/kit/Frame";
import { Callout } from "@/components/settings/SettingsKit";
import { REDDIT_NOTE_MAX, type ResearchSourceUsage, type ResearchSourcesView } from "@/lib/research/sources/catalog";

/**
 * Settings → Lead research → Research sources: Hacker News and Stack
 * Exchange are free public sources the assistant reads as evidence of a
 * stated need (nothing to set up); Reddit is unavailable, with a place to
 * record Reddit's approval. Recording it enables nothing.
 */
export function ResearchSourcesSettings() {
  const [settings, setSettings] = useState<ResearchSourcesView | null>(null);
  const [canManage, setCanManage] = useState(false);
  const [approved, setApproved] = useState(false);
  const [note, setNote] = useState("");
  const [clientId, setClientId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const apply = useCallback((view: ResearchSourcesView) => {
    setSettings(view);
    setApproved(Boolean(view.reddit.approvalRecordedAt));
    setNote(view.reddit.approvalNote ?? "");
  }, []);

  const load = useCallback(async () => {
    const response = await fetch("/api/settings/research-sources", { cache: "no-store" });
    const body = (await response.json().catch(() => null)) as { settings?: ResearchSourcesView; canManage?: boolean; error?: string } | null;
    if (!response.ok || !body?.settings) {
      setError(body?.error ?? "Could not read the research sources.");
      return;
    }
    setCanManage(Boolean(body.canManage));
    apply(body.settings);
  }, [apply]);

  useEffect(() => {
    // Loads once on mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function save() {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const response = await fetch("/api/settings/research-sources", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ redditApproved: approved, redditApprovalNote: note, ...(clientId.trim() ? { redditClientId: clientId.trim() } : {}) }),
      });
      const body = (await response.json().catch(() => null)) as { settings?: ResearchSourcesView; error?: string } | null;
      if (!response.ok || !body?.settings) throw new Error(body?.error ?? "Could not save.");
      apply(body.settings);
      setClientId("");
      setSaved(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  if (!settings) return error ? <Callout tone="error">{error}</Callout> : null;
  const field = "w-full rounded-lg border border-stroke-soft-200 bg-bg-white-0 px-3 text-paragraph-sm text-text-strong-950 disabled:opacity-60";
  const { hackerNews, stackExchange, reddit } = settings;

  return (
    <Frame>
      <FrameHeader
        title="Research sources"
        description="Public discussions the assistant can read when a web search finds them. A thread is evidence that someone stated a need or a problem, not that they want to buy, and its authors use pseudonyms: they are never treated as leads to contact."
      />
      <FramePanel className="flex flex-col gap-4">
        <ul className="flex flex-col gap-3">
          <SourceRow
            name="Hacker News"
            status="Available, free"
            detail={`Read through its official public API, at most ${hackerNews.perMinute} requests a minute from this server.`}
            usage={hackerNews}
          />
          <SourceRow
            name="Stack Exchange"
            status="Available, free"
            detail={`Stack Overflow, Super User, Server Fault, Ask Ubuntu and the *.stackexchange.com sites, through the public API without a key: ${stackExchange.perDay} requests a day for this server, shared by every organization on it. A repeat of the same request within a minute is answered from memory.`}
            usage={stackExchange}
          />
        </ul>

        <section className="flex flex-col gap-3 border-t border-stroke-soft-200 pt-4" aria-labelledby="research-reddit">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h4 id="research-reddit" className="text-label-sm text-text-strong-950">Reddit</h4>
            <span className="text-paragraph-xs text-text-sub-600">Unavailable</span>
          </div>
          <p className="text-paragraph-xs text-text-sub-600">
            Reddit&apos;s API needs Reddit&apos;s approval for this use. Nothing reads Reddit: no scraping, feeds or browser workarounds.
            {reddit.approvalRecordedAt
              ? ` Approval recorded ${new Date(reddit.approvalRecordedAt).toLocaleDateString()}${reddit.clientHint ? ` (app ${reddit.clientHint})` : ""}; a Reddit reader is not built yet, so Reddit stays unavailable.`
              : " Approval is not recorded."}{" "}
            Reddit&apos;s rules forbid automated unsolicited messages, so AgentSDR never sends Reddit messages.
          </p>
          <label className="flex items-center gap-2 text-paragraph-sm text-text-strong-950">
            <input type="checkbox" checked={approved} disabled={!canManage || busy} onChange={(event) => setApproved(event.target.checked)} />
            Reddit approved our use of its API
          </label>
          <label className="flex flex-col gap-1 text-label-xs text-text-strong-950">
            Approval note
            <textarea className={`${field} min-h-16 py-2`} maxLength={REDDIT_NOTE_MAX} placeholder="Who approved it, when, and for what use" value={note} disabled={!canManage || busy} onChange={(event) => setNote(event.target.value)} />
          </label>
          <label className="flex flex-col gap-1 text-label-xs text-text-strong-950 sm:max-w-xs">
            Approved app&apos;s client id
            <input className={`${field} h-9`} autoComplete="off" placeholder={reddit.clientHint ? `Saved as ${reddit.clientHint}` : "Only its last 4 characters are kept"} value={clientId} disabled={!canManage || busy} onChange={(event) => setClientId(event.target.value)} />
          </label>
        </section>

        {error && <Callout tone="error">{error}</Callout>}
        {saved && !error && <p className="text-paragraph-xs text-success-base">Saved.</p>}
        {canManage && (
          <div className="flex justify-end">
            <Button.Root variant="primary" mode="filled" size="xsmall" disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Save"}</Button.Root>
          </div>
        )}
      </FramePanel>
      {!canManage && <FrameFooter>Only owners and admins can record Reddit&apos;s approval.</FrameFooter>}
    </Frame>
  );
}

function SourceRow({ name, status, detail, usage }: { name: string; status: string; detail: string; usage: ResearchSourceUsage }) {
  const waiting = usage.waitingUntil ? new Date(usage.waitingUntil) : null;
  return (
    <li className="flex flex-col gap-1">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-label-sm text-text-strong-950">{name}</span>
        <span className="text-paragraph-xs text-text-sub-600">{waiting ? "Waiting" : status}</span>
      </div>
      <p className="text-paragraph-xs text-text-sub-600">
        {detail} Today (UTC): {usage.usedToday} by your organization, {usage.serverUsedToday} from this server.
      </p>
      {/* The server only reports a wait that has not ended yet. */}
      {waiting && <Callout tone="warning">{usage.waitingReason ?? `${name} asked AgentSDR to wait`}: reading resumes at {waiting.toLocaleString()}.</Callout>}
    </li>
  );
}
