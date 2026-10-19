/**
 * What the chat the webhook stored first takes over from AgentSDR's own
 * placeholder when a send's chat is merged into it (send.ts settleNewChat):
 * the person and the number AgentSDR opened the chat with, where it has
 * none. An echo addressed by a privacy id ("…@lid") carries no number, and
 * without this the chat would forget the number that the lead writes from,
 * which wrong-number checks and new-chat lookups go by. Pure.
 */
export function mergedChatPatch(
  kept: { personId: string | null; phone: string | null },
  placeholder: { personId: string | null; phone: string | null },
): { personId?: string; phone?: string } {
  return {
    ...(!kept.personId && placeholder.personId ? { personId: placeholder.personId } : {}),
    ...(!kept.phone && placeholder.phone ? { phone: placeholder.phone } : {}),
  };
}
