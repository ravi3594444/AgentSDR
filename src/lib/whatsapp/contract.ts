/**
 * WhatsApp messaging through Unipile: the shapes the API, the UI and the
 * webhook share. Pure types and constants — safe to import from client
 * components.
 *
 * How it fits together:
 *   - A rep links their WhatsApp number in the Unipile dashboard. AgentSDR
 *     reads the linked numbers from Unipile (accounts.ts, "Sync") into
 *     whatsapp_accounts — separately from the LinkedIn accounts, which read
 *     only type LINKEDIN.
 *   - Unipile posts every message on those numbers to
 *     /api/webhooks/whatsapp-message: replies from leads, and echoes of what
 *     the rep sent — from AgentSDR or straight from their phone. Each lands in
 *     whatsapp_chats / whatsapp_messages (the Messages tab), and, for a lead
 *     AgentSDR knows by phone, in the CRM on a "whatsapp" conversation, like
 *     LinkedIn replies do.
 *   - AgentSDR sends through Unipile (POST /api/whatsapp/send): into the
 *     existing chat with that number, or a new one.
 *
 * Calls stay with the call-recorder extension on web.whatsapp.com; Unipile
 * has no calling API.
 */

// --- accounts ------------------------------------------------------------------

export const WHATSAPP_ACCOUNT_STATUSES = ["connected", "disconnected", "credentials", "error"] as const;
export type WhatsappAccountStatus = (typeof WHATSAPP_ACCOUNT_STATUSES)[number];

export type WhatsappAccountSummary = {
  id: string;
  unipileAccountId: string;
  /** As Unipile names the account — usually the WhatsApp profile name. */
  name: string | null;
  /** E.164, when Unipile reports the number. */
  phone: string | null;
  status: WhatsappAccountStatus;
  /** When AgentSDR first saw it connected; starts the new-chat warm-up. */
  connectedAt: string | null;
  /** New chats are held until then (WHATSAPP_NEW_CHAT_WARMUP_HOURS); null once past. */
  warmUpEndsAt: string | null;
  /** Sends go from this number when nothing else picks one. */
  isDefault: boolean;
  /** This number's own new-chats-per-day limit; null = the organization's rule. */
  newChatsPerDay: number | null;
  lastSyncedAt: string | null;
};

// GET  /api/whatsapp/accounts        → { accounts }
// POST /api/whatsapp/accounts/sync   → { accounts }  (re-reads Unipile)
// PATCH /api/whatsapp/accounts/:id   { isDefault: true } → WhatsappAccountSummary
export type ListWhatsappAccountsResponse = { accounts: WhatsappAccountSummary[] };

// POST /api/whatsapp/accounts/:id/backfill → BackfillWhatsappAccountResponse.
// Imports the number's recent chats (up to 100) and their last 30 messages
// from Unipile — history, so nothing reaches the CRM. Safe to re-run.
export type BackfillWhatsappAccountResponse = { importedChats: number; importedMessages: number; skippedGroups: number };

// --- guardrails --------------------------------------------------------------------
// Unipile's own guidance for WhatsApp (provider limits): wait a day after
// linking before starting new chats, space sends out, keep new chats per
// day modest. A banned number also loses its calling, so these are enforced
// server-side. Env vars of the same names override them.

/** Hours after a number is linked before AgentSDR starts new chats from it. */
export const WHATSAPP_NEW_CHAT_WARMUP_HOURS = 24;
/** New chats (numbers never messaged from this account) per account per day. */
export const WHATSAPP_NEW_CHATS_PER_DAY = 25;
/** Minimum seconds between two sends from one account. */
export const WHATSAPP_MIN_SECONDS_BETWEEN_SENDS = 10;

// --- chats and messages ---------------------------------------------------------------

export type WhatsappPersonRef = {
  id: string;
  fullName: string | null;
  title: string | null;
  companyName: string | null;
  profilePictureUrl: string | null;
  /** Their CRM record, when they have one. */
  crmRecordId: string | null;
};

export type WhatsappChatSummary = {
  id: string;
  accountId: string;
  /** The lead's number, E.164. */
  phone: string | null;
  /** The name WhatsApp shows for the chat. */
  name: string | null;
  /** The AgentSDR person with this number, when there is one. */
  person: WhatsappPersonRef | null;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  lastDirection: WhatsappDirection | null;
  unreadCount: number;
};

export type WhatsappDirection = "inbound" | "outbound";

/**
 * Where a message came from: the lead, AgentSDR (sent through Unipile), or
 * the rep's phone / WhatsApp Web directly (an echo AgentSDR did not send).
 */
export type WhatsappMessageOrigin = "lead" | "agentsdr" | "phone";

export type WhatsappAttachment = {
  id: string | null;
  type: string | null;
  name: string | null;
  mimeType: string | null;
};

export type WhatsappMessage = {
  id: string;
  chatId: string;
  direction: WhatsappDirection;
  origin: WhatsappMessageOrigin;
  body: string;
  attachments: WhatsappAttachment[];
  sentAt: string;
  deliveredAt: string | null;
  readAt: string | null;
};

// GET  /api/whatsapp/chats?accountId=&search=&unread=true&cursor= → ListWhatsappChatsResponse
export type ListWhatsappChatsResponse = { chats: WhatsappChatSummary[]; nextCursor: string | null };

// GET  /api/whatsapp/chats/:id → WhatsappThreadResponse (oldest message first)
// POST /api/whatsapp/chats/:id/read → { ok: true }  (clears unread in AgentSDR)
export type WhatsappThreadResponse = { chat: WhatsappChatSummary; messages: WhatsappMessage[] };

// GET /api/whatsapp/people/:personId/thread → PersonWhatsappThreadResponse.
// The lead's chat (the most recent, across accounts), for the calling panel
// and the CRM record; chat null when nobody has messaged them yet.
export type PersonWhatsappThreadResponse = {
  chat: WhatsappChatSummary | null;
  messages: WhatsappMessage[];
  /** Whether a number is linked and connected, i.e. whether sending can work. */
  canSend: boolean;
};

/**
 * POST /api/whatsapp/send → SendWhatsappResponse. Exactly one of chatId,
 * personId or phone says who to: the chat's own number, the person's phone,
 * or a number. accountId picks the sending number; by default the one
 * already chatting with them, else the default account.
 *
 * Refused with 409 while the account is warming up (new chats only), over
 * the daily new-chat cap, or to a Do Not Contact person; 429 when sent
 * sooner than WHATSAPP_MIN_SECONDS_BETWEEN_SENDS after the last one.
 */
export type SendWhatsappRequest = {
  chatId?: string;
  personId?: string;
  phone?: string;
  accountId?: string;
  text: string;
  /** Links the message to the call it follows up, when sent from Calling. */
  callSessionId?: string | null;
  campaignContactId?: string | null;
  /**
   * Set by the campaign engine only (the HTTP API refuses the field): the CRM
   * records the send as a campaign step (raw.origin "campaign") rather than as
   * a person's send from AgentSDR ("agentsdr"). It settles the record the same.
   */
  crmOrigin?: "campaign";
};
export type SendWhatsappResponse = { chat: WhatsappChatSummary; message: WhatsappMessage };
