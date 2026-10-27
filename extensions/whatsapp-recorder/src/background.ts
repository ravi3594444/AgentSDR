/**
 * Places calls from AgentSDR through the rep's WhatsApp Web tab, and carries
 * their recordings and outcomes back to AgentSDR.
 *
 * The call itself is dialed and recorded inside web.whatsapp.com (wa-agent,
 * wa-hook); this worker opens the chat, keeps the call's state across its
 * steps (storage.session, which survives this worker being suspended),
 * relays the call's phase to the AgentSDR tab, and uploads the recording.
 */

import type {
  FinishCallRequest,
  RecorderBridgeRequest,
  RecorderCallPhase,
  RecorderCallRequest,
} from "../../../src/lib/calls/contract";
import { digitsOnly } from "../../../src/lib/calls/digits";
import {
  WA_RECORDING_PORT,
  type ActiveCall,
  type AgentCommand,
  type BackgroundMessage,
  type BridgeCommand,
  type BridgeResult,
  type ProbeResult,
  type RecentCall,
  type WaCall,
  type WaRecordingPortMessage,
} from "./messages";
import { allowedOrigins, customOrigins, isCustomOriginsChange, originPattern } from "./origins";
import { beginPairing, disconnectFrom } from "./research";
import { callApi, getCallStatus, uploadRecording } from "./upload";

const ACTIVE_CALL_KEY = "activeCall";
/** The toolbar icon's tooltip between calls. */
const IDLE_TITLE = "AgentSDR Call Recorder";
const RECENT_CALLS_KEY = "recentCalls";
/** How long the WhatsApp tab can keep asking about a finished call. */
const RECENT_CALL_TTL_MS = 2 * 60 * 60 * 1000;
/** A call not recorded within this long is treated as abandoned. */
const ACTIVE_CALL_TTL_MS = 30 * 60 * 1000;
/**
 * WhatsApp stays in front until its call screen says "Ringing": hidden
 * sooner, Chrome throttles the tab and WhatsApp's call set-up slowed from
 * about a second to 4.4 s (measured 29 Sep 2026). This is the longest it
 * waits for "Ringing" before switching back anyway.
 */
const RETURN_FALLBACK_MS = 10_000;
/** Calls placed by the extension whose rep has not been switched back yet. */
const awaitingReturn = new Set<string>();
/** wa-agent's own in-place attempt gives up at 6 s; this only catches a hang. */
// --- call timing ---------------------------------------------------------------
// Each step of a call, in ms after the rep's click, printed to the AgentSDR
// tab's console (and this worker's) once the call rings or settles — to see
// where the time between "Call" and ringing goes.

type Timing = { t0: number; steps: { step: string; ms: number }[] };
const timings = new Map<string, Timing>();
const TIMING_REPORT_PHASES = new Set(["on-call", "not-answered", "not-on-whatsapp", "error", "manual-dial"]);

function startTiming(callId: string, clickedAt: number | undefined): void {
  const now = Date.now();
  timings.set(callId, { t0: clickedAt ?? now, steps: [] });
  if (clickedAt !== undefined) trace(callId, "AgentSDR: Call clicked", clickedAt);
  trace(callId, "Extension: got the call (AgentSDR had created it on the server)", now);
}

function trace(callId: string, step: string, at = Date.now()): void {
  const timing = timings.get(callId);
  if (!timing) return;
  const ms = at - timing.t0;
  timing.steps.push({ step, ms });
  console.log(`[recorder] ${callId.slice(0, 8)} +${ms}ms ${step}`);
}

async function reportTiming(callId: string): Promise<void> {
  const timing = timings.get(callId);
  const call = await recentCall(callId);
  if (!timing) return;
  console.table(timing.steps);
  if (call?.appTabId === undefined) return;
  const report: BridgeCommand = { target: "bridge", type: "call:timing", callId, steps: timing.steps };
  await chrome.tabs.sendMessage(call.appTabId, report).catch(() => {});
}
const OPEN_IN_PLACE_TIMEOUT_MS = 9_000;

chrome.runtime.onInstalled.addListener(() => void syncCustomBridges().then(refreshBridges));
chrome.runtime.onStartup.addListener(() => void syncCustomBridges());
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "sync" && isCustomOriginsChange(changes)) void syncCustomBridges().then(refreshBridges);
});
chrome.permissions.onAdded.addListener(() => void syncCustomBridges().then(refreshBridges));
chrome.permissions.onRemoved.addListener(() => void syncCustomBridges());

