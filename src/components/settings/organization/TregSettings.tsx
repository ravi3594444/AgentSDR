"use client";

import { useCallback, useEffect, useState } from "react";
import * as Button from "@/components/alignui/button";
import { Frame, FrameFooter, FrameHeader, FramePanel } from "@/components/analytics/kit/Frame";
import { Callout } from "@/components/settings/SettingsKit";
import { TREG_LIMITS, type TregSettingsView } from "@/lib/treg/catalog";

/**
 * Settings → Providers & features → Treg, shown once "Treg tools" is on: the key
 * (write-only) and the daily spend cap. Treg bills each call to the team's
 * prepaid balance; AgentSDR never tops it up.
 */
export function TregSettings() {
  const [enabled, setEnabled] = useState(false);
  const [settings, setSettings] = useState<TregSettingsView | null>(null);
  const [canManage, setCanManage] = useState(false);
  const [key, setKey] = useState("");
  const [cap, setCap] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const apply = useCallback((view: TregSettingsView) => {
    setSettings(view);
    setCap(String(view.dailyCapUsd));
  }, []);

  const load = useCallback(async () => {
    const response = await fetch("/api/settings/treg", { cache: "no-store" });
    const body = (await response.json().catch(() => null)) as { enabled?: boolean; settings?: TregSettingsView; canManage?: boolean; error?: string } | null;
    if (!response.ok || !body?.settings) {
      setError(body?.error ?? "Could not read the Treg settings.");
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
      const response = await fetch("/api/settings/treg", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...(extra.key !== undefined ? { key: extra.key } : key.trim() ? { key: key.trim() } : {}),
          dailyCapUsd: Number(cap),
        }),
      });
      const body = (await response.json().catch(() => null)) as { settings?: TregSettingsView; error?: string } | null;
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

  return (
    <Frame>
      <FrameHeader
        title="Treg (beta)"
        description={`Paid data tools from your own Treg account (treg.to): the assistant finds the right tool in Treg's catalog and calls it, billed by Treg to your prepaid balance. A call costing more than $${TREG_LIMITS.maxUsdPerCall} is never made, and none once the daily cap below is reached. AgentSDR never tops up your Treg balance.`}
      />
      <FramePanel className="flex flex-col gap-4">
        <p className="text-paragraph-xs text-text-sub-600">
          {settings.connected ? `Connected${settings.team ? ` to the team “${settings.team}”` : ""} (key ${settings.keyHint ?? "saved"}).` : "Not connected."} Last 24 hours: ${settings.spentTodayUsd.toFixed(3)} of your ${settings.dailyCapUsd.toFixed(2)} daily cap.
        </p>
        <label className="flex flex-col gap-1 text-label-xs text-text-strong-950">
          API key
          <input className={field} type="password" autoComplete="off" placeholder={settings.connected ? "Leave empty to keep the saved key" : "Paste your Treg key (treg.to → Team → API keys)"} value={key} disabled={!canManage || busy} onChange={(event) => setKey(event.target.value)} />
        </label>
        <label className="flex flex-col gap-1 text-label-xs text-text-strong-950 sm:max-w-xs">
          Daily spend cap (USD)
          <input className={field} type="number" min={0} max={TREG_LIMITS.maxDailyCapUsd} step="0.5" value={cap} disabled={!canManage || busy} onChange={(event) => setCap(event.target.value)} />
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
      {!canManage && <FrameFooter>Only owners and admins can change the Treg connection.</FrameFooter>}
    </Frame>
  );
}
