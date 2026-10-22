import { UnipileClient } from "unipile-node-sdk";
import axios from "axios";
import { requirePlatformCredentials } from "@/lib/platform/credentials";
import { serializeError } from "@/lib/linkedin/serializeError";
import { inferLinkedinApi, linkedinLookupIdentifier, normalizeEmail, normalizeLinkedinSlug, type LinkedinApiHint } from "@/lib/leads/identity";

let _client: { key: string; client: UnipileClient } | null = null;
/**
 * The one Unipile client, shared by LinkedIn (here) and WhatsApp
 * (unipile.whatsapp.ts). Credentials come from the platform-integration store
 * only; throws PlatformNotConnectedError when Unipile is not connected. The
 * instance is rebuilt whenever the stored credentials change.
 */
export async function getUnipileClient(): Promise<UnipileClient> {
  const { baseUrl, apiKey } = await requirePlatformCredentials("unipile");
  const key = `${baseUrl}\n${apiKey}`;
  if (!_client || _client.key !== key) {
    _client = { key, client: new UnipileClient(baseUrl, apiKey) };
  }
  return _client.client;
}

export interface LinkedInAccountInfo {
  linkedinId: string;
  name: string;
  username: string;
  status: "CONNECTED" | "DISCONNECTED";
}

export interface AcceptedConnection {
  linkedinUrl: string;
  providerId: string;
  acceptedAt: Date;
}

export interface IncomingMessage {
  senderProviderId: string;
  text: string;
  receivedAt: Date;
}

interface UnipileAccountItem {
  id: string;
  name: string;
  type?: string;
  sources?: { status?: string }[];
  connection_params?: { im?: { publicIdentifier?: string; username?: string } };
}

// Fields read from a message that the SDK's declared type omits.
interface UnipileMessageItem {
  is_sender?: boolean;
  sender_id?: string;
  attendee_id?: string;
  text?: string;
  created_at: string;
}

// Fetch all LinkedIn accounts connected to this Unipile workspace
/**
 * The accounts in a reply from Unipile's account list. A reply without a
 * list is an error, never "no accounts": every sync marks the accounts the
 * list leaves out as disconnected.
 */
export function unipileAccountItems<T = Record<string, unknown>>(response: unknown): T[] {
  const items = (response as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) throw new Error("Unipile answered without an account list");
  return items as T[];
}

export const getLinkedInAccounts = async (): Promise<LinkedInAccountInfo[]> => {
  const response = await (await getUnipileClient()).account.getAll();
  return unipileAccountItems<UnipileAccountItem>(response)
    .filter((acc) => acc.type === "LINKEDIN")
    .map((acc) => {
      const sourceStatus: string = acc.sources?.[0]?.status ?? "ERROR";
      return {
        linkedinId: acc.id as string,
        name: acc.name as string,
        username: (acc.connection_params?.im?.publicIdentifier ?? acc.connection_params?.im?.username ?? "") as string,
        status: sourceStatus === "OK" ? "CONNECTED" : "DISCONNECTED",
      } satisfies LinkedInAccountInfo;
    });
};

export interface LinkedInProfile {
  providerId: string;
  publicIdentifier: string | null;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  profilePictureUrl: string | null;
  location: string | null;
  headline: string;
  currentTitle: string | null;
  currentCompanyName: string | null;
  leadData: Record<string, unknown>;
}

export function mapLinkedinProfile(raw: unknown): LinkedInProfile {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw, untyped Unipile profile payload; every field is type-checked at use
  const p = raw as Record<string, any>;
  const currentExperience = Array.isArray(p.work_experience)
    ? p.work_experience.find((item: unknown) => item && typeof item === "object" && (item as { current?: boolean }).current)
      ?? p.work_experience[0]
    : null;
  const contactEmails = Array.isArray(p.contact_info?.emails) ? p.contact_info.emails : [];
  const email = contactEmails.map((value: unknown) => {
    if (typeof value === "string") return normalizeEmail(value);
    if (!value || typeof value !== "object") return null;
    const item = value as Record<string, unknown>;
    const candidate = typeof item.email === "string" ? item.email : typeof item.value === "string" ? item.value : null;
    return normalizeEmail(candidate);
  }).find(Boolean) ?? null;
  const providerId = typeof p.provider_id === "string" ? p.provider_id : typeof p.user_provider_id === "string" ? p.user_provider_id : "";
  if (!providerId) throw new Error("Unipile returned no provider_id");
  return {
    providerId,
    publicIdentifier: normalizeLinkedinSlug(p.public_identifier ?? p.public_profile_url),
    email,
    firstName: typeof p.first_name === "string" ? p.first_name : null,
    lastName: typeof p.last_name === "string" ? p.last_name : null,
    profilePictureUrl: typeof p.profile_picture_url === "string" ? p.profile_picture_url : null,
    location: typeof p.location === "string" ? p.location : null,
    headline: typeof p.headline === "string" ? p.headline : "",
    currentTitle: typeof currentExperience?.position === "string" ? currentExperience.position : null,
    currentCompanyName: typeof currentExperience?.company === "string" ? currentExperience.company : null,
    leadData: p,
  };
}

