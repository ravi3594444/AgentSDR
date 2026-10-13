import { describe, expect, test } from "bun:test";
import type { ImportRow } from "./importRows";
import { customFieldKey, parseImportRows } from "./importRows";
import { planPeopleImport } from "./peopleImport";

const row = (rowNumber: number, fields: Partial<ImportRow>): ImportRow => ({ rowNumber, ...fields });
const csv = (text: string) => {
  const bytes = new TextEncoder().encode(text);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
};

describe("planPeopleImport", () => {
  test("a row with an Email or LinkedIn URL is a person by that identity", () => {
    const plan = planPeopleImport([row(2, { email: "a@x.com" }), row(3, { linkedinUrl: "https://linkedin.com/in/b" })], "IN");
    expect(plan.identified.map((r) => r.rowNumber)).toEqual([2, 3]);
    expect(plan.phoneOnly).toEqual([]);
    expect(plan.failed).toEqual([]);
  });

  test("a row with only a valid phone becomes a phone-only contact, normalized with the default country", () => {
    const plan = planPeopleImport([row(4, { fullName: "Asha", phone: "09876543210" })], "IN");
    expect(plan.phoneOnly).toEqual([{ row: row(4, { fullName: "Asha", phone: "09876543210" }), phone: "+919876543210" }]);
  });

  test("a phone-only row with an unusable number fails with the reason and its row number", () => {
    const plan = planPeopleImport([row(7, { phone: "4155552671" })], undefined);
    expect(plan.failed).toHaveLength(1);
    expect(plan.failed[0]!.row).toBe(7);
    expect(plan.failed[0]!.error).toContain("no Default phone country is set");
  });

  test("an invalid phone on an identified row is a warning, not a failure", () => {
    const plan = planPeopleImport([row(5, { email: "a@x.com", phone: "123" })], "IN");
    expect(plan.identified).toHaveLength(1);
    expect(plan.warnings).toEqual([{ row: 5, identity: "a@x.com", message: "Phone not saved: “123” is too short to be a phone number" }]);
  });

  test("a row with no identity and no phone is counted as skipped", () => {
    expect(planPeopleImport([row(2, { fullName: "Nobody" })], "IN").skippedNoIdentity).toBe(1);
  });

  test("end to end from a CSV: leading zeros survive and error rows match the file", () => {
    const rows = parseImportRows(csv("Name,Phone\nAsha,09876543210\n\nBad,12\n"));
    const plan = planPeopleImport(rows, "IN");
    expect(plan.phoneOnly.map((entry) => entry.phone)).toEqual(["+919876543210"]);
    expect(plan.failed.map((entry) => entry.row)).toEqual([4]);
  });
});

describe("custom columns on the People import", () => {
  test("unmapped columns become camelCased custom fields, accents folded and values kept as typed", () => {
    const rows = parseImportRows(csv("Email,Full Name,Favourite Café,Zip,2024 Revenue\na@x.test,José Müller,Açaí,00123,\n"));
    expect(rows[0]!.fullName).toBe("José Müller");
    expect(rows[0]!.customFields).toEqual({ favouriteCafe: "Açaí", zip: "00123" });
  });

  test("customFieldKey", () => {
    expect(customFieldKey("Job Level")).toBe("jobLevel");
    expect(customFieldKey("2024 Revenue")).toBe("field2024Revenue");
    expect(customFieldKey("!!!")).toBe("");
  });
});
