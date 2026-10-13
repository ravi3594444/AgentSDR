/**
 * Upload checks shared by every spreadsheet import route and its form. No
 * imports, so a client component can check a file before sending it without
 * pulling SheetJS into the browser bundle.
 */

/** Lead-import uploads: far above the 5,000-row import caps, far below what strains a request. */
export const SPREADSHEET_UPLOAD_MAX_BYTES = 10 * 1024 * 1024;
const SPREADSHEET_EXTENSIONS = new Set(["csv", "tsv", "txt", "xlsx", "xlsm", "xls", "ods"]);

const megabytes = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(bytes < 1024 * 1024 ? 2 : 1)} MB`;

/**
 * Why an uploaded file cannot be imported before it is read, or null: empty,
 * over the size limit, or plainly not a spreadsheet by its extension (a file
 * without an extension is let through to content sniffing). Every lead
 * upload route checks this, so a 40 MB export or a PDF gets a sentence
 * rather than a parser error.
 */
export function spreadsheetUploadProblem(file: { name?: string; size: number }, maxBytes = SPREADSHEET_UPLOAD_MAX_BYTES): string | null {
  if (!file.size) return "The file is empty";
  if (file.size > maxBytes) return `The file is ${megabytes(file.size)}; the limit is ${megabytes(maxBytes)}. Split it into smaller files.`;
  const name = file.name?.trim() ?? "";
  const extension = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  if (extension && !SPREADSHEET_EXTENSIONS.has(extension)) {
    return `“${name}” is not a spreadsheet. Upload a .csv or .xlsx file.`;
  }
  return null;
}

/** The message for a multipart body that could not be read at all. */
export const UNREADABLE_UPLOAD_MESSAGE = `Could not read the upload. Send the spreadsheet as a file (under ${megabytes(SPREADSHEET_UPLOAD_MAX_BYTES)}).`;
