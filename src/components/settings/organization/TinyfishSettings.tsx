"use client";

import { useCallback, useEffect, useState } from "react";
import * as Button from "@/components/alignui/button";
import { Frame, FrameFooter, FrameHeader, FramePanel } from "@/components/analytics/kit/Frame";
import { Callout } from "@/components/settings/SettingsKit";
import { browserMinutesHint, TINYFISH_FREE_LIMITS, TINYFISH_LIMITS, type TinyfishSettingsView } from "@/lib/tinyfish/catalog";

/**
 * Settings → Organization → TinyFish: the key (write-only), whether web
 * searches use it, and the browser minutes a day (0 keeps the metered
 * browser off). Search and page reading stay within TinyFish's free daily
 * allowance; AgentSDR waits for its reset rather than spending the Wallet.
 */
export function TinyfishSettings() {
  const [settings, setSettings] = useState<TinyfishSettingsView | null>(null);
  const [canManage, setCanManage] = useState(false);
  const [key, setKey] = useState("");
  const [useForSearch, setUseForSearch] = useState(true);
  const [minutes, setMinutes] = useState("0");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const apply = useCallback((view: TinyfishSettingsView) => {
    setSettings(view);
    setUseForSearch(view.useForWebSearch);
    setMinutes(String(view.browserMinutesPerDay));
  }, []);

  const load = useCallback(async () => {
    const response = await fetch("/api/settings/tinyfish", { cache: "no-store" });
    const body = (await response.json().catch(() => null)) as { settings?: TinyfishSettingsView; canManage?: boolean; error?: string } | null;
    if (!response.ok || !body?.settings) {
      setError(body?.error ?? "Could not read the TinyFish settings.");
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

  async function save(extra: { key?: string } = {}) {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const response = await fetch("/api/settings/tinyfish", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...(extra.key !== undefined ? { key: extra.key } : key.trim() ? { key: key.trim() } : {}),
          useForWebSearch: useForSearch,
          browserMinutesPerDay: Number(minutes),
        }),
      });
      const body = (await response.json().catch(() => null)) as { settings?: TinyfishSettingsView; error?: string } | null;
      if (!response.ok || !body?.settings) throw new Error(body?.error ?? "Could not save.");
      apply(body.settings);
      setKey("");
      setSaved(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  if (!settings) return error ? <Callout tone="error">{error}</Callout> : null;
  const field = "h-9 w-full rounded-lg border border-stroke-soft-200 bg-bg-white-0 px-3 text-paragraph-sm text-text-strong-950 disabled:opacity-60";
  // The server's rule as typed: 1-9 minutes could never open a 10-minute session, so no spend is shown for them.
  const minutesHint = browserMinutesHint(minutes);
  const waiting = settings.waitingUntil ? new Date(settings.waitingUntil) : null;

  return (
    <Frame>
      <FrameHeader
        title="TinyFish web access"
        description={`The assistant searches the web, reads pages and, if you allow it, uses a remote browser through TinyFish (tinyfish.ai). Search (${TINYFISH_FREE_LIMITS.search.perMinute} a minute, ${TINYFISH_FREE_LIMITS.search.perDay.toLocaleString("en")} a day) and page reading (${TINYFISH_FREE_LIMITS.fetch.perDay.toLocaleString("en")} pages a day) are free; AgentSDR stops at those limits and waits for the 00:00 UTC reset instead of spending your TinyFish Wallet. The browser is paid by the minute and stays off until you set minutes below.`}
      />
      <FramePanel className="flex flex-col gap-4">
        <p className="text-paragraph-xs text-text-sub-600">
          {settings.connected ? `Connected (key ${settings.keyHint ?? "saved"}).` : "Not connected: the assistant has no general web search, and reads pages directly."}{" "}
          {settings.connected && `Today (UTC): ${settings.today.searches} searches, ${settings.today.fetchedUrls} pages read, ${settings.today.browserMinutes} browser minutes.`}
        </p>
        {/* The server only reports a wait that has not ended yet. */}
        {waiting && (
          <Callout tone="warning">{settings.waitingReason ?? "TinyFish asked AgentSDR to wait"}: work resumes at {waiting.toLocaleString()}.</Callout>
        )}
        <label className="flex flex-col gap-1 text-label-xs text-text-strong-950">
          API key
          <input className={field} type="password" autoComplete="off" placeholder={settings.connected ? "Leave empty to keep the saved key" : "Paste your TinyFish key (agent.tinyfish.ai → API keys)"} value={key} disabled={!canManage || busy} onChange={(event) => setKey(event.target.value)} />
        </label>
        <label className="flex items-center gap-2 text-paragraph-sm text-text-strong-950">
          <input type="checkbox" checked={useForSearch} disabled={!canManage || busy} onChange={(event) => setUseForSearch(event.target.checked)} />
          Use TinyFish for web searches (off: website searches use Tavily or your AI provider, as before)
        </label>
        <label className="flex flex-col gap-1 text-label-xs text-text-strong-950 sm:max-w-xs">
          Browser minutes a day (0 = off)
          <input className={field} type="number" min={TINYFISH_LIMITS.browserMinutesPerDay.min} max={TINYFISH_LIMITS.browserMinutesPerDay.max} step="1" value={minutes} disabled={!canManage || busy} onChange={(event) => setMinutes(event.target.value)} />
          <span className={`text-paragraph-xs font-normal ${minutesHint.problem ? "text-error-base" : "text-text-sub-600"}`}>
            {minutesHint.text}
          </span>
        </label>
        {error && <Callout tone="error">{error}</Callout>}
        {saved && !error && <p className="text-paragraph-xs text-success-base">Saved.</p>}
        {canManage && (
          <div className="flex flex-wrap justify-end gap-2">
            {settings.connected && (
              <Button.Root variant="neutral" mode="stroke" size="xsmall" disabled={busy} onClick={() => void save({ key: "" })}>Disconnect</Button.Root>
            )}
            <Button.Root variant="primary" mode="filled" size="xsmall" disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Save"}</Button.Root>
          </div>
        )}
      </FramePanel>
      {!canManage && <FrameFooter>Only owners and admins can change the TinyFish connection.</FrameFooter>}
    </Frame>
  );
}
