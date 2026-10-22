import { withOperator } from "@/lib/auth/operatorAccess.server";
import { managedAiProblem } from "@/lib/managed/catalog";
import { getManagedAiSettings, listPlatformCredentialStatus, storedPlatformCredentialKeys } from "@/lib/managed/store.server";

/**
 * GET /api/platform/credentials — the operator panel: which default keys are
 * stored (masked hints only, never a secret), and the Included AI engine and
 * model. Platform operators only (404 for everyone else).
 */
export async function GET(request: Request) {
  return withOperator(request, async () => {
    const [credentials, ai, stored] = await Promise.all([listPlatformCredentialStatus(), getManagedAiSettings(), storedPlatformCredentialKeys()]);
    return Response.json({ credentials, ai, aiProblem: ai.engine ? managedAiProblem(ai, stored) : null }, { headers: { "Cache-Control": "no-store" } });
  });
}
