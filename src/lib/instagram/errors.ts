import { authContextErrorResponse } from "@/lib/auth/context";
import { CrmConfigurationValidationError } from "@/lib/crm/categories";
import { crmRequestErrorResponse } from "@/lib/crm/http";
import { FeatureDisabledError } from "@/lib/features/flags.server";
import { isPlatformNotConnectedError } from "@/lib/platform/credentials";
import { UnipileInstagramError } from "@/services/unipile.instagram";

/**
 * Errors of the /api/instagram routes. A request the API answers with a
 * status of its choosing (404, 400, 409) throws InstagramApiError; the
 * feature switch being off and Unipile not being connected both answer 409.
 */
export class InstagramApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "InstagramApiError";
  }
}

export function instagramApiErrorResponse(error: unknown): Response {
  if (error instanceof InstagramApiError) return Response.json({ error: error.message }, { status: error.status });
  if (error instanceof FeatureDisabledError) return Response.json({ error: error.message, code: "FEATURE_DISABLED" }, { status: 409 });
  if (isPlatformNotConnectedError(error)) return Response.json({ error: error.message }, { status: 409 });
  const authError = authContextErrorResponse(error);
  if (authError) return authError;
  const requestError = crmRequestErrorResponse(error);
  if (requestError) return requestError;
  if (error instanceof CrmConfigurationValidationError) return Response.json({ error: error.message }, { status: 400 });
  if (error instanceof UnipileInstagramError) {
    // Unipile's own answer, passed on as a bad gateway: the request was fine, the provider was not.
    console.error("Unipile Instagram request failed", error);
    return Response.json({ error: error.message }, { status: 502 });
  }
  console.error("Instagram API request failed", error);
  return Response.json({ error: "Instagram request failed" }, { status: 500 });
}
