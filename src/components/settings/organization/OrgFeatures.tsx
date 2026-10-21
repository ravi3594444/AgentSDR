"use client";

import { useCallback, useEffect, useState } from "react";
import * as Button from "@/components/alignui/button";
import { Frame, FrameFooter, FrameHeader, FramePanel } from "@/components/analytics/kit/Frame";
import { Callout } from "@/components/settings/SettingsKit";
import { FEATURE_KEYS, FEATURES, type FeatureKey, type FeatureState } from "@/lib/features/catalog";

/**
 * Settings → Providers & features. Each is off until an owner or
 * admin turns it on here; turning one off stops it again (nothing already
 * stored is deleted).
 */
export function OrgFeatures() {
  const [features, setFeatures] = useState<FeatureState | null>(null);
  const [canManage, setCanManage] = useState(false);
  const [busy, setBusy] = useState<FeatureKey | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const response = await fetch("/api/settings/features", { cache: "no-store" });
    const body = (await response.json().catch(() => null)) as { features?: FeatureState; canManage?: boolean; error?: string } | null;
    if (!response.ok || !body?.features) {
      setError(body?.error ?? "Could not read the optional features.");
      return;
    }
    setFeatures(body.features);
    setCanManage(Boolean(body.canManage));
  }, []);

  useEffect(() => {
    // Loads once on mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  async function toggle(key: FeatureKey, enabled: boolean) {
    setBusy(key);
    setError(null);
    try {
      const response = await fetch("/api/settings/features", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key, enabled }),
      });
      const body = (await response.json().catch(() => null)) as { features?: FeatureState; error?: string } | null;
      if (!response.ok || !body?.features) throw new Error(body?.error ?? "Could not save.");
      setFeatures(body.features);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Frame>
      <FrameHeader title="Optional features" description="Off until you turn them on. Turning one off stops it; nothing already saved is deleted." />
      <FramePanel className="flex flex-col divide-y divide-stroke-soft-200">
        {!features && !error && <p className="text-paragraph-sm text-text-sub-600">Loading…</p>}
        {features && FEATURE_KEYS.map((key) => (
          <div key={key} className="flex flex-wrap items-start justify-between gap-3 py-3 first:pt-0 last:pb-0">
            <div className="min-w-0 max-w-xl">
              <p className="text-label-sm text-text-strong-950">
                {FEATURES[key].label}
                <span className={features[key] ? "ml-2 text-paragraph-xs text-success-base" : "ml-2 text-paragraph-xs text-text-soft-400"}>{features[key] ? "On" : "Off"}</span>
              </p>
              <p className="mt-1 text-paragraph-xs leading-relaxed text-text-sub-600">{FEATURES[key].description}</p>
              <p className="mt-1 text-paragraph-xs text-text-soft-400">Needs: {FEATURES[key].requires}</p>
            </div>
            {canManage && (
              <Button.Root
                variant={features[key] ? "neutral" : "primary"}
                mode={features[key] ? "stroke" : "filled"}
                size="xsmall"
                disabled={busy !== null}
                onClick={() => void toggle(key, !features[key])}
              >
                {busy === key ? "Saving…" : features[key] ? "Turn off" : "Turn on"}
              </Button.Root>
            )}
          </div>
        ))}
        {error && <Callout tone="error">{error}</Callout>}
      </FramePanel>
      {!canManage && features && <FrameFooter>Only owners and admins can turn features on or off.</FrameFooter>}
    </Frame>
  );
}
