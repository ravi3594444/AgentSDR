import { createHash } from "node:crypto";
import { isValidEmail, normalizeEmail } from "@/lib/email/recipients";
import { cleanString } from "@/lib/grid/sanitize";
import type { IntakeFieldMap } from "./schema";

/**
 * A website-form submission, as the owner's form tool posts it to
 * /api/intake/form, reduced to the fields AgentSDR keeps
 * (docs/product/INSTAGRAM_INTAKE_DISCOVERY.md). Pure: no database, no
 * network. Server-side only because the de-duplication key hashes with
 * node:crypto; the settings page receives INTAKE_FIELDS as props.
 *
 * Three steps, each tested on its own (fields.test.ts):
 *
 * 1. parseSubmission: the body — JSON, form-urlencoded or multipart text
 *    fields — into flat string fields. Form tools wrap a form's own fields in
 *    a container (`{ data: {…} }`, `{ fields: [{ name, value }] }`, Webflow's
 *    `{ payload: { data: {…} } }`, Elementor's `fields[email][value]=`);
 *    those are read as the form's fields, ahead of the tool's own metadata
 *    beside them (a form's *name* is not the visitor's name).
 * 2. mapSubmission: the endpoint's field map (AgentSDR's key → the form's
 *    field name, case- and separator-insensitive), and for every key it does
 *    not map, the common names below.
 * 3. inquiryDedupeKey: what makes a retried delivery a no-op.
 *
 * Nothing is invented or repaired: an email that is not a valid address is
 * dropped with its reason, never "fixed"; a phone stays as written (the
 * caller normalizes it against the organization's default country); a page
 * URL is kept only when it is an http(s) address. Every key and value that
 * comes out is safe to store (cleanString: no NUL bytes, no half of a
 * surrogate pair), which Postgres would otherwise refuse.
 */

export type IntakeFieldKey = keyof IntakeFieldMap;

export type IntakeFieldInfo = {
  key: IntakeFieldKey;
  label: string;
  /** Field names recognized when the endpoint does not map this key, as people write them. */
  aliases: string[];
  /** Who the visitor is (only read from the form's own fields), rather than the submission's metadata. */
  personal: boolean;
  /**
   * Aliases too generic to trust in a tool's nested metadata: a bare `id`
   * there is as likely the form's id as the submission's (Elementor's
   * `form[id]`), and taking it would make every later submission a duplicate.
   */
  shallowAliases?: string[];
};

export const INTAKE_FIELDS: IntakeFieldInfo[] = [
  { key: "email", label: "Email", personal: true, aliases: ["email", "e-mail", "your-email", "email_address", "work_email", "mail"] },
  { key: "phone", label: "Phone", personal: true, aliases: ["phone", "phone_number", "tel", "telephone", "mobile", "mobile_number", "whatsapp", "your-phone", "your-tel"] },
  { key: "name", label: "Full name", personal: true, aliases: ["name", "full_name", "your-name", "contact_name"] },
  { key: "firstName", label: "First name", personal: true, aliases: ["first_name", "fname", "given_name", "your-first-name"] },
  { key: "lastName", label: "Last name", personal: true, aliases: ["last_name", "lname", "surname", "family_name", "your-last-name"] },
  { key: "company", label: "Company", personal: true, aliases: ["company", "company_name", "organization", "organisation", "business", "business_name", "your-company"] },
  { key: "message", label: "Message", personal: true, aliases: ["message", "your-message", "comments", "comment", "inquiry", "enquiry", "details", "question", "msg"] },
  { key: "pageUrl", label: "Page URL", personal: false, aliases: ["page_url", "url", "page", "source_url", "form_url", "referrer"] },
  { key: "submissionId", label: "Submission id", personal: false, aliases: ["submission_id", "entry_id", "response_id"], shallowAliases: ["id"] },
  { key: "submittedAt", label: "Submitted at", personal: false, aliases: ["submitted_at", "created_at", "date", "timestamp"] },
];

export const INTAKE_FIELD_KEYS = INTAKE_FIELDS.map((field) => field.key);

/** Content types the webhook reads. Anything else is a 415. */
export const SUPPORTED_CONTENT_TYPES = ["application/json", "application/x-www-form-urlencoded", "multipart/form-data"] as const;

