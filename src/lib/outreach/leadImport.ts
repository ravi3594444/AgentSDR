import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { importRuns, people } from "@/lib/leads/schema";
import { upsertPerson, withLeadTransaction } from "@/lib/leads/records";
import { normalizeEmail } from "@/lib/leads/identity";
import { outreachCampaigns, outreachLeads, suppressionList } from "./schema";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";
import { leadsInOrg } from "./orgScope";
import { readTextSheet, SpreadsheetReadError, uniqueHeaders, type TextRow } from "@/lib/spreadsheet/read";

export const MAX_IMPORT_ROWS = 5000;

export type ParsedRow = {
  email: string;
  linkedinUrl: string | null;
  firstName: string | null;
  lastName: string | null;
  company: string | null;
  domain: string | null;
  companyLinkedinUrl: string | null;
  title: string | null;
  customFields: Record<string, string>;
  /** 1-based row in the file, when known; failures report it. */
  rowNumber?: number;
};

export type EmailCsvMapping = Partial<Record<
  "email" | "linkedinUrl" | "firstName" | "lastName" | "fullName" | "companyName" | "companyDomain" | "companyLinkedinUrl" | "title",
  string
>>;

function normalizeHeader(h: unknown): string {
  return String(h ?? "").trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

function cell(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s ? s : null;
}

/**
 * "Job Title" -> "jobTitle", so an unrecognized CSV column becomes usable as {{jobTitle}} in a sequence.
 * Accents are folded first ("Favourite Café" -> "favouriteCafe"), so the letter is kept rather than
 * splitting the word.
 */
function toCamelCaseKey(header: string): string {
  const words = header.trim().normalize("NFD").replace(/[\u0300-\u036f]/g, "").split(/[^a-zA-Z0-9_]+/).filter(Boolean);
  const key = words
    .map((w, i) => (i === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase()))
    .join("");
  return /^\d/.test(key) ? `field${key}` : key;
}

/**
 * The first worksheet as text with its header row: names, emails, phone
 * numbers and custom columns keep exactly what the person typed (leading
 * zeros included), and every row its file row number. Repeated headers are
 * suffixed the way SheetJS does it ("Email", "Email_1"); blank headers stay
 * blank and are never mapped or turned into custom fields.
 */
function readEmailSheet(buffer: ArrayBuffer): { headers: string[]; rows: TextRow[] } {
  const sheet = readTextSheet(buffer);
  const trimmed = sheet.headers.map((header) => header.trim());
  const named = uniqueHeaders(trimmed.filter(Boolean));
  let next = 0;
  return { headers: trimmed.map((header) => (header ? named[next++]! : "")), rows: sheet.rows };
}

/**
 * Reads the sheet's first row as headers, tolerant of column order/casing. Accepts .csv and .xlsx alike;
 * readSpreadsheet decodes UTF-8 text, so an accented name or em-dash survives. Throws SpreadsheetReadError
 * for an unreadable file.
 */
export function parseRows(buffer: ArrayBuffer): { rows: ParsedRow[]; error: string | null } {
  let sheet: { headers: string[]; rows: TextRow[] };
  try {
    sheet = readEmailSheet(buffer);
  } catch (error) {
    if (error instanceof SpreadsheetReadError && error.message === "The worksheet is empty") return { rows: [], error: "Sheet is empty" };
    throw error;
  }

  const rawHeaders = sheet.headers;
  const headers = rawHeaders.map(normalizeHeader);
  const emailCol = headers.findIndex((h) => h === "email");
  if (emailCol === -1) return { rows: [], error: 'Missing required "Email" column' };

  const firstNameCol = headers.findIndex((h) => h === "firstname");
  const lastNameCol = headers.findIndex((h) => h === "lastname");
  const nameCol = headers.findIndex((h) => h === "name");
  const companyCol = headers.findIndex((h) => h === "company");
  const domainCol = headers.findIndex((h) => h === "domain" || h === "companydomain" || h === "website");
  const linkedinCol = headers.findIndex((h) => h === "linkedin" || h === "linkedinurl");
  const companyLinkedinCol = headers.findIndex((h) => h === "companylinkedin" || h === "companylinkedinurl" || h === "companypage");
  const titleCol = headers.findIndex((h) => h === "title" || h === "jobtitle");
  const recognizedCols = new Set([emailCol, firstNameCol, lastNameCol, nameCol, companyCol, domainCol, linkedinCol, companyLinkedinCol, titleCol].filter((i) => i >= 0));

  // Any column not recognized above becomes a custom field, keyed by its
  // camelCased header (e.g. "Job Title" -> jobTitle), usable in a sequence
  // as {{jobTitle}}. Skips blank/duplicate-after-camelCasing headers.
  const customCols: { index: number; key: string }[] = [];
  const seenKeys = new Set<string>();
  rawHeaders.forEach((h, i) => {
    if (recognizedCols.has(i) || !h) return;
    const key = toCamelCaseKey(h);
    if (!key || seenKeys.has(key)) return;
    seenKeys.add(key);
    customCols.push({ index: i, key });
  });

  const rows: ParsedRow[] = [];
  for (const { cells: line, rowNumber } of sheet.rows) {
    const email = cell(line[emailCol])?.toLowerCase() ?? "";

    let firstName = firstNameCol >= 0 ? cell(line[firstNameCol]) : null;
    let lastName = lastNameCol >= 0 ? cell(line[lastNameCol]) : null;
    if (!firstName && !lastName && nameCol >= 0) {
      const full = cell(line[nameCol]);
      if (full) {
        const parts = full.trim().split(/\s+/);
        firstName = parts[0] ?? null;
        lastName = parts.slice(1).join(" ") || null;
      }
    }

    const customFields: Record<string, string> = {};
    for (const { index, key } of customCols) {
      const value = cell(line[index]);
      if (value) customFields[key] = value;
    }
    rows.push({
      email,
      linkedinUrl: linkedinCol >= 0 ? cell(line[linkedinCol]) : null,
      firstName,
      lastName,
      company: companyCol >= 0 ? cell(line[companyCol]) : null,
      domain: domainCol >= 0 ? cell(line[domainCol]) : null,
      companyLinkedinUrl: companyLinkedinCol >= 0 ? cell(line[companyLinkedinCol]) : null,
      title: titleCol >= 0 ? cell(line[titleCol]) : null,
      customFields,
      rowNumber,
    });
  }

  return { rows, error: null };
}

/** Throws SpreadsheetReadError for an unreadable file. */
export function spreadsheetPreview(buffer: ArrayBuffer): { headers: string[]; rows: string[][]; totalRows: number } {
  let sheet: { headers: string[]; rows: TextRow[] };
  try {
    sheet = readEmailSheet(buffer);
  } catch (error) {
    if (error instanceof SpreadsheetReadError && error.message === "The worksheet is empty") return { headers: [], rows: [], totalRows: 0 };
    throw error;
  }
  const { headers } = sheet;
  return {
    headers,
    rows: sheet.rows.slice(0, 5).map((row) => headers.map((_, index) => row.cells[index] ?? "")),
    totalRows: sheet.rows.length,
  };
}

export function suggestedEmailMapping(headers: string[]): EmailCsvMapping {
  const aliases: Record<keyof EmailCsvMapping, string[]> = {
    email: ["email", "emailaddress", "workemail"],
    linkedinUrl: ["linkedin", "linkedinurl", "linkedinprofile", "profileurl"],
    firstName: ["firstname", "givenname", "first", "given"],
    lastName: ["lastname", "familyname", "last", "family"],
    fullName: ["fullname", "name"],
    companyName: ["company", "companyname", "organisation", "organization"],
    companyDomain: ["domain", "companydomain", "website"],
    companyLinkedinUrl: ["companylinkedin", "companylinkedinurl", "companylinkedinprofile", "companypage"],
    title: ["title", "jobtitle", "headline", "role"],
  };
  return Object.fromEntries(Object.entries(aliases).flatMap(([field, candidates]) => {
    const header = headers.find((value) => candidates.includes(normalizeHeader(value)));
    return header ? [[field, header]] : [];
  })) as EmailCsvMapping;
}

export function parseRowsWithMapping(buffer: ArrayBuffer, mapping: EmailCsvMapping): { rows: ParsedRow[]; error: string | null } {
  if (!mapping.email) return { rows: [], error: "Map the required Email column" };
  let sheet: { headers: string[]; rows: TextRow[] };
  try {
    sheet = readEmailSheet(buffer);
  } catch (error) {
    if (error instanceof SpreadsheetReadError && error.message === "The worksheet is empty") return { rows: [], error: "Sheet is empty" };
    throw error;
  }
  const { headers } = sheet;
  const selectedHeaders = Object.values(mapping).filter((header): header is string => !!header);
  if (new Set(selectedHeaders).size !== selectedHeaders.length) return { rows: [], error: "Each CSV column can map to only one destination field" };
  if (selectedHeaders.some((header) => !headers.includes(header))) return { rows: [], error: "The mapping references a column that is not in this file" };
  const mappedHeaders = new Set(selectedHeaders);
  const rows = sheet.rows.map(({ cells, rowNumber }) => {
    const row = new Map(headers.map((header, index) => [header, cells[index] ?? ""] as const));
    const value = (field: keyof EmailCsvMapping) => cell(mapping[field] ? row.get(mapping[field]!) : null);
    let firstName = value("firstName");
    let lastName = value("lastName");
    if (!firstName && !lastName) {
      const fullName = value("fullName");
      if (fullName) {
        const parts = fullName.split(/\s+/);
        firstName = parts[0] ?? null;
        lastName = parts.slice(1).join(" ") || null;
      }
    }
    const customFields: Record<string, string> = {};
    headers.forEach((header, index) => {
      if (!header || mappedHeaders.has(header)) return;
      const parsed = cell(cells[index]);
      const key = toCamelCaseKey(header);
      if (parsed && key && !(key in customFields)) customFields[key] = parsed;
    });
    return {
      email: value("email")?.toLowerCase() ?? "",
      linkedinUrl: value("linkedinUrl"),
      firstName,
      lastName,
      company: value("companyName"),
      domain: value("companyDomain"),
      companyLinkedinUrl: value("companyLinkedinUrl"),
      title: value("title"),
      customFields,
      rowNumber,
    };
  });
  return { rows, error: null };
}

export type ImportResult = {
  total: number;
  imported: number;
  skippedSuppressed: number;
  skippedDuplicate: number;
  failed: { row: number; email: string; error: string }[];
};

export function planEmailCampaignImport(
  rows: ParsedRow[],
  suppressedEmails: ReadonlySet<string>,
  existingCampaignEmails: ReadonlySet<string>,
) {
  let imported = 0;
  let skippedSuppressed = 0;
  let skippedDuplicate = 0;
  const failed: { row: number; email: string; error: string }[] = [];
  const workItems: { row: ParsedRow; enroll: boolean }[] = [];
  const knownCampaignEmails = new Set(existingCampaignEmails);

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = row.rowNumber ?? i + 2;
    if (!normalizeEmail(row.email)) {
      failed.push({ row: rowNum, email: row.email, error: row.email ? "invalid email" : "missing email" });
      continue;
    }
    if (suppressedEmails.has(row.email)) {
      skippedSuppressed += 1;
      continue;
    }
    if (knownCampaignEmails.has(row.email)) {
      skippedDuplicate += 1;
      workItems.push({ row, enroll: false });
      continue;
    }
    workItems.push({ row, enroll: true });
    knownCampaignEmails.add(row.email);
    imported += 1;
  }

  return { workItems, imported, skippedSuppressed, skippedDuplicate, failed };
}

