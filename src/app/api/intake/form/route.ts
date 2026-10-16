import { type NextRequest, NextResponse } from "next/server";
import { featureEnabled, FeatureDisabledError } from "@/lib/features/flags.server";
import { findIntakeEndpointByToken } from "@/lib/intake/endpoints.server";
import { isSupportedContentType, parseSubmission, SUPPORTED_CONTENT_TYPES } from "@/lib/intake/fields";
import { errorSummary } from "@/lib/intake/http";
import { INTAKE_SUBMISSIONS_PER_HOUR, intakeRateLimit, recordFormInquiry } from "@/lib/intake/inquiries.server";
import { looksLikeIntakeToken } from "@/lib/intake/tokens";
import { runInOrganization } from "@/lib/tenancy/scope";

/**
 * POST /api/intake/form — the website-form webhook an owner adds to their
 * form tool (Zapier / Make "Webhooks → POST", a Webflow or WordPress form
 * plugin, or their developer). Public in proxy.ts: it authenticates itself
 * with the endpoint's secret token, sent as
 *
 *   X-AgentSDR-Token: agsdr_form_…        (recommended)
 *   Authorization: Bearer agsdr_form_…
 *   ?token=agsdr_form_…                   (fallback for tools that cannot set
 *                                          headers; URLs end up in logs)
 *
 * The token's hash names the endpoint and so its organization — the one
 * deliberately unscoped read — and everything after runs in that scope.
 *
 * Body: application/json (an object; a form's fields may sit in `data`,
 * `fields: [{ name, value }]` and the like), application/x-www-form-urlencoded,
 * or multipart/form-data (text fields), at most 64 KB. `?historical=1` marks
 * a backfill of old submissions: stored and listed, never acted on.
 *
 * 202 { ok, inquiryId, duplicate, status } — recorded (or already recorded:
 * a retry is a no-op). 400 no fields / unreadable body, 401 unknown token,
 * 403 endpoint turned off, 409 Inquiry intake off for the organization
 * (nothing stored), 413 too large, 415 other content types, 429 the
 * endpoint's hourly limit (INTAKE_SUBMISSIONS_PER_HOUR) reached, with
 * Retry-After, 500 a failure worth retrying. Past the endpoint's daily limit
 * of new contacts the submission is still 202, stored as unusable with that
 * reason (inquiries.server.ts).
 *
 * Errors are logged by name and code only: a query's message carries the
 * visitor's details.
 */

const MAX_BODY_BYTES = 64 * 1024;

function fail(status: number, error: string, headers?: HeadersInit) {
  return NextResponse.json({ ok: false, error }, { status, headers });
}

function tokenOf(req: NextRequest): string | null {
  const header = req.headers.get("x-agentsdr-token")?.trim();
  if (header) return header;
  const bearer = /^bearer\s+(\S+)\s*$/i.exec(req.headers.get("authorization") ?? "")?.[1];
  if (bearer) return bearer;
  return req.nextUrl.searchParams.get("token")?.trim() || null;
}

/** The body, or null past the limit (checked against Content-Length first, then while reading). */
async function readBody(req: NextRequest, limit: number): Promise<Uint8Array | null> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > limit) return null;
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function POST(req: NextRequest) {
  const token = tokenOf(req);
  if (!token) return fail(401, "Send the endpoint's token in the X-AgentSDR-Token header.");
  if (!looksLikeIntakeToken(token)) return fail(401, "Unknown token.");
  const endpoint = await findIntakeEndpointByToken(token);
  if (!endpoint) return fail(401, "Unknown token.");
  if (!endpoint.enabled) return fail(403, "This endpoint is turned off. Turn it on in Settings → Inquiries.");

  const historical = ["1", "true", "yes"].includes((req.nextUrl.searchParams.get("historical") ?? "").toLowerCase());
  // Read before the body: some runtimes set a multipart boundary header lazily.
  const contentType = req.headers.get("content-type");

  try {
    return await runInOrganization(endpoint.organizationId, async () => {
      if (!(await featureEnabled("inquiry_intake"))) throw new FeatureDisabledError("inquiry_intake");
      if (!isSupportedContentType(contentType)) {
        return fail(415, `Send the submission as ${SUPPORTED_CONTENT_TYPES.join(", ")}.`);
      }
      // Before the body is read: a flood costs one count per request.
      const limited = await intakeRateLimit(endpoint.id);
      if (limited) {
        return fail(
          429,
          `This form has sent ${INTAKE_SUBMISSIONS_PER_HOUR} submissions in the last hour. Retry later.`,
          { "retry-after": String(limited.retryAfterSeconds) },
        );
      }
      const body = await readBody(req, MAX_BODY_BYTES);
      if (!body) return fail(413, `The submission is larger than ${MAX_BODY_BYTES / 1024} KB.`);
      const parsed = await parseSubmission(body, contentType);
      if (!parsed.ok) return fail(parsed.status, parsed.error);

      const result = await recordFormInquiry(endpoint, parsed.fields, { historical });
      return NextResponse.json(
        { ok: true, inquiryId: result.inquiryId, duplicate: result.duplicate, status: result.status },
        { status: 202 },
      );
    });
  } catch (error) {
    if (error instanceof FeatureDisabledError) return fail(409, error.message);
    console.error(`[intake/form] could not record a submission for endpoint ${endpoint.id}: ${errorSummary(error)}`);
    return fail(500, "The submission could not be recorded. Retry it.");
  }
}
