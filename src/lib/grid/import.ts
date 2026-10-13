import * as XLSX from "xlsx";
import { readSpreadsheet, SpreadsheetReadError } from "@/lib/spreadsheet/read";
import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { gridColumns, gridRows } from "./schema";
import { listColumns, toColumnKey, uniqueColumnKey, uniqueColumnName } from "./columns";
import { coerceClipboardValue, parseNumericText } from "./clipboard";
import { MAX_NAME_LENGTH } from "./validate";
import { insertRows } from "./rows";
import { inOrgTables, tableInOrganization } from "./scope";
import { isStaticColumnType, type CellValues, type ColumnType, type StaticColumnType } from "./types";

/**
 * Ceiling on one import. Higher than the outreach importer's 5,000 because an
 * enrichment table is where a large prospect list lands; it matches the
 * ≤50k-rows-per-table scale target in docs/design/enrichment-plan.md.
 */
export const MAX_IMPORT_ROWS = 50_000;

export type ParsedSheet = {
  headers: string[];
  /** Data rows only — the header row is already removed. */
  rows: string[][];
  /** Row count before MAX_IMPORT_ROWS truncation. */
  totalRows: number;
  truncated: boolean;
};

export type ParseResult =
  | { ok: true; sheet: ParsedSheet; sheetNames: string[] }
  | { ok: false; error: string };

function cell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).trim();
}

/**
 * Reads the first row as headers. Accepts .csv, .tsv, .txt and .xlsx alike.
 *
 * readSpreadsheet decodes UTF-8 text itself: without that, xlsx guesses a
 * single-byte codepage for plain-text input, so a UTF-8 .csv containing an
 * em-dash, curly quote or accented name imports as mojibake. Real .xlsx
 * carries its own encoding.
 */
export function parseSpreadsheet(buffer: ArrayBuffer, sheetName?: string): ParseResult {
  let workbook: XLSX.WorkBook;
  try {
    // cellDates matters as much as the encoding: without it xlsx converts any
    // date-looking cell — in CSV as well as .xlsx — into an Excel serial
    // number, so "2024-03-01" arrives as 45352 and infers as a number column.
    workbook = readSpreadsheet(buffer, { cellDates: true });
  } catch (error) {
    if (error instanceof SpreadsheetReadError) return { ok: false, error: error.message };
    return { ok: false, error: "Could not read that file — is it a valid CSV or Excel file?" };
  }

  const names = workbook.SheetNames;
  if (!names.length) return { ok: false, error: "That file has no sheets" };

  const chosen = sheetName && names.includes(sheetName) ? sheetName : names[0];
  const raw = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[chosen], {
    header: 1,
    blankrows: false,
    defval: "",
  });

  if (!raw.length) return { ok: false, error: "That sheet is empty" };

  const headers = (raw[0] ?? []).map((h) => cell(h));
  if (!headers.some(Boolean)) {
    return { ok: false, error: "The first row is empty — it should hold the column headers" };
  }

  // XLSX can represent a visually blank, formatted Excel row as an array of
  // empty strings. `blankrows: false` does not remove that shape once defval
  // fills missing cells, so drop it before previewing or inserting records.
  const body = raw.slice(1).filter((row) => row.some((value) => cell(value) !== ""));
  const kept = body.slice(0, MAX_IMPORT_ROWS);

  return {
    ok: true,
    sheetNames: names,
    sheet: {
      headers,
      // Pad short rows so every row lines up with the header indices.
      rows: kept.map((r) => headers.map((_, i) => cell(r[i]))),
      totalRows: body.length,
      truncated: body.length > MAX_IMPORT_ROWS,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Type inference                                                              */
/* -------------------------------------------------------------------------- */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const URL_RE = /^https?:\/\/\S+$/i;
const BOOL_VALUES = new Set(["true", "false", "yes", "no", "y", "n", "1", "0"]);

/** Share of non-empty samples that must fit a number or date type; the rest stay raw strings. */
const MAJORITY = 0.9;

const MONTH = "(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?";
const DATE_SHAPES: RegExp[] = [
  // 2024-01-05, 2024-01-05 13:45, 2024-01-05T13:45:10.000Z, 2024/01/05
  /^\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:[T ]\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:\s?[AP]M)?(?:Z|[+-]\d{2}:?\d{2})?)?$/i,
  // 05/01/2024, 5-1-24, 5.1.2024
  /^\d{1,2}[/.-]\d{1,2}[/.-](?:\d{4}|\d{2})(?:[ T]\d{1,2}:\d{2}(?::\d{2})?(?:\s?[AP]M)?)?$/i,
  // Jan 5, 2024 / January 5 2024
  new RegExp(`^${MONTH}\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}$`, "i"),
  // 5 Jan 2024 / 5th January, 2024
  new RegExp(`^\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH},?\\s+\\d{4}$`, "i"),
];

