import * as XLSX from "xlsx";
import { readSpreadsheet } from "@/lib/spreadsheet/read";
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
const isBlank = (row: unknown[]) => row.every((value) => !cell(value));

/** Throws a readable Error (SpreadsheetReadError for an unreadable file). */
export function parseImportRows(buffer: ArrayBuffer): ImportRow[] {
  const workbook = readSpreadsheet(buffer);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet) throw new Error("The file has no worksheet");
  // Blank rows are kept (and skipped below) so each row's position in the
  // file is known; the range may start below row 1 in an .xlsx.
  const firstRow = sheet["!ref"] ? XLSX.utils.decode_range(sheet["!ref"]).s.r : 0;
  const values = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, blankrows: true });
  const lines = values
    .map((row, index) => ({ row, rowNumber: firstRow + index + 1 }))
    .filter(({ row }) => !isBlank(row));
  if (!lines.length) throw new Error("The worksheet is empty");
  const headers = lines[0].row.map(normalizedHeader);
  const at = (row: unknown[], names: string[]) => {
    const index = headers.findIndex((header) => names.includes(header));
    return index < 0 ? null : cell(row[index]);
  };
  return lines.slice(1).map(({ row, rowNumber }) => ({
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
