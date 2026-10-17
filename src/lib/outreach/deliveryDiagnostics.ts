import type { WorkingHours } from "./schema";
import { mailboxAtDailyLimit } from "./sendRules";
import { isWithinWorkingHours } from "./workingHours";

export type DeliveryGate = { code: string; reason: string };

/** The same persisted gates as the email scheduler, with no guessed provider state. */
export function emailDeliveryGates(
  mailbox: {
    status: string;
    provider: string;
    unipileAccountId: string | null;
    todayEmailsSent: number;
    dailySendLimit: number;
    sendCounterResetAt: Date | null;
    nextEmailTime: Date | null;
    workingHours: WorkingHours;
  },
  input: {
    providerConnected: boolean;
    paused: boolean;
    activeQueue: number;
    now: Date;
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
  if (!isWithinWorkingHours(mailbox.workingHours, input.now))
    add(
      "hours",
      `Outside this mailbox's sending hours (${mailbox.workingHours.timezone})`,
    );
  if (mailbox.nextEmailTime && mailbox.nextEmailTime > input.now)
    add(
      "gap",
      `Next send is allowed at ${mailbox.nextEmailTime.toISOString()}`,
    );
  if (mailboxAtDailyLimit(mailbox, input.now))
    add(
      "capacity",
      `Mailbox has used its daily limit of ${mailbox.dailySendLimit} (${mailbox.workingHours.timezone})`,
    );
  if (!input.activeQueue)
    add(
      "queue",
      "No send is in this mailbox's queue for an active campaign; the send tick does not build the queue",
    );
  return gates;
}