/** True for text that has the shape of a real calendar date, not merely something Date.parse tolerates. */
export function looksLikeDate(value: string): boolean {
  const text = value.trim();
  if (!DATE_SHAPES.some((shape) => shape.test(text))) return false;
  const numeric = /^(\d{1,2})[/.-](\d{1,2})[/.-]\d{2,4}/.exec(text);
  if (numeric) {
    const [a, b] = [Number(numeric[1]), Number(numeric[2])];
    // dd/mm or mm/dd — one of the two has to be a month.
    return a >= 1 && b >= 1 && a <= 31 && b <= 31 && (a <= 12 || b <= 12);
  }
  const iso = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/.exec(text);
  if (iso) return Number(iso[2]) >= 1 && Number(iso[2]) <= 12 && Number(iso[3]) >= 1 && Number(iso[3]) <= 31;
  return !Number.isNaN(Date.parse(text));
}

/** A number as a person writes it; zip-code-like "02134" and 16+ digit ids stay text. */
function looksNumeric(value: string): boolean {
  if (/^[+-]?0\d/.test(value.trim())) return false;
  if (/^[+-]?\d{16,}$/.test(value.trim())) return false;
  return parseNumericText(value) !== null;
}

/**
 * Guesses a column type from sample values, so an imported file arrives with
 * sensible types instead of everything being text.
 *
 * Only non-empty samples count. Email, URL and boolean need every one to
 * agree. Number and date accept a 90% majority: a column of figures with one
 * "N/A" is still a number column, and the stray value is kept as its raw
 * string (see coerceValue) rather than lost. Dates must have a real date
 * shape — Date.parse alone accepts far too much ("a&b=1", "Room 5").
 */
export function inferColumnType(samples: string[]): StaticColumnType {
  const values = samples.map((s) => s.trim()).filter(Boolean);
  if (!values.length) return "text";
  const mostly = (test: (v: string) => boolean) =>
    values.filter(test).length / values.length >= MAJORITY;

  if (values.every((v) => EMAIL_RE.test(v))) return "email";
  if (values.every((v) => URL_RE.test(v))) return "url";
  // A column of only 0s and 1s is far more often a count or a flag stored as
  // a number than a yes/no question; numbers also round-trip losslessly.
  if (values.every((v) => v === "0" || v === "1")) return "number";
  if (values.every((v) => BOOL_VALUES.has(v.toLowerCase()))) return "boolean";
  if (mostly(looksNumeric)) return "number";
  if (mostly(looksLikeDate)) return "date";

  return "text";
}

/**
 * Coerces a cell string into the shape its column type expects.
 *
 * Same rules as a paste (clipboard.ts): a value that does not fit the type —
 * "N/A" in a number column, "maybe" in a boolean one — is kept as the raw
 * string rather than turned into null/false and silently lost. Only blank
 * cells become null.
 */
export function coerceValue(raw: string, type: ColumnType): unknown {
  const v = raw.trim();
  if (!v) return null;
  return isStaticColumnType(type) ? coerceClipboardValue(v, type) : v;
}

/* -------------------------------------------------------------------------- */
/* Mapping + execution                                                         */
/* -------------------------------------------------------------------------- */

export type ColumnMapping =
  /** Write into a column that already exists. */
  | { headerIndex: number; action: "map"; columnKey: string }
  /** Create a new column for this header. */
  | { headerIndex: number; action: "create"; name: string; type: StaticColumnType }
  /** Ignore this file column entirely. */
  | { headerIndex: number; action: "skip" };

/**
 * Default mapping for a freshly-parsed file: reuse an existing column when the
 * header matches one (by key or case-insensitive name), otherwise propose
 * creating one with an inferred type.
 */
