import "server-only";

import { and, desc, eq, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { personCompanyName } from "@/lib/leads/companyName";
import { companies, people } from "@/lib/leads/schema";
import {
  assertExactKeys,
  assertObject,
  CrmConfigurationValidationError,
  parseNonNegativeInteger,
  parseRequiredText,
} from "@/lib/crm/categories";
import { crmRequestErrorResponse } from "@/lib/crm/http";
import {
  MAX_RECORDING_BYTES,
  TERMINAL_CALL_STATUSES,
  type CallDetail,
  type CallStartedRequest,
  type CallStatus,
  type CallSummary,
  type FinishCallRequest,
  type FinishCallResponse,
  type ListCallsResponse,
  type RecorderCallStatus,
  type RecorderLead,
  type StartCallRequest,
  type StartCallResponse,
  type UploadUrlRequest,
  type UploadUrlResponse,
} from "./contract";
import { callCampaignContacts, callCampaigns, callSessions } from "./schema";
import { applyCallResultToContactSafely } from "./contactCallStatus";
import { normalizePhone } from "./phone";
import { isPlatformNotConnectedError } from "@/lib/platform/credentials";
import { headRecording, presignRecordingUpload, recordingKeyFor } from "./storage";
import { createRecorderToken, recorderTokenMatches } from "./token";
import { transcribeCall } from "./transcription";
import { authContextErrorResponse } from "@/lib/auth/context";
import { currentOrganizationId, inOrg, runInOrganization } from "@/lib/tenancy/scope";
import { BRAND } from "@/lib/brand";

type CallSessionRow = typeof callSessions.$inferSelect;

const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Every /api/calls and /api/call-recorder route catches into this. It mirrors
 * src/lib/crm/api.ts's crmOperationErrorResponse: one class carrying the HTTP
 * status, one function turning any caught error into a Response.
 */
export class CallApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "CallApiError";
  }
}

export function callApiErrorResponse(error: unknown): Response {
  if (error instanceof CallApiError) {
    return Response.json({ error: error.message }, { status: error.status });
  }
  if (isPlatformNotConnectedError(error)) {
    return Response.json({ error: error.message }, { status: 409 });
  }
  const authError = authContextErrorResponse(error);
  if (authError) return authError;
  // requireCrmMutationContext (auth/CSRF) and the parseX() helpers below both
  // throw crm/http and crm/categories' own error types — handle them the same
  // way their own routes do rather than falling through to a bare 500.
  const requestError = crmRequestErrorResponse(error);
  if (requestError) return requestError;
  if (error instanceof CrmConfigurationValidationError) {
    return Response.json({ error: error.message }, { status: 400 });
  }
  console.error("Call API request failed", error);
  return Response.json({ error: "Call request failed" }, { status: 500 });
}

export function isTerminalStatus(status: CallStatus): boolean {
  return (TERMINAL_CALL_STATUSES as readonly string[]).includes(status);
}

export function toCallSummary(row: CallSessionRow): CallSummary {
  return {
    id: row.id,
    personId: row.personId,
    crmRecordId: row.crmRecordId,
    campaignContactId: row.campaignContactId,
    phone: row.phone,
    status: row.status,
    startedAt: row.startedAt ? row.startedAt.toISOString() : null,
    endedAt: row.endedAt ? row.endedAt.toISOString() : null,
    durationMs: row.durationMs,
    hasRecording: row.recordingKey != null,
    recordingOffsetMs: row.recordingOffsetMs,
    error: row.error,
    disposition: row.disposition,
    transcriptStatus: row.transcriptStatus,
    createdAt: row.createdAt.toISOString(),
  };
}

export function toCallDetail(row: CallSessionRow): CallDetail {
  return {
    ...toCallSummary(row),
    transcript: row.transcript ?? null,
    transcriptError: row.transcriptError,
  };
}

/** GET /api/calls/:id — proxy-gated like every other GET route here. */
export async function getCall(callId: string): Promise<CallDetail> {
  if (!UUID_PATTERN.test(callId)) throw new CallApiError(404, "Call not found");
  const [row] = await db.select().from(callSessions).where(and(inOrg(callSessions), eq(callSessions.id, callId))).limit(1);
  if (!row) throw new CallApiError(404, "Call not found");
  return toCallDetail(row);
}

