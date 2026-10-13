import { and, eq, or, sql } from "drizzle-orm";
import { people } from "./schema";
import { normalizeEmail, normalizeLinkedinSlug } from "./identity";
import { inOrg } from "@/lib/tenancy/scope";
import { upsertPerson, withLeadTransaction } from "./records";
import { checkPhone } from "@/lib/calls/phone";
import { organizationPhoneCountry } from "@/lib/calls/phone.server";

export type ManualPersonInput = {
  email?: string | null;
  linkedinUrl?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  fullName?: string | null;
  title?: string | null;
  companyName?: string | null;
  companyDomain?: string | null;
  notes?: string | null;
  /** Free-form ("+91 98765 43210", "0091…"). Invalid input is dropped, not rejected — see normalizeManualPersonInput. */
  phone?: string | null;
};

const clean = (value: string | null | undefined) => value?.trim() || null;
/** The same rules (and the same outcome) as the import report's checkPhone. */
const phoneOrNull = (input: string, country?: string) => {
  const checked = checkPhone(input, country);
  return checked.ok ? checked.e164 : null;
};

/** `phoneCountry`: assumed for a number typed without a + (the organization's default phone country). */
export function normalizeManualPersonInput(input: ManualPersonInput, phoneCountry?: string) {
  const email = normalizeEmail(input.email);
  const linkedinUrl = normalizeLinkedinSlug(input.linkedinUrl);
  if (input.email && !email) throw new Error(`Invalid email address: ${input.email}`);
  if (input.linkedinUrl && !linkedinUrl) throw new Error(`Invalid LinkedIn profile URL: ${input.linkedinUrl}`);
  if (!email && !linkedinUrl) throw new Error("An Email or LinkedIn URL is required");
  return {
    email,
    linkedinUrl,
    firstName: clean(input.firstName),
    lastName: clean(input.lastName),
    fullName: clean(input.fullName),
    title: clean(input.title),
    companyName: clean(input.companyName),
    companyDomain: clean(input.companyDomain),
    notes: clean(input.notes),
    // A malformed phone number shouldn't fail the whole row — it's less
    // load-bearing than an email or LinkedIn identity, so it's just dropped.
    phone: input.phone ? phoneOrNull(input.phone, phoneCountry) : null,
  };
}

/** Person-only manual import. It intentionally never writes any CRM table. */
export async function upsertManualPerson(input: ManualPersonInput) {
  const normalized = normalizeManualPersonInput(input, await organizationPhoneCountry());
  return withLeadTransaction(async (tx) => {
    const existing = await tx.select({ id: people.id }).from(people).where(and(inOrg(people), or(
      normalized.email ? sql`lower(${people.email}) = ${normalized.email}` : undefined,
      normalized.linkedinUrl ? eq(people.linkedinUrl, normalized.linkedinUrl) : undefined,
    )));
    const person = await upsertPerson(tx, {
      email: normalized.email,
      linkedinUrl: normalized.linkedinUrl,
      firstName: normalized.firstName,
      lastName: normalized.lastName,
      fullName: normalized.fullName,
      title: normalized.title,
      phone: normalized.phone,
      company: normalized.companyName || normalized.companyDomain ? {
        name: normalized.companyName,
        domain: normalized.companyDomain,
      } : null,
      raw: normalized.notes ? { notes: normalized.notes } : undefined,
      source: "manual-people-import",
    });
    return { personId: person.id, created: existing.length === 0 };
  });
}