const CUSTOM_BRIDGE_ID = "bridge-custom-origins";

/**
 * The bridge for AgentSDR origins added on the Options page (a self-hosted
 * AgentSDR). Manifest content scripts cover only the built-in origins, so
 * the added ones get the same bridge registered at runtime — for those whose
 * host permission is still granted.
 */
async function syncCustomBridges(): Promise<void> {
  const granted: string[] = [];
  for (const origin of await customOrigins()) {
    if (await chrome.permissions.contains({ origins: [originPattern(origin)] })) granted.push(origin);
  }
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [CUSTOM_BRIDGE_ID] });
  if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: [CUSTOM_BRIDGE_ID] });
  if (!granted.length) return;
  await chrome.scripting
    .registerContentScripts([
      {
        id: CUSTOM_BRIDGE_ID,
        matches: granted.map(originPattern),
        js: ["bridge.js"],
        runAt: "document_start",
        persistAcrossSessions: true,
      },
    ])
    .catch((error: unknown) => console.warn("[recorder] could not register the bridge for added origins", error));
}

/**
 * Chrome only injects manifest content scripts into pages loaded after the
 * extension was, so AgentSDR tabs already open at install or update would be
 * left with no bridge, or an orphaned one. Give them a fresh copy.
 */
async function refreshBridges(): Promise<void> {
  const tabs = await chrome.tabs.query({ url: (await allowedOrigins()).map(originPattern) });
  for (const tab of tabs) {
    if (tab.id === undefined) continue;
    await chrome.scripting
      .executeScript({ target: { tabId: tab.id }, files: ["bridge.js"] })
      .catch((error: unknown) => console.warn("[recorder] could not refresh the bridge in tab", tab.id, error));
  }
}

chrome.runtime.onMessage.addListener((message: BackgroundMessage, sender, sendResponse) => {
  if (message.target !== "background") return;

  switch (message.type) {
    case "bridge":
      void handleBridge(message.request, sender).then(sendResponse);
      return true; // answers asynchronously
    case "browser-bridge":
      void handleBrowserBridge(message.request, sender).then(sendResponse);
      return true;
    case "wa:hello":
      void callForTab(sender.tab?.id).then(sendResponse);
      return true;
    case "wa:dialed":
      void updateActiveCall(message.callId, { dialedAt: Date.now() });
      // Back to AgentSDR once the call is placed; WhatsApp carries it on in
      // its picture-in-picture window. Not when the rep still has to press
      // Voice call themselves.
      if (message.pressed) {
        awaitingReturn.add(message.callId);
        setTimeout(() => returnToAgentSdr(message.callId, "no \"Ringing\" within 10 s"), RETURN_FALLBACK_MS);
      }
      break;
    case "wa:answered":
      void onAnswered(message.callId, message.answeredAt);
      break;
    case "wa:not-answered":
      void finishActiveCall(message.callId, {
        outcome: "no_recording",
        startedAt: new Date(message.dialedAt).toISOString(),
        endedAt: new Date(message.endedAt).toISOString(),
      });
      break;
    case "wa:not-on-whatsapp":
      // The error's "isn't on WhatsApp" is what marks the lead Not on WhatsApp.
      void finishActiveCall(message.callId, {
        outcome: "failed",
        error: message.noCallButton
          ? "This number isn't on WhatsApp for calls (its chat has no Voice call button, as with a business number)"
          : "This number isn't on WhatsApp",
      });
      break;
    case "wa:recording-failed":
      void finishActiveCall(message.callId, { outcome: "failed", error: `Recording failed: ${message.error}` });
      break;
    case "wa:status":
      void statusFor(message.callId).then(sendResponse);
      return true;
    case "wa:focus-app":
      // The automatic return at the end of a call is skipped when the rep
      // was already switched back when it rang — they may have gone to
      // WhatsApp on purpose since. The rep's own "Back" always works.
      if (!(message.auto && returnedToAgentSdr.has(message.callId))) void focusApp(message.callId);
      break;
    case "wa:call-shown":
      // The call screen is up: back to AgentSDR now rather than at "Ringing…",
      // which WhatsApp does not always show.
      returnToAgentSdr(message.callId, "WhatsApp shows the call screen");
      break;
    case "wa:phase":
      trace(message.callId, `phase: ${message.phase.kind}`);
      if (message.phase.kind !== "calling" && message.phase.kind !== "ringing" && message.phase.kind !== "opening") {
        returnToAgentSdr(message.callId, `the call moved on (${message.phase.kind})`);
      }
      void forwardPhase(message.callId, message.phase);
      if (TIMING_REPORT_PHASES.has(message.phase.kind)) void reportTiming(message.callId);
      break;
    case "wa:trace":
      trace(message.callId, message.step);
      if (/^WhatsApp shows "Ringing/i.test(message.step)) {
        returnToAgentSdr(message.callId, "WhatsApp is ringing");
        void reportTiming(message.callId);
      }
      break;
  }
});

