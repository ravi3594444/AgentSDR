/**
 * Client-safe wrappers around the /api/instagram routes described in
 * ./contract. Imports only types from the contract — no `db`, so this is
 * safe from client components (see the `.server.ts` note in CLAUDE.md).
 */

import type {
  ImportInstagramHistoryResponse,
  InstagramAccountSummary,
  InstagramThreadResponse,
  ListInstagramAccountsResponse,
  ListInstagramChatsResponse,
} from "./contract";

/** An API refusal, with its status: 409 is "turned off or not connected" rather than a failure. */
export class InstagramRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "InstagramRequestError";
  }
}

async function jsonFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && typeof init.body === "string" && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(`/api/instagram${path}`, { cache: "no-store", ...init, headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof body?.error === "string" ? body.error : `Request failed (${response.status})`;
    throw new InstagramRequestError(response.status, message);
  }
  return body as T;
}

export function listInstagramAccounts(): Promise<ListInstagramAccountsResponse> {
  return jsonFetch("/accounts");
}

export function syncInstagramAccounts(): Promise<{ accounts: InstagramAccountSummary[] }> {
  return jsonFetch("/accounts/sync", { method: "POST" });
}

/** A single-use Unipile sign-in URL for a new Instagram account; navigate to it. */
export function linkInstagramAccount(): Promise<{ url: string }> {
  return jsonFetch("/accounts/link", { method: "POST" });
}

export function setInstagramInquiryIntake(id: string, inquiryIntake: boolean): Promise<InstagramAccountSummary> {
  return jsonFetch(`/accounts/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify({ inquiryIntake }),
  });
}

/** Imports the account's recent chats as history (never answered). */
export function importInstagramHistory(id: string): Promise<ImportInstagramHistoryResponse> {
  return jsonFetch(`/accounts/${encodeURIComponent(id)}/import`, { method: "POST" });
}

export function listInstagramChats(params: { accountId?: string; cursor?: string | null } = {}): Promise<ListInstagramChatsResponse> {
  const query = new URLSearchParams();
  if (params.accountId) query.set("accountId", params.accountId);
  if (params.cursor) query.set("cursor", params.cursor);
  const suffix = query.size ? `?${query.toString()}` : "";
  return jsonFetch(`/chats${suffix}`);
}

export function getInstagramChat(id: string): Promise<InstagramThreadResponse> {
  return jsonFetch(`/chats/${encodeURIComponent(id)}`);
}

export function markInstagramChatRead(id: string): Promise<{ ok: true }> {
  return jsonFetch(`/chats/${encodeURIComponent(id)}/read`, { method: "POST" });
}
