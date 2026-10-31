/** Browser work is activity, not an extra lead search. No outcome is inferred from a click. */
type Message = { tool: string | null; status: string | null; toolResult: { data?: Record<string, unknown> } | null };

export function isConnectedBrowserTool(tool: string | null): boolean {
  return tool === "browser_connection" || tool === "browser_task" || tool === "check_browser_routes" || tool?.startsWith("browser_tab_") === true;
}

export function browserActivity(messages: readonly Message[]): { label: string; goal: string | null; waiting: boolean } | null {
  const browser = messages.filter((message) => isConnectedBrowserTool(message.tool));
  if (!browser.length) return null;
  let goal: string | null = null;
  let site: string | null = null;
  for (const message of browser) {
    const data = message.toolResult?.data;
    const grant = data?.grant && typeof data.grant === "object" ? data.grant as Record<string, unknown> : null;
    if (typeof grant?.goal === "string" && grant.goal.trim()) goal = grant.goal.trim();
    if (typeof data?.url === "string") {
      try {
        const host = new URL(data.url).hostname.replace(/^www\./, "");
        site = host === "web.whatsapp.com" ? "WhatsApp" : host;
      } catch { /* A malformed diagnostic URL is not displayed. */ }
    }
  }
  const last = browser.at(-1)?.toolResult?.data?.readiness;
  const waiting = Boolean(last && typeof last === "object" && (last as Record<string, unknown>).state === "timeout");
  return { label: site ? `Chrome · ${site}` : "Chrome", goal, waiting };
}

/** The phases overlap: never add them and present that as total elapsed time. */
export function browserTimingDetails(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const timing = value as Record<string, unknown>;
  const labels = { authorizationMs: "Task authorization", queueMs: "Queue", browserMs: "Browser", readyWaitMs: "Readiness wait (within browser time)", roundTripMs: "Tool round trip (includes queue and browser)" };
  const parts: string[] = [];
  for (const [key, label] of Object.entries(labels)) {
    const ms = timing[key];
    if (typeof ms === "number" && Number.isFinite(ms) && ms >= 0 && ms <= 3_600_000) parts.push(`${label}: ${ms < 1_000 ? `${Math.round(ms)} ms` : `${(ms / 1_000).toFixed(1)} s`}`);
  }
  return parts.length ? parts.join(" · ") : null;
}