/**
 * A request from an AgentSDR page, relayed by the bridge content script. The
 * sender's origin is checked again here rather than trusted.
 */
async function handleBridge(
  request: RecorderBridgeRequest,
  sender: chrome.runtime.MessageSender,
): Promise<BridgeResult> {
  const senderOrigin = sender.origin ?? (sender.url ? new URL(sender.url).origin : null);
  const origins = await allowedOrigins();
  if (!senderOrigin || !origins.includes(senderOrigin)) {
    return { ok: false, error: `Requests are only accepted from ${origins.join(" or ")}. Add your AgentSDR address in the extension's Options.` };
  }
  if (request.type === "call:end") return endCall(request.callId);
  if (request.type === "recorder:update") {
    // The Update page downloads the build from the AgentSDR that asked for it.
    await chrome.tabs.create({ url: chrome.runtime.getURL(`update.html?from=${encodeURIComponent(senderOrigin)}`) });
    return { ok: true };
  }
  const digits = digitsOnly(request.phone);
  if (digits.length < 7) return { ok: false, error: `"${request.phone}" is not a dialable number` };

  if (request.type === "message:open") {
    // The tab reloads for the message; a call still waiting to be dialed
    // there must not be dialed by that reload.
    const pending = await getActiveCall();
    if (pending && !pending.dialedAt) await updateActiveCall(pending.callId, { dialedAt: Date.now() });
    // Typed in, not sent: the rep reads it and presses Enter themselves, so
    // WhatsApp comes to the front. Answered before the chat opens — see startCall.
    void openChat(digits, { text: request.text, focus: true }).catch((error) => console.warn("[recorder] could not open the chat", error));
    return { ok: true };
  }
  if (request.apiBase !== senderOrigin) {
    return { ok: false, error: "A call must report back to the page that placed it" };
  }
  return startCall(request, digits, sender.tab?.id);
}

/**
 * Connected-browser research from an AgentSDR page (research.ts). The pairing
 * belongs to the page's own origin, checked here against the allowed ones,
 * never to an address the page names.
 */
async function handleBrowserBridge(
  request: Extract<BackgroundMessage, { type: "browser-bridge" }>["request"],
  sender: chrome.runtime.MessageSender,
): Promise<BridgeResult> {
  const senderOrigin = sender.origin ?? (sender.url ? new URL(sender.url).origin : null);
  const origins = await allowedOrigins();
  if (!senderOrigin || !origins.includes(senderOrigin)) {
    return { ok: false, error: `Requests are only accepted from ${origins.join(" or ")}. Add your AgentSDR address in the extension's Options.` };
  }
  if (request.type === "browser:disconnect") return disconnectFrom(senderOrigin);
  if (request.apiBase !== senderOrigin) return { ok: false, error: "The browser can only connect to the page that asked." };
  return beginPairing(request.code, senderOrigin);
}

/**
 * A call placed from the app: remember it, and open the chat. wa-agent in
 * that tab then dials it and wa-hook records it (see wa-hook.ts).
 */
async function startCall(request: RecorderCallRequest, digits: string, appTabId: number | undefined): Promise<BridgeResult> {
  const previous = await getActiveCall();
  if (previous?.answeredAt) {
    if (await stillBusy(previous)) {
      return { ok: false, error: "The last call is still being recorded — hang it up first" };
    }
    // The WhatsApp tab no longer has that call — reloaded or closed during
    // it, or the extension was. Its end will never be reported, and without
    // this it would block calling until Chrome restarts.
    await callApi(previous, "finish", {
      outcome: "failed",
      error: "The call was interrupted: WhatsApp or the extension reloaded during it, so the recording was lost",
    }).catch(() => {});
    await clearActiveCall(previous.callId);
  }
  // A call that was opened but never recorded is over; say so rather than
  // leaving it pending in the app.
  if (previous) await callApi(previous, "finish", { outcome: "no_recording" }).catch(() => {});

  const call: ActiveCall = {
    callId: request.callId,
    recorderToken: request.recorderToken,
    apiBase: request.apiBase,
    phone: request.phone,
    requestedAt: Date.now(),
    lead: request.lead,
    appTabId,
  };
  await rememberCall(call);
  startTiming(call.callId, request.clickedAt);
  // Stored before the chat opens, so wa-agent's reports (and, after a
  // reload, its hello) find it. The tab id is merged in afterwards rather
  // than written over, since wa-agent may already have reported dialing.
  await setActiveCall(call);
  // The page is answered now, not after the chat opens: an in-place open can
  // take several seconds to confirm, and the page gives up on a silent
  // extension after 5 s and marks the call failed — after which the app
  // refuses its recording. From here on the card, not the page, reports.
  void openChat(digits, { call: { callId: call.callId, phone: call.phone, lead: call.lead ?? null }, focus: true })
    .then((tabId) => updateActiveCall(call.callId, { tabId }))
    .catch((error) => console.warn("[recorder] could not open the chat", error));
  return { ok: true };
}

