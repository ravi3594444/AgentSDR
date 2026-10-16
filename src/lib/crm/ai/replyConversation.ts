/** The bounded conversation shared by the reply writer and its checker. */
export type ReplyConversationMessage = {
  direction: "inbound" | "outbound";
  bodyText: string;
};

const MAX_MESSAGES = 20;
const MAX_MESSAGE_CHARS = 2_000;
const MAX_CONVERSATION_CHARS = 12_000;

export function replyConversationSnapshot(value: unknown): ReplyConversationMessage[] {
  if (!Array.isArray(value)) return [];
  const messages: ReplyConversationMessage[] = [];
  let remaining = MAX_CONVERSATION_CHARS;
  for (const item of value.slice(-MAX_MESSAGES).reverse()) {
    if (!item || typeof item !== "object" || item.channel === "whatsapp_call") continue;
    if (item.direction !== "inbound" && item.direction !== "outbound") continue;
    if (typeof item.bodyText !== "string" || !item.bodyText.trim()) continue;
    const text = item.bodyText.trim();
    const bodyText = text.slice(0, Math.min(MAX_MESSAGE_CHARS, remaining));
    if (!bodyText) break;
    messages.push({ direction: item.direction, bodyText });
    remaining -= bodyText.length;
    if (remaining === 0) break;
  }
  return messages.reverse();
}

/** Older drafts have no snapshot; they remain compatible and use the latest message. */
export function storedReplyConversation(request: Record<string, unknown> | null): ReplyConversationMessage[] {
  const context = request?.replyContext;
  if (!context || typeof context !== "object" || !("messages" in context)) return [];
  return replyConversationSnapshot(context.messages);
}
