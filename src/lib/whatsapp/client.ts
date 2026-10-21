/**
 * Client-safe wrappers around the /api/whatsapp routes described in
 * ./contract. Imports only types from the contract — no `db`, so this is safe
 * from client components (see the `.server.ts` note in CLAUDE.md).
 */

import type {
  ListWhatsappAccountsResponse,
  ListWhatsappChatsResponse,
  PersonWhatsappThreadResponse,
  SendWhatsappRequest,
  SendWhatsappResponse,
  WhatsappAccountSummary,
  WhatsappThreadResponse,
} from "./contract";

async function jsonFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && typeof init.body === "string" && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(`/api/whatsapp${path}`, { ...init, headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof body?.error === "string" ? body.error : `Request failed (${response.status})`;
    throw new Error(message);
  }
  return body as T;
}

export function listWhatsappAccounts(): Promise<ListWhatsappAccountsResponse> {
  return jsonFetch("/accounts");
}

export function syncWhatsappAccounts(): Promise<ListWhatsappAccountsResponse> {
  return jsonFetch("/accounts/sync", { method: "POST" });
}

export function setDefaultWhatsappAccount(id: string): Promise<WhatsappAccountSummary> {
  return jsonFetch(`/accounts/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ isDefault: true }),
  });
}

/** Pulls the account's recent chats from Unipile into AgentSDR. */
export function backfillWhatsappAccount(id: string): Promise<unknown> {
  return jsonFetch(`/accounts/${encodeURIComponent(id)}/backfill`, { method: "POST" });
}

export function listWhatsappChats(
  params: { accountId?: string; search?: string; unread?: boolean; cursor?: string | null } = {},
  init?: RequestInit,
): Promise<ListWhatsappChatsResponse> {
  const query = new URLSearchParams();
  if (params.accountId) query.set("accountId", params.accountId);
  if (params.search) query.set("search", params.search);
  if (params.unread) query.set("unread", "true");
  if (params.cursor) query.set("cursor", params.cursor);
  const suffix = query.size ? `?${query.toString()}` : "";
  return jsonFetch(`/chats${suffix}`, init);
}

export function getWhatsappChat(id: string, init?: RequestInit): Promise<WhatsappThreadResponse> {
  return jsonFetch(`/chats/${encodeURIComponent(id)}`, init);
}

export function markWhatsappChatRead(id: string): Promise<{ ok: true }> {
  return jsonFetch(`/chats/${encodeURIComponent(id)}/read`, { method: "POST" });
}

export function getPersonWhatsappThread(personId: string, init?: RequestInit): Promise<PersonWhatsappThreadResponse> {
  return jsonFetch(`/people/${encodeURIComponent(personId)}/thread`, init);
}

/** Guardrail refusals (409 warm-up / cap / DNC, 429 too soon) throw with the API's message. */
export function sendWhatsapp(request: SendWhatsappRequest): Promise<SendWhatsappResponse> {
  return jsonFetch("/send", { method: "POST", body: JSON.stringify(request) });
}