/**
 * Imports leads for a campaign from a CSV/XLSX buffer. Rows whose email is
 * on the suppression list are skipped up front — never even inserted as a
 * lead — same principle as checking suppression before every send, just
 * applied at import time so a suppressed contact never appears in the list.
 */
export async function importLeadsForCampaign(
  campaignId: string,
  buffer: ArrayBuffer,
  options: { filename?: string | null; mapping?: EmailCsvMapping } = {},
): Promise<ImportResult | { error: string }> {
  let parsed: { rows: ParsedRow[]; error: string | null };
  try {
    parsed = options.mapping ? parseRowsWithMapping(buffer, options.mapping) : parseRows(buffer);
  } catch (readError) {
    if (readError instanceof SpreadsheetReadError) return { error: readError.message };
    throw readError;
  }
  const { rows, error } = parsed;
  if (error) return { error };
  if (rows.length === 0) return { error: "No rows with an Email column were found" };
  if (rows.length > MAX_IMPORT_ROWS) return { error: `Too many rows (max ${MAX_IMPORT_ROWS} per import)` };

  // The campaign must be this organization's: another organization's id is simply not found.
  const [campaign] = await db
    .select({ id: outreachCampaigns.id })
    .from(outreachCampaigns)
    .where(and(inOrg(outreachCampaigns), eq(outreachCampaigns.id, campaignId)))
    .limit(1);
  if (!campaign) return { error: "Campaign not found" };

  const emails = rows.map((r) => r.email);
  const suppressed = new Set(
    (await db.select({ email: suppressionList.email }).from(suppressionList).where(and(inOrg(suppressionList), inArray(suppressionList.email, emails)))).map(
      (r) => r.email,
    ),
  );
  const existing = new Set(
    (
      await db
        .select({ email: people.email })
        .from(outreachLeads)
        .innerJoin(people, eq(outreachLeads.personId, people.id))
        .where(and(leadsInOrg(), inOrg(people), eq(outreachLeads.campaignId, campaignId), inArray(people.email, emails)))
    ).flatMap((r) => (r.email ? [r.email] : [])),
  );

  const { workItems, imported, skippedSuppressed, skippedDuplicate, failed } =
    planEmailCampaignImport(rows, suppressed, existing);

  await withLeadTransaction(async (tx) => {
    for (const { row, enroll } of workItems) {
      const person = await upsertPerson(tx, {
        email: row.email,
        linkedinUrl: row.linkedinUrl,
        firstName: row.firstName,
        lastName: row.lastName,
        title: row.title,
        company: row.domain || row.company
          ? { domain: row.domain, name: row.company, linkedinUrl: row.companyLinkedinUrl }
          : null,
        raw: row.customFields,
        source: `campaign:email:${campaignId}`,
      });
      if (enroll) {
        await tx.insert(outreachLeads).values({
          personId: person.id,
          campaignId,
          sequenceStatus: "pending",
        });
      }
    }

    await tx.insert(importRuns).values({
      organizationId: currentOrganizationId(),
      source: "file",
      filename: options.filename ?? null,
      destination: "campaign",
      destinationCampaignId: campaignId,
      mapping: {
        mode: options.mapping ? "explicit-column-mapping" : "legacy-email-auto-map",
        mapped: options.mapping ?? ["email", "linkedinUrl", "firstName", "lastName", "title", "company", "domain"],
        extra: "people.raw",
      },
      stats: { total: rows.length, imported, skippedSuppressed, skippedDuplicate, failed: failed.length },
    });
  });

  return { total: rows.length, imported, skippedSuppressed, skippedDuplicate, failed };
}
