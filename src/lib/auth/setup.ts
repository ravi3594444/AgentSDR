import "server-only";

import { hashPassword } from "better-auth/crypto";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { slugify } from "./slug";
import type { SetupInput } from "./setupInput";
import { channelSettings } from "@/lib/channels/schema";
import { accounts, members, organizations, users } from "./schema";

/**
 * First-run setup of a fresh instance: with no user yet, /setup creates the
 * first admin and their organization in one step, with no verification email
 * (a new self-hoster may have no mail provider yet).
 */

/** Arbitrary constant: serialises concurrent setups for the length of a transaction. */
const SETUP_LOCK = 724_105_301;

export class SetupAlreadyDoneError extends Error {
  constructor() {
    super("This instance is already set up.");
  }
}

/** True until the first user exists. Once false it never becomes true again. */
export async function needsSetup(): Promise<boolean> {
  const [anyUser] = await db.select({ id: users.id }).from(users).limit(1);
  return !anyUser;
}

/**
 * Creates the user (email verified), their credential account, the initial
 * organization (the one `operatorOrganizationId` looks for) and an owner
 * membership, atomically. Rows are shaped exactly as Better Auth's own
 * signUpEmail writes them (credential account: accountId = user id, password
 * hashed with Better Auth's hashPassword, which signInEmail verifies with),
 * so signing in afterwards is an ordinary sign-in. Throws
 * SetupAlreadyDoneError if any user exists.
 */
export async function createInitialAdmin(input: SetupInput): Promise<{ userId: string; organizationId: string }> {
  const passwordHash = await hashPassword(input.password);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${SETUP_LOCK})`);
    const [existing] = await tx.select({ id: users.id }).from(users).limit(1);
    if (existing) throw new SetupAlreadyDoneError();

    const [user] = await tx
      .insert(users)
      .values({ name: input.name, email: input.email.toLowerCase(), emailVerified: true })
      .returning({ id: users.id });
    await tx.insert(accounts).values({ userId: user.id, providerId: "credential", accountId: user.id, password: passwordHash });
    const [organization] = await tx
      .insert(organizations)
      .values({
        name: input.organizationName,
        slug: slugify(input.organizationName) || "workspace",
        metadata: JSON.stringify({ initial: true }),
      })
      .returning({ id: organizations.id });
    await tx.insert(members).values({ organizationId: organization.id, userId: user.id, role: "owner" });
    // The browser's time zone (validated in setupInput.ts) starts the
    // organization's day (Settings → Sending defaults). UTC is the default, not stored.
    if (input.timeZone && input.timeZone !== "UTC") {
      await tx.insert(channelSettings).values({
        organizationId: organization.id,
        channel: "general",
        values: { timeZone: input.timeZone },
        updatedBy: user.id,
      });
    }
    return { userId: user.id, organizationId: organization.id };
  });
}
