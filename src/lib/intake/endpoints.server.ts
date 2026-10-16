import "server-only";

import { and, count, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { cleanString } from "@/lib/grid/sanitize";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";
import { cleanFieldMap } from "./fields";
import { inquiries, intakeEndpoints, type InquirySource, type InquiryStatus, type IntakeEndpointRow, type IntakeFieldMap } from "./schema";
import { generateIntakeToken, hashIntakeToken, looksLikeIntakeToken, secretsMatch } from "./tokens";

/**
 * Website-form endpoints and the inquiries they (and Instagram) received,
 * for Settings → Inquiries and its API. Everything here runs in the
 * organization scope and filters by it, except findIntakeEndpointByToken:
 * the public webhook's one deliberately unscoped read, the way a Unipile
 * webhook finds its organization through the account id.
 *
 * A token is returned only by create and rotate, once; listings carry its
 * last four characters, never the hash. Only creating an endpoint needs the
 * organization's Inquiry intake on (checked by the route): listing, turning
 * off, rotating and deleting work while it is off, so a leaked token can
 * always be killed. The feature switch never touches an endpoint's own
 * on/off, so turning the feature back on revives nothing that was off.
 */

export class IntakeInputError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "IntakeInputError";
  }
}

export type IntakeEndpointSummary = {
  id: string;
  name: string;
  tokenHint: string;
  fieldMap: IntakeFieldMap;
  enabled: boolean;
  lastReceivedAt: string | null;
  createdAt: string;
  /** Inquiries this endpoint recorded (historical ones included). */
  inquiries: number;
};

const NAME_MAX = 100;
export const DEFAULT_ENDPOINT_NAME = "Website form";

function cleanName(value: unknown, fallback?: string): string {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== "string") throw new IntakeInputError("Give the webhook a name.");
  const name = cleanString(value).trim().replace(/\s+/g, " ");
  if (!name) throw new IntakeInputError("Give the webhook a name.");
  if (name.length > NAME_MAX) throw new IntakeInputError(`Keep the name under ${NAME_MAX} characters.`);
  return name;
}

function summary(row: IntakeEndpointRow, received = 0): IntakeEndpointSummary {
  return {
    id: row.id,
    name: row.name,
    tokenHint: row.tokenHint,
    fieldMap: row.fieldMap ?? {},
    enabled: row.enabled,
    lastReceivedAt: row.lastReceivedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    inquiries: received,
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** An id from a URL: anything that is not a uuid is simply not found (and never reaches Postgres). */
export function isUuid(value: string): boolean {
  return UUID.test(value);
}

export async function listIntakeEndpoints(): Promise<IntakeEndpointSummary[]> {
  const rows = await db.select().from(intakeEndpoints).where(inOrg(intakeEndpoints)).orderBy(desc(intakeEndpoints.createdAt));
  if (!rows.length) return [];
  const counts = await db
    .select({ endpointId: inquiries.endpointId, total: count() })
    .from(inquiries)
    .where(and(inOrg(inquiries), inArray(inquiries.endpointId, rows.map((row) => row.id))))
    .groupBy(inquiries.endpointId);
  const byEndpoint = new Map(counts.map((row) => [row.endpointId, Number(row.total)]));
  return rows.map((row) => summary(row, byEndpoint.get(row.id) ?? 0));
}

async function endpointSummary(id: string): Promise<IntakeEndpointSummary | null> {
  if (!isUuid(id)) return null;
  const [row] = await db.select().from(intakeEndpoints).where(and(inOrg(intakeEndpoints), eq(intakeEndpoints.id, id))).limit(1);
  if (!row) return null;
  const [{ total }] = await db.select({ total: count() }).from(inquiries).where(and(inOrg(inquiries), eq(inquiries.endpointId, id)));
  return summary(row, Number(total));
}

/** A new endpoint and its token, which is shown this once. */
export async function createIntakeEndpoint(
  input: { name?: unknown; fieldMap?: unknown },
  userId: string | null,
): Promise<{ endpoint: IntakeEndpointSummary; token: string }> {
  const name = cleanName(input.name, DEFAULT_ENDPOINT_NAME);
  const { token, hash, hint } = generateIntakeToken();
  const [row] = await db.insert(intakeEndpoints).values({
    organizationId: currentOrganizationId(),
    name,
    tokenHash: hash,
    tokenHint: hint,
    fieldMap: cleanFieldMap(input.fieldMap),
    createdBy: userId,
  }).returning();
  return { endpoint: summary(row!), token };
}

/** Renames it, replaces its field map, or turns it on or off. Null when it is not this organization's. */
export async function updateIntakeEndpoint(
  id: string,
  input: { name?: unknown; fieldMap?: unknown; enabled?: unknown },
): Promise<IntakeEndpointSummary | null> {
  if (!isUuid(id)) return null;
  const set: Partial<typeof intakeEndpoints.$inferInsert> = {};
  if (input.name !== undefined) set.name = cleanName(input.name);
  if (input.fieldMap !== undefined) {
    if (input.fieldMap !== null && (typeof input.fieldMap !== "object" || Array.isArray(input.fieldMap))) {
      throw new IntakeInputError("The field map is an object of AgentSDR field → your form's field name.");
    }
    set.fieldMap = cleanFieldMap(input.fieldMap);
  }
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== "boolean") throw new IntakeInputError("enabled is true or false.");
    set.enabled = input.enabled;
  }
  if (!Object.keys(set).length) throw new IntakeInputError("Nothing to change: send name, fieldMap or enabled.");
  const [row] = await db.update(intakeEndpoints)
    .set({ ...set, updatedAt: new Date() })
    .where(and(inOrg(intakeEndpoints), eq(intakeEndpoints.id, id)))
    .returning({ id: intakeEndpoints.id });
  return row ? endpointSummary(row.id) : null;
}