/**
 * Opens the chat in the rep's WhatsApp Web tab — in place when that tab is
 * already loaded (about a second), otherwise by loading it at
 * /send?phone=… (a full WhatsApp Web start-up). Returns the tab's id.
 *
 * WhatsApp comes to the front to open the chat: in a background tab it does
 * not re-render the chat header in time for openInPlace to confirm the chat,
 * so the call would fall back to a slow reload (seen 29 Sep 2026). For a call
 * it is only for a moment — once Voice call is pressed the rep is switched
 * back to AgentSDR (the wa:dialed handler), WhatsApp moves the call into its
 * picture-in-picture window, and the call's phase is pushed to AgentSDR.
 */
async function openChat(
  digits: string,
  options: { call?: WaCall; text?: string; focus: boolean },
): Promise<number | undefined> {
  const url = `https://web.whatsapp.com/send?phone=${digits}${options.text ? `&text=${encodeURIComponent(options.text)}` : ""}`;
  const callId = options.call?.callId;
  const note = (step: string) => {
    if (callId) trace(callId, step);
  };
  const [existing] = await chrome.tabs.query({ url: "https://web.whatsapp.com/*" });
  if (existing?.id === undefined) {
    note("Extension: no WhatsApp tab open — opening one (full WhatsApp start-up)");
    return (await chrome.tabs.create({ url })).id;
  }

  if (options.focus) await focusTab(existing);
  note("Extension: WhatsApp tab in front; opening the chat in place");
  if (await openInPlace(existing.id, digits, options)) {
    note("Extension: chat opened in place");
    return existing.id;
  }
  note("Extension: in-place open failed — reloading WhatsApp (full start-up)");
  // A fresh load has had no click from the rep yet, so Chrome may hold its
  // audio back; bring it forward for this one.
  await chrome.tabs.update(existing.id, { url });
  await focusTab(existing);
  return existing.id;
}

async function focusTab(tab: chrome.tabs.Tab): Promise<void> {
  if (tab.id === undefined) return;
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
}

/** Switches the rep back to AgentSDR once per call, when the call has got going. */
/** Calls whose rep was switched back to AgentSDR when the call rang. */
const returnedToAgentSdr = new Set<string>();

function returnToAgentSdr(callId: string, why: string): void {
  if (!awaitingReturn.delete(callId)) return;
  returnedToAgentSdr.add(callId);
  void focusApp(callId).then(() => trace(callId, `Extension: switched back to AgentSDR (${why})`));
}

/** AgentSDR's End call: pressed in the WhatsApp tab holding the call. */
async function endCall(callId: string): Promise<BridgeResult> {
  const call = await getActiveCall();
  // Already closed out — hung up in WhatsApp and reported: nothing to end.
  if (!call || call.callId !== callId) return { ok: true };
  // The call's own tab when known; otherwise the rep's WhatsApp tab, which is
  // where calls are placed.
  const tabId = call.tabId ?? (await chrome.tabs.query({ url: "https://web.whatsapp.com/*" }))[0]?.id;
  if (tabId === undefined) return { ok: false, error: "No WhatsApp Web tab is open" };
  const command: AgentCommand = { target: "wa-agent", type: "end", callId };
  try {
    return (await chrome.tabs.sendMessage<AgentCommand, BridgeResult>(tabId, command)) ?? {
      ok: false,
      error: "WhatsApp didn't answer",
    };
  } catch {
    return { ok: false, error: "The WhatsApp tab can't be reached — reload it" };
  }
}

