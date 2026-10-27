import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { platformSettings } from "@/lib/managed/schema";

/**
 * A private pilot grant is operator data, never a workspace setting that
 * its owner can self-approve. Each grant is an exact workspace/user pair.
 * This does not publish customer login or share anybody else's login.
 */
export const CLAUDE_PRIVATE_PILOTS = "claude-private-pilots";

export async function privateClaudePilot(organizationId: string, userId: string): Promise<boolean> {
  const [row] = await db.select({ value: platformSettings.value }).from(platformSettings)
    .where(eq(platformSettings.key, CLAUDE_PRIVATE_PILOTS)).limit(1);
  const grants = row?.value.grants;
  return Array.isArray(grants) && grants.some((value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const grant = value as Record<string, unknown>;
    return grant.organizationId === organizationId && grant.userId === userId;
  });
}
