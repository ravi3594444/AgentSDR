/** Read-only waits and exact-page reuse; shared by the app and its extension. */
export const BROWSER_EFFICIENCY_MIN_VERSION = "0.19.0";
export const DEFAULT_READY_TIMEOUT_MS = 20_000;
export const MAX_READY_TIMEOUT_MS = 30_000;

export type BrowserWaitFor = { selector?: string; text?: string; timeoutMs?: number };
export type BrowserReadiness = {
  state: "ready" | "timeout" | "cancelled" | "blocked";
  waitedMs: number;
  checks: number;
  reason?: string;
};
export type BrowserTiming = {
  /** Extension execution, including local readiness waits. */
  browserMs?: number;
  readyWaitMs?: number;
  /** App queue and round-trip times, measured by the server. */
  queueMs?: number;
  roundTripMs?: number;
  reusedTab?: boolean;
};

export function waitForProblem(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "waitFor must be an object with selector and/or text";
  const wait = value as Record<string, unknown>;
  if (Object.keys(wait).some((key) => !["selector", "text", "timeoutMs"].includes(key))) return "waitFor accepts selector, text and timeoutMs only";
  if (wait.selector !== undefined && (typeof wait.selector !== "string" || !wait.selector.trim() || wait.selector.length > 1_000)) return "waitFor.selector must be a nonempty CSS selector, at most 1000 characters";
  if (wait.text !== undefined && (typeof wait.text !== "string" || !wait.text.trim() || wait.text.length > 1_000)) return "waitFor.text must be nonempty page text, at most 1000 characters";
  if (wait.selector === undefined && wait.text === undefined) return "waitFor needs selector and/or text";
  if (wait.timeoutMs !== undefined && (typeof wait.timeoutMs !== "number" || !Number.isSafeInteger(wait.timeoutMs) || wait.timeoutMs < 0 || wait.timeoutMs > MAX_READY_TIMEOUT_MS)) return `waitFor.timeoutMs must be between 0 and ${MAX_READY_TIMEOUT_MS}`;
  return null;
}

/** A known chat entry point can wait for its composer without model polling. */
export function defaultPageWait(raw: string): BrowserWaitFor | undefined {
  try {
    const url = new URL(raw);
    if (url.protocol === "https:" && url.hostname === "web.whatsapp.com" && url.pathname === "/send" && /^\d{7,15}$/.test(url.searchParams.get("phone") ?? "")) {
      return { selector: "#main footer [contenteditable=true], #main footer textarea, #main footer [role=textbox]", timeoutMs: DEFAULT_READY_TIMEOUT_MS };
    }
  } catch { /* An invalid URL is refused by the caller. */ }
  return undefined;
}

/** Exact URL, including its query and fragment, and only this request's assistant-owned tab. */
export function reusablePage<T extends { tabId: number; url: string; requestId: string; lastUsedAt: number; home?: unknown }>(tabs: readonly T[], requestId: string, url: string): T | undefined {
  const normal = (value: string) => { try { return new URL(value).href; } catch { return null; } };
  const target = normal(url);
  if (!target) return undefined;
  return tabs.filter((tab) => tab.requestId === requestId && !tab.home && normal(tab.url) === target)
    .sort((a, b) => b.lastUsedAt - a.lastUsedAt)[0];
}

/** Poll locally, never by spending another model call; no page actions occur here. */
export async function waitForReady(condition: BrowserWaitFor, input: {
  probe: () => Promise<{ ready: boolean; blocked?: boolean }>;
  stopped: () => Promise<string | null>;
  expiresAt: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<BrowserReadiness> {
  const problem = waitForProblem(condition);
  if (problem) throw new Error(problem);
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  const started = now();
  const deadline = Math.min(started + (condition.timeoutMs ?? DEFAULT_READY_TIMEOUT_MS), input.expiresAt);
  let checks = 0;
  const result = (state: BrowserReadiness["state"], reason?: string): BrowserReadiness => ({ state, waitedMs: Math.max(0, now() - started), checks, ...(reason ? { reason } : {}) });
  for (;;) {
    const stopped = await input.stopped();
    if (stopped) return result("cancelled", stopped);
    if (now() >= input.expiresAt) return result("cancelled", "the command expired while waiting; no action was taken");
    const probe = await input.probe();
    checks += 1;
    // Stop and expiry are checked again even when readiness appears at the same moment.
    const ended = await input.stopped();
    if (ended) return result("cancelled", ended);
    if (now() >= input.expiresAt) return result("cancelled", "the command expired while waiting; no action was taken");
    if (probe.blocked) return result("blocked", "the page needs attention");
    if (probe.ready) return result("ready");
    const left = deadline - now();
    if (left <= 0) return result("timeout", "the requested page condition is not ready yet; nothing was submitted or sent");
    await sleep(Math.min(250, left));
  }
}

/** Diagnostics are untrusted numbers, not authority to act. */
export function browserTiming(value: unknown): BrowserTiming | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const timing: BrowserTiming = {};
  for (const key of ["browserMs", "readyWaitMs", "queueMs", "roundTripMs"] as const) {
    if (typeof raw[key] === "number" && Number.isFinite(raw[key]) && raw[key] >= 0 && raw[key] <= 3_600_000) timing[key] = Math.round(raw[key]);
  }
  if (typeof raw.reusedTab === "boolean") timing.reusedTab = raw.reusedTab;
  return Object.keys(timing).length ? timing : undefined;
}

export function browserReadiness(value: unknown): BrowserReadiness | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (!["ready", "timeout", "cancelled", "blocked"].includes(String(raw.state)) || typeof raw.waitedMs !== "number" || !Number.isFinite(raw.waitedMs) || raw.waitedMs < 0 || raw.waitedMs > 3_600_000 || !Number.isSafeInteger(raw.checks) || (raw.checks as number) < 0 || (raw.checks as number) > 10_000) return undefined;
  return { state: raw.state as BrowserReadiness["state"], waitedMs: Math.round(raw.waitedMs), checks: raw.checks as number, ...(typeof raw.reason === "string" ? { reason: raw.reason.slice(0, 500) } : {}) };
}
