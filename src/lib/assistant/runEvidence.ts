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
import { isWindowOpenFrom, isWithinWorkingHours, mailboxHoursFromWeekly, nextWindowStart } from "@/lib/outreach/workingHours";
import { formatWorkingHoursSummary, hasWorkingHoursConfigured, isWithinWorkingHours as isWithinLinkedinHours, parseHHmmToMinutes, parseWorkDays, type WorkingHoursFields } from "@/lib/linkedin/workingHours";
import { NEW_CHAT_WINDOW_MS, secondsUntilNextSend, warmUpEndsAt, type WhatsappGuardrails } from "@/lib/whatsapp/guardrails";
import { everyMinutes, latestDueSlot, nextSlotAt } from "@/lib/scheduler/slots";
import { displayTime } from "./displayTime";

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
  // A run fails only when no channel launched, so nothing was sent, whoever pressed Start.
  if (NOT_STARTED.has(input.status) || input.status === "failed") {
    if (input.status === "cancelled") return { kind: "none", text: "Not started; nothing was sent from it.", by: null, at: null, until: null };
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
  channel: "email" | "whatsapp" | "instagram" | "linkedin";
  account: string;
  /** The IANA time zone of the sender's configured sending hours; null when no hours are set (any time). */
  timezone: string | null;
  /** Gates recorded right now. None is not proof that a worker is running. */
  gates: string[];
  /** The earliest time every recorded gate allows a send, when it can be worked out. */
  nextAt: string | null;
  queued: number | null;
  note: string | null;
  /** The sender's limit and how much of it is used, in plain words; null when not worked out for this channel. */
  limits: string | null;
  /** Further facts, one sentence each: the next scheduled check, when capacity frees up, the last time it was held back and why. */
  details: string[];
};

function latest(dates: (Date | null)[]): Date | null {
  return dates.reduce<Date | null>((max, date) => (date && (!max || date > max) ? date : max), null);
}

/** The start of the next sending window on another local day: after a daily limit is used. */
function nextDayWindow(hours: WorkingHours, now: Date): Date | null {
  try {
    const midnight = fromZonedTime(setTime(addDays(toZonedTime(now, hours.timezone), 1), { hours: 0, minutes: 0, seconds: 0, milliseconds: 0 }), hours.timezone);
    return isWindowOpenFrom(hours, midnight) ? midnight : nextWindowStart(hours, midnight);
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
    limits: null,
    details: [],
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
  /** When each chat this number started in the last 24 hours was created, oldest first, from every campaign and manual send. */
  newChatTimes: Date[];
  /** Leads waiting for their next message (a first message or a follow-up). */
  queued: number;
  /** Of those, the leads still waiting for a first message: the ones a new chat is needed for. */
  firstMessagesQueued?: number;
  /** Why the campaign sender last held this number back (whatsapp_accounts.last_refusal), cleared by its next accepted send. */
  lastRefusal?: { reason: string; at: Date } | null;
  /** The zone times are written in (the organization's). */
  displayTimeZone?: string;
  now: Date;
}): SenderStatus {
  const { guardrails, now } = input;
  const zone = input.displayTimeZone ?? "UTC";
  const details: string[] = [];
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
  const newChats = input.newChatTimes.length;
  const full = newChats >= guardrails.newChatsPerDay;
  if (full) {
    gates.push(`${newChats} of ${guardrails.newChatsPerDay} new chats used in the last 24 hours`);
    // send.ts allows a new chat once the count is under the limit: after this many have left the window.
    const freedBy = input.newChatTimes[newChats - guardrails.newChatsPerDay];
    const frees = freedBy ? new Date(freedBy.getTime() + NEW_CHAT_WINDOW_MS) : null;
    times.push(frees);
    const leaving = newChats - guardrails.newChatsPerDay + 1;
    if (frees) details.push(`Next new chat possible from ${displayTime(frees, now, zone)}, when ${leaving === 1 ? "the oldest counted chat is" : `the ${leaving} oldest counted chats are`} 24 hours old.`);
  }
  const wait = secondsUntilNextSend(input.lastSentAt, now, guardrails.minSecondsBetweenSends);
  if (wait > 0) times.push(new Date(now.getTime() + wait * 1000));
  const next = open || times.some((time) => time === null) ? null : latest(times);
  if (input.lastRefusal) details.push(`Last held back at ${displayTime(input.lastRefusal.at, now, zone, { seconds: true })}: ${input.lastRefusal.reason}.`);
  const available = Math.max(0, guardrails.newChatsPerDay - newChats);
  const firsts = input.firstMessagesQueued;
  return {
    channel: "whatsapp",
    account: input.account,
    timezone: input.sendingHours?.timezone ?? null,
    gates,
    nextAt: next?.toISOString() ?? null,
    queued: input.queued,
    note: full || warmUp ? "Follow-ups in chats already open are not held by the new-chat limits." : null,
    limits: `New chats per 24 hours, per number: ${newChats} of ${guardrails.newChatsPerDay} used, ${available} available${firsts === undefined ? "" : `; ${firsts} ${firsts === 1 ? "lead waits" : "leads wait"} for a first message`}. `
      + "Every campaign on this number shares the count. Each chat counts for 24 hours from when it started (no reset at midnight); replies in chats already open are not limited by it.",
    details,
  };
}

/**
 * When a LinkedIn account's working hours next open: the same window the
 * LinkedIn engine checks (runOutreach: the account's own hours, else the
 * organization's), as weekly hours. Null when it runs any time.
 */
