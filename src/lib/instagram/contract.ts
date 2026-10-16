/**
 * Instagram direct messages through Unipile (API v1, the version every
 * other channel here uses): the shapes the API, the UI and the webhook
 * share. Pure types and constants — safe to import from client components.
 *
 * How it fits together (docs/product/INSTAGRAM_INTAKE_DISCOVERY.md):
 *   - An owner or admin links an Instagram account through Unipile's hosted
 *     sign-in (or in the Unipile dashboard and then "Sync"). AgentSDR reads
 *     type INSTAGRAM accounts into instagram_accounts — apart from LinkedIn
 *     and WhatsApp, which read only their own types. The member who started
 *     the link is recorded as its owner in AgentSDR (connected_by).
 *   - Unipile's one messaging webhook (/api/webhooks/unipile-message) routes
 *     account_type INSTAGRAM to /api/webhooks/instagram-message. Messages
 *     land in instagram_chats / instagram_messages and, for a person AgentSDR
 *     knows, on an "instagram" CRM conversation — classified and drafted
 *     like any reply, answered only after review unless the owner started an
 *     inquiry run in Automatic mode.
 *   - History is imported on request and stored as historical: it is never
 *     forwarded to the CRM, never counted as unread and never answered.
 *     A webhook message older than the account's history cutoff is
 *     historical too.
 *   - Sending is a reply into an existing chat. AgentSDR does not start new
 *     Instagram chats (no cold Instagram outreach in this release).
 *
 * Only the organization's Instagram feature switch (Settings →
 * Organization) makes any of this run; it is off by default.
 */

export const INSTAGRAM_ACCOUNT_STATUSES = ["connected", "disconnected", "credentials", "error"] as const;
export type InstagramAccountStatus = (typeof INSTAGRAM_ACCOUNT_STATUSES)[number];

export type InstagramDirection = "inbound" | "outbound";
/** Who wrote a message: the lead, AgentSDR (sent through Unipile), or the owner in the Instagram app ("phone"). */
export type InstagramMessageOrigin = "lead" | "agentsdr" | "phone";
/** How AgentSDR first learned of a chat. */
export type InstagramChatSource = "webhook" | "import" | "send";

export type InstagramAttachment = {
  id: string | null;
  type: string | null;
  name: string | null;
  mimeType: string | null;
};

export type InstagramAccountSummary = {
  id: string;
  unipileAccountId: string;
  username: string | null;
  name: string | null;
  status: InstagramAccountStatus;
  connectedAt: string | null;
  /** Messages sent before this are history: stored, shown, never answered. */
  historyCutoffAt: string | null;
  /** The member who linked it, when it was linked from AgentSDR. */
  connectedBy: { id: string; name: string | null } | null;
  /** New messages from people AgentSDR does not know yet become inquiries (needs the Inquiry intake feature). */
  inquiryIntake: boolean;
  lastSyncedAt: string | null;
  lastImportedAt: string | null;
};

export type InstagramPersonRef = {
  id: string;
  fullName: string | null;
  crmRecordId: string | null;
};

export type InstagramChatSummary = {
  id: string;
  accountId: string;
  username: string | null;
  name: string | null;
  person: InstagramPersonRef | null;
  firstSeenVia: InstagramChatSource;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  lastDirection: InstagramDirection | null;
  unreadCount: number;
};

export type InstagramMessage = {
  id: string;
  chatId: string;
  direction: InstagramDirection;
  origin: InstagramMessageOrigin;
  body: string;
  attachments: InstagramAttachment[];
  sentAt: string;
  historical: boolean;
};

// GET  /api/instagram/accounts                 → { accounts, canManage }
// POST /api/instagram/accounts/sync            → { accounts }
// POST /api/instagram/accounts/link            → { url }  (Unipile hosted sign-in, single use)
// PATCH /api/instagram/accounts/:id            { inquiryIntake } → InstagramAccountSummary
// POST /api/instagram/accounts/:id/import      → ImportInstagramHistoryResponse
// GET  /api/instagram/chats?accountId&cursor   → { chats, nextCursor }
// GET  /api/instagram/chats/:id                → { chat, messages }
// POST /api/instagram/chats/:id/read           → { ok }
export type ListInstagramAccountsResponse = { accounts: InstagramAccountSummary[]; canManage: boolean };
export type ImportInstagramHistoryResponse = { importedChats: number; importedMessages: number; skippedGroups: number };
export type ListInstagramChatsResponse = { chats: InstagramChatSummary[]; nextCursor: string | null };
export type InstagramThreadResponse = { chat: InstagramChatSummary; messages: InstagramMessage[] };

/**
 * A webhook message sent this long before it arrived is history, not a new
 * message: Unipile answers within seconds and retries for minutes, so
 * anything older is a sync of old messages (for example right after an
 * account is linked) and must never get a reply.
 */
export const INSTAGRAM_FRESH_MESSAGE_WINDOW_MS = 6 * 60 * 60 * 1000;

/** What the CRM stores for a message with no text (a photo, voice note, story reply…). */
export const INSTAGRAM_NO_TEXT_BODY = "(Instagram message with no text — an attachment, voice note, or story reply)";