// --- startCall ---------------------------------------------------------------

/**
 * The phone-resolution rule from StartCallRequest, isolated from the person
 * lookup and the DB write so it can be unit-tested without a database.
 * Throws CallApiError the same way the route wants to see it.
 */
export function resolveStartPhone(
  personPhone: string | null,
  requestedPhone: string | null | undefined,
  normalize: (input: string) => string | null = normalizePhone,
): { phone: string; changed: boolean } {
  if (requestedPhone != null && requestedPhone !== "") {
    const normalized = normalize(requestedPhone);
    if (!normalized) {
      throw new CallApiError(400, "Enter the number with its country code, e.g. +91…");
    }
    return { phone: normalized, changed: normalized !== personPhone };
  }
  if (!personPhone) throw new CallApiError(400, "This lead has no phone number");
  return { phone: personPhone, changed: false };
}

export async function startCall(input: StartCallRequest): Promise<StartCallResponse> {
  // Two rounds of queries rather than six in a row: the rep is waiting on
  // this before WhatsApp can dial, and each round trip to the database counts
  // (2.6 s end to end from a local dev server, 29 Sep 2026).
  const [[found], [contact]] = await Promise.all([
    db
      .select({ person: people, companyName: companies.name })
      .from(people)
      .leftJoin(companies, eq(people.companyId, companies.id))
      .where(and(inOrg(people), eq(people.id, input.personId)))
      .limit(1),
    input.campaignContactId
      ? db
          .select({ id: callCampaignContacts.id, personId: callCampaignContacts.personId })
          .from(callCampaignContacts)
          .innerJoin(callCampaigns, eq(callCampaigns.id, callCampaignContacts.campaignId))
          .where(and(inOrg(callCampaigns), eq(callCampaignContacts.id, input.campaignContactId)))
          .limit(1)
      : // A call from elsewhere (the CRM record, Action required) still
        // counts for the lead's open campaign entry — the soonest due — so its
        // result moves their call status and follow-up like one placed there.
        db
          .select({ id: callCampaignContacts.id, personId: callCampaignContacts.personId })
          .from(callCampaignContacts)
          .innerJoin(callCampaigns, eq(callCampaigns.id, callCampaignContacts.campaignId))
          .where(
            and(
              inOrg(callCampaigns),
              eq(callCampaignContacts.personId, input.personId),
              ne(callCampaignContacts.stage, "done"),
              isNull(callCampaigns.archivedAt),
            ),
          )
          .orderBy(sql`${callCampaignContacts.followUpAt} asc nulls last`, desc(callCampaignContacts.lastCalledAt))
          .limit(1),
  ]);
  const campaignContactId = input.campaignContactId ?? contact?.id ?? null;
  if (!found) throw new CallApiError(404, "Lead not found");
  const { person, companyName } = found;

  // A campaign contact must belong to this same person — it's the campaign's
  // link to the call, and stamping call_count/last_called_at on the wrong
  // contact would silently corrupt another lead's call history.
  if (campaignContactId && (!contact || contact.personId !== person.id)) {
    throw new CallApiError(400, "campaignContactId does not belong to this lead");
  }

  const { phone, changed } = resolveStartPhone(person.phone, input.phone);
  const { token, hash } = createRecorderToken();
  const now = new Date();
  const [[row]] = await Promise.all([
    db
      .insert(callSessions)
      .values({
        organizationId: currentOrganizationId(),
        personId: person.id,
        crmRecordId: input.crmRecordId ?? null,
        campaignContactId,
        phone,
        status: "pending",
        uploadTokenHash: hash,
        tokenExpiresAt: new Date(now.getTime() + TOKEN_TTL_MS),
      })
      .returning(),
    changed ? db.update(people).set({ phone, updatedAt: now }).where(and(inOrg(people), eq(people.id, person.id))) : null,
    campaignContactId
      ? db
          .update(callCampaignContacts)
          .set({
            callCount: sql`${callCampaignContacts.callCount} + 1`,
            lastCalledAt: now,
            callStatus: "calling",
            statusUpdatedAt: now,
            updatedAt: now,
          })
          .where(and(
            inArray(callCampaignContacts.campaignId, db.select({ id: callCampaigns.id }).from(callCampaigns).where(inOrg(callCampaigns))),
            eq(callCampaignContacts.id, campaignContactId),
          ))
      : null,
  ]);
  if (!row) throw new Error("call_sessions insert did not return a row");

  return { call: toCallSummary(row), recorderToken: token, lead: recorderLeadFor(person, personCompanyName(person.raw, companyName)) };
}