function linkedinNextWindow(hours: WorkingHoursFields, now: Date): Date | null {
  if (!hasWorkingHoursConfigured(hours)) return null;
  const start = hours.workStartTime ?? "09:00";
  const end = hours.workEndTime ?? "18:00";
  if (parseHHmmToMinutes(start) === parseHHmmToMinutes(end)) return null;
  // Probe minute by minute from the next window start the shared helper gives,
  // since its end is inclusive where the engine's is exclusive.
  const weekly = mailboxHoursFromWeekly({ timezone: hours.workTimezone!, days: parseWorkDays(hours.workDays), start, end });
  const next = nextWindowStart(weekly, now);
  return next && isWithinLinkedinHours(hours, next) ? next : null;
}

/** One LinkedIn account of a plan, from the same checks the LinkedIn engine (runOutreach, sendInvitations) makes. */
export function linkedinSenderStatus(input: {
  account: string;
  status: string;
  limitReached: boolean;
  unipileConnected: boolean;
  paused: boolean;
  hours: WorkingHoursFields;
  nextAllowedRun: Date | null;
  invitationsToday: number;
  invitationsPerDay: number;
  /** The start of the next day the engine counts invitations by. */
  nextDayStart: Date;
  queued: number;
  /** How often the LinkedIn engine's scheduled run looks at accounts (linkedin-run-outreach, every 30 minutes on the UTC clock); null when it is not scheduled. */
  checkEveryMinutes?: number | null;
  /** The organization's next daily reset (its daily rollover), which clears LinkedIn's invitation-limit flag. */
  limitResetsAt?: Date | null;
  /** The zone times are written in (the organization's). */
  displayTimeZone?: string;
  now: Date;
}): SenderStatus {
  const { now } = input;
  const zone = input.displayTimeZone ?? "UTC";
  const gates: string[] = [];
  const details: string[] = [];
  let open = false;
  const times: (Date | null)[] = [];
  const schedule = input.checkEveryMinutes ? everyMinutes(input.checkEveryMinutes) : null;
  if (!input.unipileConnected) { gates.push("Unipile is disconnected"); open = true; }
  if (input.status !== "CONNECTED") { gates.push(`The account is ${input.status.toLowerCase().replace(/_/g, " ")}`); open = true; }
  if (input.limitReached) {
    // Cleared by the organization's daily rollover (resetDailyLimits), whatever LinkedIn says then.
    if (input.limitResetsAt) {
      gates.push(`LinkedIn reported this account's invitation limit; the flag is cleared at the organization's daily reset, ${displayTime(input.limitResetsAt, now, zone)}`);
      // The first time after the reset its working hours allow.
      const reset = input.limitResetsAt;
      times.push(hasWorkingHoursConfigured(input.hours) && !isWithinLinkedinHours(input.hours, reset) ? linkedinNextWindow(input.hours, reset) : reset);
    } else {
      gates.push("LinkedIn reported this account's invitation limit; the flag is cleared at the organization's daily reset");
      open = true;
    }
  }
  if (input.paused) { gates.push("LinkedIn outbound is paused by the server's migration controls"); open = true; }
  const configured = hasWorkingHoursConfigured(input.hours);
  if (configured && !isWithinLinkedinHours(input.hours, now)) {
    gates.push(`Outside working hours (${formatWorkingHoursSummary(input.hours)})`);
    times.push(linkedinNextWindow(input.hours, now));
  }
  // The rest between runs (runOutreach sets it after each run): the account is only looked at again by a scheduled check after it.
  const cooldownEnds = input.nextAllowedRun;
  if (cooldownEnds && cooldownEnds > now) {
    gates.push(`Between LinkedIn runs until ${displayTime(cooldownEnds, now, zone, { seconds: true })}`);
    times.push(cooldownEnds);
  } else if (cooldownEnds && schedule && cooldownEnds > latestDueSlot(schedule, now)) {
    // The rest ended after the last check: nothing runs for it before the next one.
    const check = nextSlotAt(schedule, now);
    gates.push(`Waiting for the next scheduled check at ${displayTime(check, now, zone)}`);
    times.push(check);
  }
  if (input.invitationsToday >= input.invitationsPerDay) {
    gates.push(`${input.invitationsToday} of ${input.invitationsPerDay} invitations sent today`);
    const tomorrow = input.nextDayStart;
    times.push(configured && !isWithinLinkedinHours(input.hours, tomorrow) ? linkedinNextWindow(input.hours, tomorrow) : tomorrow);
  }
  const allowed = open || times.some((time) => time === null) ? null : latest(times);
  // The engine sends only when a scheduled check finds the account free: the first check at or after every gate's end.
  const next = allowed && schedule ? nextSlotAt(schedule, allowed) : allowed;
  if (schedule) details.push(`Next scheduled check ${displayTime(nextSlotAt(schedule, cooldownEnds && cooldownEnds > now ? cooldownEnds : now), now, zone)} (checks run every ${input.checkEveryMinutes} minutes).`);
  const left = Math.max(0, input.invitationsPerDay - input.invitationsToday);
  return {
    channel: "linkedin",
    account: input.account,
    timezone: configured ? input.hours.workTimezone : null,
    gates,
    nextAt: next?.toISOString() ?? null,
    queued: input.queued,
    note: input.invitationsToday >= input.invitationsPerDay ? "Follow-up messages to accepted invitations are not held by the invitation limit." : null,
    limits: `Invitations: ${input.invitationsToday} of ${input.invitationsPerDay} sent today, ${left} left. Working hours: ${configured ? formatWorkingHoursSummary(input.hours) : "any time (none set)"}.`,
    details,
  };
}
