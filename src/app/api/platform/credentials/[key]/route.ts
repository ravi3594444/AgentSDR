import { OperatorActionError, withOperator } from "@/lib/auth/operatorAccess.server";
import { isPlatformCredentialKey } from "@/lib/managed/catalog";
import { PlatformCredentialError, removePlatformCredential, storePlatformCredential } from "@/lib/managed/store.server";
import { verifyPlatformCredential } from "@/lib/managed/verify.server";
import { onPlatformCredentialRemoved, onPlatformCredentialStored } from "@/lib/managed/hooks.server";

type Ctx = { params: Promise<{ key: string }> };

/**
 * PUT /api/platform/credentials/:key — store or replace one default key,
 * verified with one cheap call first. A secret left blank keeps the stored
 * one. The answer is the masked status. Platform operators only.
 */
export async function PUT(request: Request, { params }: Ctx) {
  return withOperator(request, async (operator) => {
    const { key } = await params;
    if (!isPlatformCredentialKey(key)) throw new OperatorActionError("Unknown provider", 404);
    const body: unknown = await request.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new OperatorActionError("Invalid request body");
    try {
      const status = await storePlatformCredential(key, body as Record<string, unknown>, { userId: operator.userId, verify: verifyPlatformCredential });
      await onPlatformCredentialStored(key);
      return Response.json(status);
    } catch (error) {
      if (error instanceof PlatformCredentialError) throw new OperatorActionError(error.message);
      throw error;
    }
  });
}

/** DELETE /api/platform/credentials/:key — remove one default key. Included workspaces stop using that provider. */
export async function DELETE(request: Request, { params }: Ctx) {
  return withOperator(request, async () => {
    const { key } = await params;
    if (!isPlatformCredentialKey(key)) throw new OperatorActionError("Unknown provider", 404);
    await onPlatformCredentialRemoved(key);
    const removed = await removePlatformCredential(key);
    return Response.json({ ok: true, removed });
  });
}
