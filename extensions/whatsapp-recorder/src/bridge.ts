/**
 * Runs on AgentSDR's own pages and connects them to the extension.
 *
 * A web page cannot call chrome.runtime without knowing the extension's id,
 * which differs on every rep's machine for an unpacked extension. So the page
 * talks window.postMessage to this content script instead, and it relays to
 * the service worker. It also marks the page, so the app can tell "not
 * installed" from "did not answer".
 *
 * Reloading the extension orphans the copies of this script already running
 * in open tabs: they stay on the page, but every chrome.runtime call throws
 * "Extension context invalidated". So an orphaned copy steps aside, and the
 * service worker injects a fresh copy into open AgentSDR tabs on install and
 * update (background.ts) — the page never needs a manual reload.
 */

import {
  RECORDER_INSTALLED_ATTRIBUTE,
  type RecorderBridgeReply,
  type RecorderBridgeRequest,
  type RecorderCallUpdate,
} from "../../../src/lib/calls/contract";
import type { BrowserBridgeReply, BrowserBridgeRequest } from "../../../src/lib/browser/connected/contract";
import type { BackgroundMessage, BridgeCommand, BridgeResult } from "./messages";

// Injected both by the manifest and, after an update, by the service worker:
// one live copy per extension instance is enough.
const scope = globalThis as { __agentsdrBridge?: boolean };
if (!scope.__agentsdrBridge) {
  scope.__agentsdrBridge = true;
  document.documentElement.setAttribute(RECORDER_INSTALLED_ATTRIBUTE, chrome.runtime.getManifest().version);
  window.addEventListener("message", onMessage);
  // The live phase of a call this tab placed, pushed by the service worker.
  chrome.runtime.onMessage.addListener((message: BridgeCommand) => {
    if (message?.target !== "bridge") return;
    if (message.type === "call:timing") {
      console.log(`[AgentSDR call timing] call ${message.callId} — ms after the Call click:`);
      console.table(message.steps);
      return;
    }
    const update: RecorderCallUpdate = {
      source: "agentsdr-recorder",
      type: "call:update",
      callId: message.callId,
      phase: message.phase,
    };
    window.postMessage(update, location.origin);
  });
}

/** False once the extension this copy belongs to was reloaded or removed. */
function extensionAlive(): boolean {
  try {
    return Boolean(chrome.runtime?.id);
  } catch {
    return false;
  }
}

function onMessage(event: MessageEvent): void {
  if (event.source !== window || event.origin !== location.origin) return;
  const data = event.data as Partial<RecorderBridgeRequest> | Partial<BrowserBridgeRequest> | null;
  if (data?.source !== "agentsdr-app" || !data.requestId) return;
  const browser = data.type === "browser:connect" || data.type === "browser:disconnect";
  if (!browser && data.type !== "call:start" && data.type !== "message:open" && data.type !== "call:end" && data.type !== "recorder:update") return;

  // An orphaned copy cannot reach the extension. Answering would race the
  // fresh copy's reply with an error, so it goes quiet instead.
  if (!extensionAlive()) {
    window.removeEventListener("message", onMessage);
    return;
  }

  if (browser) {
    relayBrowser(data as BrowserBridgeRequest);
    return;
  }
  const request = data as RecorderBridgeRequest;
  const message: BackgroundMessage = { target: "background", type: "bridge", request };
  try {
    chrome.runtime
      .sendMessage<BackgroundMessage, BridgeResult>(message)
      // No answer means no listener took it — an extension build too old for
      // this request type. Say so rather than failing on the missing result.
      .then((result) => reply(request, result ?? {
        ok: false,
        error: "The call recorder did not understand this request. Reload it in chrome://extensions.",
      }))
      .catch((error: unknown) =>
        reply(request, { ok: false, error: error instanceof Error ? error.message : String(error) }),
      );
  } catch {
    // Invalidated between the check and the call.
    window.removeEventListener("message", onMessage);
  }
}

function reply(request: RecorderBridgeRequest, result: BridgeResult): void {
  const { requestId } = request;
  const accepted = {
    "call:start": "call:accepted",
    "message:open": "message:opened",
    "call:end": "call:end-accepted",
    "recorder:update": "recorder:update-opened",
  } as const;
  const rejected = {
    "call:start": "call:rejected",
    "message:open": "message:rejected",
    "call:end": "call:end-rejected",
    "recorder:update": "recorder:update-rejected",
  } as const;
  const message: RecorderBridgeReply = result.ok
    ? { source: "agentsdr-recorder", requestId, type: accepted[request.type] }
    : { source: "agentsdr-recorder", requestId, type: rejected[request.type], error: result.error };
  window.postMessage(message, location.origin);
}

/** Connected-browser research requests (contract.ts in src/lib/browser/connected): connect and disconnect. */
function relayBrowser(request: BrowserBridgeRequest): void {
  const message: BackgroundMessage = { target: "background", type: "browser-bridge", request };
  const answer = (result: BridgeResult) => {
    const reply: BrowserBridgeReply = result.ok
      ? { source: "agentsdr-recorder", requestId: request.requestId, type: request.type === "browser:connect" ? "browser:connect-opened" : "browser:disconnected" }
      : { source: "agentsdr-recorder", requestId: request.requestId, type: request.type === "browser:connect" ? "browser:connect-rejected" : "browser:disconnect-rejected", error: result.error };
    window.postMessage(reply, location.origin);
  };
  try {
    chrome.runtime
      .sendMessage<BackgroundMessage, BridgeResult>(message)
      .then((result) => answer(result ?? { ok: false, error: "This extension is too old for browser research. Update it from AgentSDR's Settings." }))
      .catch((error: unknown) => answer({ ok: false, error: error instanceof Error ? error.message : String(error) }));
  } catch {
    window.removeEventListener("message", onMessage);
  }
}
