import {
  describeOpening,
  describeWorkingHours,
  workingWindow,
} from "@/lib/channels/sendingWindow";
import { emailDeliveryGates } from "@/lib/outreach/deliveryDiagnostics";
import { isSameLocalDay } from "@/lib/outreach/workingHours";
import type { ChannelSending } from "./results";

type MailboxSnapshot = Parameters<typeof emailDeliveryGates>[0] & {
  activeQueue: number;
  providerConnected: boolean;
};

/** Capacity is in each mailbox's local day, including a counter not reset yet. */
export function mailboxDailyRoom(
  mailbox: Parameters<typeof emailDeliveryGates>[0],
  now: Date,
): number {
  const used = isSameLocalDay(
    mailbox.sendCounterResetAt,
    now,
    mailbox.workingHours.timezone,
  )
    ? mailbox.todayEmailsSent
    : 0;
  return Math.max(0, mailbox.dailySendLimit - used);
}

/** A sender must pass its own gates; capacity from another mailbox cannot help it. */
export function emailSendingStatus(
  mailboxes: readonly MailboxSnapshot[],
  input: { now: Date; paused: boolean },
): ChannelSending {
  const snapshots = mailboxes.map((mailbox) => ({
    mailbox,
    gates: emailDeliveryGates(mailbox, {
      ...input,
      activeQueue: mailbox.activeQueue,
      providerConnected: mailbox.providerConnected,
    }),
    window: workingWindow(mailbox.workingHours, input.now),
  }));
  const connected = snapshots.filter(
    ({ gates }) =>
      !gates.some((g) => ["mailbox", "provider", "account"].includes(g.code)),
  );
  const queued = connected.filter(({ mailbox }) => mailbox.activeQueue > 0);
  let blockedBy: ChannelSending["blockedBy"] = null;
  if (input.paused) blockedBy = "paused";
  else if (!connected.length) blockedBy = "no_sender";
  else if (!queued.length)
    blockedBy = mailboxes.some((m) => m.activeQueue > 0)
      ? "sender_checks"
      : "nothing_queued";
  else if (!queued.some(({ gates }) => gates.length === 0)) {
    const allHave = (code: string) =>
      queued.every(({ gates }) => gates.some((g) => g.code === code));
    blockedBy = allHave("hours")
      ? "outside_hours"
      : allHave("capacity")
        ? "daily_limit"
        : allHave("gap")
          ? "throttled"
          : "sender_checks";
  }
  const next = queued
    .filter(({ window }) => window.opensAt)
    .sort(
      (a, b) => a.window.opensAt!.getTime() - b.window.opensAt!.getTime(),
    )[0];
  const governing = next ?? queued[0];
  const details = [
    ...new Set(
      snapshots
        .filter(({ mailbox }) => mailbox.activeQueue > 0)
        .flatMap(({ gates }) =>
          gates.filter((g) => g.code !== "hours").map((g) => g.reason),
        ),
    ),
  ];
  return {
    open: blockedBy === null,
    blockedBy,
    queued: mailboxes.reduce((sum, m) => sum + m.activeQueue, 0),
    nextOpenAt:
      blockedBy === "outside_hours"
        ? (next?.window.opensAt?.toISOString() ?? null)
        : null,
    nextOpenLabel:
      blockedBy === "outside_hours" && next?.window.opensAt
        ? describeOpening(
            next.window.opensAt,
            next.mailbox.workingHours.timezone,
          )
        : null,
    hours: governing
      ? describeWorkingHours(governing.mailbox.workingHours)
      : null,
    ...(blockedBy === "sender_checks" || blockedBy === "outside_hours"
      ? { detail: details.join("; ") }
      : {}),
  };
}
