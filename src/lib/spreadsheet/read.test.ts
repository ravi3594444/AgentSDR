import { describe, expect, test } from "bun:test";
import * as XLSX from "xlsx";
import { readSpreadsheet, SpreadsheetReadError, utf8Text } from "./read";

const bytesOf = (text: string) => new TextEncoder().encode(text);

function firstSheetRows(workbook: XLSX.WorkBook): unknown[][] {
  return XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[workbook.SheetNames[0]], { header: 1, blankrows: false });
}

function xlsxBytes(rows: unknown[][]): Uint8Array {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), "Leads");
  return new Uint8Array(XLSX.write(workbook, { type: "array", bookType: "xlsx" }));
}

describe("the SheetJS dependency", () => {
  // CVE-2023-30533 (prototype pollution, fixed in 0.19.3) and CVE-2024-22363
  // (ReDoS, fixed in 0.20.2) affect every xlsx on the npm registry, whose
  // last release is 0.18.5. The fixed builds ship only from cdn.sheetjs.com;
  // package.json pins the vendored copy in vendor/. This fails if a reinstall
  // or `bun update` puts the registry build back.
  test("is a release with both advisories fixed", () => {
    const [major, minor, patch] = XLSX.version.split(".").map(Number);
    expect(major * 1_000_000 + minor * 1_000 + patch).toBeGreaterThanOrEqual(20_002);
  });
});

describe("readSpreadsheet", () => {
  test("keeps accents and other scripts in a UTF-8 CSV without a byte-order mark", () => {
    const workbook = readSpreadsheet(bytesOf("Email,Name,Company\njose@example.com,José Müller,Zürich — AG\nr@example.in,राम शर्मा,Café Ltd\n"));
    expect(firstSheetRows(workbook)).toEqual([
      ["Email", "Name", "Company"],
      ["jose@example.com", "José Müller", "Zürich — AG"],
      ["r@example.in", "राम शर्मा", "Café Ltd"],
    ]);
  });

  test("drops a UTF-8 byte-order mark instead of gluing it to the first header", () => {
    const workbook = readSpreadsheet(bytesOf("﻿Email,Name\njose@example.com,José\n"));
    expect(firstSheetRows(workbook)[0]).toEqual(["Email", "Name"]);
    expect(firstSheetRows(workbook)[1]).toEqual(["jose@example.com", "José"]);
  });

  test("still reads a legacy single-byte (Windows-1252) CSV", () => {
    // "José" with é as the single byte 0xE9: not valid UTF-8.
    const bytes = new Uint8Array([...bytesOf("Email,Name\nj@example.com,Jos"), 0xe9, 0x0a]);
    expect(utf8Text(bytes)).toBeNull();
    expect(firstSheetRows(readSpreadsheet(bytes))[1]).toEqual(["j@example.com", "José"]);
  });

  test("reads an .xlsx workbook from an ArrayBuffer or a Uint8Array", () => {
    const bytes = xlsxBytes([["Email", "Name"], ["jose@example.com", "José Müller"]]);
    expect(utf8Text(bytes)).toBeNull();
    const fromArrayBuffer = readSpreadsheet(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    expect(firstSheetRows(fromArrayBuffer)).toEqual([["Email", "Name"], ["jose@example.com", "José Müller"]]);
    expect(firstSheetRows(readSpreadsheet(bytes))).toEqual(firstSheetRows(fromArrayBuffer));
  });

  test("parses CSV values the same way as before the UTF-8 change", () => {
    const csv = "Email,Phone,Joined,Amount\na@b.com,919876543210,2024-03-01,\"1,234.50\"\n";
    const viaHelper = firstSheetRows(readSpreadsheet(bytesOf(csv)));
    const viaBytes = firstSheetRows(XLSX.read(bytesOf(csv), { type: "array" }));
    expect(viaHelper).toEqual(viaBytes);
  });

  test("passes parsing options through", () => {
    const workbook = readSpreadsheet(bytesOf("Joined\n2024-03-01\n"), { cellDates: true });
    expect(firstSheetRows(workbook)[1][0]).toBeInstanceOf(Date);
  });

  test("an empty upload is a readable error", () => {
    expect(() => readSpreadsheet(new Uint8Array())).toThrow(new SpreadsheetReadError("The file is empty"));
  });

  test("an image or a corrupt workbook is a readable error, not a SheetJS internal message", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82]);
    const corruptZip = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    for (const bytes of [png, corruptZip]) {
      let caught: unknown;
      try {
        readSpreadsheet(bytes);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(SpreadsheetReadError);
      expect((caught as Error).message).toBe("Could not read that file. Upload a CSV or an Excel workbook (.xlsx).");
    }
  });
});
