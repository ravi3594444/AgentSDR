import type { OutreachLeadStatus, WorkingHours } from "./schema";
import { isSameLocalDay } from "./workingHours";

/** Pure rules of the email send tick (scheduler.ts), unit-tested on their own. */

/**
 * The error a step claim (outreach_emails row) gets when Person-global Do
 * Not Contact stops it before the provider is called: a definite non-send,
 * so the daily lead limit does not count it (dailyLeadLimit.server.ts). Every
 * other failed claim may have been delivered and stays counted.
 */
export const EMAIL_DNC_BLOCKED_ERROR = "Blocked by Person-global Do Not Contact policy before provider submission";

/** True when the mailbox has already sent its daily limit today (in its own timezone). */
export function mailboxAtDailyLimit(
  mailbox: { todayEmailsSent: number; dailySendLimit: number; sendCounterResetAt: Date | null; workingHours: Pick<WorkingHours, "timezone"> },
  now: Date,
): boolean {
  if (!isSameLocalDay(mailbox.sendCounterResetAt, now, mailbox.workingHours.timezone)) return false;
  return mailbox.todayEmailsSent >= mailbox.dailySendLimit;
}

const IN_SEQUENCE: readonly OutreachLeadStatus[] = ["pending", "initial_sent", "in_follow_up"];

/**
 * Whether a lead's next step may be sent at `now`: a first email (pending)
 * unless a time was set for it, a follow-up once its time has come. The tick
 * checks it after claiming a queue row, so a row left from before the lead
 * advanced (a rebuild that overlapped a send) never sends a follow-up early.
 */
export function leadDueNow(lead: { sequenceStatus: OutreachLeadStatus; nextSendAt: Date | null }, now: Date): boolean {
  if (!IN_SEQUENCE.includes(lead.sequenceStatus)) return false;
  if (!lead.nextSendAt) return lead.sequenceStatus === "pending";
  return lead.nextSendAt.getTime() <= now.getTime();
}

/**
 * How many more rows a top-up may add to a mailbox's queue: its daily
 * limit less what it sent today and what is already queued. Null when its
 * counter is from an earlier local day (the caller resets it first, once a
 * day, as the build does): topping up against a stale one could pass the
 * daily limit.
 */
export function topUpRoom(
  mailbox: { todayEmailsSent: number; dailySendLimit: number; sendCounterResetAt: Date | null; workingHours: Pick<WorkingHours, "timezone"> },
  queued: number,
  now: Date,
): number | null {
  if (!isSameLocalDay(mailbox.sendCounterResetAt, now, mailbox.workingHours.timezone)) return null;
  return Math.max(0, mailbox.dailySendLimit - mailbox.todayEmailsSent - queued);
}

/**
 * Which waiting first emails to queue, in order: someone automated outreach
 * already reached on another channel takes no place under the daily lead
 * limit; everyone else takes one of today's remaining `places`. At most
 * `capacity` in all. The claim (newLeadAllowance) still decides; this keeps
 * the queue from holding first emails the limit would refuse.
 */
export function newLeadsToQueue(candidates: readonly { id: string; contacted: boolean }[], input: { places: number; capacity: number }): string[] {
  const picked: string[] = [];
  let places = Math.max(0, input.places);
  for (const candidate of candidates) {
    if (picked.length >= input.capacity) break;
    if (!candidate.contacted) {
      if (places <= 0) continue;
      places -= 1;
    }
    picked.push(candidate.id);
  }
  return picked;
}

/**
 * The lead after a step was delivered: the next step and when it is due, or
 * sequence_completed after the last one. sendNextStep applies it only while
 * the lead is still in the sequence; a reply, bounce or unsubscribe that
 * landed during the send keeps its status.
 */
export function leadAfterSend(
  lead: { currentStep: number },
  sequenceLength: number,
  waitDaysOfNextStep: number | null,
  now: Date,
) {
  const hasNext = lead.currentStep + 1 < sequenceLength && waitDaysOfNextStep !== null;
  return {
    currentStep: lead.currentStep + 1,
    sequenceStatus: (hasNext ? (lead.currentStep === 0 ? "initial_sent" : "in_follow_up") : "sequence_completed") as OutreachLeadStatus,
    nextSendAt: hasNext ? new Date(now.getTime() + waitDaysOfNextStep! * 24 * 60 * 60 * 1000) : null,
  };
}
