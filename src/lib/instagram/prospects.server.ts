import "server-only";
import { and, eq, sql } from "drizzle-orm";
import { people } from "@/lib/leads/schema";
import {
  createProvisionalPerson,
  upsertPerson,
  type LeadExecutor,
  type CanonicalPersonInput,
} from "@/lib/leads/records";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";
import { instagramUsername } from "./parse";

/** Keep an Instagram-only lead as a real Person without inventing an email or phone. */
export async function upsertInstagramProspect(
  tx: LeadExecutor,
  usernameInput: string,
  input: CanonicalPersonInput,
) {
  const username = instagramUsername(usernameInput)?.toLowerCase();
  if (!username)
    throw new Error("The discovered Instagram username is invalid");
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`${currentOrganizationId()}:instagram:${username}`}, 0))`,
  );
  const existing = await tx
    .select()
    .from(people)
    .where(
      and(
        inOrg(people),
        sql`lower(${people.raw} -> 'instagram' ->> 'username') = ${username}`,
      ),
    )
    .limit(2);
  if (existing.length > 1)
    throw new Error(
      `Instagram @${username} belongs to multiple People; resolve the duplicate before outreach`,
    );
  if (!existing.length && !input.email && !input.linkedinUrl && input.phone) {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`person:phone:${input.phone}`},0))`,
    );
    const matches = await tx
      .select()
      .from(people)
      .where(and(inOrg(people), eq(people.phone, input.phone)))
      .limit(2);
    if (matches.length > 1)
      throw new Error(
        "The Instagram profile's phone belongs to multiple People; resolve the identity before outreach",
      );
    if (matches[0]) existing.push(matches[0]);
  }
  if (existing[0]) {
    const previous = existing[0].raw.instagram as
      | Record<string, unknown>
      | undefined;
    const incoming = input.raw?.instagram as
      | Record<string, unknown>
      | undefined;
    const raw = {
      ...existing[0].raw,
      ...input.raw,
      instagram: { ...previous, ...incoming, username },
    };
    const [updated] = await tx
      .update(people)
      .set({ raw, updatedAt: new Date() })
      .where(and(inOrg(people), eq(people.id, existing[0].id)))
      .returning();
    return updated!;
  }
  const normalized = {
    ...input,
    raw: {
      ...input.raw,
      instagram: {
        ...(input.raw?.instagram as Record<string, unknown> | undefined),
        username,
      },
    },
  };
  const person =
    input.email || input.linkedinUrl
      ? await upsertPerson(tx, normalized)
      : await createProvisionalPerson(tx, normalized);
  return person;
}
