import { describe, expect, test } from "bun:test";
import * as XLSX from "xlsx";

import { isInitialPlaceholderRow, isInitialSeedColumn, parseSpreadsheet } from "./import.ts";

describe("grid spreadsheet imports", () => {
  test("does not import a formatted-but-empty first data row from Excel", () => {
    const workbook = XLSX.utils.book_new();
    const sheet = XLSX.utils.aoa_to_sheet([
      ["Email", "Company"],
      ["", ""],
      ["ada@example.com", "Analytical Engines"],
    ]);
    XLSX.utils.book_append_sheet(workbook, sheet, "Leads");
    const buffer = XLSX.write(workbook, { type: "array", bookType: "xlsx" });

    const parsed = parseSpreadsheet(buffer);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.sheet.totalRows).toBe(1);
    expect(parsed.sheet.rows).toEqual([["ada@example.com", "Analytical Engines"]]);
  });

  test("reads a UTF-8 CSV without mojibake and keeps ISO dates as dates", () => {
    const bytes = new TextEncoder().encode("Name,Joined\nJosé Müller,2024-03-01\n");
    const parsed = parseSpreadsheet(bytes.buffer);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.sheet.rows).toEqual([["José Müller", "2024-03-01"]]);
  });

  test("an unreadable file is a readable error", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
    expect(parseSpreadsheet(png.buffer)).toEqual({ ok: false, error: "Could not read that file. Upload a CSV or an Excel workbook (.xlsx)." });
  });

  test("identifies only a sole empty seed row as replaceable", () => {
    expect(isInitialPlaceholderRow([{ cells: {}, cellMeta: {} }])).toBe(true);
    expect(isInitialPlaceholderRow([{ cells: { email: "ada@example.com" }, cellMeta: {} }])).toBe(false);
    expect(isInitialPlaceholderRow([{ cells: {}, cellMeta: {} }, { cells: {}, cellMeta: {} }])).toBe(false);
  });

  test("identifies only the untouched starter column as reusable", () => {
    expect(isInitialSeedColumn([{ key: "name", name: "New Column" }])).toBe(true);
    expect(isInitialSeedColumn([{ key: "email", name: "Email" }])).toBe(false);
    expect(isInitialSeedColumn([{ key: "name", name: "New Column" }, { key: "email", name: "Email" }])).toBe(false);
  });
});
