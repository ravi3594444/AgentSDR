/**
 * What the toolbar popup says about the browser assistant, as pure functions
 * of its ResearchStatus (popup.ts puts them on the page; popupState.test.ts
 * checks them).
 */

import { RESEARCH_SITES } from "../../../src/lib/browser/connected/contract";
import type { ResearchStatus } from "./messages";

/** Without an answer from the app for this long (and no command running), the browser counts as offline. Polls last up to 35 s. */
export const OFFLINE_AFTER_MS = 90_000;

export type PopupState = { label: "Not connected" | "Stopped" | "Needs you" | "Offline" | "Connected"; tone: "ok" | "warn" | ""; detail: string };

/** Connected, offline, stopped or needs you: the states the app shows beside its chat. */
export function popupState(status: ResearchStatus, now: number): PopupState {
  if (!status.connected) return { label: "Not connected", tone: "", detail: "Press Connect browser in the 22nd x ai chat to let the assistant work here." };
  if (status.paused) return { label: "Stopped", tone: "warn", detail: "Nothing runs in this browser until you press Resume." };
  if (status.attention) return { label: "Needs you", tone: "warn", detail: "" };
  const silent = status.lastContactAt !== null && now - status.lastContactAt > OFFLINE_AFTER_MS;
  if (!status.busy && (status.lastError || silent)) {
    return { label: "Offline", tone: "warn", detail: `Can't reach 22nd x ai${status.lastError ? ` (${status.lastError})` : ""}. It keeps trying.` };
  }
  return { label: "Connected", tone: "ok", detail: status.busy ? "Working in this browser" : "" };
}

/** "All websites", or the selected sites and websites by name. */
export function accessLine(status: Pick<ResearchStatus, "access" | "sites" | "domains">): string {
  if (status.access === "all") return "All websites";
  const parts = [...status.sites.map((key) => RESEARCH_SITES[key].label), ...status.domains];
  return parts.length ? `Selected sites: ${parts.join(", ")}` : "No websites";
}

/** What it is doing now, and for how long. */
export function nowLine(status: Pick<ResearchStatus, "paused" | "activity" | "busy">, now: number): string {
  if (status.paused) return "Stopped";
  if (status.activity) return `${status.activity.label} · ${elapsed(status.activity.since, now)}`;
  return status.busy ? "Working" : "Nothing right now";
}

/** The last thing it did, whether it worked, and when. */
export function lastLine(status: Pick<ResearchStatus, "lastActivity">, now: number): string {
  const last = status.lastActivity;
  return last ? `${last.label} · ${last.ok ? "worked" : "didn't work"} · ${elapsed(last.at, now)} ago` : "Nothing yet";
}

export function elapsed(since: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - since) / 1000));
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "a page";
  }
}
