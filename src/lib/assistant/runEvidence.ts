/**
 * What a plan card may claim, from records only: who authorized the plan to
 * send and how, and for each sending account the gates recorded right now
 * and the earliest time it may send. A sender with no recorded gate is not
 * proof that a worker is running, and a time zone is always the one
 * configured for the sender, never inferred from where leads are. Pure;
 * deliveryDiagnostics.server.ts and http.server.ts read the rows.
 */
import { addDays, set as setTime } from "date-fns";
import { fromZonedTime, toZonedTime } from "date-fns-tz";
import type { WorkingHours } from "@/lib/outreach/schema";
import { isWithinWorkingHours, nextWindowStart } from "@/lib/outreach/workingHours";
import { NEW_CHAT_WINDOW_MS, secondsUntilNextSend, warmUpEndsAt, type WhatsappGuardrails } from "@/lib/whatsapp/guardrails";

export type RunAuthorization = {
  kind: "none" | "start" | "request" | "autonomous";
  text: string;
  /** Who it was authorized by, and when (ISO), for the card to format locally. */
  by: string | null;
  at: string | null;
  /** A request approval's end (ISO): it covers the request's later plans until then. */
  until: string | null;
};

export type RunAuthorizationInput = {
  status: string;
  approvedAt: Date | null;
  approverName: string | null;
  /** Started by the chat's Autonomous mode (plan.autonomous). */
  autonomous: boolean;
  /** This run's own request approval (plan.requestApproval), if the owner approved the rest of the request with it. */
  ownApproval: { expiresAt: string } | null;
  /** Another plan's request approval that this run started under (recorded on the run as plan.startedUnder). */
  coveringApproval: { approverName: string | null; approvedAt: string; expiresAt: string } | null;
  /** No marker, but a request approval was open when it started: it may have been either, so neither is claimed. */
  mayBeUnderApproval?: boolean;
  threadAutonomous: boolean;
};

const NOT_STARTED = new Set(["proposed", "cancelled"]);

/** Who authorized this plan to send, in plain words; never "started" for a plan that has not. */
export function runAuthorization(input: RunAuthorizationInput): RunAuthorization {
  const who = input.approverName?.trim() || "an owner";
  const at = input.approvedAt?.toISOString() ?? null;
  if (NOT_STARTED.has(input.status) || (input.status === "failed" && !input.approvedAt)) {
    if (input.status === "cancelled") return { kind: "none", text: "Discarded before it started; nothing was sent.", by: null, at: null, until: null };
    if (input.status === "failed") return { kind: "none", text: "It did not start; nothing was sent.", by: null, at: null, until: null };
    return {
      kind: "none",
      text: input.threadAutonomous
        ? "Not started: nothing is sent until you press Start. Autonomous mode is on in this chat, but it starts plans only as they are prepared, within its daily caps; it did not start this one."
        : "Not started: nothing is sent until you press Start.",
      by: null,
      at: null,
      until: null,
    };
  }
  if (input.autonomous) {
    return { kind: "autonomous", text: `Started on its own by this chat's Autonomous mode, in ${who}'s name.`, by: input.approverName, at, until: null };
  }
  if (input.coveringApproval) {
    const by = input.coveringApproval.approverName?.trim() || "an owner";
    return { kind: "request", text: `Started on its own under ${by}'s approval of this request.`, by: input.coveringApproval.approverName, at, until: input.coveringApproval.expiresAt };
  }
  if (input.ownApproval) {
    return { kind: "request", text: `Started by ${who}, who also approved the rest of this request.`, by: input.approverName, at, until: input.ownApproval.expiresAt };
  }
  if (input.mayBeUnderApproval) return { kind: "start", text: `Started in ${who}'s name.`, by: input.approverName, at, until: null };
  return { kind: "start", text: `Started by ${who} with Start.`, by: input.approverName, at, until: null };
}

/** A request approval that was open when a plan started: recorded before its start and still valid then. */
export function coveringApproval<T extends { approvedAt: string; expiresAt: string }>(startedAt: Date | null, approvals: readonly T[]): T | null {
  if (!startedAt) return null;
  const time = startedAt.getTime();
  return approvals
    .filter((approval) => Date.parse(approval.approvedAt) <= time && time <= Date.parse(approval.expiresAt))
    .sort((a, b) => Date.parse(b.approvedAt) - Date.parse(a.approvedAt))[0] ?? null;
}

