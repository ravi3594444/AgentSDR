"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { RiChromeLine, RiLoader4Line } from "@remixicon/react";
import * as Popover from "@/components/alignui/popover";
import { RESEARCH_SITES, type BrowserConnectionView } from "@/lib/browser/connected/contract";
import { browserConnection, connectThisBrowser, disconnectThisBrowser, extensionCanResearch } from "@/lib/browser/connected/client";
import { isRecorderInstalled, recorderVersion } from "@/lib/calls/client";
import { RECORDER_INSTALLED_ATTRIBUTE } from "@/lib/calls/contract";
import { RECORDER_SETUP_PATH } from "@/lib/calls/recorderRelease";
import { cn } from "@/utils/cn";

/**
 * The person's own Chrome for research (src/lib/browser/connected/), in one
 * short state beside the chat's other switches: Connect browser, connected,
 * offline, stopped or needs you, with Disconnect. The extension's toolbar
 * button has Stop and Share this tab.
 */

function subscribe(onChange: () => void): () => void {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: [RECORDER_INSTALLED_ATTRIBUTE] });
  return () => observer.disconnect();
}
/** The installed extension's version ("" when unreadable), null when missing; undefined on the server. */
const readVersion = () => (isRecorderInstalled() ? (recorderVersion() ?? "") : null);
const readOnServer = () => undefined;

const LABELS: Record<BrowserConnectionView["state"], string> = {
  none: "Connect browser",
  connected: "Browser connected",
  offline: "Browser offline",
  paused: "Browser stopped",
  needs_attention: "Browser needs you",
};

export function BrowserConnection() {
  const version = useSyncExternalStore(subscribe, readVersion, readOnServer);
  const [view, setView] = useState<BrowserConnectionView | null>(null);
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [error, setError] = useState("");

  const state = view?.state ?? "none";
  // Waiting for the Connect page in the other tab, until the connection shows up.
  const pairing = waiting && state === "none";

  useEffect(() => {
    let live = true;
    // A failed read keeps the last state; the next one tries again.
    const refresh = () => browserConnection().then((next) => { if (live) setView(next); }, () => undefined);
    void refresh();
    const timer = setInterval(refresh, pairing ? 3_000 : 30_000);
    window.addEventListener("focus", refresh);
    return () => {
      live = false;
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [pairing]);

  const connect = async () => {
    setError("");
    setBusy(true);
    try {
      await connectThisBrowser();
      setWaiting(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setError("");
    setBusy(true);
    try {
      setView(await disconnectThisBrowser());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const installed = version !== undefined && version !== null;
  const capable = installed && extensionCanResearch(version || null);
  const dot = state === "connected" ? "bg-success-base" : state === "needs_attention" || state === "paused" ? "bg-warning-base" : "bg-stroke-sub-300";
  const sites = (view?.sites ?? []).map((key) => RESEARCH_SITES[key].label).join(", ");

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button type="button" data-testid="browser-connection" className="inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-lg px-2.5 text-label-xs text-text-sub-600 ring-1 ring-inset ring-stroke-soft-200 hover:bg-bg-weak-50">
          {busy ? <RiLoader4Line className="size-4 animate-spin" aria-hidden="true" /> : state === "none" ? <RiChromeLine className="size-4" aria-hidden="true" /> : <span className={cn("size-2 rounded-full", dot)} aria-hidden="true" />}
          {pairing ? "Finish in the new tab…" : LABELS[state]}
        </button>
      </Popover.Trigger>
      <Popover.Content align="end" showArrow={false} sideOffset={8} className="w-80 max-w-[calc(100vw-2rem)] space-y-2 p-3">
        <p className="text-label-sm text-text-strong-950">Research in your browser</p>
        {state === "none" ? (
          <>
            <p className="text-paragraph-xs text-text-sub-600">The assistant opens background tabs in your Chrome and reads the sites you enable — LinkedIn, X, Reddit, Instagram, Facebook or other websites — signed in as you. It reads only; sending stays in your approved outreach.</p>
            {!installed ? (
              <p className="text-paragraph-xs text-text-sub-600">Install the AgentSDR extension first: <Link href={RECORDER_SETUP_PATH} className="text-primary-base hover:underline">Settings → WhatsApp → Integrations</Link>, then reload this page.</p>
            ) : !capable ? (
              <p className="text-paragraph-xs text-text-sub-600">Your AgentSDR extension is too old for this. <Link href={RECORDER_SETUP_PATH} className="text-primary-base hover:underline">Update it</Link>, then reload this page.</p>
            ) : (
              <button type="button" onClick={() => void connect()} disabled={busy} className="inline-flex h-8 items-center rounded-lg bg-primary-base px-3 text-label-xs text-primary-contrast disabled:opacity-60">Connect this browser</button>
            )}
            {pairing && <p className="text-paragraph-xs text-text-sub-600">Choose the sites in the tab that opened and press Connect there.</p>}
          </>
        ) : (
          <>
            <p className="text-paragraph-xs text-text-sub-600">
              {state === "connected" && `Connected${view?.deviceLabel ? ` (${view.deviceLabel})` : ""}. Sites: ${sites || "none"}.`}
              {state === "offline" && `Offline: Chrome is closed or asleep${view?.deviceLabel ? ` (${view.deviceLabel})` : ""}. Research there resumes when it is back.`}
              {state === "paused" && "You pressed Stop in the extension. Resume it from the extension's toolbar button."}
              {state === "needs_attention" && `${view?.attention?.detail ?? "A page needs you"}${view?.attention?.host ? ` on ${view.attention.host}` : ""}. Open the “AgentSDR research” tab group in Chrome to deal with it.`}
            </p>
            <p className="text-paragraph-xs text-text-soft-400">Stop, Share this tab and the sites are on the extension&apos;s toolbar button.</p>
            <button type="button" onClick={() => void disconnect()} disabled={busy} className="inline-flex h-8 items-center rounded-lg px-3 text-label-xs text-text-sub-600 ring-1 ring-inset ring-stroke-soft-200 hover:bg-bg-weak-50 disabled:opacity-60">Disconnect</button>
          </>
        )}
        {error && <p role="alert" className="text-paragraph-xs text-error-base">{error}</p>}
      </Popover.Content>
    </Popover.Root>
  );
}
