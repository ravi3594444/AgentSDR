import { displayTime } from "@/lib/assistant/displayTime";
import type { WorkingHours } from "./schema";
import { mailboxAtDailyLimit } from "./sendRules";

export type DeliveryGate = { code: string; reason: string };

/**
 * The same persisted gates as the email scheduler, with no guessed provider
 * state. Sending is always on: there is no hours gate (a mailbox's time zone
 * only sets the day its daily counter belongs to). Times are written in
 * `displayTimeZone` (the organization's; UTC when not given). The "queue"
 * gate is technical: an empty queue is normal while every lead waits for a
 * reply or a follow-up that is not due (runEvidence.ts keeps it in details).
 */
export function emailDeliveryGates(
  mailbox: {
    status: string;
    provider: string;
    unipileAccountId: string | null;
    todayEmailsSent: number;
    dailySendLimit: number;
    sendCounterResetAt: Date | null;
    nextEmailTime: Date | null;
    workingHours: Pick<WorkingHours, "timezone">;
  },
  input: {
    providerConnected: boolean;
    paused: boolean;
    activeQueue: number;
    now: Date;
    displayTimeZone?: string;
  },
): DeliveryGate[] {
  const gates: DeliveryGate[] = [];
  const add = (code: string, reason: string) => gates.push({ code, reason });
  if (input.paused)
    add(
      "paused",
      "Email outbound is paused by the server's migration controls",
    );
  if (mailbox.status !== "connected")
    add("mailbox", `Mailbox status is ${mailbox.status}`);
  if (!input.providerConnected)
    add("provider", `${mailbox.provider} sending integration is disconnected`);
  if (mailbox.provider === "unipile" && !mailbox.unipileAccountId)
    add("account", "Mailbox has no linked Unipile account ID");
  if (mailbox.nextEmailTime && mailbox.nextEmailTime > input.now)
    add(
      "gap",
      `Pausing between sends until ${displayTime(mailbox.nextEmailTime, input.now, input.displayTimeZone ?? "UTC", { seconds: true })}`,
    );
  if (mailboxAtDailyLimit(mailbox, input.now))
    add(
      "capacity",
      `Mailbox has used its daily limit of ${mailbox.dailySendLimit} (${mailbox.workingHours.timezone})`,
    );
  if (!input.activeQueue)
    add(
      "queue",
      "No email of an active campaign is in this mailbox's send queue",
    );
  return gates;
}
