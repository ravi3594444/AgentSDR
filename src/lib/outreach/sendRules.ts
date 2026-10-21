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
