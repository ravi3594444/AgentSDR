import { describe, expect, test } from "bun:test";
import * as XLSX from "xlsx";
import { readTextSheet, uniqueHeaders } from "./read";
import { SPREADSHEET_UPLOAD_MAX_BYTES, spreadsheetUploadProblem } from "./upload";

const bytesOf = (text: string) => new TextEncoder().encode(text);

function xlsxBytes(sheet: XLSX.WorkSheet): Uint8Array {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Leads");
  return new Uint8Array(XLSX.write(workbook, { type: "array", bookType: "xlsx" }));
}

describe("readTextSheet", () => {
  test("keeps CSV phone numbers and zip codes as typed, leading zeros included", () => {
    const sheet = readTextSheet(bytesOf("Name,Phone,Zip\nAsha,09876543210,00123\nRavi,+91 98765 43210,0\n"));
    expect(sheet.headers).toEqual(["Name", "Phone", "Zip"]);
    expect(sheet.rows.map((row) => row.cells)).toEqual([
      ["Asha", "09876543210", "00123"],
      ["Ravi", "+91 98765 43210", "0"],
    ]);
  });

  test("does not turn CSV numbers into dates or scientific notation", () => {
    const sheet = readTextSheet(bytesOf("Phone,When\n919876543210,1/2/2026\n"));
    expect(sheet.rows[0]!.cells).toEqual(["919876543210", "1/2/2026"]);
  });

  test("XLSX text cells keep their leading zeros", () => {
    const ws = XLSX.utils.aoa_to_sheet([["Phone"], ["09876543210"]]);
    expect(readTextSheet(xlsxBytes(ws)).rows[0]!.cells).toEqual(["09876543210"]);
  });

  test("an XLSX number in General format is written out in full, not as 9.19877E+11", () => {
    const ws = XLSX.utils.aoa_to_sheet([["Phone"], [919876543210]]);
    expect(readTextSheet(xlsxBytes(ws)).rows[0]!.cells).toEqual(["919876543210"]);
  });

  test("an XLSX number with a zero-padded format keeps its displayed zeros", () => {
    const ws = XLSX.utils.aoa_to_sheet([["Zip"], [123]]);
    ws.A2!.z = "00000";
    expect(readTextSheet(xlsxBytes(ws)).rows[0]!.cells).toEqual(["00123"]);
  });

  test("row numbers are the file's, across blank rows and a blank first line", () => {
    const sheet = readTextSheet(bytesOf("\nEmail\na@x.com\n\n,\nb@x.com\n"));
    expect(sheet.headers).toEqual(["Email"]);
    expect(sheet.rows).toEqual([
      { cells: ["a@x.com"], rowNumber: 3 },
      { cells: ["b@x.com"], rowNumber: 6 },
    ]);
  });

  test("keeps accents from a UTF-8 CSV without a byte-order mark", () => {
    expect(readTextSheet(bytesOf("Name\nJosé Müller\n")).rows[0]!.cells).toEqual(["José Müller"]);
  });

  test("a sheet with nothing in it is an error", () => {
    expect(() => readTextSheet(bytesOf("\n\n,,\n"))).toThrow("The worksheet is empty");
  });
});

describe("uniqueHeaders", () => {
  test("suffixes repeats the way sheet_to_json does", () => {
    expect(uniqueHeaders(["Email", "Name", "Email", "Email"])).toEqual(["Email", "Name", "Email_1", "Email_2"]);
  });
});

describe("spreadsheetUploadProblem", () => {
  test("accepts a CSV or workbook under the limit, and a file without an extension", () => {
    expect(spreadsheetUploadProblem({ name: "leads.csv", size: 2048 })).toBeNull();
    expect(spreadsheetUploadProblem({ name: "Leads.XLSX", size: 2048 })).toBeNull();
    expect(spreadsheetUploadProblem({ name: "blob", size: 2048 })).toBeNull();
  });

  test("explains an empty, oversized or non-spreadsheet file", () => {
    expect(spreadsheetUploadProblem({ name: "leads.csv", size: 0 })).toBe("The file is empty");
    expect(spreadsheetUploadProblem({ name: "leads.csv", size: SPREADSHEET_UPLOAD_MAX_BYTES + 1 })).toBe(
      "The file is 10.0 MB; the limit is 10.0 MB. Split it into smaller files.",
    );
    expect(spreadsheetUploadProblem({ name: "deck.pdf", size: 2048 })).toBe("“deck.pdf” is not a spreadsheet. Upload a .csv or .xlsx file.");
  });

  test("takes a per-route limit", () => {
    expect(spreadsheetUploadProblem({ name: "big.csv", size: 15 * 1024 * 1024 }, 20 * 1024 * 1024)).toBeNull();
  });
});