export function suggestMapping(
  headers: string[],
  rows: string[][],
  existing: { key: string; name: string }[],
): ColumnMapping[] {
  const byKey = new Map(existing.map((c) => [c.key.toLowerCase(), c]));
  const byName = new Map(existing.map((c) => [c.name.trim().toLowerCase(), c]));

  return headers.map((header, headerIndex) => {
    if (!header.trim()) return { headerIndex, action: "skip" as const };

    const match =
      byKey.get(toColumnKey(header).toLowerCase()) ?? byName.get(header.trim().toLowerCase());

    if (match) return { headerIndex, action: "map" as const, columnKey: match.key };

    const samples = rows.slice(0, 50).map((r) => r[headerIndex] ?? "");
    return {
      headerIndex,
      action: "create" as const,
      name: header.trim(),
      type: inferColumnType(samples),
    };
  });
}

/**
 * Validates a client-supplied mapping and fills in what it left out (a
 * created column's name defaults to its header). Never throws: the route turns
 * the message into a 400.
 */
export function normalizeMapping(
  raw: unknown,
  headers: string[],
  knownKeys: ReadonlySet<string>,
): { ok: true; mapping: ColumnMapping[] } | { ok: false; error: string } {
  if (!Array.isArray(raw)) return { ok: false, error: "mapping must be an array" };
  const seen = new Set<number>();
  const mapping: ColumnMapping[] = [];
  for (const entry of raw as unknown[]) {
    if (typeof entry !== "object" || entry === null) return { ok: false, error: "every mapping entry must be an object" };
    const m = entry as Record<string, unknown>;
    const index = m.headerIndex;
    if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= headers.length) {
      return { ok: false, error: "headerIndex must point at a column in the file" };
    }
    if (seen.has(index)) return { ok: false, error: `file column ${index + 1} is mapped more than once` };
    seen.add(index);

    if (m.action === "skip") {
      mapping.push({ headerIndex: index, action: "skip" });
    } else if (m.action === "map") {
      if (typeof m.columnKey !== "string" || !knownKeys.has(m.columnKey)) {
        return { ok: false, error: `mapping targets unknown column "${String(m.columnKey)}"` };
      }
      mapping.push({ headerIndex: index, action: "map", columnKey: m.columnKey });
    } else if (m.action === "create") {
      if (typeof m.type !== "string" || !isStaticColumnType(m.type as ColumnType)) {
        return { ok: false, error: `"${String(m.type)}" is not a column type an import can create` };
      }
      if (m.name !== undefined && typeof m.name !== "string") {
        return { ok: false, error: "a new column's name must be text" };
      }
      const name = (typeof m.name === "string" ? m.name.trim() : "") || headers[index].trim();
      if (!name) return { ok: false, error: `name the new column for file column ${index + 1}` };
      if (name.length > MAX_NAME_LENGTH) {
        return { ok: false, error: `column names must be ${MAX_NAME_LENGTH} characters or fewer` };
      }
      mapping.push({ headerIndex: index, action: "create", name, type: m.type as StaticColumnType });
    } else {
      return { ok: false, error: "mapping action must be map, create or skip" };
    }
  }
  return { ok: true, mapping };
}

export type ImportResult = {
  rowsInserted: number;
  columnsCreated: number;
  truncated: boolean;
};

/**
 * Fresh tables are seeded with an empty row so a blank grid is immediately
 * editable. An import should replace that placeholder, not append below it.
 */
export function isInitialPlaceholderRow(
  rows: Array<{ cells: Record<string, unknown>; cellMeta: Record<string, unknown> }>,
): boolean {
  return rows.length === 1 && Object.keys(rows[0].cells).length === 0 && Object.keys(rows[0].cellMeta).length === 0;
}

/** New tables carry this editable starter column until their first import. */
export function isInitialSeedColumn(columns: Array<{ key: string; name: string }>): boolean {
  return columns.length === 1 && columns[0].key === "name" && columns[0].name === "New Column";
}

/**
 * Creates any columns the mapping asks for, then inserts the rows.
 *
 * Columns are created first and in one transaction so a failure part-way
 * cannot leave rows referencing a key with no column behind it.
 */
