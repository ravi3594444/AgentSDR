import * as XLSX from "xlsx";

/**
 * The one way an uploaded CSV/TSV/XLSX is opened. Every importer (People,
 * email/LinkedIn/WhatsApp/Calling campaigns, LinkedIn search batches, Tables)
 * reads through here so they agree on two things:
 *
 * - Encoding. Given raw bytes, SheetJS decodes a plain-text file as a
 *   single-byte codepage, so a UTF-8 CSV without a byte-order mark (what
 *   Google Sheets and most tools export) imports "José" as "JosÃ©". The
 *   `codepage: 65001` hint fixed that only for the importers that passed it,
 *   and SheetJS 0.20 logs a warning for it unless its codepage tables are
 *   bundled. Instead, text that is valid UTF-8 is decoded here and handed over
 *   as a string; anything else (a real workbook, or a CSV in another
 *   encoding) keeps SheetJS's own detection.
 * - Errors. An unreadable file throws SpreadsheetReadError with a message fit
 *   to show the person who uploaded it, so routes can answer 400 rather than
 *   500.
 */
export class SpreadsheetReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpreadsheetReadError";
  }
}

const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04]; // .xlsx, .xlsm, .xlsb, .ods
const CFB_MAGIC = [0xd0, 0xcf, 0x11, 0xe0]; // legacy .xls, password-protected workbooks

const startsWith = (bytes: Uint8Array, magic: number[]) => magic.every((byte, index) => bytes[index] === byte);

/**
 * The text of a plain-text upload when it is valid UTF-8 (a leading BOM is
 * dropped); null for workbook containers, binary data and other encodings.
 */
export function utf8Text(bytes: Uint8Array): string | null {
  if (startsWith(bytes, ZIP_MAGIC) || startsWith(bytes, CFB_MAGIC) || bytes.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function readableMessage(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  if (/password-protected/i.test(detail)) {
    return "The file is password-protected. Remove the password, save it again and upload it.";
  }
  return "Could not read that file. Upload a CSV or an Excel workbook (.xlsx).";
}

export type SpreadsheetReadOptions = Omit<XLSX.ParsingOptions, "type" | "codepage">;

/** Opens an uploaded spreadsheet. Throws SpreadsheetReadError for an empty or unreadable file. */
export function readSpreadsheet(input: ArrayBuffer | Uint8Array, options: SpreadsheetReadOptions = {}): XLSX.WorkBook {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (!bytes.length) throw new SpreadsheetReadError("The file is empty");
  const text = utf8Text(bytes);
  let workbook: XLSX.WorkBook;
  try {
    workbook = text === null
      ? XLSX.read(bytes, { ...options, type: "array" })
      : XLSX.read(text, { ...options, type: "string" });
  } catch (error) {
    throw new SpreadsheetReadError(readableMessage(error));
  }
  if (!workbook.SheetNames.length) throw new SpreadsheetReadError("The file has no worksheet");
  return workbook;
}

/** One data row of a sheet read as text, with its row number as the spreadsheet shows it. */
export type TextRow = { cells: string[]; rowNumber: number };

/**
 * A cell as the person typed it. Text cells are taken verbatim, so a phone
 * number or zip code keeps its leading zeros. A number cell uses its display
 * text only when it has an explicit number format ("00000" keeps 00123);
 * under General, SheetJS would display 919876543210 as "9.19877E+11", so the
 * raw value is written out in full instead.
 */
export function cellText(cell: XLSX.CellObject | undefined): string {
  if (!cell) return "";
  switch (cell.t) {
    case "s":
      return String(cell.v ?? "").trim();
    case "n": {
      if (cell.z && cell.z !== "General" && typeof cell.w === "string") return cell.w.trim();
      return typeof cell.v === "number" && Number.isFinite(cell.v) ? String(cell.v) : String(cell.w ?? "").trim();
    }
    case "b":
      return cell.v ? "TRUE" : "FALSE";
    case "e":
    case "z":
      return "";
    default:
      return String(cell.w ?? cell.v ?? "").trim();
  }
}

/**
 * Header names made unique the way SheetJS's sheet_to_json does it ("Email",
 * "Email_1"), so a file with a repeated column can still be mapped by name.
 */
export function uniqueHeaders(headers: string[]): string[] {
  const seen = new Map<string, number>();
  return headers.map((header) => {
    const count = seen.get(header) ?? 0;
    seen.set(header, count + 1);
    return count ? `${header}_${count}` : header;
  });
}

/**
 * The first worksheet as text: the first non-blank row is the header, blank
 * rows are skipped, and every row keeps its file row number for error
 * messages. CSV/TSV values are not parsed at all (no number or date
 * inference), which is what an importer of names, emails and phone numbers
 * wants; Tables, which infers column types, keeps using readSpreadsheet.
 * Throws SpreadsheetReadError for an unreadable or empty file.
 */
export function readTextSheet(input: ArrayBuffer | Uint8Array): { headers: string[]; rows: TextRow[] } {
  // cellNF keeps each cell's number format, which cellText needs to tell "00123" from 123.
  const workbook = readSpreadsheet(input, { raw: true, cellNF: true });
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  if (!sheet?.["!ref"]) throw new SpreadsheetReadError("The worksheet is empty");
  const range = XLSX.utils.decode_range(sheet["!ref"]);
  const lines: TextRow[] = [];
  for (let r = range.s.r; r <= range.e.r; r += 1) {
    const cells: string[] = [];
    for (let c = range.s.c; c <= range.e.c; c += 1) cells.push(cellText(sheet[XLSX.utils.encode_cell({ r, c })]));
    while (cells.length && !cells[cells.length - 1]) cells.pop();
    if (cells.length) lines.push({ cells, rowNumber: r + 1 });
  }
  if (!lines.length) throw new SpreadsheetReadError("The worksheet is empty");
  const [header, ...rows] = lines;
  return { headers: header.cells, rows };
}

/**
 * readTextSheet as one object per row, keyed by header (repeats suffixed as
 * uniqueHeaders does, blank headers as "__EMPTY", "__EMPTY_1" like
 * sheet_to_json), every key present: a drop-in for
 * `sheet_to_json(sheet, { defval: "" })` that keeps cells as typed text.
 */
export function readTextRecords(input: ArrayBuffer | Uint8Array): { headers: string[]; records: Record<string, string>[] } {
  const sheet = readTextSheet(input);
  const headers = uniqueHeaders(sheet.headers.map((header) => header.trim() || "__EMPTY"));
  const records = sheet.rows.map((row) => Object.fromEntries(headers.map((header, index) => [header, row.cells[index] ?? ""])));
  return { headers, records };
}
