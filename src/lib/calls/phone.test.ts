import { describe, expect, test } from "bun:test";
import { checkPhone, normalizePhone, whatsappDigits } from "./phone";

describe("normalizePhone", () => {
  test("accepts a valid Indian number given with a country code", () => {
    expect(normalizePhone("+91 98765 43210")).toBe("+919876543210");
  });

  test("accepts a valid US number given with dashes", () => {
    expect(normalizePhone("+1-415-555-2671")).toBe("+14155552671");
  });

  test("accepts a valid UK number given with parentheses and spacing", () => {
    expect(normalizePhone("+44 20 7946 0958")).toBe("+442079460958");
  });

  test("accepts messy spacing and dashes around a country code", () => {
    expect(normalizePhone("+91 98765-43210")).toBe("+919876543210");
  });

  test("accepts a leading-00 international prefix when it matches the default country's IDD", () => {
    expect(normalizePhone("0091 98765 43210", "IN")).toBe("+919876543210");
  });

  test("parses a number given without '+' when a default country is set", () => {
    expect(normalizePhone("98765 43210", "IN")).toBe("+919876543210");
  });

  test("returns null for a number given without '+' and no default country", () => {
    expect(normalizePhone("98765 43210")).toBeNull();
  });

  test("returns null for garbage input", () => {
    expect(normalizePhone("not a phone number")).toBeNull();
  });

  test("returns null for an empty or blank string", () => {
    expect(normalizePhone("")).toBeNull();
    expect(normalizePhone("   ")).toBeNull();
  });

  test("returns null for a string that is too short to be valid", () => {
    expect(normalizePhone("+91 123")).toBeNull();
  });
});

describe("whatsappDigits", () => {
  test("strips the leading '+' and keeps only digits", () => {
    expect(whatsappDigits("+919876543210")).toBe("919876543210");
  });

  test("strips any stray non-digit characters", () => {
    expect(whatsappDigits("+1 (415) 555-2671")).toBe("14155552671");
  });
});

describe("checkPhone", () => {
  test("reads a bare local number with a leading zero against the organization's country", () => {
    expect(checkPhone("09876543210", "IN")).toEqual({ ok: true, e164: "+919876543210" });
    expect(checkPhone("(415) 555-2671", "US")).toEqual({ ok: true, e164: "+14155552671" });
  });

  test("accepts +, 00 and a country code that lost its plus", () => {
    expect(checkPhone("+44 20 7946 0958", "IN")).toEqual({ ok: true, e164: "+442079460958" });
    expect(checkPhone("0044 20 7946 0958", undefined)).toEqual({ ok: true, e164: "+442079460958" });
    expect(checkPhone("919876543210", "US")).toEqual({ ok: true, e164: "+919876543210" });
  });

  test("never guesses a country for a short bare number", () => {
    const result = checkPhone("4155552671", undefined);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("no Default phone country is set");
  });

  test("says why a number cannot be used", () => {
    const reason = (input: string, country?: string) => {
      const result = checkPhone(input, country);
      return result.ok ? null : result.reason;
    };
    expect(reason("")).toBe("no phone number");
    expect(reason("n/a")).toBe("“n/a” is not a phone number");
    expect(reason("12345")).toBe("“12345” is too short to be a phone number");
    expect(reason("1234567890123456")).toBe("“1234567890123456” is too long to be a phone number");
    expect(reason("+999 1234 5678")).toBe("“+999 1234 5678” is not a valid phone number");
    expect(reason("1234567", "IN")).toBe("“1234567” is not a valid IN number; check it, or write it with its country code (+…)");
  });
});
