import { PLATFORM_SETTINGS_LABEL } from "@/lib/platform/catalog";
import type { MailboxProvider, SequenceStep } from "./schema";

/**
 * What an email campaign must have before it may send, checked on the
 * server whenever a campaign becomes active (launch or resume) and whenever
 * its sequence is saved. The wizard and the detail page check the same
 * things to disable their buttons, but a disabled button is not a guard: a
 * direct PATCH, a stale tab or a mailbox disconnected since the page loaded
 * would otherwise start a campaign that sends nothing, or sends an empty
 * email. Pure, so the rules are unit-tested.
 */

export const MAX_SEQUENCE_STEPS = 20;
export const MAX_WAIT_DAYS = 365;

/**
 * The sequence as it will be stored (each step renumbered 1..n, which the
 * per-lead send claim keys on), or the first reason it cannot be used.
 */
export function parseSequence(value: unknown): { ok: true; sequence: SequenceStep[] } | { ok: false; error: string } {
  if (!Array.isArray(value)) return { ok: false, error: "sequence must be a list of steps" };
  if (value.length === 0) return { ok: false, error: "Add at least one email to the sequence." };
  if (value.length > MAX_SEQUENCE_STEPS) return { ok: false, error: `A sequence can have at most ${MAX_SEQUENCE_STEPS} emails.` };
  const sequence: SequenceStep[] = [];
  for (const [index, raw] of value.entries()) {
    const label = index === 0 ? "The initial email" : `Email step ${index + 1}`;
    if (!raw || typeof raw !== "object") return { ok: false, error: `${label} is not a valid step.` };
    const step = raw as Record<string, unknown>;
    const subject = typeof step.subject === "string" ? step.subject : "";
    const body = typeof step.body === "string" ? step.body : "";
    const waitDays = index === 0 ? 0 : step.waitDays;
    if (index === 0 && !subject.trim()) return { ok: false, error: "The initial email needs a subject." };
    if (!body.trim()) return { ok: false, error: `${label} needs a message body.` };
    if (typeof waitDays !== "number" || !Number.isInteger(waitDays) || waitDays < 0 || waitDays > MAX_WAIT_DAYS) {
      return { ok: false, error: `${label} needs a wait of 0 to ${MAX_WAIT_DAYS} whole days.` };
    }
    sequence.push({ stepNumber: index + 1, subject, body, waitDays });
  }
  return { ok: true, sequence };
}

export type EmailLaunchFacts = {
  sequence: unknown;
  /** Connected mailboxes, by what sends for them. */
  connectedMailboxes: Record<MailboxProvider, number>;
  googleConnected: boolean;
  unipileConnected: boolean;
  /** Enrolled leads that can still receive a step: not replied, bounced, suppressed or finished, and with an email. */
  usableLeads: number;
};

/**
 * Every reason the campaign cannot go active, in the order a person would fix
 * them; empty when it can. It needs one connected mailbox whose provider is
 * connected too: a Google Workspace address, or an inbox linked in Unipile.
 */
export function emailLaunchProblems(facts: EmailLaunchFacts): string[] {
  const problems: string[] = [];
  const { google, unipile } = facts.connectedMailboxes;
  const sending = (facts.googleConnected ? google : 0) + (facts.unipileConnected ? unipile : 0);
  if (google + unipile === 0) {
    problems.push("Connect at least one sending mailbox in Settings → Email → Mailboxes: a Google Workspace address, or an inbox linked in Unipile.");
  } else if (sending === 0) {
    if (google > 0) problems.push(`Connect Google Workspace in ${PLATFORM_SETTINGS_LABEL.google}.`);
    if (unipile > 0) problems.push(`Connect Unipile in ${PLATFORM_SETTINGS_LABEL.unipile}.`);
  }
  const sequence = parseSequence(facts.sequence);
  if (!sequence.ok) problems.push(sequence.error);
  if (facts.usableLeads === 0) problems.push("Add leads with an email address that have not replied, bounced or unsubscribed.");
  return problems;
}
