import "server-only";

import { and, eq, sql } from "drizzle-orm";
import { findOrCreateContactPerson, resolveImportRow } from "@/lib/calls/campaigns";
import { organizationPhoneCountry } from "@/lib/calls/phone.server";
import { inOrg } from "@/lib/tenancy/scope";
import type { ImportRow } from "./importRows";
import { upsertManualPerson } from "./manualImport";
import { planPeopleImport, type PeopleImportPlan } from "./peopleImport";
import { withLeadTransaction } from "./records";
import { people } from "./schema";

/**
 * A phone-only contact from the People import: found by its E.164 phone (the
 * same identity the WhatsApp campaign import uses) or created as a
 * provisional person with that phone. Returns whether it was new.
 */
export async function importPhoneOnlyPerson(row: ImportRow, phone: string): Promise<{ created: boolean; personId: string }> {
  const resolved = resolveImportRow(row, row.rowNumber, () => phone);
  if (!resolved.ok) throw new Error(resolved.message);
  return withLeadTransaction(async (tx) => {
    const [existing] = await tx.select({ id: people.id }).from(people).where(and(inOrg(people), eq(people.phone, phone))).limit(1);
    const person = await findOrCreateContactPerson(
      tx,
      {
        fullName: resolved.fullName,
        phone: resolved.phone,
        companyName: resolved.companyName,
        companyDomain: resolved.companyDomain,
        title: resolved.title,
        email: null,
        linkedinUrl: null,
      },
      "people-import",
    );
    // Unmapped columns are kept on raw, as for the other rows (merged over earlier values).
    if (row.customFields && Object.keys(row.customFields).length) {
      await tx
        .update(people)
        .set({ raw: sql`coalesce(${people.raw}, '{}'::jsonb) || ${JSON.stringify(row.customFields)}::jsonb`, updatedAt: new Date() })
        .where(and(inOrg(people), eq(people.id, person.id)));
    }
    return { created: !existing, personId: person.id };
  });
}

export type PeopleImportResult = {
  total: number;
  created: number;
  updated: number;
  phoneOnly: number;
  failed: PeopleImportPlan["failed"];
  warnings: PeopleImportPlan["warnings"];
  skippedNoIdentity: number;
  /** Everyone the import created or updated, in file order. */
  personIds: string[];
};

/**
 * Imports parsed rows as People: a row with an email or LinkedIn URL is
 * upserted by that identity, a phone-only row becomes a WhatsApp contact,
 * and every failure keeps its file row and reason. Shared by the People
 * import route and the assistant's contact lists.
 */
export async function importPeopleRows(rows: ImportRow[]): Promise<PeopleImportResult> {
  const plan = planPeopleImport(rows, await organizationPhoneCountry());
  const failed = [...plan.failed];
  const personIds: string[] = [];
  let created = 0;
  let updated = 0;
  for (const row of plan.identified) {
    try {
      const result = await upsertManualPerson(row, row.customFields);
      personIds.push(result.personId);
      if (result.created) created += 1;
      else updated += 1;
    } catch (error) {
      failed.push({ row: row.rowNumber, identity: row.email ?? row.linkedinUrl ?? "unknown", error: error instanceof Error ? error.message : String(error) });
    }
  }
  for (const { row, phone } of plan.phoneOnly) {
    try {
      const result = await importPhoneOnlyPerson(row, phone);
      personIds.push(result.personId);
      if (result.created) created += 1;
      else updated += 1;
    } catch (error) {
      failed.push({ row: row.rowNumber, identity: phone, error: error instanceof Error ? error.message : String(error) });
    }
  }
  failed.sort((a, b) => a.row - b.row);
  return {
    total: plan.identified.length + plan.phoneOnly.length + plan.failed.length,
    created,
    updated,
    phoneOnly: plan.phoneOnly.length,
    failed,
    warnings: plan.warnings,
    skippedNoIdentity: plan.skippedNoIdentity,
    personIds: [...new Set(personIds)],
  };
}