/** Who the call card on web.whatsapp.com says is being called. */
export function recorderLeadFor(
  person: Pick<typeof people.$inferSelect, "fullName" | "firstName" | "lastName" | "title">,
  companyName: string | null,
): RecorderLead {
  const joined = [person.firstName, person.lastName].map((part) => part?.trim()).filter(Boolean).join(" ");
  const name = person.fullName?.trim() || joined || null;
  const detail = [person.title?.trim(), companyName?.trim()].filter(Boolean).join(" · ") || null;
  const firstName = person.firstName?.trim() || name?.split(/\s+/)[0] || null;
  return { name, detail, firstName, company: companyName?.trim() || null };
}

/** GET /api/call-recorder/calls/:id — the call card's view of a call after upload. */
export function recorderCallStatus(row: CallSessionRow): RecorderCallStatus {
  return {
    status: row.status,
    transcriptStatus: row.transcriptStatus,
    summary: row.transcript?.summary ?? null,
    durationMs: row.durationMs,
  };
}

// --- listCalls -----------------------------------------------------------

export async function listCalls(personId: string): Promise<ListCallsResponse["calls"]> {
  await expireStaleCalls();
  const rows = await db
    .select()
    .from(callSessions)
    .where(and(inOrg(callSessions), eq(callSessions.personId, personId)))
    .orderBy(desc(callSessions.createdAt))
    .limit(50);
  return rows.map(toCallSummary);
}

// --- calls that never report back ----------------------------------------------
// A call is finished by the extension. If it never reports — WhatsApp closed,
// the extension reloaded, the tab gone — the call would stay "pending" (or
// "in_progress") for good. Reads close such calls out first. A call still
// pending this long after it was placed cannot still be ringing (WhatsApp
// gives up in about a minute); one recording this long has lost its recorder.

const PENDING_EXPIRES_AFTER = sql`now() - interval '3 minutes'`;
const IN_PROGRESS_EXPIRES_AFTER = sql`now() - interval '3 hours'`;
/** The reason an auto-closed, never-connected call carries; see finishCall. */
export const NEVER_CONNECTED_ERROR =
  "Never connected — the call was cut, or WhatsApp closed, before the lead picked up";
const RECORDER_LOST_ERROR = "The call stopped reporting — WhatsApp or the extension closed during it";

export async function expireStaleCalls(): Promise<void> {
  const now = new Date();
  const [neverConnected, recorderLost] = await Promise.all([
    db
      .update(callSessions)
      .set({ status: "no_recording", error: NEVER_CONNECTED_ERROR, updatedAt: now })
      .where(and(inOrg(callSessions), eq(callSessions.status, "pending"), lt(callSessions.createdAt, PENDING_EXPIRES_AFTER)))
      .returning(),
    db
      .update(callSessions)
      .set({ status: "failed", error: RECORDER_LOST_ERROR, updatedAt: now })
      .where(and(inOrg(callSessions), eq(callSessions.status, "in_progress"), lt(callSessions.updatedAt, IN_PROGRESS_EXPIRES_AFTER)))
      .returning(),
  ]);
  // Only the request whose update closed a call gets it back, so each
  // closed call moves its lead once.
  await Promise.all([...neverConnected, ...recorderLost].map(applyCallResultToContactSafely));
}

/**
 * The rep's Cancel on a call that has not connected. Only a pending call:
 * one in progress is ended with End call, so its recording is kept.
 */
