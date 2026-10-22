import { timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { gridProviders } from "@/lib/grid/schema";
import { authContextErrorResponse, requireOrgContext, withOrgContext, type OrgContext } from "@/lib/auth/context";
import { getPlatformCredentials, platformCredentialSource } from "@/lib/platform/credentials";
import { MANAGED_WEBHOOK_ORG } from "@/lib/platform/unipileWebhooks";
import { getPlatformCredential } from "@/lib/managed/store.server";
import { runInOrganization } from "@/lib/tenancy/scope";
import { accountOwner, organizationOwningAccount, organizationsOwningAccounts } from "@/lib/unipile/ownership.server";
import { linkedInAccounts } from "./schema";

/**
 * How the LinkedIn side finds "which organization" when no session says so:
 * workers loop over the organizations that connected Unipile, and webhooks
 * look the organization up from the Unipile account the event is about.
 * These are the only cross-organization reads in the LinkedIn code.
 */

/**
 * Every organization a Unipile worker should visit: those with their own
 * Unipile saved, and those owning accounts (on the Included Unipile they
 * have no row of their own). Each worker still checks, inside the
 * organization's scope, that Unipile resolves for it.
 */
export async function unipileOrganizationIds(): Promise<string[]> {
  const rows = await db
    .select({ organizationId: gridProviders.organizationId })
    .from(gridProviders)
    .where(and(eq(gridProviders.key, "platform-unipile"), eq(gridProviders.enabled, true)));
  return [...new Set([...rows.map((row) => row.organizationId), ...(await organizationsOwningAccounts())])];
}

/** The organization that owns a Unipile account id (LinkedInAccount.linkedinId is globally unique), or null. */
export async function organizationIdForLinkedinAccount(linkedinId: string): Promise<string | null> {
  const [row] = await db
    .select({ organizationId: linkedInAccounts.organizationId })
    .from(linkedInAccounts)
    .where(eq(linkedInAccounts.linkedinId, linkedinId))
    .limit(1);
  return row?.organizationId ?? null;
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** The Unipile notify secret stored for `organizationId`, or null when not connected / none set. */
export async function unipileNotifySecret(organizationId: string): Promise<string | null> {
  const credentials = await runInOrganization(organizationId, () => getPlatformCredentials("unipile"));
  return credentials?.notifySecret || null;
}

const ORGANIZATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The verdict on a Unipile webhook delivery, from the URL's `org` and the
 * secret it carries.
 *
 * URLs AgentSDR registers itself (src/lib/platform/unipileWebhooks.ts)
 * carry `org=<organization id>`, and those are held to all of it:
 *   reject   — no such organization (or no Unipile connected), or the
 *              secret is missing or wrong: answer 401.
 *   ignore   — the secret is right, but the event's account is not one of
 *              this organization's (not synced yet, or another
 *              organization's on a shared Unipile workspace): answer 200
 *              so Unipile does not retry, and do nothing.
 *   accept   — proceed in `organizationId`; the secret is already checked.
 * A URL without `org` was registered by hand before that existed:
 *   legacy   — the caller applies its older checks unchanged.
 */
export type UnipileWebhookVerdict =
  | { verdict: "reject" }
  | { verdict: "ignore"; reason: string }
  | { verdict: "accept"; organizationId: string }
  | { verdict: "legacy" };

export async function gateUnipileWebhook(
  request: { nextUrl: { searchParams: URLSearchParams }; headers: Headers },
  accountOrganizationId: string | null,
  /** The event's account: its owner (unipile_account_owners) must be the organization the event is accepted for. */
  accountId?: string | null,
): Promise<UnipileWebhookVerdict> {
  const claimed = request.nextUrl.searchParams.get("org");
  if (claimed === null) {
    // A hand-registered URL keeps its older checks, but never for an account another organization owns.
    if (accountId && accountOrganizationId) {
      const owner = await accountOwner(accountId);
      if (owner && owner.organizationId !== accountOrganizationId) return { verdict: "ignore", reason: "account is owned by another organization" };
    }
    return { verdict: "legacy" };
  }
  const provided = request.headers.get("x-unipile-secret") ?? request.nextUrl.searchParams.get("secret");
  if (claimed === MANAGED_WEBHOOK_ORG) {
    // The platform's own registration on the Included Unipile, which sees every Included workspace's accounts:
    // the platform's secret, then the account's owner decides the workspace, and only one on the Included Unipile.
    const expected = (await getPlatformCredential("unipile"))?.notifySecret ?? null;
    if (!provided || !expected || !safeEqual(expected, provided)) return { verdict: "reject" };
    const owner = accountId ? await organizationOwningAccount(accountId) : null;
    if (!owner) return { verdict: "ignore", reason: "account not connected to any workspace" };
    if (accountOrganizationId !== owner) return { verdict: "ignore", reason: "account rows do not belong to its owner" };
    const source = await runInOrganization(owner, () => platformCredentialSource("unipile"));
    if (source !== "managed") return { verdict: "ignore", reason: "the owning workspace uses its own Unipile" };
    return { verdict: "accept", organizationId: owner };
  }
  if (!ORGANIZATION_ID.test(claimed)) return { verdict: "reject" };
  const expected = await unipileNotifySecret(claimed);
  if (!provided || !expected || !safeEqual(expected, provided)) return { verdict: "reject" };
  if (!accountOrganizationId) return { verdict: "ignore", reason: "account not linked to this organization yet" };
  if (accountOrganizationId !== claimed) return { verdict: "ignore", reason: "account belongs to another organization" };
  if (accountId && (await organizationOwningAccount(accountId)) !== claimed) return { verdict: "ignore", reason: "account is not owned by this organization" };
  return { verdict: "accept", organizationId: claimed };
}

/** The organization whose stored Unipile notify secret equals `secret`, or null. */
export async function organizationIdForNotifySecret(secret: string): Promise<string | null> {
  if (!secret) return null;
  for (const organizationId of await unipileOrganizationIds()) {
    const stored = await unipileNotifySecret(organizationId);
    if (stored && safeEqual(stored, secret)) return organizationId;
  }
  return null;
}

/**
 * Checks the shared secret a Unipile webhook may carry against the one stored
 * for `organizationId`. "absent" = the request carried none (existing Unipile
 * registrations have none, so it is accepted with a warning by the caller).
 */
export async function checkUnipileWebhookSecret(
  organizationId: string,
  request: { nextUrl: { searchParams: URLSearchParams }; headers: Headers },
): Promise<"ok" | "absent" | "mismatch"> {
  const provided = request.nextUrl.searchParams.get("secret") ?? request.headers.get("x-unipile-secret");
  if (!provided) return "absent";
  const expected = await unipileNotifySecret(organizationId);
  return expected && safeEqual(expected, provided) ? "ok" : "mismatch";
}

/**
 * Session routes: open the caller's organization scope and run `fn` in it.
 * Authentication failures become the usual 401/403/409 JSON response; any
 * other error propagates to the caller as before.
 */
export async function withLinkedinOrg<T>(
  request: { headers: Headers },
  fn: (ctx: OrgContext) => Promise<T>,
): Promise<T | Response> {
  try {
    return await withOrgContext(request, fn);
  } catch (error) {
    const response = authContextErrorResponse(error);
    if (response) return response;
    throw error;
  }
}

/**
 * Who is calling a /api/linkedin/jobs/* route: the cron (Bearer CRON_SECRET)
 * serves every organization, a signed-in member only their own.
 * Returns `organizationId: null` for the cron.
 */
export async function resolveJobCaller(request: { headers: Headers }): Promise<{ organizationId: string | null }> {
  const secret = process.env.CRON_SECRET;
  const header = request.headers.get("authorization");
  if (secret && header && safeEqual(header, `Bearer ${secret}`)) return { organizationId: null };
  const ctx = await requireOrgContext(request);
  return { organizationId: ctx.organizationId };
}
