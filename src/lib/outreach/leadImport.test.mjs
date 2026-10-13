import { describe, expect, test } from "bun:test";
import * as XLSX from "xlsx";
import {
  parseRows,
  parseRowsWithMapping,
  planEmailCampaignImport,
  spreadsheetPreview,
  suggestedEmailMapping,
} from "./leadImport.ts";

function workbookBuffer(rows) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), "Leads");
  return XLSX.write(workbook, { type: "array", bookType: "xlsx" });
}

function csvBuffer(text) {
  const bytes = new TextEncoder().encode(text);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

describe("Email campaign lead mapping", () => {
  test("maps canonical identity fields and preserves unknown merge fields", () => {
    const result = parseRows(workbookBuffer([{
      Email: "Person@Example.com",
      "LinkedIn URL": "https://linkedin.com/in/person",
      "First Name": "Pat",
      "Last Name": "Lee",
      Company: "Acme",
      "Company Domain": "acme.com",
      "Job Title": "VP Sales",
      Region: "APAC",
    }]));
    expect(result.error).toBeNull();
    expect(result.rows[0]).toMatchObject({
      email: "person@example.com",
      linkedinUrl: "https://linkedin.com/in/person",
      firstName: "Pat",
      lastName: "Lee",
      company: "Acme",
      domain: "acme.com",
      title: "VP Sales",
      customFields: { region: "APAC" },
    });
  });

  test("maps capitalization and underscore variants to canonical columns", () => {
    const result = parseRows(workbookBuffer([{
      EMAIL: "person@example.com",
      First_Name: "Pat",
      LAST_NAME: "Lee",
      JOB_TITLE: "VP Sales",
      COMPANY_DOMAIN: "acme.com",
      Favorite_Color: "Blue",
    }]));
    expect(result.rows[0]).toMatchObject({
      firstName: "Pat",
      lastName: "Lee",
      title: "VP Sales",
      domain: "acme.com",
      customFields: { favorite_color: "Blue" },
    });
  });

  test("keeps populated rows with missing email so the importer can report them", () => {
    const result = parseRows(workbookBuffer([{ Email: "", "First Name": "Pat" }]));
    expect(result.error).toBeNull();
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].email).toBe("");
  });

  test("turns punctuation-heavy headers into usable template tokens", () => {
    const result = parseRows(workbookBuffer([{ Email: "person@example.com", "Intent score (%)": "91" }]));
    expect(result.rows[0].customFields).toEqual({ intentScore: "91" });
  });

  test("previews and imports user-selected columns instead of guessing", () => {
    const buffer = workbookBuffer([{ "Primary inbox": "person@example.com", Given: "Pat", Segment: "Enterprise" }]);
    const preview = spreadsheetPreview(buffer);
    expect(preview.headers).toEqual(["Primary inbox", "Given", "Segment"]);
    expect(suggestedEmailMapping(preview.headers).email).toBeUndefined();
    const result = parseRowsWithMapping(buffer, { email: "Primary inbox", firstName: "Given" });
    expect(result.rows[0]).toMatchObject({ email: "person@example.com", firstName: "Pat", customFields: { segment: "Enterprise" } });
  });

  test("suggests common export column aliases", () => {
    expect(suggestedEmailMapping([
      "Work Email",
      "LinkedIn Profile",
      "Given Name",
      "Family Name",
      "Organisation",
      "Website",
      "Company LinkedIn",
      "Role",
    ])).toEqual({
      email: "Work Email",
      linkedinUrl: "LinkedIn Profile",
      firstName: "Given Name",
      lastName: "Family Name",
      companyName: "Organisation",
      companyDomain: "Website",
      companyLinkedinUrl: "Company LinkedIn",
      title: "Role",
    });
  });

  test("a UTF-8 CSV keeps accented merge fields and failures point at their row in the file", () => {
    const csv = "Email,First Name,City\nana@example.com,Ana,São Paulo\n\nnot-an-email,Bo,Malmö\n";
    const result = parseRowsWithMapping(csvBuffer(csv), { email: "Email", firstName: "First Name" });
    expect(result.error).toBeNull();
    expect(result.rows[0]).toMatchObject({ email: "ana@example.com", firstName: "Ana", customFields: { city: "São Paulo" }, rowNumber: 2 });
    expect(result.rows[1].customFields).toEqual({ city: "Malmö" });
    const plan = planEmailCampaignImport(result.rows, new Set(), new Set());
    expect(plan.failed).toEqual([{ row: 4, email: "not-an-email", error: "invalid email" }]);
  });

  test("an unreadable upload is a readable error", () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).buffer;
    expect(() => spreadsheetPreview(png)).toThrow("Could not read that file");
    expect(() => parseRowsWithMapping(png, { email: "Email" })).toThrow("Could not read that file");
  });

  test("rejects assigning one source column to two canonical fields", () => {
    const buffer = workbookBuffer([{ Identity: "person@example.com" }]);
    expect(parseRowsWithMapping(buffer, { email: "Identity", firstName: "Identity" }).error).toContain("only one");
  });
});

