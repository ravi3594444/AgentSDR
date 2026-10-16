import "server-only";

import { and, asc, count, eq, gt, isNull, min, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { findOrCreateContactPerson } from "@/lib/calls/campaigns";
import { checkPhone, type PhoneCheck } from "@/lib/calls/phone";
import { organizationPhoneCountry } from "@/lib/calls/phone.server";
import { requireFeature } from "@/lib/features/flags.server";
import { cleanJson, cleanString } from "@/lib/grid/sanitize";
import { personCompanyName } from "@/lib/leads/companyName";
import { inferCompanyDomainFromEmail, normalizeCompanyDomain } from "@/lib/leads/identity";
import { resolvePersonNames, upsertPerson, withLeadTransaction, type LeadExecutor } from "@/lib/leads/records";
import { companies, people } from "@/lib/leads/schema";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";
import { inquiryDedupeKey, mapSubmission, type DroppedValue, type FlatField, type MappedSubmission } from "./fields";
import { inquiries, intakeEndpoints, type InquiryStatus, type IntakeEndpointRow } from "./schema";

/**
 * A website-form submission becomes an inquiry, and — when it carries a
 * usable email or phone — a contact. Nothing is sent and no CRM record is
 * made: the person is a contact like an imported one, and the inquiry keeps
 * what they wrote as the evidence of need the assistant reads later.
 *
 * Who it is: an existing person of this organization with the same email
 * (any case), else with the same E.164 phone (and no other email), is
 * reused — only an empty name or company is filled in, nothing they already
 * have is overwritten.
 * Otherwise the person is created with the same helpers the People import
 * and calling lists use (upsertPerson for an email, findOrCreateContactPerson
 * for a phone alone), source "intake:website-form".
 *
 * Two submissions with the same new email (or, without one, the same
 * phone) are serialized on the advisory lock the People import takes for
 * that identity, so the second finds the first's person instead of
 * overwriting it.
 *
 * Retries: the inquiry is inserted first, ON CONFLICT DO NOTHING on
 * (organization, source, dedupe key) — a retry, even one racing the
 * original, finds the original and creates nothing. The person is resolved
 * in the same transaction, so a failure leaves neither behind.
 *
 * Limits, per endpoint, so a leaked token cannot flood the organization:
 * INTAKE_SUBMISSIONS_PER_HOUR inquiries an hour (the route answers 429
 * past it, before reading the body), and INTAKE_NEW_CONTACTS_PER_DAY new
 * people in 24 hours. Past the second, the submission is still stored —
 * nothing a real visitor sent is lost — as unusable with that reason, and no
 * person is made; a 429 there would make form tools drop it after their
 * retries. Both are soft under concurrency (a few over, never far).
 */

export const INTAKE_FORM_PERSON_SOURCE = "intake:website-form";
export const INTAKE_SUBMISSIONS_PER_HOUR = 300;
export const INTAKE_NEW_CONTACTS_PER_DAY = 500;
export const DAILY_CONTACT_LIMIT_REASON =
  `Daily limit of new contacts from this form reached (${INTAKE_NEW_CONTACTS_PER_DAY} in 24 hours); the submission is kept without a contact.`;

/**
 * Whether the endpoint has had its hour's worth of inquiries; if so, how
 * many seconds until the oldest of them leaves the window. Counts what was
 * stored (refused deliveries do not count), on the (organization,
 * received_at) index.
 */
export async function intakeRateLimit(endpointId: string): Promise<{ retryAfterSeconds: number } | null> {
  const [row] = await db
    .select({ total: count(), oldest: min(inquiries.receivedAt) })
    .from(inquiries)
    .where(and(inOrg(inquiries), gt(inquiries.receivedAt, sql`now() - interval '1 hour'`), eq(inquiries.endpointId, endpointId)));
  if (Number(row?.total ?? 0) < INTAKE_SUBMISSIONS_PER_HOUR) return null;
  const freesAt = (row?.oldest ? new Date(row.oldest).getTime() : Date.now()) + 60 * 60 * 1000;
  return { retryAfterSeconds: Math.min(3600, Math.max(1, Math.ceil((freesAt - Date.now()) / 1000))) };
}

/** New people this endpoint made in the last 24 hours (inquiries flagged raw.createdPerson). */
async function newContactsToday(tx: LeadExecutor, endpointId: string): Promise<number> {
  const [row] = await tx
    .select({ total: count() })
    .from(inquiries)
    .where(and(
      inOrg(inquiries),
      gt(inquiries.receivedAt, sql`now() - interval '24 hours'`),
      eq(inquiries.endpointId, endpointId),
      sql`${inquiries.raw} ->> 'createdPerson' = 'true'`,
    ));
  return Number(row?.total ?? 0);
}

/** The same transaction-scoped advisory lock records.ts / campaigns.ts take for this identity. */
async function lockIdentity(tx: LeadExecutor, key: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
}

export type FormInquiryResult = {
  inquiryId: string;
  /** True when this submission was already recorded (a retry): nothing new was created. */
  duplicate: boolean;
  status: InquiryStatus;
  personId: string | null;
  reason: string | null;
};

type Contact = {
  email: string | null;
  phone: string | null;
  name: string | null;
  firstName: string | null;
  lastName: string | null;
  company: string | null;
};

/** Why neither the email nor the phone can reach this person. */
function unusableReason(mapped: MappedSubmission, phone: PhoneCheck | null): string {
  const parts = [
    mapped.emailRejected ? mapped.emailRejected.reason : "no email address",
    phone && !phone.ok ? phone.reason : "no phone number",
  ];
  return `No way to reach them: ${parts.join("; ")}.`;
}

/** Fills an existing person's empty name and company from the inquiry; never overwrites. */
async function fillBlanks(tx: LeadExecutor, person: typeof people.$inferSelect, contact: Contact) {
  const set: Partial<typeof people.$inferInsert> = {};
  if (!person.fullName && !person.firstName && !person.lastName && contact.name) {
    Object.assign(set, resolvePersonNames({ fullName: contact.name, firstName: contact.firstName, lastName: contact.lastName }));
  }
  if (contact.company && !person.companyId && !personCompanyName(person.raw, null)) {
    set.raw = { ...(person.raw ?? {}), company: contact.company, companyName: contact.company };
  }
  if (!Object.keys(set).length) return person;
  const [updated] = await tx.update(people)
    .set({ ...set, updatedAt: new Date() })
    .where(and(inOrg(people), eq(people.id, person.id)))
    .returning();
  return updated ?? person;
}

type Resolved = { person: typeof people.$inferSelect; created: boolean };

/**
 * The person behind a usable inquiry: an existing one by email, then by
 * phone, else a new one — unless `mayCreate` says the endpoint has made its
 * day's worth (null then).
 */
async function resolvePerson(tx: LeadExecutor, contact: Contact, mayCreate: () => Promise<boolean>): Promise<Resolved | null> {
  // Held until the transaction ends: a concurrent submission with the same
  // identity waits here, then finds this one's person.
  if (contact.email) await lockIdentity(tx, `${currentOrganizationId()}:person:email:${contact.email}`);
  else if (contact.phone) await lockIdentity(tx, `person:phone:${contact.phone}`);

  if (contact.email) {
    const [byEmail] = await tx.select().from(people)
      .where(and(inOrg(people), sql`lower(${people.email}) = ${contact.email}`))
      .limit(1);
    if (byEmail) return { person: await fillBlanks(tx, byEmail, contact), created: false };
  }
  if (contact.phone) {
    // A phone is shared more often than an email (a switchboard, a family
    // number), so a match that has a different email is someone else.
    const [byPhone] = await tx.select().from(people)
      .where(and(inOrg(people), eq(people.phone, contact.phone), contact.email ? isNull(people.email) : undefined))
      .orderBy(asc(people.createdAt))
      .limit(1);
    if (byPhone) return { person: await fillBlanks(tx, byPhone, contact), created: false };
  }
  if (!(await mayCreate())) return null;
  if (contact.email) {
    // The company is linked when this organization already has it (by the
    // email's domain) and otherwise kept by name on the person: a name typed
    // in a form never renames or creates a company record.
    const domain = normalizeCompanyDomain(inferCompanyDomainFromEmail(contact.email));
    const [company] = contact.company && domain
      ? await tx.select({ id: companies.id }).from(companies).where(and(inOrg(companies), eq(companies.domain, domain))).limit(1)
      : [];
    const person = await upsertPerson(tx, {
      email: contact.email,
      fullName: contact.name,
      firstName: contact.firstName,
      lastName: contact.lastName,
      phone: contact.phone,
      raw: contact.company ? { company: contact.company, companyName: contact.company } : {},
      source: INTAKE_FORM_PERSON_SOURCE,
    });
    if (!company || person.companyId) return { person, created: true };
    const [linked] = await tx.update(people)
      .set({ companyId: company.id, updatedAt: new Date() })
      .where(and(inOrg(people), eq(people.id, person.id)))
      .returning();
    return { person: linked ?? person, created: true };
  }
  const person = await findOrCreateContactPerson(tx, {
    fullName: contact.name,
    phone: contact.phone!,
    companyName: contact.company,
    companyDomain: null,
    title: null,
    email: null,
  }, INTAKE_FORM_PERSON_SOURCE);
  return { person, created: true };
}

const text = (value: string | null) => (value === null ? null : cleanString(value));

/**
 * Records one website-form submission for `endpoint`, inside that
 * endpoint's organization scope. Throws FeatureDisabledError (nothing
 * stored) while the organization's Inquiry intake is off. `historical`
 * marks a backfill of old submissions: stored and listed, never acted on.
 * The hourly limit is the caller's (intakeRateLimit, before the body is
 * read); the daily new-contact limit is applied here.
 */
export async function recordFormInquiry(
  endpoint: Pick<IntakeEndpointRow, "id" | "organizationId" | "fieldMap">,
  submission: FlatField[],
  options: { historical?: boolean } = {},
): Promise<FormInquiryResult> {
  if (currentOrganizationId() !== endpoint.organizationId) {
    throw new Error("recordFormInquiry must run in the endpoint's organization scope");
  }
  await requireFeature("inquiry_intake");

  const mapped = mapSubmission(submission, endpoint.fieldMap ?? {});
  const phoneCheck = mapped.phone ? checkPhone(mapped.phone, await organizationPhoneCountry()) : null;
  const phone = phoneCheck?.ok ? phoneCheck.e164 : null;
  const dropped: DroppedValue[] = [
    ...(mapped.emailRejected ? [mapped.emailRejected] : []),
    ...(mapped.phone && phoneCheck && !phoneCheck.ok ? [{ field: "phone" as const, value: mapped.phone, reason: phoneCheck.reason }] : []),
    ...(mapped.pageUrlRejected ? [mapped.pageUrlRejected] : []),
  ];
  const usable = Boolean(mapped.email || phone);
  const status: InquiryStatus = usable ? "received" : "unusable";
  const reason = usable ? null : unusableReason(mapped, phoneCheck);
  const dedupeKey = inquiryDedupeKey(endpoint.id, mapped);
  const historical = options.historical === true;

  // Every string is made safe for Postgres (no NUL, no lone surrogate) here,
  // at the boundary, whatever mapSubmission already did.
  const raw: Record<string, unknown> = cleanJson({
    ...(dropped.length ? { dropped } : {}),
    ...(mapped.submissionId ? { submissionId: mapped.submissionId } : {}),
    ...(mapped.company ? { company: mapped.company } : {}),
  });

  const result = await withLeadTransaction(async (tx): Promise<FormInquiryResult> => {
    const [inserted] = await tx.insert(inquiries).values({
      organizationId: currentOrganizationId(),
      source: "website_form",
      endpointId: endpoint.id,
      dedupeKey: cleanString(dedupeKey),
      name: text(mapped.name),
      email: text(mapped.email),
      phone,
      message: text(mapped.message),
      fields: cleanJson(mapped.fields),
      pageUrl: text(mapped.pageUrl),
      historical,
      status,
      reason: text(reason),
      submittedAt: mapped.submittedAt,
      raw,
    }).onConflictDoNothing({
      target: [inquiries.organizationId, inquiries.source, inquiries.dedupeKey],
    }).returning({ id: inquiries.id });

    if (!inserted) {
      const [original] = await tx.select({ id: inquiries.id, status: inquiries.status, personId: inquiries.personId, reason: inquiries.reason })
        .from(inquiries)
        .where(and(inOrg(inquiries), eq(inquiries.source, "website_form"), eq(inquiries.dedupeKey, dedupeKey)))
        .limit(1);
      if (!original) throw new Error("The inquiry was recorded and removed again while this delivery ran; retry it");
      return { inquiryId: original.id, duplicate: true, status: original.status, personId: original.personId, reason: original.reason };
    }
    if (!usable) return { inquiryId: inserted.id, duplicate: false, status, personId: null, reason };

    const resolved = await resolvePerson(tx, {
      email: mapped.email,
      phone,
      name: text(mapped.name),
      firstName: text(mapped.firstName),
      lastName: text(mapped.lastName),
      company: text(mapped.company),
    }, async () => (await newContactsToday(tx, endpoint.id)) < INTAKE_NEW_CONTACTS_PER_DAY);

    if (!resolved) {
      await tx.update(inquiries)
        .set({ status: "unusable", reason: DAILY_CONTACT_LIMIT_REASON })
        .where(and(inOrg(inquiries), eq(inquiries.id, inserted.id)));
      return { inquiryId: inserted.id, duplicate: false, status: "unusable", personId: null, reason: DAILY_CONTACT_LIMIT_REASON };
    }
    await tx.update(inquiries)
      .set({ personId: resolved.person.id, ...(resolved.created ? { raw: { ...raw, createdPerson: true } } : {}) })
      .where(and(inOrg(inquiries), eq(inquiries.id, inserted.id)));
    return { inquiryId: inserted.id, duplicate: false, status, personId: resolved.person.id, reason: null };
  });

  // The endpoint is wired up: Settings → Inquiries shows when it last heard from the form.
  await db.update(intakeEndpoints)
    .set({ lastReceivedAt: new Date() })
    .where(and(inOrg(intakeEndpoints), eq(intakeEndpoints.id, endpoint.id)));
  return result;
}
