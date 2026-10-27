/**
 * The page's side of connected-browser research: the person's connection
 * (/api/browser-connections) and the request that hands a pairing code to
 * the extension over window.postMessage (its bridge content script).
 * Client-safe.
 */

import { isOlderVersion } from "@/lib/calls/recorderRelease";
import { BROWSER_RESEARCH_MIN_VERSION, type BrowserBridgeReply, type BrowserBridgeRequest, type BrowserConnectionView } from "./contract";

const REPLY_TIMEOUT_MS = 5_000;

/** Whether the installed extension (its stamped version) can research; null version means not installed. */
export function extensionCanResearch(version: string | null): boolean {
  return Boolean(version) && !isOlderVersion(version!, BROWSER_RESEARCH_MIN_VERSION);
}

async function call<T>(method: "GET" | "POST" | "DELETE"): Promise<T> {
  const response = await fetch("/api/browser-connections", { method, headers: method === "GET" ? undefined : { "Content-Type": "application/json" } });
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `Request failed (HTTP ${response.status})`);
  return body;
}

export const browserConnection = () => call<BrowserConnectionView>("GET");
export const disconnectBrowserConnection = () => call<BrowserConnectionView>("DELETE");

type BridgeMessage = { type: "browser:connect"; code: string } | { type: "browser:disconnect" };

function sendToExtension(message: BridgeMessage): Promise<BrowserBridgeReply> {
  return new Promise((resolve, reject) => {
    const requestId = crypto.randomUUID();
    const request: BrowserBridgeRequest = message.type === "browser:connect"
      ? { source: "agentsdr-app", type: "browser:connect", requestId, code: message.code, apiBase: window.location.origin }
      : { source: "agentsdr-app", type: "browser:disconnect", requestId };
    const onMessage = (event: MessageEvent) => {
      if (event.source !== window) return;
      const data = event.data as Partial<BrowserBridgeReply> | null;
      if (data?.source !== "agentsdr-recorder" || data.requestId !== requestId) return;
      cleanup();
      resolve(data as BrowserBridgeReply);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("The AgentSDR extension didn't respond. If it was just installed or updated, reload this page."));
    }, REPLY_TIMEOUT_MS);
    function cleanup() {
      window.removeEventListener("message", onMessage);
      clearTimeout(timer);
    }
    window.addEventListener("message", onMessage);
    window.postMessage(request, window.location.origin);
  });
}

/** Mints a pairing code for the signed-in person and hands it to the extension, which opens its Connect page. */
export async function connectThisBrowser(): Promise<void> {
  const { code } = await call<{ code: string }>("POST");
  const reply = await sendToExtension({ type: "browser:connect", code });
  if (reply.type === "browser:connect-rejected") throw new Error(reply.error);
}

/** Disconnects in the app (the token stops working) and tells the extension, best effort, to close its research tabs. */
export async function disconnectThisBrowser(): Promise<BrowserConnectionView> {
  const view = await disconnectBrowserConnection();
  await sendToExtension({ type: "browser:disconnect" }).catch(() => undefined);
  return view;
}