export async function cancelCall(callId: string): Promise<CallDetail> {
  if (!UUID_PATTERN.test(callId)) throw new CallApiError(404, "Call not found");
  const now = new Date();
  const [updated] = await db
    .update(callSessions)
    .set({ status: "no_recording", error: `Cancelled from ${BRAND.shortName} before it connected`, endedAt: now, updatedAt: now })
    .where(and(inOrg(callSessions), eq(callSessions.id, callId), eq(callSessions.status, "pending")))
    .returning();
  if (updated) {
    // Counts as not picking up: the rep cancels a call that keeps ringing.
    await applyCallResultToContactSafely(updated);
    return toCallDetail(updated);
  }
  const [current] = await db.select().from(callSessions).where(and(inOrg(callSessions), eq(callSessions.id, callId))).limit(1);
  if (!current) throw new CallApiError(404, "Call not found");
  return toCallDetail(current);
}

// --- recorder authorization ------------------------------------------------

/**
 * The comparison rules alone — no DB, no header parsing — so they're testable
 * against a fake row.
 */
export function checkRecorderAuthorization(
  row: Pick<CallSessionRow, "uploadTokenHash" | "tokenExpiresAt">,
  token: string,
  now: Date,
): void {
  if (!recorderTokenMatches(token, row.uploadTokenHash)) {
    throw new CallApiError(401, "Invalid bearer token");
  }
  if (row.tokenExpiresAt.getTime() < now.getTime()) {
    throw new CallApiError(410, "This call's recorder token has expired");
  }
}

export function parseBearerToken(header: string | null): string {
  const match = header ? /^Bearer\s+(.+)$/.exec(header) : null;
  const token = match?.[1]?.trim();
  if (!token) throw new CallApiError(401, "Missing bearer token");
  return token;
}

/**
 * Every /api/call-recorder route starts here instead of a cookie check.
 *
 * There is no session, so this is where the organization is resolved: the
 * call id (a UUID) names the call_sessions row, and the row — once the
 * bearer token matches its hash — names the organization. The lookup is the
 * one deliberately unscoped read of call_sessions; use withRecorderScope to
 * run the rest of the request in the call's organization.
 */
export async function authorizeRecorder(request: Request, callId: string): Promise<CallSessionRow> {
  const token = parseBearerToken(request.headers.get("authorization"));
  if (!UUID_PATTERN.test(callId)) throw new CallApiError(404, "Call not found");

  const [row] = await db.select().from(callSessions).where(eq(callSessions.id, callId)).limit(1);
  if (!row) throw new CallApiError(404, "Call not found");
  checkRecorderAuthorization(row, token, new Date());
  return row;
}

/**
 * Authorizes the recorder's bearer token, then runs `fn` as the call's
 * organization (the scope that uploads' R2 credentials, transcription's
 * model settings and the CRM follow-up all read).
 */
export async function withRecorderScope<T>(
  request: Request,
  callId: string,
  fn: (row: CallSessionRow) => Promise<T>,
): Promise<T> {
  const row = await authorizeRecorder(request, callId);
  return runInOrganization(row.organizationId, () => fn(row));
}

// --- recording download ----------------------------------------------------

export async function getCallForDownload(callId: string): Promise<CallSessionRow> {
  if (!UUID_PATTERN.test(callId)) throw new CallApiError(404, "Call not found");
  const [row] = await db.select().from(callSessions).where(and(inOrg(callSessions), eq(callSessions.id, callId))).limit(1);
  if (!row || !row.recordingKey) throw new CallApiError(404, "This call has no recording");
  return row;
}

// --- POST .../transcribe (manual retry) -------------------------------------

/** 404 if missing, 409 if there's no recording to transcribe yet. */
export async function requireRecordedCall(callId: string): Promise<CallSessionRow> {
  if (!UUID_PATTERN.test(callId)) throw new CallApiError(404, "Call not found");
  const [row] = await db.select().from(callSessions).where(and(inOrg(callSessions), eq(callSessions.id, callId))).limit(1);
  if (!row) throw new CallApiError(404, "Call not found");
  if (row.status !== "recorded") throw new CallApiError(409, "This call has no recording to transcribe");
  return row;
}

// --- POST .../started --------------------------------------------------------

export function parseCallStartedRequest(value: unknown): CallStartedRequest {
  assertObject(value);
  assertExactKeys(value, ["startedAt"]);
  return { startedAt: parseIsoTimestamp(value.startedAt, "startedAt") };
}