/** Caps, so one submission cannot bloat a row: the body itself is capped at 64 KB by the route. */
export const LIMITS = {
  fields: 100,
  key: 200,
  value: 2_000,
  message: 10_000,
  name: 200,
  company: 200,
  email: 320,
  phone: 64,
  pageUrl: 2_048,
  submissionId: 500,
  fieldMapValue: 200,
} as const;

/**
 * Where a field sat in the body. `form`: inside a container of the form's
 * own fields; `top`: a top-level field; `meta`: anything else nested (the
 * tool's metadata — form name, site id, timestamps).
 */
export type FieldTier = "form" | "top" | "meta";

export type FlatField = {
  /** The field's own name ("Email", "your-email"). */
  key: string;
  /** Where it was, for a field map that names a nested field ("payload.data.email"). */
  path: string;
  value: string;
  tier: FieldTier;
};

/** How names are compared: case- and separator-insensitive ("Your E-mail" = "your_email" = "youremail"). */
export function normalizeFieldName(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
}

/** Containers form tools put a form's own fields in. */
const FORM_CONTAINERS = new Set(["data", "fields", "formdata", "formfields", "formvalues", "values", "answers", "submission", "entry", "inputs"].map(normalizeFieldName));
/** In `[{ name, value }]` lists, the keys that name the field, in order of preference. */
const NAME_KEYS = ["name", "label", "title", "key", "field", "id"];
/** Keys never written into an object built from form pairs. */
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

type Plain = Record<string, unknown>;

