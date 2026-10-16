import "server-only";

import { requirePermission, withOrgContext, type OrgContext } from "@/lib/auth/context";
import { assertExactKeys, assertObject, CrmConfigurationValidationError } from "@/lib/crm/categories";
import { assertSameOriginMutation } from "@/lib/crm/http";
import { requireFeature } from "@/lib/features/flags.server";
import { requirePlatformCredentials } from "@/lib/platform/credentials";
import { InstagramApiError, instagramApiErrorResponse } from "./errors";

/**
 * The shared frame of src/app/api/instagram/**: the caller's organization
 * scope (withOrgContext), the Instagram feature switch and the Unipile
 * connection (each 409 when missing), and — for linking, syncing, importing
 * and the inquiry switch — the integrations permission (owners and admins).
 * Mutations are also held to the same origin, as the CRM's are.
 */
export async function instagramRoute(
  request: Request,
  fn: (ctx: OrgContext) => Promise<Response>,
  options: { manage?: boolean } = {},
): Promise<Response> {
  try {
    assertSameOriginMutation(request);
    return await withOrgContext(request, async (ctx) => {
      if (options.manage) requirePermission(ctx, { integrations: ["manage"] });
      await requireFeature("instagram");
      await requirePlatformCredentials("unipile");
      return fn(ctx);
    });
  } catch (error) {
    return instagramApiErrorResponse(error);
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A path id that is not a UUID cannot exist: 404, before it reaches a uuid column. */
export function assertIdParam(value: string, label: string): string {
  if (!UUID_PATTERN.test(value)) throw new InstagramApiError(404, `${label} not found`);
  return value;
}

/** An optional query-string UUID: absent → null, malformed → 400. */
export function optionalUuidQuery(value: string | null, label: string): string | null {
  if (!value) return null;
  if (!UUID_PATTERN.test(value)) throw new InstagramApiError(400, `${label} must be a UUID`);
  return value;
}

/** PATCH /api/instagram/accounts/:id — `{ inquiryIntake: boolean }`, nothing else. */
export function parseAccountUpdateRequest(value: unknown): { inquiryIntake: boolean } {
  assertObject(value);
  assertExactKeys(value, ["inquiryIntake"]);
  if (typeof value.inquiryIntake !== "boolean") throw new CrmConfigurationValidationError("inquiryIntake must be true or false");
  return { inquiryIntake: value.inquiryIntake };
}