export async function importRows(
  tableId: string,
  sheet: ParsedSheet,
  mapping: ColumnMapping[],
): Promise<ImportResult> {
  if (!(await tableInOrganization(tableId))) throw new Error("That table no longer exists");
  const [existing, existingRows] = await Promise.all([
    listColumns(tableId),
    db
      .select({ id: gridRows.id, cells: gridRows.cells, cellMeta: gridRows.cellMeta })
      .from(gridRows)
      .where(and(inOrgTables(gridRows.tableId), eq(gridRows.tableId, tableId)))
      .orderBy(asc(gridRows.position))
      .limit(2),
  ]);
  const placeholderId = isInitialPlaceholderRow(existingRows) ? existingRows[0].id : null;
  const canReuseSeedColumn = Boolean(placeholderId && isInitialSeedColumn(existing));
  const taken = new Set(existing.map((c) => c.key));
  const takenNames = existing.map((c) => c.name);

  // A fresh grid has a placeholder row and a "New Column" column. Reuse that
  // column for the first newly-created file column instead of leaving an
  // empty column in front of the imported data. A header the person mapped
  // onto an existing column — the seed included — is written into it as is:
  // mapping never renames or retypes a column.
  const seedMapped = canReuseSeedColumn && mapping.some((m) => m.action === "map" && m.columnKey === existing[0].key);
  const seedMapping = canReuseSeedColumn && !seedMapped
    ? mapping.find((m): m is Extract<ColumnMapping, { action: "create" }> => m.action === "create")
    : undefined;
  const creates = mapping.filter(
    (m): m is Extract<ColumnMapping, { action: "create" }> => m.action === "create" && m !== seedMapping,
  );
  let position = existing.reduce((max, c) => Math.max(max, c.position), 0);

  /** headerIndex -> the column key its values land in. */
  const target = new Map<number, string>();
  for (const m of mapping) {
    if (m.action === "map") target.set(m.headerIndex, m.columnKey);
  }

  if (seedMapping) {
    const seed = existing[0];
    const nextName = seedMapping.name.trim() || seed.name;
    await db
      .update(gridColumns)
      .set({ name: nextName, type: seedMapping.type, updatedAt: new Date() })
      .where(and(inOrgTables(gridColumns.tableId), eq(gridColumns.id, seed.id)));
    target.set(seedMapping.headerIndex, seed.key);
    takenNames.splice(0, takenNames.length, nextName);
  }

  if (creates.length) {
    const toInsert = creates.map((m) => {
      const key = uniqueColumnKey(m.name, taken);
      taken.add(key);
      position += 1;
      target.set(m.headerIndex, key);
      return {
        tableId,
        key,
        name: (() => {
          const name = uniqueColumnName(m.name.trim() || key, takenNames);
          takenNames.push(name);
          return name;
        })(),
        type: m.type as ColumnType,
        config: {},
        dependsOn: [],
        position,
      };
    });

    await db.transaction(async (tx) => {
      await tx.insert(gridColumns).values(toInsert);
    });
  }

  // Type per target key, so values are coerced the way their column expects.
  const typeByKey = new Map<string, ColumnType>(existing.map((c) => [c.key, c.type]));
  if (seedMapping) {
    typeByKey.set(existing[0].key, seedMapping.type);
  }
  for (const m of creates) {
    const key = target.get(m.headerIndex);
    if (key) typeByKey.set(key, m.type);
  }

  const records: CellValues[] = sheet.rows.map((row) => {
    const out: CellValues = {};
    for (const [headerIndex, key] of target) {
      const value = coerceValue(row[headerIndex] ?? "", typeByKey.get(key) ?? "text");
      if (value !== null) out[key] = value;
    }
    return out;
  }).filter((record) => Object.keys(record).length > 0);

  const rowsInserted = await insertRows(tableId, records);

  // Insert before deleting so a failed import leaves a fresh table usable.
  // Re-check the JSONB fields in the DELETE in case another editor populated
  // the placeholder while the import was being parsed.
  if (rowsInserted > 0 && placeholderId) {
    await db
      .delete(gridRows)
      .where(and(
        inOrgTables(gridRows.tableId),
        eq(gridRows.id, placeholderId),
        sql`${gridRows.cells} = '{}'::jsonb`,
        sql`${gridRows.cellMeta} = '{}'::jsonb`,
      ));
  }

  return { rowsInserted, columnsCreated: creates.length, truncated: sheet.truncated };
}
