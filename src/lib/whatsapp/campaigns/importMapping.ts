import { checkPhone } from "@/lib/calls/phone";
import { readTextSheet } from "@/lib/spreadsheet/read";
import type { ManualPersonInput } from "@/lib/leads/manualImport";
import { WHATSAPP_CAMPAIGN_IMPORT_FIELDS, type WhatsappCampaignImportField } from "./contract";

/**
 * Pure helpers for the WhatsApp campaign spreadsheet import: parsing, the
 * suggested column mapping, mapped rows, and the lead's custom fields. No
 * database, so it is unit-tested directly.
 */

export type ImportSheet = {
  headers: string[];
  /** Every non-empty data row, cells as trimmed strings, aligned with `headers`. */
  rows: string[][];
  /** 1-based row number in the file (header = 1) of each entry in `rows`. */
  rowNumbers: number[];
};

export type ImportMapping = Partial<Record<WhatsappCampaignImportField, string>>;

const FIELD_KEYS: readonly string[] = WHATSAPP_CAMPAIGN_IMPORT_FIELDS.map((field) => field.key);

const squash = (value: string) => value.trim().toLowerCase().replace(/[^a-z0-9]/g, "");

/** Header names (squashed: lowercase, letters and digits only) that suggest each field. */
const HEADER_ALIASES: Record<WhatsappCampaignImportField, string[]> = {
  phone: [
    "phone", "phonenumber", "mobile", "mobilenumber", "mobilephone", "whatsapp", "whatsappnumber", "whatsappphone",
    "cell", "cellphone", "cellnumber", "contactnumber", "contactphone", "telephone", "tel", "number", "phoneno", "mobileno", "workphone",
  ],
  firstName: ["firstname", "first", "givenname", "fname"],
  lastName: ["lastname", "last", "surname", "familyname", "lname"],
  fullName: ["name", "fullname", "contactname", "contact", "leadname"],
  email: ["email", "emailaddress", "workemail", "mail"],
  title: ["title", "jobtitle", "position", "role", "headline"],
  companyName: ["company", "companyname", "organization", "organisation", "employer", "account"],
  companyDomain: ["domain", "companydomain", "website", "companywebsite", "companyurl", "url", "site"],
  linkedinUrl: ["linkedin", "linkedinurl", "linkedinprofile", "linkedinprofileurl", "profileurl"],
};

/**
 * Reads the first worksheet of a CSV/XLSX file as text, so phone numbers keep
 * their leading zeros ("09876543210" must reach the normalizer intact).
 * Throws a readable Error.
 */
export function parseImportSheet(buffer: ArrayBuffer): ImportSheet {
  const sheet = readTextSheet(buffer);
  const headers = sheet.headers.map((cell) => cell.trim());
  if (!headers.some(Boolean)) throw new Error("The worksheet is empty");
  const rows: string[][] = [];
  const rowNumbers: number[] = [];
  for (const row of sheet.rows) {
    const cells = headers.map((_, column) => (row.cells[column] ?? "").trim());
    if (!cells.some(Boolean)) continue;
    rows.push(cells);
    rowNumbers.push(row.rowNumber);
  }
  return { headers, rows, rowNumbers };
}

/** Field key → header, for every field that has an obvious column. A header is used at most once. */
export function suggestWhatsappMapping(headers: string[]): Record<string, string> {
  const suggested: Record<string, string> = {};
  const used = new Set<number>();
  const squashed = headers.map(squash);
  for (const field of WHATSAPP_CAMPAIGN_IMPORT_FIELDS) {
    const aliases = HEADER_ALIASES[field.key];
    // Exact alias order wins: "phone" beats "number" when both columns exist.
    for (const alias of aliases) {
      const index = squashed.findIndex((header, position) => header === alias && !used.has(position) && headers[position] !== "");
      if (index >= 0) {
        suggested[field.key] = headers[index]!;
        used.add(index);
        break;
      }
    }
  }
  return suggested;
}

/** Why a mapping cannot be used for this file, or null. */
export function importMappingError(mapping: unknown, headers: string[]): string | null {
  if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) return "mapping must be a JSON object";
  const entries = Object.entries(mapping as Record<string, unknown>).filter(([, value]) => value !== null && value !== "" && value !== undefined);
  for (const [key, value] of entries) {
    if (!FIELD_KEYS.includes(key)) return `Unknown field: ${key}`;
    if (typeof value !== "string") return `The column for ${key} must be a column name`;
    if (!headers.includes(value)) return `The mapping references a column that is not in this file: ${value}`;
  }
  const columns = entries.map(([, value]) => value as string);
  if (new Set(columns).size !== columns.length) return "Each column can map to only one field";
  if (!entries.some(([key]) => key === "phone")) return "Map the required Phone number column";
  return null;
}

/** "Job Title" → "jobTitle", "e-mail_2" → "email2", "Café" → "cafe"; "" when nothing usable remains. */
export function headerToCustomKey(header: string): string {
  const words = header
    .trim()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .split(" ")
    .filter(Boolean);
  if (!words.length) return "";
  return words
    .map((word, index) => (index === 0 ? word.charAt(0).toLowerCase() + word.slice(1) : word.charAt(0).toUpperCase() + word.slice(1)))
    .join("");
}

/**
 * One data row as person fields plus the lead's custom fields: every column
 * the mapping does not claim, camelCased, non-empty values only. The first
 * of two columns that camelCase to the same key wins.
 */
export function mapImportRow(
  row: string[],
  headers: string[],
  mapping: ImportMapping,
): { person: ManualPersonInput; customFields: Record<string, string> } {
  const columnOf = (field: WhatsappCampaignImportField): number => {
    const header = mapping[field];
    return header ? headers.indexOf(header) : -1;
  };
  const read = (field: WhatsappCampaignImportField): string | null => {
    const column = columnOf(field);
    return column < 0 ? null : row[column]?.trim() || null;
  };
  const claimed = new Set<number>();
  for (const field of FIELD_KEYS) {
    const column = columnOf(field as WhatsappCampaignImportField);
    if (column >= 0) claimed.add(column);
  }
  const customFields: Record<string, string> = {};
  headers.forEach((header, column) => {
    if (claimed.has(column)) return;
    const key = headerToCustomKey(header);
    const value = row[column]?.trim();
    if (!key || !value || key in customFields) return;
    customFields[key] = value;
  });
  return {
    person: {
      phone: read("phone"),
      firstName: read("firstName"),
      lastName: read("lastName"),
      fullName: read("fullName"),
      email: read("email"),
      title: read("title"),
      companyName: read("companyName"),
      companyDomain: read("companyDomain"),
      linkedinUrl: read("linkedinUrl"),
    },
    customFields,
  };
}

/**
 * A phone cell as E.164, using the organization's default country for bare
 * local numbers (see checkPhone for the rules and the reasons it gives).
 */
export function normalizeCampaignPhone(input: string, defaultCountry: string | undefined): string | null {
  const checked = checkPhone(input, defaultCountry);
  return checked.ok ? checked.e164 : null;
}

/** Why a phone cell could not be used, for the import report. */
export function campaignPhoneProblem(input: string | null | undefined, defaultCountry: string | undefined): string {
  const checked = checkPhone(input, defaultCountry);
  return checked.ok ? "" : checked.reason;
}
