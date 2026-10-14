"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { RiAddLine, RiLoader4Line, RiRefreshLine } from "@remixicon/react";
import * as Button from "@/components/alignui/button";
import { Callout } from "@/components/settings/SettingsKit";

/**
 * Mints a Unipile hosted-auth link and hands the browser over to it.
 *
 * A full-page navigation, not an iframe: Unipile advises against framing the
 * wizard because LinkedIn's captcha and OAuth screens break inside one. The
 * wizard sends the user back to /settings/linkedin-accounts?unipile=success|failure.
 */
export async function startHostedAuth(accountId?: string): Promise<void> {
  const res = await fetch("/api/linkedin/accounts/hosted-auth", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(accountId ? { accountId } : {}),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.ok || !data.url) {
    throw new Error(data?.error || "Could not start the LinkedIn connection flow");
  }
  window.location.href = data.url as string;
}

/**
 * Drives one "go to the wizard" button.
 *
 * The redirecting flag has to survive the round trip: navigating to Unipile
 * freezes this page in the browser's back/forward cache with its React state
 * intact, so pressing Back restores the page mid-redirect and the spinner would
 * spin forever. `pageshow` is the one event that fires on a bfcache restore, so
 * it is what clears the flag; on a normal load it fires with the flag already
 * false and changes nothing.
 */
export function useHostedAuthRedirect() {
  const [redirecting, setRedirecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onPageShow = () => {
      setRedirecting(false);
      setError(null);
    };
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, []);

  const start = useCallback(async (accountId?: string) => {
    setRedirecting(true);
    setError(null);
    try {
      await startHostedAuth(accountId);
      // Navigation is underway — the spinner stays up until the page unloads,
      // and pageshow clears it if the user comes back instead.
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setRedirecting(false);
    }
  }, []);

  return { redirecting, error, start };
}

export function ConnectAccountButton({
  label = "Connect LinkedIn account",
  variant = "default",
}: {
  label?: string;
  variant?: "default" | "outline";
}) {
  const { redirecting, error, start } = useHostedAuthRedirect();

  return (
    <div className="flex flex-col items-end gap-1">
      <Button.Root
        type="button"
        variant={variant === "outline" ? "neutral" : "primary"}
        mode={variant === "outline" ? "stroke" : "filled"}
        size="small"
        disabled={redirecting}
        onClick={() => start()}
      >
        <Button.Icon as={redirecting ? RiLoader4Line : RiAddLine} className={redirecting ? "animate-spin" : undefined} />
        {redirecting ? "Opening LinkedIn…" : label}
      </Button.Root>
      {error && <p role="alert" className="text-paragraph-xs text-error-base">{error}</p>}
    </div>
  );
}

/**
 * Pulls the LinkedIn accounts already linked in the Unipile dashboard into
 * this workspace now, instead of at the next scheduled LinkedIn run (every 30
 * minutes). For an account linked outside the wizard, which is the common
 * case: running the wizard again would link the same profile a second time.
 */
export function SyncLinkedInAccountsButton() {
  const router = useRouter();
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function sync() {
    setSyncing(true);
    setError(null);
    try {
      const res = await fetch("/api/linkedin/accounts/sync", { method: "POST" });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.ok) throw new Error(data?.error || `Sync failed (HTTP ${res.status})`);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSyncing(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button.Root type="button" variant="neutral" mode="stroke" size="small" disabled={syncing} onClick={() => void sync()}>
        <Button.Icon as={syncing ? RiLoader4Line : RiRefreshLine} className={syncing ? "animate-spin" : undefined} />
        {syncing ? "Syncing…" : "Sync from Unipile"}
      </Button.Root>
      {error && <p role="alert" className="max-w-72 text-right text-paragraph-xs text-error-base">{error}</p>}
    </div>
  );
}

/**
 * Handles the return leg of the wizard. Unipile's notify_url already triggers a
 * sync server-side, but that callback cannot reach a localhost dev server and
 * may land after the redirect, so the returning tab syncs once itself. Both
 * paths upsert, so a double sync is harmless.
 */
export function HostedAuthReturn() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const outcome = searchParams.get("unipile");
  // Starts at "syncing" rather than flipping there inside the effect: the effect
  // runs on the same render that first sees ?unipile=success.
  const [state, setState] = useState<"syncing" | "done" | "failed">("syncing");

  const clearParam = useCallback(() => {
    router.replace("/settings/linkedin-accounts");
  }, [router]);

  useEffect(() => {
    if (outcome !== "success") return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/linkedin/accounts/sync", { method: "POST" });
        if (!res.ok) throw new Error(await res.text());
        if (cancelled) return;
        setState("done");
        router.replace("/settings/linkedin-accounts");
        router.refresh();
      } catch {
        if (!cancelled) setState("failed");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [outcome, router]);

  if (!outcome) return null;

  const dismiss = (
    <button type="button" onClick={clearParam} className="rounded text-label-xs underline underline-offset-2 outline-none focus-visible:ring-2 focus-visible:ring-primary-base">
      Dismiss
    </button>
  );

  if (outcome === "failure") {
    return (
      <Callout tone="error" className="mb-5" title="LinkedIn was not connected" action={dismiss}>
        The Unipile wizard did not complete. Try connecting again.
      </Callout>
    );
  }

  if (state === "failed") {
    return (
      <Callout tone="warning" className="mb-5" title="Connected, but the sync failed" action={dismiss}>
        The account will appear here after the next outreach run.
      </Callout>
    );
  }

  return (
    <div role="status" className="mb-5 flex items-center gap-2 rounded-xl bg-bg-weak-50 px-3.5 py-3 text-paragraph-sm text-text-sub-600 ring-1 ring-inset ring-stroke-soft-200">
      <RiLoader4Line className="size-4 animate-spin" aria-hidden="true" />
      Syncing the connected account from Unipile…
    </div>
  );
}