// Resolves a LinkedIn slug → provider_id plus profile data saved on the lead
export const getProfile = async (
  sourceIdentifier: string,
  accountId: string,
  linkedinApi?: LinkedinApiHint | null,
  includeAllSections = false,
): Promise<LinkedInProfile> => {
  const identifier = linkedinLookupIdentifier(sourceIdentifier);
  const api = linkedinApi ?? inferLinkedinApi(sourceIdentifier) ?? undefined;
  const raw = await (await getUnipileClient()).users.getProfile({
    account_id: accountId,
    identifier,
    ...(api ? { linkedin_api: api } : {}),
    ...(includeAllSections ? { linkedin_sections: "*" as const } : {}),
  });
  return mapLinkedinProfile(raw);
};

export function invitationResponseId(response: unknown): string | null {
  if (!response || typeof response !== "object") return null;
  const value = response as Record<string, unknown>;
  for (const key of ["invitation_id", "id", "message_id"] as const) {
    if (typeof value[key] === "string" && value[key].trim()) return value[key].trim();
  }
  return null;
}

// Step 2: send the connection request using provider_id — returns the
// provider's invitation ID. Current Unipile responses use `invitation_id`;
// the older aliases remain accepted for compatibility.
export const sendConnectionRequest = async (
  providerId: string,
  message: string,
  accountId: string
): Promise<string | null> => {
  const res = await (await getUnipileClient()).users.sendInvitation({ account_id: accountId, provider_id: providerId, message });
  return invitationResponseId(res);
};

// Get all current connections for an account and return ones that match our leads
export const getAcceptedConnections = async (
  accountId: string
): Promise<AcceptedConnection[]> => {
  const response = await (await getUnipileClient()).users.getAllRelations({ account_id: accountId });
  return response.items.map((item) => ({
    linkedinUrl: normalizeUrl(item.public_profile_url),
    providerId: item.member_id,
    acceptedAt: new Date(item.created_at),
  }));
};

// Send a message — returns LinkedIn message ID if available
export const sendMessage = async (
  chatId: string,
  message: string
): Promise<string | null> => {
  const res = await (await getUnipileClient()).messaging.sendMessage({ chat_id: chatId, text: message });
  const sent = res as { id?: string; message_id?: string } | null | undefined;
  return sent?.id ?? sent?.message_id ?? null;
};

// Get incoming messages since a given date, keyed by sender provider_id
export const getNewMessages = async (
  accountId: string,
  since: Date
): Promise<IncomingMessage[]> => {
  const response = await (await getUnipileClient()).messaging.getAllMessages({
    account_id: accountId,
    after: since.toISOString(),
  });

  return ((response.items ?? []) as unknown as UnipileMessageItem[])
    .filter((msg) => !msg.is_sender)
    .map((msg) => ({
      senderProviderId: (msg.sender_id ?? msg.attendee_id) as string,
      text: msg.text ?? "",
      receivedAt: new Date(msg.created_at),
    }));
};

