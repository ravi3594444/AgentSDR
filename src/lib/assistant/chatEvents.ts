/**
 * The chat's longer status reports — a search finished, a plan is ready,
 * outreach started, the research continues — carry their figures as data
 * (`toolResult.data.event`) beside the unchanged text, so the chat can show
 * one compact line of counts and keep the full text one click away.
 *
 * Older chats stored the text only: compactEvent returns null for them and
 * they render exactly as before. Pure; shared by the server that writes the
 * events and the chat that reads them.
 */

import { formatChatDateTime } from "./chatTime";

export type ChatEvent =
  | { kind: "search_report"; jobId: string; ok: boolean; source: string | null; found: number; contactable: number; matching: number | null; judged: number | null; error?: string | null }
  | { kind: "plan_ready"; runId: string | null; leads: number; channels: Record<string, number>; waitingReason: string | null }
  /** A launch's `note`: it started, and its messages are not prepared for sending yet (they are again automatically). */
  | { kind: "outreach_started"; runId: string | null; ok: boolean; launches: { channel: string; added: number; skipped: number; problem: string | null; note?: string | null }[]; automatic: boolean }
  | { kind: "continuation"; n: number; leads: number; target: number; spentUsd: number; capUsd: number; minutesLeft: number };

/** The tool cards that are reports: their counts are a snapshot of when they were written. */
const REPORT_TOOLS = new Set(["report", "daily_summary"]);

/**
 * When a chat report was written, for it to say "As of …" in the
 * organization's zone, and where the current counts are: a report (the run
 * report and Results card, the daily summary, a job's or a request's report
 * event, which carries its report key) is a snapshot, so an early "0
 * contacted" reads as historical. Null for anything that is not a report.
 */
export function reportAsOf(message: { role: string; tool?: string | null; createdAt: string; toolResult?: unknown }, timeZone: string): { label: string; pointer: string } | null {
  const report = message.role === "event"
    ? isRecord(message.toolResult) && typeof message.toolResult.reportKey === "string"
    : message.role === "tool" && REPORT_TOOLS.has(message.tool ?? "");
  const at = report ? formatChatDateTime(message.createdAt, timeZone) : "";
  return at ? { label: `As of ${at}`, pointer: "Current counts are on the plan card and in This request." } : null;
}

export type CompactFigure = { label: string; value: string };
export type CompactEvent = { title: string; figures: CompactFigure[]; tone: "neutral" | "good" | "warning" | "bad"; note: string | null };

const CHANNEL_NAMES: Record<string, string> = { email: "Email", whatsapp: "WhatsApp", linkedin: "LinkedIn", instagram: "Instagram" };
const channelName = (channel: string) => CHANNEL_NAMES[channel] ?? channel;
const usd = (value: number) => `$${value.toFixed(2)}`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/** The event's data, when the message carries any we know how to read. */
export function eventData(toolResult: unknown): ChatEvent | null {
  const event = isRecord(toolResult) && isRecord(toolResult.data) ? toolResult.data.event : null;
  if (!isRecord(event)) return null;
  switch (event.kind) {
    case "search_report":
    case "plan_ready":
    case "outreach_started":
    case "continuation":
      return event as ChatEvent;
    default:
      return null;
  }
}

/** One compact line for a known event, or null (an older text-only event, or one we do not know): render the text as it is. */
export function compactEvent(message: { toolResult?: unknown }): CompactEvent | null {
  const event = eventData(message.toolResult);
  if (!event) return null;
  switch (event.kind) {
    case "search_report": {
      if (!event.ok) return { title: `Search failed${event.source ? ` · ${event.source}` : ""}`, figures: [], tone: "bad", note: event.error ?? null };
      const figures: CompactFigure[] = [
        { label: "found", value: String(num(event.found)) },
        { label: "contactable", value: String(num(event.contactable)) },
      ];
      if (event.matching !== null && event.judged) figures.push({ label: "match", value: `${num(event.matching)} of ${num(event.judged)}` });
      return { title: `Search finished${event.source ? ` · ${event.source}` : ""}`, figures, tone: num(event.contactable) > 0 ? "good" : "warning", note: null };
    }
    case "plan_ready": {
      const figures: CompactFigure[] = [{ label: event.leads === 1 ? "lead" : "leads", value: String(num(event.leads)) }];
      for (const [channel, count] of Object.entries(event.channels).sort((a, b) => b[1] - a[1])) figures.push({ label: channelName(channel), value: String(num(count)) });
      return { title: "Plan ready · press Start below", figures, tone: "neutral", note: event.waitingReason ? `Not started with the rest: ${event.waitingReason}` : "Nothing is sent before Start." };
    }
    case "outreach_started": {
      if (!event.ok) return { title: "Starting the outreach failed", figures: [], tone: "bad", note: null };
      const started = event.launches.filter((launch) => !launch.problem);
      const failed = event.launches.filter((launch) => launch.problem);
      const noted = started.filter((launch) => launch.note);
      const figures = started.map((launch) => ({ label: channelName(launch.channel), value: String(num(launch.added)) }));
      const notes = [
        ...noted.map((launch) => `${channelName(launch.channel)}: ${launch.note}`),
        ...failed.map((launch) => `${channelName(launch.channel)} not started: ${launch.problem}`),
      ];
      return {
        title: `Outreach started · ${event.automatic ? "Automatic replies" : "replies wait in the Inbox"}`,
        figures,
        tone: notes.length ? "warning" : "good",
        note: notes.length ? notes.join("; ") : "Messages go out as each sender's limits and gaps allow.",
      };
    }
    case "continuation":
      return {
        title: `Research continues · round ${num(event.n)}`,
        figures: [
          { label: "leads", value: `${num(event.leads)} of ${num(event.target)}` },
          { label: "spent", value: `${usd(num(event.spentUsd))} of ${usd(num(event.capUsd))}` },
          { label: "left", value: `${Math.max(0, Math.round(num(event.minutesLeft)))} min` },
        ],
        tone: "neutral",
        note: null,
      };
  }
}
