/**
 * Messages between the extension's own contexts: the service worker,
 * wa-agent on web.whatsapp.com, and the bridge content script on the app's
 * pages.
 *
 * All of them listen on chrome.runtime.onMessage, which every extension
 * context receives, so each message names its `target` and receivers ignore
 * the rest.
 */

import type { RecorderBridgeRequest, RecorderCallPhase, RecorderLead } from "../../../src/lib/calls/contract";
import type { BrowserBridgeRequest, ResearchSiteKey } from "../../../src/lib/browser/connected/contract";

/** A call placed from the app, which the next recording belongs to. */
export type ActiveCall = {
  callId: string;
  recorderToken: string;
  apiBase: string;
  /** E.164. */
  phone: string;
  requestedAt: number;
  /** The WhatsApp Web tab the chat was opened in. */
  tabId?: number;
  /** When wa-agent clicked Voice call; set means the call is handled there. */
  dialedAt?: number;
  /** When the lead picked up (the call timer appeared). */
  answeredAt?: number;
  lead?: RecorderLead | null;
  /** The AgentSDR tab the call was placed from — "Back to AgentSDR" returns there. */
  appTabId?: number;
};

/** What the service worker keeps after a call ends, for the call card's status checks. */
export type RecentCall = Pick<ActiveCall, "callId" | "recorderToken" | "apiBase" | "appTabId"> & { endedAt: number };

/** What wa-agent is told about the call to place in its tab — never the token. */
export type WaCall = { callId: string; phone: string; lead: RecorderLead | null };

/**
 * Service worker → wa-agent in an already-loaded WhatsApp tab: open this chat
 * in place (with `text` typed in, for a follow-up), then place `call` if one
 * is given. Answered with a BridgeResult; not ok means "reload instead".
 */
export type AgentCommand =
  | {
      target: "wa-agent";
      type: "open";
      /** Digits only, country code first. */
      phone: string;
      text: string | null;
      call: WaCall | null;
    }
  /** Hang up `callId` — answered with a BridgeResult saying whether End call was pressed. */
  | { target: "wa-agent"; type: "end"; callId: string }
  /** Which calls this tab is still busy with — answered with a ProbeResult. */
  | { target: "wa-agent"; type: "probe" };

/** A call is busy while it is being recorded, finished off, or uploaded. */
export type ProbeResult = { busyCallIds: string[] };

/** Service worker → the bridge in the AgentSDR tab that placed a call. */
export type BridgeCommand =
  | { target: "bridge"; type: "call:update"; callId: string; phase: RecorderCallPhase }
  /** Printed to the AgentSDR tab's console: how long each step of a call took. */
  | { target: "bridge"; type: "call:timing"; callId: string; steps: { step: string; ms: number }[] };

export type BackgroundMessage =
  | { target: "background"; type: "bridge"; request: RecorderBridgeRequest }
  /** Connected-browser research from an AgentSDR page: connect (with its pairing code) or disconnect. */
  | { target: "background"; type: "browser-bridge"; request: BrowserBridgeRequest }
  // From wa-agent on web.whatsapp.com, about the call in its own tab:
  | { target: "background"; type: "wa:hello" }
  /** `pressed`: the extension pressed Voice call itself (false: the rep has to). */
  | { target: "background"; type: "wa:dialed"; callId: string; pressed: boolean }
  /** `noCallButton`: the chat opened but has no Voice call button (a business number). */
  | { target: "background"; type: "wa:not-on-whatsapp"; callId: string; noCallButton?: boolean }
  | { target: "background"; type: "wa:answered"; callId: string; answeredAt: number }
  | { target: "background"; type: "wa:not-answered"; callId: string; dialedAt: number; endedAt: number }
  | { target: "background"; type: "wa:recording-failed"; callId: string; error: string }
  /** The call card polls the transcript's progress; answered with RecorderCallStatus | null. */
  | { target: "background"; type: "wa:status"; callId: string }
  /**
   * Back to the AgentSDR tab the call came from. `auto`: sent by the extension
   * itself at the end of a call, not by the rep — skipped when the rep was
   * already switched back when the call rang.
   */
  | { target: "background"; type: "wa:focus-app"; callId: string; auto?: boolean }
  /** WhatsApp's call screen is up: the moment to switch the rep back to AgentSDR. */
  | { target: "background"; type: "wa:call-shown"; callId: string }
  /** The call card's phase changed; forwarded to the AgentSDR tab that placed the call. */
  | { target: "background"; type: "wa:phase"; callId: string; phase: RecorderCallPhase }
  /** A timed step of a call, for the timing table printed in the AgentSDR tab's console. */
  | { target: "background"; type: "wa:trace"; callId: string; step: string };

/**
 * From the extension's own pages (Connect, the toolbar popup) to the service
 * worker, about connected-browser research (research.ts). The worker accepts
 * them only from those pages, never from a content script.
 */
export type ResearchMessage =
  /** The Connect page asks what it was opened for: the app and the sites already enabled. */
  | { target: "research"; type: "pairing"; nonce: string | null }
  /** Pair with the app's code (the page asked Chrome for the sites' permissions first). */
  | { target: "research"; type: "pair"; nonce: string; sites: ResearchSiteKey[] }
  /** Change the enabled sites of the current connection. */
  | { target: "research"; type: "set-sites"; sites: ResearchSiteKey[] }
  | { target: "research"; type: "status" }
  /** Stop (or resume) research in this browser; stopping closes its tabs. */
  | { target: "research"; type: "pause"; paused: boolean }
  | { target: "research"; type: "share-tab"; tabId: number }
  | { target: "research"; type: "unshare-tab"; tabId: number }
  | { target: "research"; type: "disconnect" };

/** What the popup and the Connect page show. */
export type ResearchStatus = {
  connected: boolean;
  apiBase: string | null;
  organizationName: string | null;
  userEmail: string | null;
  sites: ResearchSiteKey[];
  paused: boolean;
  /** A command is running now. */
  busy: boolean;
  openTabs: number;
  sharedTabs: { tabId: number; title: string; url: string }[];
  /** The last page that needs the owner, if any. */
  attention: { detail: string; url: string; tabId: number } | null;
  /** Epoch ms of the last answer from the app. */
  lastContactAt: number | null;
  lastError: string | null;
};

export type ResearchPairing = { apiBase: string; sites: ResearchSiteKey[]; connected: boolean; organizationName: string | null };

/** The "wa-recording" port: wa-agent streams the file to the service worker. */
export const WA_RECORDING_PORT = "wa-recording";
export type WaRecordingPortMessage =
  /** The recording runs startedAt → endedAt; the lead picked up at answeredAt. */
  | { type: "meta"; callId: string; mimeType: string; startedAt: number; answeredAt: number; endedAt: number }
  /** base64 — runtime messaging is JSON-only, so a Blob cannot cross it. */
  | { type: "chunk"; data: string }
  | { type: "end" };

/** The service worker's answer to a bridged request. */
export type BridgeResult = { ok: true } | { ok: false; error: string };
