"use client";

import { useCallback, useEffect, useState } from "react";
import * as Button from "@/components/alignui/button";
import { Frame, FrameFooter, FrameHeader, FramePanel } from "@/components/analytics/kit/Frame";
import { Callout } from "@/components/settings/SettingsKit";
import { TAVILY_LIMITS, type TavilySettingsView } from "@/lib/tavily/catalog";

/**
 * Settings → Providers & features → Tavily, shown once "Website and directory
 * search" is on: the key (write-only) and the searches a day. While a key is
 * saved, website searches use Tavily instead of the AI provider's web search.
 */
export function TavilySettings() {
  const [enabled, setEnabled] = useState(false);
  const [settings, setSettings] = useState<TavilySettingsView | null>(null);
  const [canManage, setCanManage] = useState(false);
  const [key, setKey] = useState("");
  const [daily, setDaily] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const apply = useCallback((view: TavilySettingsView) => {
    setSettings(view);
    setDaily(String(view.dailySearches));
  }, []);

  const load = useCallback(async () => {
    const response = await fetch("/api/settings/tavily", { cache: "no-store" });
    const body = (await response.json().catch(() => null)) as { enabled?: boolean; settings?: TavilySettingsView; canManage?: boolean; error?: string } | null;
    if (!response.ok || !body?.settings) {
      setError(body?.error ?? "Could not read the Tavily settings.");
      return;
    }
    setEnabled(Boolean(body.enabled));
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
      const response = await fetch("/api/settings/tavily", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...(extra.key !== undefined ? { key: extra.key } : key.trim() ? { key: key.trim() } : {}),
          dailySearches: Number(daily),
        }),
      });
      const body = (await response.json().catch(() => null)) as { settings?: TavilySettingsView; error?: string } | null;
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

  if (!enabled || !settings) return null;
  const field = "h-9 w-full rounded-lg border border-stroke-soft-200 bg-bg-white-0 px-3 text-paragraph-sm text-text-strong-950 disabled:opacity-60";
  const plan = settings.plan;

  return (
    <Frame>
      <FrameHeader
        title="Tavily web search"
        description="Website searches use Tavily (tavily.com) whenever a key is saved here, instead of your AI provider's web search: real result pages, about 20 per search. One website search is 2–3 Tavily searches. Tavily's free plan includes 1,000 searches a month; AgentSDR never changes your Tavily plan."
      />
      <FramePanel className="flex flex-col gap-4">
        <p className="text-paragraph-xs text-text-sub-600">
          {settings.connected ? `Connected (key ${settings.keyHint ?? "saved"}).` : "Not connected: website searches use your AI provider's web search, if it has one."}{" "}
          Last 24 hours: {settings.searchesToday} of {settings.dailySearches} searches.
          {plan && plan.used !== null ? ` Tavily plan${plan.name ? ` “${plan.name}”` : ""}: ${plan.used}${plan.limit !== null ? ` of ${plan.limit}` : ""} credits used this month.` : ""}
        </p>
        <label className="flex flex-col gap-1 text-label-xs text-text-strong-950">
          API key
          <input className={field} type="password" autoComplete="off" placeholder={settings.connected ? "Leave empty to keep the saved key" : "Paste your Tavily key (app.tavily.com → API keys)"} value={key} disabled={!canManage || busy} onChange={(event) => setKey(event.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-label-xs text-text-strong-950 sm:max-w-xs">
          Searches a day (at most)
          <input className={field} type="number" min={TAVILY_LIMITS.dailySearches.min} max={TAVILY_LIMITS.dailySearches.max} step="1" value={daily} disabled={!canManage || busy} onChange={(event) => setDaily(event.target.value)} />
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
      {!canManage && <FrameFooter>Only owners and admins can change the Tavily connection.</FrameFooter>}
    </Frame>
  );
}