/** Sends a call's phase to the AgentSDR tab that placed it. */
async function forwardPhase(callId: string, phase: RecorderCallPhase): Promise<void> {
  const call = await recentCall(callId);
  if (call?.appTabId === undefined) return;
  const update: BridgeCommand = { target: "bridge", type: "call:update", callId, phase };
  await chrome.tabs.sendMessage(call.appTabId, update).catch(() => {
    // The AgentSDR tab was closed or navigated away; nothing to update.
  });
}

/**
 * Asks wa-agent in a loaded tab to open the chat itself. False when there is
 * no live wa-agent there (the tab predates this extension build, or is still
 * loading) or it could not confirm the chat — the caller then reloads.
 */
async function openInPlace(tabId: number, digits: string, options: { call?: WaCall; text?: string }): Promise<boolean> {
  const command: AgentCommand = {
    target: "wa-agent",
    type: "open",
    phone: digits,
    text: options.text ?? null,
    call: options.call ?? null,
  };
  try {
    const result = await Promise.race([
      chrome.tabs.sendMessage<AgentCommand, BridgeResult>(tabId, command),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), OPEN_IN_PLACE_TIMEOUT_MS)),
    ]);
    return result?.ok === true;
  } catch {
    return false;
  }
}

/** wa-agent's hello: the call to place in its tab, if one was just opened there. */
async function callForTab(tabId: number | undefined): Promise<WaCall | null> {
  const call = await getActiveCall();
  if (!call || tabId === undefined || call.dialedAt) return null;
  // The tab id is recorded right after navigation starts; a hello that races
  // it (or comes from the only WhatsApp tab) is still this call's.
  if (call.tabId !== undefined && call.tabId !== tabId) return null;
  if (Date.now() - call.requestedAt >= ACTIVE_CALL_TTL_MS) return null;
  return { callId: call.callId, phone: call.phone, lead: call.lead ?? null };
}

/**
 * Calls stay known here for a while after they end, so the call card can
 * show the transcript arriving and "Back to AgentSDR" can find its tab.
 */
async function rememberCall(call: ActiveCall): Promise<void> {
  const stored = await chrome.storage.session.get(RECENT_CALLS_KEY);
  const recent = (stored[RECENT_CALLS_KEY] as Record<string, RecentCall> | undefined) ?? {};
  const now = Date.now();
  for (const [id, entry] of Object.entries(recent)) if (now - entry.endedAt > RECENT_CALL_TTL_MS) delete recent[id];
  recent[call.callId] = {
    callId: call.callId,
    recorderToken: call.recorderToken,
    apiBase: call.apiBase,
    appTabId: call.appTabId,
    endedAt: now,
  };
  await chrome.storage.session.set({ [RECENT_CALLS_KEY]: recent });
}

async function recentCall(callId: string): Promise<RecentCall | null> {
  const stored = await chrome.storage.session.get(RECENT_CALLS_KEY);
  return (stored[RECENT_CALLS_KEY] as Record<string, RecentCall> | undefined)?.[callId] ?? null;
}

async function statusFor(callId: string) {
  const call = await recentCall(callId);
  return call ? getCallStatus(call).catch(() => null) : null;
}

/** "Back to AgentSDR": the tab the call came from, else any AgentSDR tab, else a new one. */
async function focusApp(callId: string): Promise<void> {
  const call = await recentCall(callId);
  const tab =
    (call?.appTabId !== undefined ? await chrome.tabs.get(call.appTabId).catch(() => null) : null) ??
    (await chrome.tabs.query({ url: (await allowedOrigins()).map(originPattern) }))[0] ??
    null;
  if (tab?.id !== undefined) {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } else if (call) {
    await chrome.tabs.create({ url: `${call.apiBase}/calling` });
  }
}

async function onAnswered(callId: string, answeredAt: number): Promise<void> {
  const call = await updateActiveCall(callId, { answeredAt });
  if (!call) return;
  await setBadge("REC", "#d92d20", "Recording this call");
  await callApi(call, "started", { startedAt: new Date(answeredAt).toISOString() }).catch((error) =>
    console.warn("[recorder] could not mark the call started", error),
  );
}

/** Reports the active call's end without a recording, and forgets it. */
/**
 * Reports a call's end without a recording. Usually the active call; an
 * earlier call whose end arrives late (see wa-agent's finishOtherCall) is
 * reported through the details kept for recent calls.
 */
