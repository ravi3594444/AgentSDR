import { readTextSheet } from "@/lib/spreadsheet/read";
import type { ManualPersonInput } from "./manualImport";

/**
 * The CSV/XLSX row parsing shared by every importer that produces
 * ManualPersonInput rows: the People import
 * (src/app/api/leads/people/import/route.ts) and the Calling campaign
 * contacts import (src/app/api/calling/campaigns/[id]/contacts/import/route.ts).
 * Header aliasing must stay identical between the two, so a file behaves the
 * same way wherever it's uploaded — that's the whole reason this is shared
 * rather than copied.
 *
 * Deliberately returns every row, unfiltered: the two callers disagree on
 * what makes a row usable (People requires an Email or LinkedIn URL; Calling
 * requires a phone number instead), so filtering is each caller's job.
 */

/** A parsed row plus where it sits in the file, for error messages ("row 7: …"). */
export type ImportRow = ManualPersonInput & {
  /** 1-based row number as the spreadsheet shows it, counting the header row and any blank lines. */
  rowNumber: number;
};

const normalizedHeader = (value: unknown) => String(value ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
const cell = (value: unknown) => String(value ?? "").trim() || null;

/**
 * Throws a readable Error (SpreadsheetReadError for an unreadable file).
 * Cells are read as text (readTextSheet), so a phone number such as
 * 09876543210 keeps its leading zero for the normalizer, and row numbers
 * count the header and any blank lines, as the spreadsheet shows them.
 */
export function parseImportRows(buffer: ArrayBuffer): ImportRow[] {
  const sheet = readTextSheet(buffer);
  const headers = sheet.headers.map(normalizedHeader);
  const at = (row: string[], names: string[]) => {
    const index = headers.findIndex((header) => names.includes(header));
    return index < 0 ? null : cell(row[index]);
  };
  const lines = sheet.rows.map(({ cells, rowNumber }) => ({ row: cells, rowNumber }));
  return lines.map(({ row, rowNumber }) => ({
    email: at(row, ["email", "emailaddress"]),
    linkedinUrl: at(row, ["linkedin", "linkedinurl", "linkedinprofile"]),
    fullName: at(row, ["name", "fullname"]),
    firstName: at(row, ["firstname"]),
    lastName: at(row, ["lastname"]),
    title: at(row, ["title", "jobtitle", "headline"]),
    companyName: at(row, ["company", "companyname"]),
    companyDomain: at(row, ["domain", "companydomain", "website", "companywebsite", "companyurl"]),
    notes: at(row, ["notes"]),
    phone: at(row, ["phone", "phonenumber", "mobile", "mobilephone", "mobilenumber", "whatsapp", "whatsappnumber", "workphone"]),
    rowNumber,
  }));
}
