import "server-only";

import { publicAppUrl } from "@/lib/http/publicAppUrl";
import type { PlatformCredentials, UnipileWebhookRegistration } from "./catalog";
import { BRAND } from "@/lib/brand";

/**
 * The webhooks AgentSDR needs from Unipile, registered in the organization's
 * own Unipile workspace through Unipile's API (`POST /api/v1/webhooks`)
 * whenever the integration is saved, so nobody has to copy URLs into the
 * Unipile dashboard.
 *
 * Every URL carries `org=<organization id>`, and every request carries the
 * organization's webhook secret in the `x-unipile-secret` header, which
 * Unipile sends with each delivery. The webhook routes check both: an
 * unknown organization or a wrong secret is refused, and an event for an
 * account that belongs to another organization is acknowledged and dropped
 * (see gateUnipileWebhook in src/lib/linkedin/organizations.server.ts).
 *
 * Registration replaces, never duplicates: before creating, it deletes this
 * organization's earlier registrations and any hand-made registration of
 * the same endpoints that names no organization (the pre-automation setup).
 * Another organization's registrations sharing the same Unipile workspace
 * are left alone. Webhooks created through the API carry no JSON content
 * type unless asked, so every one sets it.
 */

export const UNIPILE_WEBHOOKS = [
  {
    key: "connection-accepted",
    label: "LinkedIn connection accepted",
    path: "/api/webhooks/connection-accepted",
    source: "users",
    events: ["new_relation"],
  },
  {
    // One webhook for every messaging account; the route sends each event
    // to the LinkedIn or WhatsApp handler by its account_type.
    key: "unipile-message",
    label: "Messages (LinkedIn and WhatsApp)",
    path: "/api/webhooks/unipile-message",
    source: "messaging",
    events: ["message_received", "message_read", "message_delivered"],
  },
  {
    // Email inboxes linked in Unipile and used as sending mailboxes: a new
    // email in one is filed like a Gmail reply (Master Inbox, CRM).
    key: "unipile-email",
    label: "Email replies",
    path: "/api/webhooks/unipile-email",
    source: "email",
    events: ["mail_received"],
  },
] as const;

/**
 * Endpoints earlier versions registered separately (LinkedIn messages and
 * WhatsApp messages, before they shared /unipile-message). The routes still
 * answer, but a new registration deletes these so no message arrives twice.
 */
const RETIRED_PATHS = ["/api/webhooks/message-received", "/api/webhooks/whatsapp-message"];

/** Unipile's servers cannot call these. */
const LOCAL_ORIGIN = /^https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?$/;

export type UnipileWebhookEndpoint = { key: string; label: string; url: string };

/**
 * The `org` value of the platform's own registration on the Included Unipile
 * (one set of webhooks for every Included workspace; the account's owner
 * decides the workspace). Not an organization id.
 */
export const MANAGED_WEBHOOK_ORG = "managed";

/** The URL each webhook is registered at, for this organization. Null when the app has no public origin. */
export function unipileWebhookEndpoints(organizationId: string): UnipileWebhookEndpoint[] | null {
  const origin = publicAppUrl();
  if (!origin) return null;
  return UNIPILE_WEBHOOKS.map((hook) => ({
    key: hook.key,
    label: hook.label,
    url: `${origin}${hook.path}?org=${encodeURIComponent(organizationId)}`,
  }));
}

type ListedWebhook = { id?: unknown; request_url?: unknown };

/**
 * Whether a webhook already in the workspace is one this registration
 * replaces: it points at one of our endpoints (current or retired) on this
 * origin, and either names this organization or names none (registered by
 * hand).
 */
export function isReplaceable(requestUrl: string, origin: string, organizationId: string): boolean {
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return false;
  }
  if (url.origin !== new URL(origin).origin) return false;
  if (!UNIPILE_WEBHOOKS.some((hook) => url.pathname === hook.path) && !RETIRED_PATHS.includes(url.pathname)) return false;
  const org = url.searchParams.get("org");
  return org === null || org === organizationId;
}

