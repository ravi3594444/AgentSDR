import { checkPhone } from "@/lib/calls/phone";
import type { ImportRow } from "./importRows";

/**
 * How each row of a People (Leads) import is handled, decided before any
 * write so the rules are unit-tested:
 *
 * - A row with an Email or LinkedIn URL is a person by that identity. A phone
 *   on it that cannot be normalized is not saved, and the report says why
 *   (it used to be dropped without a word).
 * - A row with neither, but a valid phone number, is a phone-only contact:
 *   what a WhatsApp campaign needs, matched by phone like the WhatsApp
 *   campaign import does. Bare local numbers use the organization's Default
 *   phone country.
 * - A phone-only row whose number is invalid or ambiguous fails with the
 *   reason; a row with no identity and no phone is counted as skipped.
 */
export type PeopleImportPlan = {
  identified: ImportRow[];
  phoneOnly: Array<{ row: ImportRow; phone: string }>;
  failed: Array<{ row: number; identity: string; error: string }>;
  warnings: Array<{ row: number; identity: string; message: string }>;
  skippedNoIdentity: number;
};

export function planPeopleImport(rows: ImportRow[], defaultCountry: string | undefined): PeopleImportPlan {
  const plan: PeopleImportPlan = { identified: [], phoneOnly: [], failed: [], warnings: [], skippedNoIdentity: 0 };
  for (const row of rows) {
    const identity = row.email ?? row.linkedinUrl;
    const phone = row.phone ? checkPhone(row.phone, defaultCountry) : null;
    if (identity) {
      plan.identified.push(row);
      if (phone && !phone.ok) plan.warnings.push({ row: row.rowNumber, identity, message: `Phone not saved: ${phone.reason}` });
    } else if (phone?.ok) {
      plan.phoneOnly.push({ row, phone: phone.e164 });
    } else if (phone) {
      plan.failed.push({ row: row.rowNumber, identity: row.phone!, error: `No Email or LinkedIn URL, and the phone cannot be used: ${phone.reason}` });
    } else {
      plan.skippedNoIdentity += 1;
    }
  }
  return plan;
}