// Extracts the LinkedIn username slug from any format:
// "janedoe42", "linkedin.com/in/janedoe42", "https://www.linkedin.com/in/janedoe42/"
const normalizeUrl = (input: string): string => {
  const trimmed = input.replace(/\/$/, "").trim().toLowerCase();
  const match = trimmed.match(/linkedin\.com\/in\/([^/?#]+)/);
  return match ? match[1]! : trimmed;
};

export interface LinkedInSearchResult {
  object: string;
  items: Record<string, unknown>[];
  config: Record<string, unknown>;
  paging: { start: number; page_count: number; total_count: number };
  cursor?: string;
}

export const searchLinkedIn = async (
  accountId: string,
  url: string,
  cursor?: string
): Promise<LinkedInSearchResult> => {
  const body: Record<string, string> = { url };
  if (cursor) body.cursor = cursor;

  const { baseUrl, apiKey } = await requirePlatformCredentials("unipile");
  const response = await axios.post<LinkedInSearchResult>(
    `${baseUrl}/api/v1/linkedin/search`,
    body,
    {
      params: { account_id: accountId },
      headers: { "X-API-KEY": apiKey, "accept": "application/json" },
    }
  );

  return response.data;
};

// Lookup the Unipile chat_id for a connection by their provider_id.
// Returns null if no chat exists yet (common right after a new connection).
export const getChatIdForUser = async (
  attendeeProviderId: string,
  accountId: string
): Promise<string | null> => {
  try {
    const res = await (await getUnipileClient()).messaging.getAllChatsFromAttendee({
      attendee_id: attendeeProviderId,
      account_id: accountId,
      limit: 1,
    });
    return (res.items?.[0] as { id?: string })?.id ?? null;
  } catch (err) {
    console.warn(
      `[unipile] getChatIdForUser failed for ${attendeeProviderId}:`,
      serializeError(err)
    );
    return null;
  }
};

/** Start a LinkedIn chat with a 1st-degree connection when no chat_id exists yet. */
export const startNewChatWithUser = async (
  attendeeProviderId: string,
  accountId: string,
  text: string
): Promise<{ chatId: string | null; messageId: string | null }> => {
  try {
    const res = await (await getUnipileClient()).messaging.startNewChat({
      account_id: accountId,
      text,
      attendees_ids: [attendeeProviderId],
      options: { linkedin: { api: "classic" } },
    });
    const data = res as { chat_id?: string | null; message_id?: string | null };
    return { chatId: data.chat_id ?? null, messageId: data.message_id ?? null };
  } catch (err) {
    console.warn(
      `[unipile] startNewChat failed for ${attendeeProviderId}:`,
      serializeError(err)
    );
    return { chatId: null, messageId: null };
  }
};

/** Send via existing chat, or start a new chat when LinkedIn has no thread yet. */
export const deliverMessageToConnection = async (
  attendeeProviderId: string,
  accountId: string,
  text: string,
  existingChatId?: string | null
): Promise<{ chatId: string | null; messageId: string | null }> => {
  if (existingChatId) {
    const messageId = await sendMessage(existingChatId, text);
    return { chatId: existingChatId, messageId };
  }
  return startNewChatWithUser(attendeeProviderId, accountId, text);
};

/**
 * Hosted Auth: Unipile hosts the LinkedIn login (and its captcha / 2FA / OAuth
 * screens) on their own domain and hands back a one-shot URL we send the user
 * to. Unipile explicitly advises against iframing it — the LinkedIn captcha
 * and the OAuth screens misbehave inside a frame — so callers must navigate
 * to the returned URL, and Unipile returns the user via success/failure
 * redirect. See https://developer.unipile.com/docs/hosted-auth
 */
export interface HostedAuthLinkInput {
  /** Echoed back verbatim on notify_url so the callback can be matched to a row. */
  name: string;
  successRedirectUrl: string;
  failureRedirectUrl: string;
  /** Omitted in local dev, where Unipile cannot reach the callback. */
  notifyUrl?: string;
  /** Unipile account id to re-authenticate. Omit to connect a brand new account. */
  reconnectAccountId?: string | null;
  expiresInMinutes?: number;
}

/**
 * Mints a Hosted Auth URL locked to LinkedIn — `providers: ["LINKEDIN"]` means
 * the wizard skips its provider picker and opens straight on LinkedIn.
 * A reconnect link carries no `providers`: the provider is already fixed by the
 * account being reconnected.
 */
export const createLinkedInHostedAuthLink = async ({
  name,
  successRedirectUrl,
  failureRedirectUrl,
  notifyUrl,
  reconnectAccountId = null,
  expiresInMinutes = 15,
}: HostedAuthLinkInput): Promise<string> => {
  const { baseUrl: apiUrl } = await requirePlatformCredentials("unipile");

  // Unipile expires every link on their daily restart regardless of this value,
  // so keep it short: the link is used within seconds of being minted.
  const shared = {
    expiresOn: new Date(Date.now() + expiresInMinutes * 60_000).toISOString(),
    api_url: apiUrl,
    name,
    success_redirect_url: successRedirectUrl,
    failure_redirect_url: failureRedirectUrl,
    ...(notifyUrl ? { notify_url: notifyUrl } : {}),
  };

  const response = await (await getUnipileClient()).account.createHostedAuthLink(
    reconnectAccountId
      ? { type: "reconnect", reconnect_account: reconnectAccountId, ...shared }
      : { type: "create", providers: ["LINKEDIN"], ...shared }
  );

  return response.url;
};

export { normalizeUrl };
