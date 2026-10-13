import "server-only";

import { and, eq } from "drizzle-orm";
import { findOrCreateContactPerson, resolveImportRow } from "@/lib/calls/campaigns";
import { inOrg } from "@/lib/tenancy/scope";
import type { ImportRow } from "./importRows";
import { withLeadTransaction } from "./records";
import { people } from "./schema";

/**
 * A phone-only contact from the People import: found by its E.164 phone (the
 * same identity the WhatsApp campaign import uses) or created as a
 * provisional person with that phone. Returns whether it was new.
 */
export async function importPhoneOnlyPerson(row: ImportRow, phone: string): Promise<{ created: boolean }> {
  const resolved = resolveImportRow(row, row.rowNumber, () => phone);
  if (!resolved.ok) throw new Error(resolved.message);
  return withLeadTransaction(async (tx) => {
    const [existing] = await tx.select({ id: people.id }).from(people).where(and(inOrg(people), eq(people.phone, phone))).limit(1);
    await findOrCreateContactPerson(
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
    return { created: !existing };
  });
}