/** Only a pending call can start; a retried/duplicate report is a no-op. */
export async function markCallStarted(row: CallSessionRow, startedAt: Date): Promise<CallSummary> {
  if (row.status !== "pending") return toCallSummary(row);
  const [updated] = await db
    .update(callSessions)
    .set({ status: "in_progress", startedAt, updatedAt: new Date() })
    .where(and(inOrg(callSessions), eq(callSessions.id, row.id)))
    .returning();
  return toCallSummary(updated ?? row);
}

// --- POST .../upload-url ------------------------------------------------------

export function parseUploadUrlRequest(value: unknown): UploadUrlRequest {
  assertObject(value);
  assertExactKeys(value, ["contentType", "bytes"]);
  return {
    contentType: parseRequiredText(value.contentType, "contentType", 200),
    bytes: parseNonNegativeInteger(value.bytes, "bytes"),
  };
}

/** The business rules for issuing an upload URL, separated from the S3 call. */
export function assertUploadAllowed(row: Pick<CallSessionRow, "status">, input: UploadUrlRequest): void {
  if (isTerminalStatus(row.status)) throw new CallApiError(409, "This call has already finished");
  if (!input.contentType.startsWith("audio/")) {
    throw new CallApiError(400, "contentType must be an audio/* MIME type");
  }
  if (input.bytes < 1) throw new CallApiError(400, "bytes must be a positive integer");
  if (input.bytes > MAX_RECORDING_BYTES) throw new CallApiError(413, "Recording is too large");
}

export async function issueUploadUrl(row: CallSessionRow, input: UploadUrlRequest): Promise<UploadUrlResponse> {
  assertUploadAllowed(row, input);
  const key = recordingKeyFor(row.id, row.createdAt, input.contentType);
  const { url, headers } = await presignRecordingUpload(key, input.contentType);
  return { uploadUrl: url, recordingKey: key, headers };
}

// --- POST .../finish -----------------------------------------------------

/** Exported for reuse by src/lib/calls/campaigns.ts's own request parsers. */
export function parseIsoTimestamp(value: unknown, label: string): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    throw new CrmConfigurationValidationError(`${label} must be an ISO 8601 timestamp`);
  }
  return value;
}

export function parseOptionalIsoTimestamp(value: unknown, label: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return parseIsoTimestamp(value, label);
}

export function parseFinishCallRequest(value: unknown): FinishCallRequest {
  assertObject(value);
  const outcome = value.outcome;
  if (outcome === "recorded") {
    assertExactKeys(value, [
      "outcome",
      "recordingKey",
      "bytes",
      "contentType",
      "startedAt",
      "endedAt",
      "durationMs",
      "recordingOffsetMs",
    ]);
    return {
      outcome: "recorded",
      recordingKey: parseRequiredText(value.recordingKey, "recordingKey", 500),
      bytes: parseNonNegativeInteger(value.bytes, "bytes"),
      contentType: parseRequiredText(value.contentType, "contentType", 200),
      startedAt: parseIsoTimestamp(value.startedAt, "startedAt"),
      endedAt: parseIsoTimestamp(value.endedAt, "endedAt"),
      durationMs: parseNonNegativeInteger(value.durationMs, "durationMs"),
      ...(value.recordingOffsetMs === undefined
        ? {}
        : { recordingOffsetMs: parseNonNegativeInteger(value.recordingOffsetMs, "recordingOffsetMs") }),
    };
  }
  if (outcome === "no_recording") {
    assertExactKeys(value, ["outcome", "startedAt", "endedAt", "error"]);
    return {
      outcome: "no_recording",
      startedAt: parseOptionalIsoTimestamp(value.startedAt, "startedAt"),
      endedAt: parseOptionalIsoTimestamp(value.endedAt, "endedAt"),
      ...(typeof value.error === "string" && value.error.trim() ? { error: value.error.trim().slice(0, 1000) } : {}),
    };
  }
  if (outcome === "failed") {
    assertExactKeys(value, ["outcome", "error"]);
    return { outcome: "failed", error: parseRequiredText(value.error, "error", 10_000) };
  }
  throw new CrmConfigurationValidationError("outcome must be one of: recorded, no_recording, failed");
}

