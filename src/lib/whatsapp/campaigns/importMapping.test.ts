import { describe, expect, test } from "bun:test";
import * as XLSX from "xlsx";
import {
  headerToCustomKey,
  importMappingError,
  mapImportRow,
  normalizeCampaignPhone,
  parseImportSheet,
  suggestWhatsappMapping,
} from "./importMapping";

function csvBuffer(text: string): ArrayBuffer {
  const bytes = new TextEncoder().encode(text);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

describe("suggestWhatsappMapping", () => {
  test("finds the phone, name and company columns by common names", () => {
    const mapping = suggestWhatsappMapping(["Full Name", "Mobile Number", "Company", "Job Title", "Website", "Notes"]);
    expect(mapping).toEqual({
      phone: "Mobile Number",
      fullName: "Full Name",
      companyName: "Company",
      title: "Job Title",
      companyDomain: "Website",
    });
  });

  test("prefers the exact phone header over a generic one and never reuses a column", () => {
    const mapping = suggestWhatsappMapping(["Number", "Phone", "First Name", "Last Name"]);
    expect(mapping.phone).toBe("Phone");
    expect(mapping.firstName).toBe("First Name");
    expect(mapping.lastName).toBe("Last Name");
    expect(Object.values(mapping).filter((header) => header === "Phone")).toHaveLength(1);
  });

  test("suggests nothing for unrelated headers", () => {
    expect(suggestWhatsappMapping(["Region", "Score"])).toEqual({});
  });
});

describe("importMappingError", () => {
  const headers = ["Phone", "Name", "City"];
  test("accepts a mapping with a phone column", () => {
    expect(importMappingError({ phone: "Phone", fullName: "Name" }, headers)).toBeNull();
  });
  test("requires phone", () => {
    expect(importMappingError({ fullName: "Name" }, headers)).toMatch(/Phone number/);
    expect(importMappingError({ phone: "" }, headers)).toMatch(/Phone number/);
  });
  test("rejects unknown fields, unknown columns and a column used twice", () => {
    expect(importMappingError({ phone: "Phone", nope: "Name" }, headers)).toMatch(/Unknown field/);
    expect(importMappingError({ phone: "Mobile" }, headers)).toMatch(/not in this file/);
    expect(importMappingError({ phone: "Phone", fullName: "Phone" }, headers)).toMatch(/only one field/);
    expect(importMappingError([], headers)).toMatch(/JSON object/);
  });
});

describe("headerToCustomKey", () => {
  test("camelCases headers", () => {
    expect(headerToCustomKey("Job Title")).toBe("jobTitle");
    expect(headerToCustomKey("  e-mail_2 ")).toBe("eMail2");
    expect(headerToCustomKey("CITY")).toBe("cITY");
    expect(headerToCustomKey("---")).toBe("");
  });
});

describe("mapImportRow", () => {
  const headers = ["Phone", "Name", "City", "Favourite Colour", "Empty"];
  test("maps claimed columns to person fields and the rest to custom fields", () => {
    const { person, customFields } = mapImportRow(["+1 415 555 2671", "Ada Lovelace", "London", "Blue", ""], headers, {
      phone: "Phone",
      fullName: "Name",
    });
    expect(person.phone).toBe("+1 415 555 2671");
    expect(person.fullName).toBe("Ada Lovelace");
    expect(person.email).toBeNull();
    expect(customFields).toEqual({ city: "London", favouriteColour: "Blue" });
  });
  test("a duplicate camelCased key keeps the first column", () => {
    const { customFields } = mapImportRow(["1", "a", "b"], ["Phone", "Plan Tier", "plan-tier"], { phone: "Phone" });
    expect(customFields).toEqual({ planTier: "a" });
  });
});

describe("normalizeCampaignPhone", () => {
  test("uses the organization's country for local numbers", () => {
    expect(normalizeCampaignPhone("(415) 555-2671", "US")).toBe("+14155552671");
    expect(normalizeCampaignPhone("98765 43210", "IN")).toBe("+919876543210");
    expect(normalizeCampaignPhone("(415) 555-2671", undefined)).toBeNull();
  });
  test("accepts international numbers and digits that lost their plus", () => {
    expect(normalizeCampaignPhone("+44 20 7946 0958", undefined)).toBe("+442079460958");
    expect(normalizeCampaignPhone("442079460958", undefined)).toBe("+442079460958");
  });
  test("rejects junk", () => {
    expect(normalizeCampaignPhone("call me", "US")).toBeNull();
    expect(normalizeCampaignPhone("", "US")).toBeNull();
  });
});

describe("parseImportSheet", () => {
  test("keeps file row numbers across blank rows", () => {
    const sheet = parseImportSheet(csvBuffer("Phone,Name\n+14155552671,Ada\n,\n+442079460958,Grace\n"));
    expect(sheet.headers).toEqual(["Phone", "Name"]);
    expect(sheet.rows).toEqual([["+14155552671", "Ada"], ["+442079460958", "Grace"]]);
    expect(sheet.rowNumbers).toEqual([2, 4]);
  });
  test("reads xlsx and pads short rows", () => {
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["Phone", "Name"], ["+14155552671"]]), "Sheet1");
    const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }) as Buffer;
    const sheet = parseImportSheet(buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer);
    expect(sheet.rows).toEqual([["+14155552671", ""]]);
  });
  test("an empty file is an error", () => {
    expect(() => parseImportSheet(csvBuffer(""))).toThrow();
  });
  test("keeps non-ASCII names from a UTF-8 CSV", () => {
    const sheet = parseImportSheet(csvBuffer("Phone,Name\n+919876543210,राम शर्मा\n+5511987654321,João\n"));
    expect(sheet.rows).toEqual([["+919876543210", "राम शर्मा"], ["+5511987654321", "João"]]);
  });
});
