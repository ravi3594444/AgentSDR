import { parsePhoneNumberFromString, type CountryCode } from "libphonenumber-js";
import { digitsOnly } from "./digits";

const COUNTRY_CODE_PATTERN = /^[A-Z]{2}$/;

function asCountryCode(value: string | undefined): CountryCode | undefined {
  return value && COUNTRY_CODE_PATTERN.test(value) ? (value as CountryCode) : undefined;
}

/**
 * Normalizes messy phone input ("+91 98765-43210", "0091 98765 43210",
 * "(415) 555-2671") into E.164 — the only shape people.phone and
 * call_sessions.phone ever store.
 *
 * Input given without a leading "+" only parses against `defaultCountry`:
 * libphonenumber-js has no other way to know which country's dialing rules
 * apply to a bare local number, so ambiguous input with no default
 * configured comes back null rather than a guess.
 *
 * The default is DEFAULT_PHONE_COUNTRY, read at runtime (this runs on the
 * server only). NEXT_PUBLIC_DEFAULT_PHONE_COUNTRY is the older name; a
 * NEXT_PUBLIC_ value is fixed at build time, and the Docker build sees no env.
 */
export function normalizePhone(
  input: string,
  defaultCountry: string | undefined = process.env.DEFAULT_PHONE_COUNTRY ?? process.env.NEXT_PUBLIC_DEFAULT_PHONE_COUNTRY,
): string | null {
  const trimmed = input?.trim();
  if (!trimmed) return null;
  try {
    const parsed = parsePhoneNumberFromString(trimmed, asCountryCode(defaultCountry));
    return parsed?.isValid() ? parsed.number : null;
  } catch {
    return null;
  }
}

/** Digits only, no "+" — what web.whatsapp.com/send?phone= expects. */
export function whatsappDigits(e164: string): string {
  return digitsOnly(e164);
}

export type PhoneCheck = { ok: true; e164: string } | { ok: false; reason: string };

/**
 * normalizePhone with a reason when it fails, for import reports: a person
 * fixing a spreadsheet needs to know whether a number is missing its country
 * code, wrong for the default country, or not a number at all.
 *
 * A bare number (no "+" or "00") is read against `defaultCountry`, the
 * organization's Default phone country. One long enough to already carry a
 * country code (11-15 digits, what a spreadsheet leaves after stripping the
 * "+") is tried as international too. A shorter bare number is never
 * guessed into a country: "4155552671" without a default could be read as
 * Swiss (+41) as easily as American, so it is refused with that explanation.
 */
export function checkPhone(input: string | null | undefined, defaultCountry: string | undefined): PhoneCheck {
  const raw = (input ?? "").trim();
  if (!raw) return { ok: false, reason: "no phone number" };
  const digits = digitsOnly(raw);
  if (!digits) return { ok: false, reason: `“${raw}” is not a phone number` };
  if (digits.length < 6) return { ok: false, reason: `“${raw}” is too short to be a phone number` };
  if (digits.length > 15) return { ok: false, reason: `“${raw}” is too long to be a phone number` };
  const country = asCountryCode(defaultCountry);
  const direct = normalizePhone(raw, country);
  if (direct) return { ok: true, e164: direct };

  const explicitInternational = raw.startsWith("+") || raw.startsWith("00");
  if (explicitInternational) {
    const viaPlus = raw.startsWith("00") ? normalizePhone(`+${digits.slice(2)}`, country) : null;
    if (viaPlus) return { ok: true, e164: viaPlus };
    return { ok: false, reason: `“${raw}” is not a valid phone number` };
  }
  if (digits.length >= 11) {
    const international = normalizePhone(`+${digits}`, country);
    if (international) return { ok: true, e164: international };
  }
  return country
    ? { ok: false, reason: `“${raw}” is not a valid ${country} number; check it, or write it with its country code (+…)` }
    : { ok: false, reason: `“${raw}” has no country code and no Default phone country is set (Settings → Your business); write it as +<country code>…` };
}
