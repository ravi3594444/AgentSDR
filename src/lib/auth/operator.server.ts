import "server-only";

import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { platformOperators } from "@/lib/managed/schema";
import { members, organizations } from "./schema";

/**
 * Whether this person holds an explicit platform operator grant
 * (`platform_operators`, scripts/grant-platform-operator.ts). The only test
 * for operator access: no organization role implies it. A missing table
 * (the migration has not run yet) means nobody is an operator.
 */
export async function isPlatformOperatorUser(userId: string): Promise<boolean> {
  try {
    const [row] = await db
      .select({ userId: platformOperators.userId })
      .from(platformOperators)
      .where(eq(platformOperators.userId, userId))
      .limit(1);
    return Boolean(row);
  } catch (error) {
    for (let current: unknown = error; current && typeof current === "object"; current = (current as { cause?: unknown }).cause) {
      if ((current as { code?: unknown }).code === "42P01") return false;
    }
    throw error;
  }
}

/**
 * The operator organization — flagged `initial` by the migration from the
 * single-workspace app, else the oldest one. Used only by the Claude Code
 * subscription-login pilot (src/lib/ai/claudeCode/), which stays restricted
 * to an owner of this one organization. It is NOT platform operator access:
 * that is the explicit grant above. Kept apart from context.ts so background
 * work (which has no session) can ask without loading the auth server.
 */
export async function operatorOrganizationId(): Promise<string | null> {
  const [flagged] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(sql`${organizations.metadata}::jsonb ->> 'initial' = 'true'`)
    .limit(1);
  if (flagged) return flagged.id;
  const [oldest] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .orderBy(organizations.createdAt)
    .limit(1);
  return oldest?.id ?? null;
}

/** Whether this person currently holds the owner role in this organization (roles are comma-separated). */
export async function isOrganizationOwner(organizationId: string, userId: string): Promise<boolean> {
  const [membership] = await db
    .select({ role: members.role })
    .from(members)
    .where(and(eq(members.organizationId, organizationId), eq(members.userId, userId)))
    .limit(1);
  return membership?.role.split(",").some((role) => role.trim() === "owner") ?? false;
}