function isPlain(value: unknown): value is Plain {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** A value as one string: text trimmed, numbers and booleans as written, a list of them joined. Null for anything else. */
function scalar(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : null;
  if (typeof value === "boolean") return String(value);
  if (Array.isArray(value) && value.length && value.every((item) => ["string", "number", "boolean"].includes(typeof item))) {
    return value.map(scalar).filter(Boolean).join(", ") || null;
  }
  return null;
}

/** `{ name: "email", value: "…" }` (or label/title/key/field/id) → ["email", value]. */
function namedValue(item: unknown): [string, unknown] | null {
  if (!isPlain(item) || !("value" in item)) return null;
  for (const key of NAME_KEYS) {
    const name = item[key];
    if (typeof name === "string" && name.trim()) return [name.trim(), item.value];
    if (typeof name === "number" && Number.isFinite(name)) return [String(name), item.value];
  }
  return null;
}

export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  let end = max - 1;
  // Never between the two halves of a surrogate pair (an emoji): a lone half is what jsonb refuses.
  const last = value.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${value.slice(0, end).trimEnd()}…`;
}

/** Control characters (NUL included): never part of an address or a URL, and never stripped into one. */
const CONTROL = /[\u0000-\u001f\u007f]/;

/** A value as it can be shown and stored: control characters and lone surrogates as "�". */
function visible(value: string): string {
  return cleanString(value.replace(/[\u0000-\u001f\u007f]/g, "\ufffd"));
}

/**
 * A parsed JSON body (or form pairs built into an object) as flat fields.
 * Top-level values, one level of nesting, and a second level only inside a
 * form container (Webflow's payload.data, Tally's data.fields). Deeper
 * values are ignored.
 */
export function fieldsFromJson(body: unknown): FlatField[] {
  const out: FlatField[] = [];
  const push = (key: string, path: string, raw: unknown, tier: FieldTier) => {
    const value = scalar(raw);
    if (value === null || out.length >= LIMITS.fields) return;
    out.push({ key: truncate(key, LIMITS.key), path: truncate(path, LIMITS.key), value, tier });
  };
  const pairs = (list: unknown[], path: string) => {
    list.forEach((item, index) => {
      const pair = namedValue(item);
      if (pair) push(pair[0], `${path}[${index}]`, pair[1], "form");
    });
  };
  const walk = (object: Plain, prefix: string, depth: number, inForm: boolean) => {
    for (const [key, value] of Object.entries(object)) {
      const path = prefix ? `${prefix}.${key}` : key;
      const tier: FieldTier = inForm ? "form" : depth === 0 ? "top" : "meta";
      if (scalar(value) !== null) {
        push(key, path, value, tier);
      } else if (Array.isArray(value)) {
        // [{ name, value }]: how Tally, many WordPress plugins and custom code list a form's fields.
        pairs(value, path);
      } else if (isPlain(value)) {
        // { email: { value, title } }: one field described by an object (Elementor's advanced data).
        if ("value" in value && scalar(value.value) !== null) {
          push(key, path, value.value, tier);
          continue;
        }
        const container = FORM_CONTAINERS.has(normalizeFieldName(key));
        if (depth === 0 || (container && depth === 1)) walk(value, path, depth + 1, inForm || container);
      }
    }
  };
  if (Array.isArray(body)) pairs(body, "");
  else if (isPlain(body)) walk(body, "", 0, false);
  return out;
}

/**
 * Form pairs (form-urlencoded, multipart text fields) as flat fields. A
 * repeated name (checkboxes) joins its values; PHP-style names
 * (`fields[email][value]`, `data[email]`) nest one or two levels, read like
 * the same JSON.
 */
export function fieldsFromPairs(entries: Iterable<[string, string]>): FlatField[] {
  const root: Plain = Object.create(null);
  const assign = (target: Plain, key: string, value: string) => {
    const existing = target[key];
    if (existing === undefined) target[key] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else if (typeof existing === "string") target[key] = [existing, value];
  };
  for (const [rawKey, value] of entries) {
    const match = /^([^[\]]+)((?:\[[^[\]]*\]){1,2})$/.exec(rawKey);
    const parts = match
      ? [match[1]!, ...Array.from(match[2]!.matchAll(/\[([^[\]]*)\]/g), (m) => m[1]!)].filter((part, index) => index === 0 || part !== "")
      : [rawKey];
    if (parts.some((part) => UNSAFE_KEYS.has(part))) continue;
    let target = root;
    let nested = true;
    for (const part of parts.slice(0, -1)) {
      const next = target[part];
      if (next === undefined) target[part] = Object.create(null);
      else if (!isPlain(next)) {
        nested = false;
        break;
      }
      target = target[part] as Plain;
    }
    // A name used both plain and with brackets keeps the bracketed one under its full name.
    if (nested) assign(target, parts[parts.length - 1]!, value);
    else assign(root, rawKey, value);
  }
  return fieldsFromJson(root);
}

export type ParsedSubmission =
  | { ok: true; fields: FlatField[] }
  | { ok: false; status: 400 | 415; error: string };

/** The media type of a Content-Type header, lowercased, without parameters. */
export function mediaType(contentType: string | null | undefined): string {
  return (contentType ?? "").split(";")[0]!.trim().toLowerCase();
}

export function isSupportedContentType(contentType: string | null | undefined): boolean {
  const type = mediaType(contentType);
  return (SUPPORTED_CONTENT_TYPES as readonly string[]).includes(type) || /^application\/[\w.+-]+\+json$/.test(type);
}

/** A submission body as flat fields, or why it cannot be read (415: the type; 400: the content). */
export async function parseSubmission(body: Uint8Array | string, contentType: string | null): Promise<ParsedSubmission> {
  const type = mediaType(contentType);
  if (!isSupportedContentType(type)) {
    return { ok: false, status: 415, error: `Send the submission as ${SUPPORTED_CONTENT_TYPES.join(", ")}.` };
  }
  const text = typeof body === "string" ? body : new TextDecoder().decode(body);
  let fields: FlatField[];
  if (type === "application/x-www-form-urlencoded") {
    fields = fieldsFromPairs(new URLSearchParams(text));
  } else if (type === "multipart/form-data") {
    let form: FormData;
    try {
      form = await new Response(typeof body === "string" ? body : new Blob([body as Uint8Array<ArrayBuffer>]), {
        headers: { "content-type": contentType ?? type },
      }).formData();
    } catch {
      return { ok: false, status: 400, error: "The multipart body could not be read." };
    }
    // Text fields only: an uploaded file is not something an inquiry keeps.
    const entries: [string, string][] = [];
    form.forEach((value, key) => {
      if (typeof value === "string") entries.push([key, value]);
    });
    fields = fieldsFromPairs(entries);
  } else {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return { ok: false, status: 400, error: "The body is not valid JSON." };
    }
    fields = fieldsFromJson(parsed);
  }
  if (!fields.length) return { ok: false, status: 400, error: "The submission has no fields." };
  return { ok: true, fields };
}

/** Field map values as saved: known keys only, trimmed, capped; empty ones dropped (that key is auto-detected). */
export function cleanFieldMap(input: unknown): IntakeFieldMap {
  const out: IntakeFieldMap = {};
  if (!isPlain(input)) return out;
  for (const key of INTAKE_FIELD_KEYS) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) out[key] = cleanString(truncate(value.trim(), LIMITS.fieldMapValue));
  }
  return out;
}

export type DroppedValue = { field: "email" | "phone" | "pageUrl"; value: string; reason: string };

export type MappedSubmission = {
  /** A valid address, normalized (trimmed, lowercased); null when there was none or it was not valid. */
  email: string | null;
  /** The email field's value when it was not a valid address, and why it was dropped. */
  emailRejected: DroppedValue | null;
  /** As written; the caller normalizes it against the organization's default country. */
  phone: string | null;
  /** The full name, or first and last name joined. */
  name: string | null;
  firstName: string | null;
  lastName: string | null;
  company: string | null;
  /** What they wrote, word for word (capped at LIMITS.message). */
  message: string | null;
  /** An http(s) address, as written; null when there was none or it was something else. */
  pageUrl: string | null;
  /** The page URL field's value when it was not an http(s) address, and why it was dropped. */
  pageUrlRejected: DroppedValue | null;
  submissionId: string | null;
  submittedAt: Date | null;
  /** The submitted-at value as sent (part of the de-duplication key even when it is not a date we read). */
  submittedAtText: string | null;
  /** Fields not used for any of the above, as sent. */
  extras: Record<string, string>;
  /** Every field as sent (a clashing name is kept under its path). */
  fields: Record<string, string>;
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?(?:Z|[+-]\d{2}:?\d{2})?$/i;
const MONTH_NAME = /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i;

/**
 * When the form says it was submitted: ISO 8601, Unix seconds or
 * milliseconds, or a date written with its month's name. Numeric day/month
 * dates ("05/10/2026") are ambiguous and not read; neither is a date in the
 * future or before 2000.
 */
export function parseSubmittedAt(value: string | null | undefined, now: Date = new Date()): Date | null {
  const text = value?.trim();
  if (!text) return null;
  let date: Date | null = null;
  if (/^\d{10}(?:\.\d+)?$/.test(text)) date = new Date(Number(text) * 1000);
  else if (/^\d{13}$/.test(text)) date = new Date(Number(text));
  else if (ISO_DATE.test(text)) date = new Date(text.replace(" ", "T"));
  else if (MONTH_NAME.test(text)) date = new Date(text);
  if (!date || Number.isNaN(date.getTime())) return null;
  if (date.getUTCFullYear() < 2000 || date.getTime() > now.getTime() + 24 * 60 * 60 * 1000) return null;
  return date;
}

/**
 * Picks each AgentSDR field from the submission: a key the endpoint maps
 * reads exactly that field (by name, or by path for a nested one) and
 * nothing else; an unmapped key takes the first common name present, from
 * the form's own fields first. Who the visitor is (email, name, message…)
 * is never read from the tool's nested metadata.
 */
export function mapSubmission(fields: FlatField[], fieldMap: IntakeFieldMap = {}, now: Date = new Date()): MappedSubmission {
  const used = new Set<FlatField>();
  const picked = new Map<IntakeFieldKey, FlatField>();

  for (const info of INTAKE_FIELDS) {
    const wanted = fieldMap[info.key]?.trim();
    if (!wanted) continue;
    const name = normalizeFieldName(wanted);
    const match = fields.find((field) => !used.has(field) && normalizeFieldName(field.key) === name)
      ?? fields.find((field) => !used.has(field) && normalizeFieldName(field.path) === name);
    if (match) {
      picked.set(info.key, match);
      used.add(match);
    }
  }
  const tiers: FieldTier[] = ["form", "top", "meta"];
  for (const info of INTAKE_FIELDS) {
    if (fieldMap[info.key]?.trim()) continue;
    const shallow = info.shallowAliases ?? [];
    search: for (const tier of info.personal ? tiers.slice(0, 2) : tiers) {
      const aliases = [...info.aliases, ...(tier === "meta" ? [] : shallow)].map(normalizeFieldName);
      for (const alias of aliases) {
        const match = fields.find((field) => !used.has(field) && field.tier === tier && normalizeFieldName(field.key) === alias);
        if (match) {
          picked.set(info.key, match);
          used.add(match);
          break search;
        }
      }
    }
  }

  const value = (key: IntakeFieldKey, max: number) => {
    const field = picked.get(key);
    return field ? cleanString(truncate(field.value, max)) : null;
  };

  // The email is checked as sent: a NUL or a stray half-emoji makes it
  // invalid, rather than being stripped into an address nobody typed.
  const rawEmail = picked.get("email")?.value ?? null;
  const normalized = rawEmail ? normalizeEmail(rawEmail) : null;
  const emailOk = Boolean(
    normalized
    && normalized.length <= LIMITS.email
    && !CONTROL.test(normalized)
    && cleanString(normalized) === normalized
    && isValidEmail(normalized),
  );
  const pageUrl = pageUrlOf(picked.get("pageUrl")?.value ?? null);
  const firstName = value("firstName", LIMITS.name);
  const lastName = value("lastName", LIMITS.name);
  const submittedAtText = value("submittedAt", LIMITS.key);

  const all: Record<string, string> = {};
  const extras: Record<string, string> = {};
  for (const field of fields) {
    const key = cleanString(field.key in all ? field.path : field.key);
    const kept = cleanString(truncate(field.value, LIMITS.value));
    all[key] = kept;
    if (!used.has(field)) extras[key] = kept;
  }

  return {
    email: emailOk ? normalized : null,
    emailRejected: rawEmail && !emailOk
      ? {
          field: "email",
          value: visible(truncate(rawEmail, LIMITS.email)),
          reason: CONTROL.test(rawEmail) || cleanString(rawEmail) !== rawEmail
            ? `“${visible(truncate(rawEmail, 80))}” has characters an email address cannot have`
            : `“${truncate(rawEmail, 80)}” is not a valid email address`,
        }
      : null,
    phone: value("phone", LIMITS.phone),
    name: value("name", LIMITS.name) ?? ([firstName, lastName].filter(Boolean).join(" ") || null),
    firstName,
    lastName,
    company: value("company", LIMITS.company),
    message: value("message", LIMITS.message),
    pageUrl: pageUrl.url,
    pageUrlRejected: pageUrl.rejected,
    submissionId: value("submissionId", LIMITS.submissionId),
    submittedAt: parseSubmittedAt(submittedAtText, now),
    submittedAtText,
    extras,
    fields: all,
  };
}

/** The page the form was on, only when it is an http(s) address; anything else (javascript:, a bare path) is dropped with why. */
function pageUrlOf(raw: string | null): { url: string | null; rejected: DroppedValue | null } {
  const value = raw?.trim();
  if (!value) return { url: null, rejected: null };
  const reject = (reason: string) => ({ url: null, rejected: { field: "pageUrl" as const, value: visible(truncate(value, LIMITS.pageUrl)), reason } });
  let parsed: URL | null = null;
  try {
    parsed = new URL(value);
  } catch {
    parsed = null;
  }
  if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:") || CONTROL.test(value)) {
    return reject(`“${visible(truncate(value, 80))}” is not a web address (http or https)`);
  }
  if (value.length > LIMITS.pageUrl) return reject(`the page address is longer than ${LIMITS.pageUrl} characters`);
  return { url: cleanString(value), rejected: null };
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * The key that makes a retried delivery a no-op (unique per organization
 * and source, so it is namespaced by endpoint), built on a SHA-256 of the
 * normalized content — email, phone digits, message with its whitespace
 * collapsed, and submitted-at as sent:
 *
 * - with the form's own submission id: `<endpoint>:id:<id>:<content hash>`.
 *   The id alone would let a different submission that reuses it (a form
 *   tool's bug, or anyone holding the token) pass as a retry and be thrown
 *   away; with the content only an exact retry matches.
 * - without one: `<endpoint>:sha256:<content hash>`. A submission with none
 *   of those four hashes every field instead, so unrelated nameless
 *   submissions do not collapse into one.
 *
 * Identical retries always agree.
 */
export function inquiryDedupeKey(
  endpointId: string,
  mapped: Pick<MappedSubmission, "email" | "emailRejected" | "phone" | "message" | "submissionId" | "submittedAtText" | "fields">,
): string {
  const content = [
    (mapped.email ?? mapped.emailRejected?.value ?? "").trim().toLowerCase(),
    (mapped.phone ?? "").replace(/\D/g, ""),
    (mapped.message ?? "").replace(/\s+/g, " ").trim(),
    (mapped.submittedAtText ?? "").trim(),
  ];
  const id = cleanString(mapped.submissionId?.trim() ?? "");
  if (id) return `${endpointId}:id:${id.length <= 200 ? id : sha256(id)}:${sha256(JSON.stringify(content))}`;
  const basis = content.some(Boolean)
    ? content
    : Object.entries(mapped.fields).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `${endpointId}:sha256:${sha256(JSON.stringify(basis))}`;
}
