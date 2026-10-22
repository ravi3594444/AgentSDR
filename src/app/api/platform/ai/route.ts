import { OperatorActionError, withOperator } from "@/lib/auth/operatorAccess.server";
import { PlatformCredentialError, saveManagedAiSettings } from "@/lib/managed/store.server";

/**
 * PUT /api/platform/ai — which engine (OpenRouter, AI/ML API or Anthropic)
 * and default model every Included workspace uses. Refused when it could not
 * run (its key not stored, a model of another engine). The Claude Code
 * subscription login is not an engine here. Platform operators only.
 */
export async function PUT(request: Request) {
  return withOperator(request, async (operator) => {
    const body: unknown = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new OperatorActionError("Invalid request body");
    try {
      return Response.json(await saveManagedAiSettings(body, operator.userId));
    } catch (error) {
      if (error instanceof PlatformCredentialError) throw new OperatorActionError(error.message);
      throw error;
    }
  });
}