/** recordingKey is server-derived, not extension-supplied — this is what stops it being spoofed. */
export function assertRecordingKeyMatches(
  row: Pick<CallSessionRow, "id" | "createdAt">,
  recordingKey: string,
  contentType: string,
): void {
  if (recordingKey !== recordingKeyFor(row.id, row.createdAt, contentType)) {
    throw new CallApiError(400, "recordingKey does not match this call");
  }
}

export async function finishCall(row: CallSessionRow, body: FinishCallRequest): Promise<FinishCallResponse["call"]> {
  // Idempotent once terminal: a retried report from the extension (e.g. after
  // a flaky response) must not re-run side effects or flip the status again.
  // A recording can still arrive for a call reads closed out as never
  // connected (expireStaleCalls) — it did connect after all; keep it.
  const autoClosed = row.status === "no_recording" && row.error === NEVER_CONNECTED_ERROR;
  if (isTerminalStatus(row.status) && !(autoClosed && body.outcome === "recorded")) return toCallSummary(row);
  // The check above reads a row loaded before this request; two reports in
  // flight at once would both pass it. Every update below therefore also
  // requires the call to still be open, and one that matches nothing lost
  // that race: the call is returned as the winner left it, with no side
  // effects (no second transcription).
  const stillOpen = and(
    inOrg(callSessions),
    eq(callSessions.id, row.id),
    or(
      inArray(callSessions.status, ["pending", "in_progress"]),
      and(eq(callSessions.status, "no_recording"), eq(callSessions.error, NEVER_CONNECTED_ERROR)),
    ),
  );
  const asFinished = async () => {
    const [current] = await db.select().from(callSessions).where(and(inOrg(callSessions), eq(callSessions.id, row.id))).limit(1);
    return toCallSummary(current ?? row);
  };

  if (body.outcome === "recorded") {
    assertRecordingKeyMatches(row, body.recordingKey, body.contentType);
    const head = await headRecording(body.recordingKey);
    if (!head) throw new CallApiError(409, "upload not found");
    const [updated] = await db
      .update(callSessions)
      .set({
        status: "recorded",
        recordingKey: body.recordingKey,
        recordingBytes: head.bytes,
        recordingContentType: body.contentType,
        startedAt: new Date(body.startedAt),
        endedAt: new Date(body.endedAt),
        durationMs: body.durationMs,
        recordingOffsetMs: body.recordingOffsetMs ?? null,
        error: null, // an auto-closed call that connected after all loses its "never connected"
        // Claimed here, in the same update as the status flip to "recorded" —
        // that's what makes the fire-and-forget transcribeCall() below safe
        // without its own claim: only one finish can ever win this update.
        transcriptStatus: "pending",
        updatedAt: new Date(),
      })
      .where(stillOpen)
      .returning();
    if (!updated) return asFinished();
    await applyCallResultToContactSafely(updated);
    const result = toCallSummary(updated);
    // Not awaited: the extension is waiting on this response, and
    // transcription can take a while. Any failure lands in transcript_error
    // via transcribeCall's own try/catch — this .catch is just a backstop
    // against a programming error escaping it.
    void transcribeCall(row.id).catch((error) => console.error("transcribeCall failed", row.id, error));
    return result;
  }

  if (body.outcome === "no_recording") {
    const [updated] = await db
      .update(callSessions)
      .set({
        status: "no_recording",
        startedAt: body.startedAt === undefined ? row.startedAt : body.startedAt ? new Date(body.startedAt) : null,
        endedAt: body.endedAt === undefined ? row.endedAt : body.endedAt ? new Date(body.endedAt) : null,
        ...(body.error ? { error: body.error } : {}),
        updatedAt: new Date(),
      })
      .where(stillOpen)
      .returning();
    if (!updated) return asFinished();
    await applyCallResultToContactSafely(updated);
    return toCallSummary(updated);
  }

  // outcome === "failed"
  const [updated] = await db
    .update(callSessions)
    .set({ status: "failed", error: body.error.slice(0, 1000), updatedAt: new Date() })
    .where(stillOpen)
    .returning();
  if (!updated) return asFinished();
  await applyCallResultToContactSafely(updated);
  return toCallSummary(updated);
}