/** A new token for the endpoint; the old one stops working at once. Null when it is not this organization's. */
export async function rotateIntakeEndpointToken(id: string): Promise<{ endpoint: IntakeEndpointSummary; token: string } | null> {
  if (!isUuid(id)) return null;
  const { token, hash, hint } = generateIntakeToken();
  const [row] = await db.update(intakeEndpoints)
    .set({ tokenHash: hash, tokenHint: hint, updatedAt: new Date() })
    .where(and(inOrg(intakeEndpoints), eq(intakeEndpoints.id, id)))
    .returning({ id: intakeEndpoints.id });
  if (!row) return null;
  return { endpoint: (await endpointSummary(row.id))!, token };
}

/** Deletes the endpoint; its inquiries stay (their endpoint_id becomes null). False when it is not this organization's. */
export async function deleteIntakeEndpoint(id: string): Promise<boolean> {
  if (!isUuid(id)) return false;
  const rows = await db.delete(intakeEndpoints)
    .where(and(inOrg(intakeEndpoints), eq(intakeEndpoints.id, id)))
    .returning({ id: intakeEndpoints.id });
  return rows.length > 0;
}

/**
 * The endpoint a public delivery's token belongs to, in any organization:
 * the token names its organization, as a Unipile account id does for the
 * messaging webhooks. Read without a scope on purpose; the caller opens the
 * endpoint's organization scope before anything else.
 */
export async function findIntakeEndpointByToken(token: string): Promise<IntakeEndpointRow | null> {
  if (!looksLikeIntakeToken(token)) return null;
  const hash = hashIntakeToken(token);
  const [row] = await db.select().from(intakeEndpoints).where(eq(intakeEndpoints.tokenHash, hash)).limit(1);
  return row && secretsMatch(hash, row.tokenHash) ? row : null;
}

export type InquiryDropped = { field: "email" | "phone" | "pageUrl"; value: string; reason: string };

export type InquirySummary = {
  id: string;
  source: InquirySource;
  endpointId: string | null;
  endpointName: string | null;
  personId: string | null;
  name: string | null;
  email: string | null;
  /** E.164. */
  phone: string | null;
  instagramUsername: string | null;
  message: string | null;
  pageUrl: string | null;
  historical: boolean;
  status: InquiryStatus;
  /** Why an unusable inquiry could not become a contact. */
  reason: string | null;
  /** An email or phone the submission carried that could not be used, and why. */
  dropped: InquiryDropped[];
  submittedAt: string | null;
  receivedAt: string;
};

function droppedOf(raw: Record<string, unknown> | null): InquiryDropped[] {
  const list = raw?.dropped;
  return Array.isArray(list) ? list.filter((item): item is InquiryDropped => Boolean(item) && typeof item === "object" && typeof (item as InquiryDropped).reason === "string") : [];
}

function instagramUsernameOf(raw: Record<string, unknown> | null): string | null {
  const instagram = raw?.instagram;
  const username = instagram && typeof instagram === "object" ? (instagram as { username?: unknown }).username : null;
  return typeof username === "string" && username ? username : null;
}

/**
 * The organization's inquiries, newest first. Historical ones (a backfill of
 * old submissions) are left out unless asked for: they are kept and shown,
 * but nothing should act on them.
 */
export async function listInquiries(input: { source?: InquirySource; limit?: number; includeHistorical?: boolean } = {}): Promise<InquirySummary[]> {
  const limit = Math.min(Math.max(Math.floor(Number.isFinite(input.limit) ? input.limit! : 50), 1), 200);
  const rows = await db
    .select({ inquiry: inquiries, endpointName: intakeEndpoints.name })
    .from(inquiries)
    .leftJoin(intakeEndpoints, and(eq(intakeEndpoints.id, inquiries.endpointId), inOrg(intakeEndpoints)))
    .where(and(
      inOrg(inquiries),
      input.source ? eq(inquiries.source, input.source) : undefined,
      input.includeHistorical ? undefined : eq(inquiries.historical, false),
    ))
    .orderBy(desc(inquiries.receivedAt), desc(inquiries.id))
    .limit(limit);
  return rows.map(({ inquiry, endpointName }) => ({
    id: inquiry.id,
    source: inquiry.source,
    endpointId: inquiry.endpointId,
    endpointName: endpointName ?? null,
    personId: inquiry.personId,
    name: inquiry.name,
    email: inquiry.email,
    phone: inquiry.phone,
    instagramUsername: instagramUsernameOf(inquiry.raw),
    message: inquiry.message,
    pageUrl: inquiry.pageUrl,
    historical: inquiry.historical,
    status: inquiry.status,
    reason: inquiry.reason,
    dropped: droppedOf(inquiry.raw),
    submittedAt: inquiry.submittedAt?.toISOString() ?? null,
    receivedAt: inquiry.receivedAt.toISOString(),
  }));
}