describe("Email campaign identity reuse", () => {
  const row = (email, customFields = {}) => ({
    email,
    linkedinUrl: null,
    firstName: null,
    lastName: null,
    company: null,
    domain: null,
    title: null,
    customFields,
  });

  test("refreshes an existing campaign Person without enrolling a second lead", () => {
    const result = planEmailCampaignImport(
      [row("person@example.com", { newSignal: "yes" })],
      new Set(),
      new Set(["person@example.com"]),
    );
    expect(result.workItems).toEqual([{ row: row("person@example.com", { newSignal: "yes" }), enroll: false }]);
    expect(result.imported).toBe(0);
    expect(result.skippedDuplicate).toBe(1);
  });

  test("updates all valid duplicate rows but enrolls their email only once", () => {
    const result = planEmailCampaignImport(
      [row("person@example.com", { firstSignal: "yes" }), row("person@example.com", { secondSignal: "yes" })],
      new Set(),
      new Set(),
    );
    expect(result.workItems.map((item) => item.enroll)).toEqual([true, false]);
    expect(result.imported).toBe(1);
    expect(result.skippedDuplicate).toBe(1);
  });

  test("does not update People for suppressed or invalid rows", () => {
    const result = planEmailCampaignImport(
      [row("blocked@example.com"), row("not-an-email")],
      new Set(["blocked@example.com"]),
      new Set(),
    );
    expect(result.workItems).toHaveLength(0);
    expect(result.skippedSuppressed).toBe(1);
    expect(result.failed).toHaveLength(1);
  });
});

describe("text cells (leading zeros, duplicate headers, row numbers)", () => {
  const csv = (text) => {
    const bytes = new TextEncoder().encode(text);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  };

  test("custom columns keep leading zeros and rows carry their file row number", () => {
    const { rows, error } = parseRows(csv("Email,Phone,Zip\na@x.com,09876543210,00123\n\nb@x.com,,\n"));
    expect(error).toBeNull();
    expect(rows.map((row) => [row.email, row.customFields, row.rowNumber])).toEqual([
      ["a@x.com", { phone: "09876543210", zip: "00123" }, 2],
      ["b@x.com", {}, 4],
    ]);
  });

  test("a repeated column can be previewed and mapped by its suffixed name", () => {
    const buffer = csv("Email,Email,Name\nold@x.com,new@x.com,Ada Lovelace\n");
    const preview = spreadsheetPreview(buffer);
    expect(preview.headers).toEqual(["Email", "Email_1", "Name"]);
    const { rows, error } = parseRowsWithMapping(buffer, { email: "Email_1", fullName: "Name" });
    expect(error).toBeNull();
    expect(rows[0]).toMatchObject({ email: "new@x.com", firstName: "Ada", lastName: "Lovelace", rowNumber: 2 });
    expect(rows[0].customFields).toEqual({ email: "old@x.com" });
  });
});

test("an accented header keeps its letters in the merge-field key", () => {
  const bytes = new TextEncoder().encode("Email,Favourite Café\na@x.test,Açaí\n");
  const { rows } = parseRows(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  expect(rows[0].customFields).toEqual({ favouriteCafe: "Açaí" });
});
