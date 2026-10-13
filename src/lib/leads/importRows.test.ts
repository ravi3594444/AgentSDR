import assert from "node:assert/strict";
import { describe, test } from "node:test";
import * as XLSX from "xlsx";
import { parseImportRows } from "./importRows";

function workbookBuffer(rows: unknown[][]): ArrayBuffer {
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, "Sheet1");
  const buffer: Buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
  return new Uint8Array(buffer).buffer;
}

function csvBuffer(text: string): ArrayBuffer {
  const bytes = new TextEncoder().encode(text);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

describe("parseImportRows", () => {
  test("matches headers case- and punctuation-insensitively and returns every row unfiltered", () => {
    const rows = parseImportRows(workbookBuffer([
      ["Email", "Full Name", "Job Title", "Company Name", "Phone Number"],
      ["jane@example.com", "Jane Doe", "VP Sales", "Acme", "+91 98765 43210"],
      ["", "No Identity, Has Phone", "", "Beta", "0091 98765 00000"],
    ]));
    assert.equal(rows.length, 2);
    assert.deepEqual(rows[0], {
      email: "jane@example.com",
      linkedinUrl: null,
      fullName: "Jane Doe",
      firstName: null,
      lastName: null,
      title: "VP Sales",
      companyName: "Acme",
      companyDomain: null,
      notes: null,
      phone: "+91 98765 43210",
      rowNumber: 2,
    });
    // Not filtered by the shared parser — a row with no email/linkedin still
    // comes back, because the Calling import only needs a phone number.
    assert.equal(rows[1].email, null);
    assert.equal(rows[1].phone, "0091 98765 00000");
  });

  test("accepts firstname/lastname and several phone header spellings", () => {
    const rows = parseImportRows(workbookBuffer([
      ["firstName", "lastName", "WhatsApp Number", "LinkedIn URL"],
      ["Jane", "Doe", "9876543210", "linkedin.com/in/jane-doe"],
    ]));
    assert.equal(rows[0].firstName, "Jane");
    assert.equal(rows[0].lastName, "Doe");
    assert.equal(rows[0].phone, "9876543210");
    assert.equal(rows[0].linkedinUrl, "linkedin.com/in/jane-doe");
  });

  test("blank cells come back null, not empty strings", () => {
    const rows = parseImportRows(workbookBuffer([
      ["Email", "Phone"],
      ["jane@example.com", ""],
    ]));
    assert.equal(rows[0].phone, null);
  });

  test("throws on an empty worksheet", () => {
    assert.throws(() => parseImportRows(workbookBuffer([])), /empty/);
  });

  test("reads a UTF-8 CSV (no byte-order mark) without mangling names", () => {
    const rows = parseImportRows(csvBuffer("Email,Full Name,Company\njose@example.com,José Müller,Zürich AG\n"));
    assert.equal(rows[0].fullName, "José Müller");
    assert.equal(rows[0].companyName, "Zürich AG");
  });

  test("reports each row's position in the file, counting blank lines", () => {
    const rows = parseImportRows(csvBuffer("Email\n\na@example.com\n\n\nb@example.com\n"));
    assert.deepEqual(rows.map((row) => [row.email, row.rowNumber]), [["a@example.com", 3], ["b@example.com", 6]]);
  });

  test("an unreadable file is a readable error", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
    assert.throws(() => parseImportRows(png.buffer), /Could not read that file/);
  });
});
