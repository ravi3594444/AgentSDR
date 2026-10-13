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
