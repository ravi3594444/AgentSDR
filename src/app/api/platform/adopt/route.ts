import { OperatorActionError, withOperator } from "@/lib/auth/operatorAccess.server";
import { adoptableSources, adoptFromOrganization } from "@/lib/managed/adopt.server";
import { isPlatformCredentialKey } from "@/lib/managed/catalog";
import { verifyPlatformCredential } from "@/lib/managed/verify.server";
import { onPlatformCredentialStored } from "@/lib/managed/hooks.server";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** GET /api/platform/adopt — organizations with credentials of their own, and which providers (names only). Operators only. */
export async function GET(request: Request) {
  return withOperator(request, async () => Response.json({ sources: await adoptableSources() }, { headers: { "Cache-Control": "no-store" } }));
}

/**
 * POST /api/platform/adopt { organizationId, keys } — copy that one
 * organization's own credentials for those providers into the platform's
 * defaults, each verified first. Only on this explicit request; the
 * originals stay as they are. Operators only.
 */
export async function POST(request: Request) {
  return withOperator(request, async (operator) => {
    const body = (await request.json().catch(() => null)) as { organizationId?: unknown; keys?: unknown } | null;
    const organizationId = typeof body?.organizationId === "string" ? body.organizationId : "";
    if (!UUID.test(organizationId)) throw new OperatorActionError("Name the organization to adopt from");
    const keys = Array.isArray(body?.keys) ? body.keys.filter(isPlatformCredentialKey) : [];
    if (!keys.length) throw new OperatorActionError("Choose at least one provider");
    try {
      const result = await adoptFromOrganization(organizationId, keys, { userId: operator.userId, verify: verifyPlatformCredential });
      for (const key of result.adopted) await onPlatformCredentialStored(key);
      return Response.json(result);
    } catch (error) {
      if (error instanceof Error && error.message === "No such organization") throw new OperatorActionError(error.message, 404);
      throw error;
    }
  });
}
