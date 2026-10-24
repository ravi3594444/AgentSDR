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
  /** A launch's `note`: it started, and its messages are not in the sending queue yet (the repair tops it up). */
  | { kind: "outreach_started"; runId: string | null; ok: boolean; launches: { channel: string; added: number; skipped: number; problem: string | null; note?: string | null }[]; automatic: boolean }
  | { kind: "continuation"; n: number; leads: number; target: number | null; spentUsd: number; capUsd: number | null; minutesLeft: number };

/** The tool cards that are reports: their counts are a snapshot of when they were written. */
const REPORT_TOOLS = new Set(["report", "daily_summary", "diagnose_delivery"]);

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
  return at ? { label: `As of ${at}`, pointer: "Current counts are in This request, and on the plan card when there is one." } : null;
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
  if (!event) {
    const result = isRecord(message.toolResult) ? message.toolResult : null;
    const objective = result && typeof result.reportKey === "string" && isRecord(result.data) && isRecord(result.data.objective) ? result.data.objective : null;
    if (!objective) return null;
    const namedTarget = isRecord(objective.named) && objective.named.target === true;
    const finished = objective.stopReason === "target_reached" || objective.stopReason === "finished";
    return {
      title: finished ? "Request finished" : "Research stopped",
      figures: [{ label: "matching leads", value: namedTarget ? `${num(objective.leads)} of ${num(objective.leadTarget)}` : String(num(objective.leads)) }],
      tone: objective.stopReason === "failed" ? "bad" : finished ? "good" : "warning",
      note: "Saved leads are below. Sending and reply status are on the plan card.",
    };
  }
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
          { label: "leads", value: event.target === null ? String(num(event.leads)) : `${num(event.leads)} of ${num(event.target)}` },
          { label: "spent", value: event.capUsd === null ? usd(num(event.spentUsd)) : `${usd(num(event.spentUsd))} of ${usd(num(event.capUsd))}` },
          { label: "left", value: `${Math.max(0, Math.round(num(event.minutesLeft)))} min` },
        ],
        tone: "neutral",
        note: null,
      };
  }
}

/** Short, recorded figures for verbose report tools, including chats saved before this UI change. */
export function compactToolReport(message: { tool?: string | null; toolResult?: unknown }): CompactEvent | null {
  const data = isRecord(message.toolResult) && isRecord(message.toolResult.data) ? message.toolResult.data : null;
  if (!data) return null;
  if (message.tool === "diagnose_delivery" && Array.isArray(data.senders)) {
    const senders = data.senders.filter(isRecord);
    const scoped = (isRecord(data.scope) && data.scope.kind === "run") || typeof data.runStatus === "string";
    const blocked = senders.filter((sender) => Array.isArray(sender.gates) && sender.gates.length > 0);
    const queued = senders.reduce((sum, sender) => sum + num(sender.queued), 0);
    const replies = Array.isArray(data.replies) ? data.replies : [];
    return {
      title: scoped ? "This plan · delivery and replies" : "Sender accounts · delivery snapshot",
      figures: [{ label: "waiting to send", value: String(queued) }, { label: "accounts with a gate", value: String(blocked.length) }, { label: "recent replies checked", value: Array.isArray(data.replies) ? String(replies.length) : "—" }],
      tone: blocked.length ? "warning" : "neutral",
      note: scoped
        ? !Array.isArray(data.replies) ? "This older snapshot checked delivery only. Use a new check to inspect reply processing."
          : blocked.length ? "See the recorded sender gates in Details; inspect the latest reply outcomes below."
            : replies.length ? "No sender gate is recorded for this plan. Reply processing is shown below; an empty send queue does not prove a reply was answered."
              : "No sender gate is recorded for this plan, and no incoming reply is recorded since it started. This does not confirm provider delivery or worker liveness."
        : "Includes distinct current and older account records. A disconnected record does not establish that a particular plan is blocked.",
    };
  }
  if (message.tool !== "report" && message.tool !== "daily_summary") return null;
  const results = isRecord(data.results) ? data.results : isRecord(data.outreach) ? data : null;
  if (!results || !isRecord(results.outreach)) return null;
  const outreach = results.outreach;
  const attention = isRecord(results.attention) ? results.attention : null;
  const measured = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? String(value) : "—";
  const label = isRecord(results.period) && typeof results.period.label === "string" ? results.period.label : "recorded results";
  return {
    title: message.tool === "daily_summary" ? `Daily summary${typeof data.day === "string" ? ` · ${data.day}` : ""}` : `Results · ${label}`,
    figures: [
      { label: "contacted", value: measured(outreach.peopleContacted) },
      { label: "people replied", value: measured(outreach.peopleReplied) },
      { label: "interested", value: measured(outreach.interested) },
      { label: "need you", value: attention ? String(num(attention.repliesWaiting) + num(attention.openDecisions)) : "—" },
    ],
    tone: attention && num(attention.repliesWaiting) + num(attention.openDecisions) > 0 ? "warning" : "neutral",
    note: isRecord(results.scope) && typeof results.scope.label === "string" ? results.scope.label : null,
  };
}
