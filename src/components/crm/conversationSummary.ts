type Message = {
  direction?: unknown;
  sentAt?: unknown;
  createdAt?: unknown;
  idempotencyKey?: unknown;
  raw?: unknown;
};

/** Display-only evidence; this never authorizes a send or resolves a decision. */
export function conversationSummary(messages: readonly Message[]) {
  const timestamp = (message: Message) => new Date(String(message.sentAt ?? message.createdAt ?? "")).getTime();
  let inbound: Message | undefined;
  let outbound: Message | undefined;
  for (const message of messages) {
    if (!Number.isFinite(timestamp(message))) continue;
    if (message.direction === "inbound" && (!inbound || timestamp(message) >= timestamp(inbound))) inbound = message;
    if (message.direction === "outbound" && (!outbound || timestamp(message) >= timestamp(outbound))) outbound = message;
  }
  const answered = Boolean(inbound && outbound && timestamp(outbound) >= timestamp(inbound));
  const key = String(outbound?.idempotencyKey ?? "");
  const raw = outbound?.raw && typeof outbound.raw === "object" ? outbound.raw as Record<string, unknown> : {};
  const answerLabel = key.startsWith("crm-send:autopilot:") ? "Answered by assistant"
    : raw.origin === "phone" ? "Answered by you" : "Reply sent";
  return { answered, answerLabel, lastOutboundAt: outbound?.sentAt ?? outbound?.createdAt };
}