export type SenderStatus = {
  channel: "email" | "whatsapp" | "instagram";
  account: string;
  /** The IANA time zone of the sender's configured sending hours; null when no hours are set (any time). */
  timezone: string | null;
  /** Gates recorded right now. None is not proof that a worker is running. */
  gates: string[];
  /** The earliest time every recorded gate allows a send, when it can be worked out. */
  nextAt: string | null;
  queued: number | null;
  note: string | null;
};

function latest(dates: (Date | null)[]): Date | null {
  return dates.reduce<Date | null>((max, date) => (date && (!max || date > max) ? date : max), null);
}

/** The start of the next sending window on another local day: after a daily limit is used. */
function nextDayWindow(hours: WorkingHours, now: Date): Date | null {
  try {
    const midnight = fromZonedTime(setTime(addDays(toZonedTime(now, hours.timezone), 1), { hours: 0, minutes: 0, seconds: 0, milliseconds: 0 }), hours.timezone);
    return isWithinWorkingHours(hours, midnight) ? midnight : nextWindowStart(hours, midnight);
  } catch {
    return null;
  }
}

/** One mailbox, from the email scheduler's own gates (emailDeliveryGates). */
export function emailSenderStatus(input: {
  mailbox: string;
  workingHours: WorkingHours;
  nextEmailTime: Date | null;
  gates: { code: string; reason: string }[];
  queued: number;
  now: Date;
}): SenderStatus {
  const codes = new Set(input.gates.map((gate) => gate.code));
  // Disconnected, paused or unlinked: no time can be promised.
  const open = ["paused", "mailbox", "provider", "account"].some((code) => codes.has(code));
  const next = open ? null : latest([
    codes.has("hours") ? nextWindowStart(input.workingHours, input.now) : null,
    codes.has("gap") ? input.nextEmailTime : null,
    codes.has("capacity") ? nextDayWindow(input.workingHours, input.now) : null,
  ]);
  return {
    channel: "email",
    account: input.mailbox,
    timezone: input.workingHours.timezone,
    gates: input.gates.map((gate) => gate.reason),
    nextAt: next?.toISOString() ?? null,
    queued: input.queued,
    note: null,
  };
}

/** One WhatsApp number, from the same rules send.ts enforces under its lock. */
export function whatsappSenderStatus(input: {
  account: string;
  status: string;
  unipileConnected: boolean;
  paused: boolean;
  sendingHours: WorkingHours | null;
  guardrails: WhatsappGuardrails;
  connectedAt: Date | null;
  lastSentAt: Date | null;
  newChatsInWindow: number;
  oldestNewChatAt: Date | null;
  queued: number;
  now: Date;
}): SenderStatus {
  const { guardrails, now } = input;
  const gates: string[] = [];
  let open = false;
  const times: (Date | null)[] = [];
  if (!input.unipileConnected) { gates.push("Unipile is disconnected"); open = true; }
  if (input.status !== "connected") { gates.push(`The number is ${input.status}`); open = true; }
  if (input.paused) { gates.push("WhatsApp outbound is paused by the server's migration controls"); open = true; }
  if (input.sendingHours && !isWithinWorkingHours(input.sendingHours, now)) {
    gates.push(`Outside campaign sending hours (${input.sendingHours.timezone})`);
    times.push(nextWindowStart(input.sendingHours, now));
  }
  const warmUp = warmUpEndsAt(input.connectedAt, now, guardrails.warmUpHours);
  if (!input.connectedAt && guardrails.warmUpHours > 0) {
    gates.push("Not seen connected yet, so it cannot start new chats");
    open = true;
  } else if (warmUp) {
    gates.push(`New chats wait for the ${guardrails.warmUpHours}-hour warm-up after linking`);
    times.push(warmUp);
  }
  if (input.newChatsInWindow >= guardrails.newChatsPerDay) {
    gates.push(`${input.newChatsInWindow} of ${guardrails.newChatsPerDay} new chats used in the last 24 hours`);
    times.push(input.oldestNewChatAt ? new Date(input.oldestNewChatAt.getTime() + NEW_CHAT_WINDOW_MS) : null);
  }
  const wait = secondsUntilNextSend(input.lastSentAt, now, guardrails.minSecondsBetweenSends);
  if (wait > 0) times.push(new Date(now.getTime() + wait * 1000));
  const next = open || times.some((time) => time === null) ? null : latest(times);
  return {
    channel: "whatsapp",
    account: input.account,
    timezone: input.sendingHours?.timezone ?? null,
    gates,
    nextAt: next?.toISOString() ?? null,
    queued: input.queued,
    note: input.newChatsInWindow >= guardrails.newChatsPerDay || warmUp ? "Follow-ups in chats already open are not held by the new-chat limits." : null,
  };
}