async function finishActiveCall(callId: string, finish: FinishCallRequest): Promise<void> {
  const active = await getActiveCall();
  const call = active?.callId === callId ? active : await recentCall(callId);
  if (!call) return;
  if (call === active) {
    await clearActiveCall(callId);
    await setBadge("", "#000000", IDLE_TITLE);
  }
  await callApi(call, "finish", finish).catch((error) => console.warn("[recorder] could not report the call", error));
}

/**
 * Whether the WhatsApp tab holding `call` is still recording, finishing off
 * or uploading it. A tab that can't be reached has lost it.
 */
async function stillBusy(call: ActiveCall): Promise<boolean> {
  if (call.tabId === undefined) return false;
  try {
    const result = await Promise.race([
      chrome.tabs.sendMessage<AgentCommand, ProbeResult>(call.tabId, { target: "wa-agent", type: "probe" }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 2_000)),
    ]);
    return result?.busyCallIds.includes(call.callId) ?? false;
  } catch {
    return false;
  }
}

// wa-agent streams a finished recording here: runtime messages are JSON-only,
// so the file crosses as base64 chunks and is uploaded from this worker,
// whose host permissions spare it CORS.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== WA_RECORDING_PORT) return;
  let meta: Extract<WaRecordingPortMessage, { type: "meta" }> | null = null;
  const parts: Uint8Array<ArrayBuffer>[] = [];
  port.onMessage.addListener((message: WaRecordingPortMessage) => {
    if (message.type === "meta") meta = message;
    else if (message.type === "chunk") parts.push(fromBase64(message.data));
    else if (meta) void receiveRecording(port, meta, parts);
  });
});

async function receiveRecording(
  port: chrome.runtime.Port,
  meta: Extract<WaRecordingPortMessage, { type: "meta" }>,
  parts: Uint8Array<ArrayBuffer>[],
): Promise<void> {
  const active = await getActiveCall();
  // An earlier call's recording can arrive after a new call started (see
  // wa-agent's finishOtherCall): upload it with the details kept for it.
  const call = active?.callId === meta.callId ? active : await recentCall(meta.callId);
  if (!call) {
    port.postMessage({ ok: false, error: "This call is no longer known to the extension" } satisfies BridgeResult);
    return;
  }
  if (call === active) {
    await clearActiveCall(meta.callId);
    await setBadge("", "#000000", IDLE_TITLE);
  }
  try {
    await uploadRecording(call, new Blob(parts, { type: meta.mimeType }), meta.startedAt, meta.endedAt, meta.answeredAt);
    port.postMessage({ ok: true } satisfies BridgeResult);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await callApi(call, "finish", { outcome: "failed", error: `Upload failed: ${message}` }).catch(() => {});
    port.postMessage({ ok: false, error: message } satisfies BridgeResult);
  }
}

function fromBase64(data: string): Uint8Array<ArrayBuffer> {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function getActiveCall(): Promise<ActiveCall | null> {
  const stored = await chrome.storage.session.get(ACTIVE_CALL_KEY);
  return (stored[ACTIVE_CALL_KEY] as ActiveCall | undefined) ?? null;
}

// Writes to the active call run one at a time. Each update reads the stored
// call, changes a field and writes it back; two in flight at once (the tab id
// after the chat opens, "dialed" right after Voice call) each wrote back the
// copy they read, and one erased the other — the tab id went missing, and
// End call could not find the call's tab. A queue, not a lock: none of these
// may wait on another from inside it.
let activeCallWrites: Promise<unknown> = Promise.resolve();

function serialized<T>(write: () => Promise<T>): Promise<T> {
  const next = activeCallWrites.then(write, write);
  activeCallWrites = next.catch(() => {});
  return next;
}

function setActiveCall(call: ActiveCall): Promise<void> {
  return serialized(() => chrome.storage.session.set({ [ACTIVE_CALL_KEY]: call }));
}

/** Forgets the active call — only if it is still `callId`, not a newer call. */
function clearActiveCall(callId: string): Promise<void> {
  return serialized(async () => {
    const call = await getActiveCall();
    if (call?.callId === callId) await chrome.storage.session.remove(ACTIVE_CALL_KEY);
  });
}

function updateActiveCall(callId: string, patch: Partial<ActiveCall>): Promise<ActiveCall | null> {
  return serialized(async () => {
    const call = await getActiveCall();
    if (!call || call.callId !== callId) return null;
    const next = { ...call, ...patch };
    await chrome.storage.session.set({ [ACTIVE_CALL_KEY]: next });
    return next;
  });
}

async function setBadge(text: string, color: string, title: string): Promise<void> {
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setTitle({ title });
}
