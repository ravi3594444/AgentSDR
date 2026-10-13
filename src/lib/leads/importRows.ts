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
  /**
   * Every column not mapped above, keyed by its camelCased header ("Job
   * Level" → jobLevel), non-empty cells only. Kept on the person's raw data,
   * as the campaign imports do, so it is usable as a {{jobLevel}} merge field.
   */
  customFields?: Record<string, string>;
};

/** "Favourite Café" → "favouriteCafe", "2024 Revenue" → "field2024Revenue"; "" when nothing usable remains. */
export function customFieldKey(header: string): string {
  const words = header
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  const key = words.map((word, index) => (index === 0 ? word.toLowerCase() : word[0]!.toUpperCase() + word.slice(1).toLowerCase())).join("");
  return /^\d/.test(key) ? `field${key}` : key;
}

const ALIASES = {
  email: ["email", "emailaddress"],
  linkedinUrl: ["linkedin", "linkedinurl", "linkedinprofile"],
  fullName: ["name", "fullname"],
  firstName: ["firstname"],
  lastName: ["lastname"],
  title: ["title", "jobtitle", "headline"],
  companyName: ["company", "companyname"],
  companyDomain: ["domain", "companydomain", "website", "companywebsite", "companyurl"],
  notes: ["notes"],
  phone: ["phone", "phonenumber", "mobile", "mobilephone", "mobilenumber", "whatsapp", "whatsappnumber", "workphone"],
} as const;
const RECOGNIZED = new Set<string>(Object.values(ALIASES).flat());

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
  const at = (row: string[], names: readonly string[]) => {
    const index = headers.findIndex((header) => names.includes(header));
    return index < 0 ? null : cell(row[index]);
  };
  // Unmapped columns become custom fields; the first of two headers with the same key wins.
  const customColumns: { index: number; key: string }[] = [];
  const seen = new Set<string>();
  sheet.headers.forEach((header, index) => {
    if (RECOGNIZED.has(headers[index]!) || !header.trim()) return;
    const key = customFieldKey(header);
    if (!key || seen.has(key)) return;
    seen.add(key);
    customColumns.push({ index, key });
  });
  const lines = sheet.rows.map(({ cells, rowNumber }) => ({ row: cells, rowNumber }));
  return lines.map(({ row, rowNumber }) => {
    const customFields: Record<string, string> = {};
    for (const { index, key } of customColumns) {
      const value = cell(row[index]);
      if (value) customFields[key] = value;
    }
    return {
      email: at(row, ALIASES.email),
      linkedinUrl: at(row, ALIASES.linkedinUrl),
      fullName: at(row, ALIASES.fullName),
      firstName: at(row, ALIASES.firstName),
      lastName: at(row, ALIASES.lastName),
      title: at(row, ALIASES.title),
      companyName: at(row, ALIASES.companyName),
      companyDomain: at(row, ALIASES.companyDomain),
      notes: at(row, ALIASES.notes),
      phone: at(row, ALIASES.phone),
      rowNumber,
      ...(Object.keys(customFields).length ? { customFields } : {}),
    };
  });
}
