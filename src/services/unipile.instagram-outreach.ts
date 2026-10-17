import "server-only";
import { requirePlatformCredentials } from "@/lib/platform/credentials";
import { instagramRecipient } from "@/lib/instagram/outreach";
import { UnipileInstagramError } from "./unipile.instagram";

// The installed SDK's Instagram profile schema predates provider_messaging_id.
// Read the raw v1 response so that field is preserved; keep the existing DSN/account IDs.
export function instagramOutreachTransport(
  { baseUrl, apiKey }: { baseUrl: string; apiKey: string },
  fetcher: typeof fetch = fetch,
) {
  async function request(
    path: string,
    init: RequestInit = {},
  ): Promise<Record<string, unknown>> {
    const root = baseUrl.replace(/\/+$/, "").replace(/\/api\/v1$/, "");
    let response: Response;
    try {
      response = await fetcher(`${root}/api/v1${path}`, {
        ...init,
        headers: {
          "X-API-KEY": apiKey,
          accept: "application/json",
          ...init.headers,
        },
        signal: AbortSignal.timeout(45_000),
      });
    } catch {
      throw new UnipileInstagramError(
        null,
        "Unipile's Instagram request did not return a response",
      );
    }
    const body = (await response.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!response.ok) {
      const reason = [body?.title, body?.detail]
        .filter((value) => typeof value === "string")
        .join(": ")
        .slice(0, 500);
      throw new UnipileInstagramError(
        response.status,
        `Instagram request refused (HTTP ${response.status})${reason ? `: ${reason}` : ""}`,
        typeof body?.type === "string" ? body.type : null,
      );
    }
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new UnipileInstagramError(
        null,
        "Unipile returned an unreadable Instagram response",
      );
    return body;
  }

  async function resolve(accountId: string, username: string) {
    const body = await request(
      `/users/${encodeURIComponent(username)}?account_id=${encodeURIComponent(accountId)}`,
    );
    return instagramRecipient(body, username);
  }

  async function start(accountId: string, messagingId: string, text: string) {
    const form = new FormData();
    form.set("account_id", accountId);
    form.set("attendees_ids", messagingId);
    form.set("text", text);
    const body = await request("/chats", { method: "POST", body: form });
    if (typeof body.chat_id !== "string" || !body.chat_id.trim())
      throw new UnipileInstagramError(
        null,
        "Unipile accepted the DM request without a chat ID; delivery requires reconciliation",
      );
    return {
      chatId: body.chat_id,
      messageId:
        typeof body.message_id === "string" && body.message_id.trim()
          ? body.message_id
          : null,
    };
  }

  return { resolve, start };
}

export async function resolveInstagramOutreachRecipient(
  accountId: string,
  username: string,
) {
  return instagramOutreachTransport(
    await requirePlatformCredentials("unipile"),
  ).resolve(accountId, username);
}

export async function startInstagramOutreachChat(
  accountId: string,
  messagingId: string,
  text: string,
) {
  return instagramOutreachTransport(
    await requirePlatformCredentials("unipile"),
  ).start(accountId, messagingId, text);
}
