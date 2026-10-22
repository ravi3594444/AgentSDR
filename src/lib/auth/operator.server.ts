import "server-only";

import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { members, organizations } from "./schema";

/**
 * The operator organization — flagged `initial` by the migration from the
 * single-workspace app, else the oldest one — i.e. the team that runs this
 * AgentSDR instance. Kept apart from context.ts so background work (which
 * has no session) can ask without loading the auth server.
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