async function unipile(
  credentials: PlatformCredentials["unipile"],
  path: string,
  init: { method: "GET" | "POST" | "DELETE"; body?: unknown },
): Promise<unknown> {
  const response = await fetch(`${credentials.baseUrl}/api/v1${path}`, {
    method: init.method,
    headers: {
      "X-API-KEY": credentials.apiKey,
      accept: "application/json",
      ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Unipile answered ${response.status} to ${init.method} ${path}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
  }
  return response.status === 204 ? null : response.json().catch(() => null);
}

async function listWebhooks(credentials: PlatformCredentials["unipile"]): Promise<ListedWebhook[]> {
  const all: ListedWebhook[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 20; page++) {
    const query: string = cursor ? `?limit=100&cursor=${encodeURIComponent(cursor)}` : "?limit=100";
    const body = (await unipile(credentials, `/webhooks${query}`, { method: "GET" })) as { items?: ListedWebhook[]; cursor?: string | null } | null;
    all.push(...(body?.items ?? []));
    cursor = body?.cursor ?? null;
    if (!cursor) break;
  }
  return all;
}

/**
 * Register every webhook in UNIPILE_WEBHOOKS for this organization,
 * replacing earlier registrations. Never throws: the result says what
 * happened, and the caller stores it so Settings can show it.
 */
export async function registerUnipileWebhooks(
  organizationId: string,
  credentials: PlatformCredentials["unipile"],
): Promise<UnipileWebhookRegistration> {
  const at = new Date().toISOString();
  const origin = publicAppUrl();
  if (!origin) {
    return { status: "skipped", at, message: "BETTER_AUTH_URL is not set, so there is no public address for Unipile to call." };
  }
  if (LOCAL_ORIGIN.test(origin)) {
    return { status: "skipped", at, origin, message: `${origin} is a local address that Unipile's servers cannot reach. Webhooks are registered automatically once the app runs at its public address.` };
  }
  if (!credentials.notifySecret) {
    return { status: "skipped", at, origin, message: "No webhook secret is stored." };
  }

  try {
    const existing = await listWebhooks(credentials);
    for (const hook of existing) {
      if (typeof hook.id !== "string" || typeof hook.request_url !== "string") continue;
      if (isReplaceable(hook.request_url, origin, organizationId)) {
        await unipile(credentials, `/webhooks/${encodeURIComponent(hook.id)}`, { method: "DELETE" });
      }
    }

    const endpoints = unipileWebhookEndpoints(organizationId)!;
    const items: { key: string; id: string }[] = [];
    for (const hook of UNIPILE_WEBHOOKS) {
      const created = (await unipile(credentials, "/webhooks", {
        method: "POST",
        body: {
          source: hook.source,
          events: hook.events,
          request_url: endpoints.find((endpoint) => endpoint.key === hook.key)!.url,
          name: `${BRAND.shortName} · ${hook.label}`,
          format: "json",
          enabled: true,
          headers: [
            { key: "Content-Type", value: "application/json" },
            { key: "x-unipile-secret", value: credentials.notifySecret },
          ],
        },
      })) as { webhook_id?: unknown } | null;
      const id = typeof created?.webhook_id === "string" ? created.webhook_id : "";
      items.push({ key: hook.key, id });
    }
    return { status: "registered", at, origin, items };
  } catch (error) {
    return { status: "failed", at, origin, message: error instanceof Error ? error.message : "Could not register the webhooks" };
  }
}

/**
 * Remove this organization's registrations, on disconnect. Best effort:
 * a failure is logged, never raised, so disconnecting always succeeds.
 */
export async function unregisterUnipileWebhooks(
  organizationId: string,
  credentials: PlatformCredentials["unipile"],
): Promise<void> {
  const origin = publicAppUrl();
  if (!origin || LOCAL_ORIGIN.test(origin)) return;
  try {
    for (const hook of await listWebhooks(credentials)) {
      if (typeof hook.id !== "string" || typeof hook.request_url !== "string") continue;
      let org: string | null = null;
      try {
        org = new URL(hook.request_url).searchParams.get("org");
      } catch {
        continue;
      }
      // Only this organization's own registrations; hand-made ones are the user's.
      if (org === organizationId && isReplaceable(hook.request_url, origin, organizationId)) {
        await unipile(credentials, `/webhooks/${encodeURIComponent(hook.id)}`, { method: "DELETE" });
      }
    }
  } catch (error) {
    console.error("[unipile-webhooks] could not remove webhooks on disconnect:", error);
  }
}
