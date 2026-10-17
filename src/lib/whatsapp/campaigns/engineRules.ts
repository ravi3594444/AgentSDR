/**
 * The decisions of the WhatsApp campaign sender, kept pure so they can be
 * tested without a database or a send. See docs/whatsapp-campaigns/plan.md.
 */
import { WHATSAPP_RECIPIENT_REFUSAL } from "../refusal";
import type { WeeklyHours } from "@/lib/channels/rules";
import { isWithinWorkingHours, mailboxHoursFromWeekly } from "@/lib/outreach/workingHours";
import { isPlatformNotConnectedError } from "@/lib/platform/credentials";
import { WhatsappSendRefusedError } from "../errors";
import type { WhatsappCampaignStep } from "./contract";

/** Consecutive transient failures after which a lead is marked failed. */
export const MAX_TRANSIENT_ATTEMPTS = 3;
/** A `sending` claim younger than this is a send still in flight (another instance during a deploy), not a crash. */
export const IN_FLIGHT_CLAIM_MS = 5 * 60 * 1000;
/** Back-off after a transient failure. */
export const TRANSIENT_RETRY_MS = 10 * 60 * 1000;

/** True when campaigns may send at `now`: no hours set means any time. */
export function withinCampaignSendingHours(hours: WeeklyHours | null, now: Date): boolean {
  if (!hours) return true;
  return isWithinWorkingHours(mailboxHoursFromWeekly(hours), now);
}

export type NextStepPlan =
  | { status: "in_sequence"; nextSendAt: Date }
  | { status: "completed"; nextSendAt: null };

/** Where a lead stands once step `sentStep` (0-based) went out at `sentAt`. */
export function planAfterSend(steps: readonly WhatsappCampaignStep[], sentStep: number, sentAt: Date): NextStepPlan {
  const next = steps[sentStep + 1];
  if (!next) return { status: "completed", nextSendAt: null };
  const delayHours = Math.max(0, next.delayHours);
  return { status: "in_sequence", nextSendAt: new Date(sentAt.getTime() + delayHours * 3_600_000) };
}

/** Steps may be removed from a campaign after leads were enrolled. */
export function sequenceExhausted(steps: readonly WhatsappCampaignStep[], currentStep: number): boolean {
  return currentStep >= steps.length;
}

export type SendFailureAction =
  /** Release the claim, leave the lead, send nothing more from this number this tick. */
  | { kind: "stop_account" }
  /** Release the claim; first messages are blocked on this number for the rest of the tick. */
  | { kind: "block_first_messages" }
  /** Release the claim, skip this number. */
  | { kind: "skip_account" }
  /** Release the claim, stop the organization's pass. */
  | { kind: "stop_organization" }
  | { kind: "stop_lead"; error: string }
  | { kind: "fail_lead"; error: string }
  | { kind: "retry_later" };

export function classifySendError(error: unknown): SendFailureAction {
  if (isPlatformNotConnectedError(error)) return { kind: "stop_organization" };
  if (error instanceof WhatsappSendRefusedError) {
    switch (error.reason) {
      case "send_gap":
      case "rate_limited":
        return { kind: "stop_account" };
      case "new_chat_limit":
      case "warm_up":
        return { kind: "block_first_messages" };
      case "not_connected":
      case "no_number":
      case "unauthorized":
        return { kind: "skip_account" };
      case "do_not_contact":
        return { kind: "stop_lead", error: "Do Not Contact" };
      case "recipient_unreachable":
        // A definite recipient refusal: fail this lead once, do not retry, and
        // do not let one bad number stop the rest of the campaign.
        return {
          kind: "fail_lead",
          error: WHATSAPP_RECIPIENT_REFUSAL,
        };
      default:
        // A refusal with no reason is a 409/429 we cannot interpret: wait, do not fail the lead.
        if (error.status === 400) return { kind: "fail_lead", error: error.message };
        return { kind: "stop_account" };
    }
  }
  return { kind: "retry_later" };
}

export type RetryPlan =
  | { status: "failed"; attempts: number }
  | { status: "retry"; attempts: number; nextSendAt: Date };

/** A transient failure (Unipile unreachable): back off, and give up after MAX_TRANSIENT_ATTEMPTS. */
export function planTransientRetry(attemptsSoFar: number, now: Date): RetryPlan {
  const attempts = attemptsSoFar + 1;
  if (attempts >= MAX_TRANSIENT_ATTEMPTS) return { status: "failed", attempts };
  return { status: "retry", attempts, nextSendAt: new Date(now.getTime() + TRANSIENT_RETRY_MS) };
}

export function uncertainDeliveryMessage(step: number): string {
  return `Delivery of message ${step + 1} is uncertain — check Messages before resuming`;
}

export function emptyMessageError(step: number): string {
  return `Message ${step + 1} is empty for this lead`;
}
