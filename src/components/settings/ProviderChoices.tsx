"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import * as Badge from "@/components/alignui/badge";
import { Frame, FrameFooter, FrameHeader, FramePanel } from "@/components/analytics/kit/Frame";
import { Callout } from "@/components/settings/SettingsKit";
import { SERVICE_MODE_LABEL, type ManagedService, type ServiceMode } from "@/lib/managed/catalog";

type Choice = {
  service: ManagedService;
  label: string;
  description: string;
  mode: ServiceMode;
  explicit: boolean;
  includedAvailable: boolean;
  includedOffered: boolean;
  ownSaved: boolean;
  ownSettingsHref: string;
  ownSettingsLabel: string;
};

/**
 * One choice per service between the Included service and My own provider.
 * Switching moves no key: a workspace's own saved credentials stay saved, and
 * a failing own key never falls back to the Included service.
 */
export function ProviderChoices() {
  const [choices, setChoices] = useState<Choice[] | null>(null);
  const [canManage, setCanManage] = useState(false);
  const [busy, setBusy] = useState<ManagedService | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const response = await fetch("/api/settings/providers", { cache: "no-store" });
    const body = (await response.json().catch(() => null)) as { services?: Choice[]; canManage?: boolean; error?: string } | null;
    if (!response.ok || !body?.services) {
      setError(body?.error ?? "Could not read the provider choices.");
      return;
    }
    setChoices(body.services);
    setCanManage(Boolean(body.canManage));
  }, []);

  useEffect(() => {
    // Loads once on mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function choose(service: ManagedService, mode: ServiceMode) {
    setBusy(service);
    setError(null);
    try {
      const response = await fetch("/api/settings/providers", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ service, mode }),
      });
      const body = (await response.json().catch(() => null)) as { services?: Choice[]; error?: string } | null;
      if (!response.ok || !body?.services) throw new Error(body?.error ?? "Could not save.");
      setChoices(body.services);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }

  if (!choices) return error ? <Callout tone="error">{error}</Callout> : <p className="text-paragraph-sm text-text-sub-600">Loading…</p>;
  return (
    <div className="flex flex-col gap-4">
      {error && <Callout tone="error">{error}</Callout>}
      {choices.map((choice) => (
        <Frame key={choice.service}>
          <FrameHeader
            title={choice.label}
            description={choice.description}
            actions={
              <Badge.Root variant="lighter" size="small" color={choice.mode === "managed" ? (choice.includedAvailable ? "green" : "orange") : "blue"}>
                {SERVICE_MODE_LABEL[choice.mode]}
              </Badge.Root>
            }
          />
          <FramePanel className="flex flex-col gap-3">
            <fieldset className="flex flex-col gap-2" disabled={!canManage || busy !== null}>
              <legend className="sr-only">{choice.label}: Included service or My own provider</legend>
              <label className={`flex items-start gap-2 text-paragraph-sm ${choice.includedOffered ? "text-text-strong-950" : "text-text-soft-400"}`}>
                <input
                  type="radio"
                  className="mt-1"
                  name={`mode-${choice.service}`}
                  checked={choice.mode === "managed"}
                  disabled={!choice.includedOffered}
                  onChange={() => void choose(choice.service, "managed")}
                />
                <span>
                  {SERVICE_MODE_LABEL.managed}
                  <span className="block text-paragraph-xs text-text-sub-600">
                    {!choice.includedOffered
                      ? "Not offered on this server yet."
                      : choice.includedAvailable
                        ? "No account or key needed. Counted against your monthly allowance (Plan & usage)."
                        : "No account or key needed. Not available right now; it starts working as soon as it is."}
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2 text-paragraph-sm text-text-strong-950">
                <input type="radio" className="mt-1" name={`mode-${choice.service}`} checked={choice.mode === "own"} onChange={() => void choose(choice.service, "own")} />
                <span>
                  {SERVICE_MODE_LABEL.own}
                  <span className="block text-paragraph-xs text-text-sub-600">
                    {choice.ownSaved ? "Your own account is saved. " : "Set up your own account first. "}
                    If it stops working, this service stops too: it never switches to the included one by itself.
                  </span>
                </span>
              </label>
            </fieldset>
            {choice.mode === "own" && (
              <p className="text-paragraph-xs text-text-sub-600">
                Your own account: <Link className="underline" href={choice.ownSettingsHref}>{choice.ownSettingsLabel}</Link>.
              </p>
            )}
          </FramePanel>
          {!canManage && <FrameFooter>Only owners and admins can change this.</FrameFooter>}
        </Frame>
      ))}
    </div>
  );
}
