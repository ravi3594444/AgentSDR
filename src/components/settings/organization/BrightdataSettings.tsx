"use client";

import { useCallback, useEffect, useState } from "react";
import * as Button from "@/components/alignui/button";
import { Frame, FrameFooter, FrameHeader, FramePanel } from "@/components/analytics/kit/Frame";
import { Callout } from "@/components/settings/SettingsKit";
import { BRIGHTDATA_FREE_MONTHLY_CREDITS, BRIGHTDATA_LIMITS, creditsLine, PLATFORM_LIMITATIONS, type BrightdataSettingsView } from "@/lib/brightdata/catalog";

/**
 * Settings → Providers & features → Bright Data, shown once "Bright Data
 * research" is on: the key (write-only), the monthly credit limit, the
 * records one search may collect, an optional SERP zone and the Reddit
 * switch. Usage is AgentSDR's own count of delivered records, and says so;
 * each dataset shows only what this organization's collections returned.
 */
export function BrightdataSettings() {
  const [enabled, setEnabled] = useState(false);
  const [settings, setSettings] = useState<BrightdataSettingsView | null>(null);
  const [canManage, setCanManage] = useState(false);
  const [key, setKey] = useState("");
  const [monthly, setMonthly] = useState("");
  const [perSearch, setPerSearch] = useState("");
  const [zone, setZone] = useState("");
  const [reddit, setReddit] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const apply = useCallback((view: BrightdataSettingsView) => {
    setSettings(view);
    setMonthly(String(view.monthlyCredits));
    setPerSearch(String(view.maxRecordsPerSearch));
    setZone(view.serpZone ?? "");
    setReddit(view.redditEnabled);
  }, []);

  const load = useCallback(async () => {
    const response = await fetch("/api/settings/brightdata", { cache: "no-store" });
    const body = (await response.json().catch(() => null)) as { enabled?: boolean; settings?: BrightdataSettingsView; canManage?: boolean; error?: string } | null;
    if (!response.ok || !body?.settings) {
      setError(body?.error ?? "Could not read the Bright Data settings.");
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
      const response = await fetch("/api/settings/brightdata", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        // Included: the platform's key and limits; only the Reddit choice is the workspace's.
        body: JSON.stringify(settings?.included ? { redditEnabled: reddit } : {
          ...(extra.key !== undefined ? { key: extra.key } : key.trim() ? { key: key.trim() } : {}),
          monthlyCredits: Number(monthly),
          maxRecordsPerSearch: Number(perSearch),
          serpZone: zone,
          redditEnabled: reddit,
        }),
      });
      const body = (await response.json().catch(() => null)) as { settings?: BrightdataSettingsView; error?: string } | null;
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
  const used = settings.datasets.filter((dataset) => dataset.state !== "unused");
  const included = settings.included === true;

  return (
    <Frame>
      <FrameHeader
        title={included ? "Social research (included)" : "Bright Data research"}
        description={included
          ? "Social research is included with your workspace: Reddit discussions by keyword, and X, Instagram and Facebook posts, profiles and pages a web search finds. No account or key is needed. What is left this month is on Settings → Plan & usage."
          : `Social research runs through Bright Data's Scraper API (brightdata.com) with your key: Reddit discussions by keyword, and X, Instagram and Facebook posts, profiles and pages a web search finds. Bright Data bills one credit per record it returns; its free tier is ${BRIGHTDATA_FREE_MONTHLY_CREDITS.toLocaleString("en-US")} credits a month shared across its products. AgentSDR stops at the limit you set here and never tops up or changes your plan.`}
      />
      <FramePanel className="flex flex-col gap-4">
        <p className="text-paragraph-xs text-text-sub-600">
          {included
            ? `${settings.connected ? "Available." : "Not available right now."} ${creditsLine(settings.usedThisMonth, settings.reservedThisMonth, settings.monthlyCredits)}.`
            : <>{settings.connected ? `Connected (key ${settings.keyHint ?? "saved"}). ` : "Not connected. "}
          {creditsLine(settings.usedThisMonth, settings.reservedThisMonth, settings.monthlyCredits)}. Bright Data&apos;s API does not report the credits left on the account; check the Control Panel for the exact figure.</>}
        </p>
        {!included && <>
        <label className="flex flex-col gap-1 text-label-xs text-text-strong-950">
          API key
          <input className={field} type="password" autoComplete="off" placeholder={settings.connected ? "Leave empty to keep the saved key" : "Paste your Bright Data API key (Control Panel → Account settings)"} value={key} disabled={!canManage || busy} onChange={(event) => setKey(event.target.value)} />
        </label>
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="flex flex-col gap-1 text-label-xs text-text-strong-950">
            Credits a month (at most)
            <input className={field} type="number" min={BRIGHTDATA_LIMITS.monthlyCredits.min} max={BRIGHTDATA_LIMITS.monthlyCredits.max} step="1" value={monthly} disabled={!canManage || busy} onChange={(event) => setMonthly(event.target.value)} />
          </label>
          <label className="flex flex-col gap-1 text-label-xs text-text-strong-950">
            Records per search (at most)
            <input className={field} type="number" min={BRIGHTDATA_LIMITS.maxRecordsPerSearch.min} max={BRIGHTDATA_LIMITS.maxRecordsPerSearch.max} step="1" value={perSearch} disabled={!canManage || busy} onChange={(event) => setPerSearch(event.target.value)} />
          </label>
        </div>
        <label className="flex flex-col gap-1 text-label-xs text-text-strong-950 sm:max-w-xs">
          SERP API zone (optional)
          <input className={field} type="text" autoComplete="off" placeholder="A SERP zone from your Control Panel" value={zone} disabled={!canManage || busy} onChange={(event) => setZone(event.target.value)} />
          <span className="text-paragraph-xs text-text-sub-600">Used only to find X, Instagram and Facebook pages when no web search (TinyFish, Tavily or your AI provider) is set up. One credit per search.</span>
        </label>
        </>}
        <label className="flex items-start gap-2 text-paragraph-sm text-text-strong-950">
          <input type="checkbox" className="mt-1" checked={reddit} disabled={!canManage || busy} onChange={(event) => setReddit(event.target.checked)} />
          <span>
            Research Reddit discussions
            <span className="block text-paragraph-xs text-text-sub-600">{PLATFORM_LIMITATIONS.reddit} Reddit&apos;s terms restrict automated collection: turn this on only if you accept that.</span>
          </span>
        </label>
        {used.length > 0 && (
          <div className="flex flex-col gap-1 text-paragraph-xs text-text-sub-600">
            <span className="text-label-xs text-text-strong-950">What your collections returned</span>
            {used.map((dataset) => (
              <span key={dataset.key}>
                {dataset.label}: {dataset.state === "verified" ? "worked" : "failed"}{dataset.at ? ` on ${new Date(dataset.at).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}` : ""}{dataset.detail ? ` — ${dataset.detail}` : ""}
              </span>
            ))}
          </div>
        )}
        {error && <Callout tone="error">{error}</Callout>}
        {saved && !error && <p className="text-paragraph-xs text-success-base">Saved.</p>}
        {canManage && (
          <div className="flex flex-wrap justify-end gap-2">
            {settings.connected && !included && (
              <Button.Root variant="neutral" mode="stroke" size="xsmall" disabled={busy} onClick={() => void save({ key: "" })}>Disconnect</Button.Root>
            )}
            <Button.Root variant="primary" mode="filled" size="xsmall" disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Save"}</Button.Root>
          </div>
        )}
      </FramePanel>
      {!canManage && <FrameFooter>Only owners and admins can change the Bright Data connection.</FrameFooter>}
    </Frame>
  );
}
