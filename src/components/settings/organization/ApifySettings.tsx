"use client";

import { useCallback, useEffect, useState } from "react";
import * as Button from "@/components/alignui/button";
import { Frame, FrameFooter, FrameHeader, FramePanel } from "@/components/analytics/kit/Frame";
import { Callout } from "@/components/settings/SettingsKit";
import { APIFY_ACTOR_KEYS, APIFY_ACTORS, APIFY_LIMITS, type ApifyActorKey, type ApifySettingsView } from "@/lib/apify/catalog";

/**
 * Settings → Providers & features → Apify, shown once "Apify discovery" is on:
 * the token (write-only), which Actors may run, and the spending limits.
 * The budget is the owner's own ceiling on top of the Apify account's;
 * AgentSDR never tops up, upgrades or raises either.
 */
export function ApifySettings() {
  const [enabled, setEnabled] = useState(false);
  const [settings, setSettings] = useState<ApifySettingsView | null>(null);
  const [canManage, setCanManage] = useState(false);
  const [token, setToken] = useState("");
  const [approved, setApproved] = useState<ApifyActorKey[]>([]);
  const [budget, setBudget] = useState("");
  const [perRun, setPerRun] = useState("");
  const [results, setResults] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const apply = useCallback((view: ApifySettingsView) => {
    setSettings(view);
    setApproved(view.approvedActors);
    setBudget(String(view.monthlyBudgetUsd));
    setPerRun(String(view.maxChargePerRunUsd));
    setResults(String(view.maxResultsPerRun));
  }, []);

  const load = useCallback(async () => {
    const response = await fetch("/api/settings/apify", { cache: "no-store" });
    const body = (await response.json().catch(() => null)) as { enabled?: boolean; settings?: ApifySettingsView; canManage?: boolean; error?: string } | null;
    if (!response.ok || !body?.settings) {
      setError(body?.error ?? "Could not read the Apify settings.");
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

  async function save(extra: { token?: string } = {}) {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const response = await fetch("/api/settings/apify", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...(extra.token !== undefined ? { token: extra.token } : token.trim() ? { token: token.trim() } : {}),
          approvedActors: approved,
          monthlyBudgetUsd: Number(budget),
          maxChargePerRunUsd: Number(perRun),
          maxResultsPerRun: Number(results),
        }),
      });
      const body = (await response.json().catch(() => null)) as { settings?: ApifySettingsView; error?: string } | null;
      if (!response.ok || !body?.settings) throw new Error(body?.error ?? "Could not save.");
      apply(body.settings);
      setToken("");
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
        title="Apify"
        description="Paid discovery from your own Apify account. Only the Actors you approve run, within the limits below; when Apify is not set up, over budget or out of credit, searches continue with Google Maps, LinkedIn or website search. AgentSDR never tops up, upgrades or raises your Apify limits."
      />
      <FramePanel className="flex flex-col gap-4">
        <p className="text-paragraph-xs text-text-sub-600">
          {settings.connected ? `Connected (token ${settings.tokenHint ?? "saved"}).` : "Not connected."} This month: ${settings.spentThisMonthUsd.toFixed(2)} spent
          {settings.reservedUsd > 0 ? `, up to $${settings.reservedUsd.toFixed(2)} reserved by open runs` : ""} of your ${settings.monthlyBudgetUsd.toFixed(2)} budget.
        </p>
        <label className="flex flex-col gap-1 text-label-xs text-text-strong-950">
          API token
          <input className={field} type="password" autoComplete="off" placeholder={settings.connected ? "Leave empty to keep the saved token" : "Paste your Apify API token"} value={token} disabled={!canManage || busy} onChange={(event) => setToken(event.target.value)} />
        </label>
        <fieldset className="flex flex-col gap-2">
          <legend className="text-label-xs text-text-strong-950">Approved Actors</legend>
          {APIFY_ACTOR_KEYS.map((key) => (
            <label key={key} className="flex items-start gap-2 text-paragraph-xs text-text-sub-600">
              <input
                type="checkbox"
                className="mt-0.5"
                checked={approved.includes(key)}
                disabled={!canManage || busy}
                onChange={(event) => setApproved((current) => (event.target.checked ? [...new Set([...current, key])] : current.filter((value) => value !== key)))}
              />
              <span>
                <span className="text-label-xs text-text-strong-950">{APIFY_ACTORS[key].label}</span> — {APIFY_ACTORS[key].purpose} <span className="text-text-soft-400">{APIFY_ACTORS[key].limitation}</span>{" "}
                <a className="underline" href={APIFY_ACTORS[key].storeUrl} target="_blank" rel="noreferrer">Pricing</a>
              </span>
            </label>
          ))}
        </fieldset>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <label className="flex flex-col gap-1 text-label-xs text-text-strong-950">
            Monthly budget (USD)
            <input className={field} type="number" min={APIFY_LIMITS.monthlyBudgetUsd.min} max={APIFY_LIMITS.monthlyBudgetUsd.max} step="1" value={budget} disabled={!canManage || busy} onChange={(event) => setBudget(event.target.value)} />
          </label>
          <label className="flex flex-col gap-1 text-label-xs text-text-strong-950">
            Most one run may spend (USD)
            <input className={field} type="number" min={APIFY_LIMITS.maxChargePerRunUsd.min} max={APIFY_LIMITS.maxChargePerRunUsd.max} step="0.1" value={perRun} disabled={!canManage || busy} onChange={(event) => setPerRun(event.target.value)} />
          </label>
          <label className="flex flex-col gap-1 text-label-xs text-text-strong-950">
            Most results per run
            <input className={field} type="number" min={APIFY_LIMITS.maxResultsPerRun.min} max={APIFY_LIMITS.maxResultsPerRun.max} step="1" value={results} disabled={!canManage || busy} onChange={(event) => setResults(event.target.value)} />
          </label>
        </div>
        {error && <Callout tone="error">{error}</Callout>}
        {saved && !error && <p className="text-paragraph-xs text-success-base">Saved.</p>}
        {canManage && (
          <div className="flex flex-wrap justify-end gap-2">
            {settings.connected && (
              <Button.Root variant="neutral" mode="stroke" size="xsmall" disabled={busy} onClick={() => void save({ token: "" })}>Disconnect</Button.Root>
            )}
            <Button.Root variant="primary" mode="filled" size="xsmall" disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Save"}</Button.Root>
          </div>
        )}
      </FramePanel>
      {!canManage && <FrameFooter>Only owners and admins can change the Apify connection.</FrameFooter>}
    </Frame>
  );
}
