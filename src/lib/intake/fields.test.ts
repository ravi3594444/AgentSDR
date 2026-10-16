import { describe, expect, test } from "bun:test";
import {
  cleanFieldMap,
  fieldsFromJson,
  fieldsFromPairs,
  inquiryDedupeKey,
  LIMITS,
  mapSubmission,
  normalizeFieldName,
  parseSubmission,
  parseSubmittedAt,
  type FlatField,
} from "./fields";

const NOW = new Date("2026-10-16T12:00:00Z");
const ENDPOINT = "11111111-1111-4111-8111-111111111111";

async function parsed(body: string, contentType: string | null): Promise<FlatField[]> {
  const result = await parseSubmission(body, contentType);
  if (!result.ok) throw new Error(`${result.status}: ${result.error}`);
  return result.fields;
}

async function mapped(body: unknown, fieldMap = {}) {
  return mapSubmission(await parsed(JSON.stringify(body), "application/json"), fieldMap, NOW);
}

describe("parseSubmission", () => {
  test("reads a flat JSON object, numbers and booleans as written", async () => {
    const fields = await parsed(JSON.stringify({ email: "a@b.co", phone: 14155552671, consent: true, empty: "", none: null }), "application/json; charset=utf-8");
    expect(fields).toEqual([
      { key: "email", path: "email", value: "a@b.co", tier: "top" },
      { key: "phone", path: "phone", value: "14155552671", tier: "top" },
      { key: "consent", path: "consent", value: "true", tier: "top" },
    ]);
  });

  test("reads the form's fields inside { data: {…} } ahead of the tool's own metadata", async () => {
    const result = await mapped({ name: "Contact form", site: "abc", data: { name: "Jane Doe", email: "jane@acme.io" } });
    expect(result.name).toBe("Jane Doe");
    expect(result.email).toBe("jane@acme.io");
    expect(result.extras).toEqual({ name: "Contact form", site: "abc" });
  });

  test("reads { fields: [{ name, value }] } lists", async () => {
    const fields = await parsed(JSON.stringify({ form: "Contact", fields: [{ name: "Email", value: "x@y.io" }, { name: "Interests", value: ["a", "b"] }, { value: "no name" }] }), "application/json");
    expect(fields).toContainEqual({ key: "Email", path: "fields[0]", value: "x@y.io", tier: "form" });
    expect(fields).toContainEqual({ key: "Interests", path: "fields[1]", value: "a, b", tier: "form" });
    expect(fields.some((field) => field.value === "no name")).toBe(false);
  });

  test("reads Webflow's payload.data, but never takes the form's name or a nested id for the visitor or the submission", async () => {
    const result = await mapped({
      triggerType: "form_submission",
      payload: {
        name: "Email Form",
        siteId: "62749158efef318abc8d5a0f",
        data: { "First Name": "Zaphod", "Last Name": "Beeblebrox", email: "zaphod@heartofgold.ai", "Phone Number": 15550000000 },
        submittedAt: "2026-10-15T12:35:16.117Z",
        id: "6321ca84df3949bfc6752327",
        formId: "65429eadebe8a9f3a30f62d0",
        pageUrl: "https://example.org/contact",
      },
    });
    expect(result.name).toBe("Zaphod Beeblebrox");
    expect(result.firstName).toBe("Zaphod");
    expect(result.lastName).toBe("Beeblebrox");
    expect(result.email).toBe("zaphod@heartofgold.ai");
    expect(result.phone).toBe("15550000000");
    expect(result.pageUrl).toBe("https://example.org/contact");
    expect(result.submittedAt?.toISOString()).toBe("2026-10-15T12:35:16.117Z");
    expect(result.submissionId).toBeNull();
  });

  test("reads Tally's data.fields by label and its submission id", async () => {
    const result = await mapped({
      eventId: "a4cb511e",
      eventType: "FORM_RESPONSE",
      createdAt: "2026-10-15T10:00:00Z",
      data: {
        responseId: "2wgx4n",
        submissionId: "2wgx4n-sub",
        formName: "Website enquiry",
        fields: [
          { key: "question_3E1Bxk", label: "Your name", type: "INPUT_TEXT", value: "Ada" },
          { key: "question_w4Q1", label: "E-mail", type: "INPUT_EMAIL", value: "ADA@Example.ORG " },
          { key: "question_99", label: "How can we help?", type: "TEXTAREA", value: "Need 40 chairs" },
          { key: "question_100", label: "Enquiry", type: "TEXTAREA", value: "Delivery to Pune" },
          { key: "question_101", label: "Skipped", type: "INPUT_TEXT", value: null },
        ],
      },
    });
    expect(result.name).toBe("Ada");
    expect(result.email).toBe("ada@example.org");
    expect(result.message).toBe("Delivery to Pune");
    expect(result.submissionId).toBe("2wgx4n-sub");
    expect(result.extras["How can we help?"]).toBe("Need 40 chairs");
  });

  test("reads form-urlencoded fields, joining repeated names", async () => {
    const fields = await parsed("your-name=Ravi+K&your-email=ravi%40shop.in&topic=a&topic=b", "application/x-www-form-urlencoded");
    expect(fields).toEqual([
      { key: "your-name", path: "your-name", value: "Ravi K", tier: "top" },
      { key: "your-email", path: "your-email", value: "ravi@shop.in", tier: "top" },
      { key: "topic", path: "topic", value: "a, b", tier: "top" },
    ]);
  });

  test("reads PHP-style names (Elementor's advanced data) without taking the form's own id as the submission id", async () => {
    const body = new URLSearchParams([
      ["form[id]", "8c1f2b9"],
      ["form[name]", "New Form"],
      ["fields[name][title]", "Name"],
      ["fields[name][value]", "Meera"],
      ["fields[email][value]", "meera@clinic.in"],
      ["fields[message][value]", "Do you open on Sundays?"],
      ["meta[page_url][value]", "https://clinic.in/contact"],
      ["meta[date][value]", "October 15, 2026"],
      ["tags[]", "x"],
      ["tags[]", "y"],
      ["__proto__[polluted]", "yes"],
    ]).toString();
    const result = mapSubmission(await parsed(body, "application/x-www-form-urlencoded"), {}, NOW);
    expect(result.name).toBe("Meera");
    expect(result.email).toBe("meera@clinic.in");
    expect(result.message).toBe("Do you open on Sundays?");
    expect(result.pageUrl).toBe("https://clinic.in/contact");
    expect(result.submittedAt?.getUTCDate()).toBe(15);
    expect(result.submissionId).toBeNull();
    expect(result.fields.tags).toBe("x, y");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.values(result.fields)).not.toContain("yes");
  });

  test("reads the text fields of a multipart body and ignores files", async () => {
    const form = new FormData();
    form.append("email", "lee@studio.co");
    form.append("message", "Quote for a logo?");
    form.append("attachment", new Blob(["%PDF-1.4"], { type: "application/pdf" }), "brief.pdf");
    const request = new Request("http://localhost/", { method: "POST", body: form });
    // Read before the body: Bun sets the boundary header lazily.
    const contentType = request.headers.get("content-type");
    const bytes = new Uint8Array(await request.arrayBuffer());
    const result = await parseSubmission(bytes, contentType);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.fields.map((field) => [field.key, field.value])).toEqual([["email", "lee@studio.co"], ["message", "Quote for a logo?"]]);
  });

  test("accepts +json media types", async () => {
    expect((await parseSubmission('{"email":"a@b.co"}', "application/vnd.api+json")).ok).toBe(true);
  });

  test("refuses unsupported content types with 415", async () => {
    for (const type of [null, "", "text/plain", "application/xml", "text/html; charset=utf-8"]) {
      const result = await parseSubmission('{"email":"a@b.co"}', type);
      expect(result).toMatchObject({ ok: false, status: 415 });
    }
  });

  test("refuses bodies with no fields with 400", async () => {
    for (const [body, type] of [
      ["not json", "application/json"],
      ["{}", "application/json"],
      ["[]", "application/json"],
      ['"just a string"', "application/json"],
      ['{"a":null,"b":"   ","c":{"d":{"e":{"f":"too deep"}}}}', "application/json"],
      ["", "application/x-www-form-urlencoded"],
      ["--x--", "multipart/form-data; boundary=x"],
    ] as const) {
      const result = await parseSubmission(body, type);
      expect(result).toMatchObject({ ok: false, status: 400 });
    }
  });

  test("caps the number of fields", () => {
    const body = Object.fromEntries(Array.from({ length: 500 }, (_, index) => [`f${index}`, "v"]));
    expect(fieldsFromJson(body)).toHaveLength(LIMITS.fields);
  });
});

describe("fieldsFromPairs", () => {
  test("keeps a name used both plain and with brackets", () => {
    const fields = fieldsFromPairs([["a", "1"], ["a[b]", "2"]]);
    expect(fields.map((field) => [field.key, field.value])).toEqual([["a", "1"], ["a[b]", "2"]]);
  });
});

describe("mapSubmission", () => {
  test("auto-detects the common field names, whatever their case and separators", async () => {
    const result = await mapped({
      "Your-Name": "Sam Lee",
      "E-mail": "Sam@Lee.dev",
      "Phone Number": "+44 20 7946 0958",
      Organisation: "Lee & Co",
      "Your Message": "Can you ship to Leeds?",
      page_url: "https://lee.dev/contact",
      entry_id: "42",
      submitted_at: "2026-10-16T09:00:00Z",
      utm_source: "google",
    });
    expect(result).toMatchObject({
      email: "sam@lee.dev",
      emailRejected: null,
      phone: "+44 20 7946 0958",
      name: "Sam Lee",
      company: "Lee & Co",
      message: "Can you ship to Leeds?",
      pageUrl: "https://lee.dev/contact",
      submissionId: "42",
      extras: { utm_source: "google" },
    });
    expect(result.submittedAt?.toISOString()).toBe("2026-10-16T09:00:00.000Z");
    expect(Object.keys(result.fields)).toHaveLength(9);
  });

  test("recognizes each documented alias", async () => {
    const cases: [string, keyof ReturnType<typeof mapSubmission>, string][] = [
      ["email", "email", "a@b.co"], ["e-mail", "email", "a@b.co"], ["your-email", "email", "a@b.co"], ["mail", "email", "a@b.co"],
      ["phone", "phone", "1"], ["tel", "phone", "1"], ["mobile", "phone", "1"], ["whatsapp", "phone", "1"], ["phone_number", "phone", "1"],
      ["name", "name", "N"], ["full_name", "name", "N"], ["your-name", "name", "N"],
      ["first_name", "firstName", "F"], ["last_name", "lastName", "L"],
      ["company", "company", "C"], ["organization", "company", "C"], ["business", "company", "C"],
      ["message", "message", "M"], ["comments", "message", "M"], ["inquiry", "message", "M"], ["enquiry", "message", "M"], ["details", "message", "M"], ["your-message", "message", "M"],
      ["page_url", "pageUrl", "U"], ["url", "pageUrl", "U"], ["page", "pageUrl", "U"],
      ["id", "submissionId", "I"], ["submission_id", "submissionId", "I"], ["entry_id", "submissionId", "I"],
      ["submitted_at", "submittedAtText", "2026-01-01"], ["created_at", "submittedAtText", "2026-01-01"], ["date", "submittedAtText", "2026-01-01"],
    ];
    for (const [name, key, value] of cases) {
      const result = await mapped({ [name]: value });
      expect([name, result[key]]).toEqual([name, value]);
    }
  });

  test("follows the endpoint's field map, case-insensitively, before any guess", async () => {
    const result = await mapped(
      { "Contact Address": "maya@shop.in", email: "someone-else@shop.in", "WA Number": "+919876543210", Notes: "Bulk order", Who: "Maya" },
      { email: "contact address", phone: "wa_number", message: "NOTES", name: "who" },
    );
    expect(result.email).toBe("maya@shop.in");
    expect(result.phone).toBe("+919876543210");
    expect(result.message).toBe("Bulk order");
    expect(result.name).toBe("Maya");
    expect(result.extras).toEqual({ email: "someone-else@shop.in" });
  });

  test("a mapped field that is missing from the submission is left empty, not guessed", async () => {
    const result = await mapped({ email: "a@b.co" }, { email: "work_email" });
    expect(result.email).toBeNull();
    expect(result.emailRejected).toBeNull();
  });

  test("a field map can name a nested field by its path", async () => {
    const result = await mapped({ data: { addr: "x@y.co" }, meta: { addr: "y@z.co" } }, { email: "meta.addr" });
    expect(result.email).toBe("y@z.co");
  });

  test("never reads who the visitor is from a tool's nested metadata", async () => {
    const result = await mapped({ form: { name: "Footer form", email: "forms@tool.io" }, message: "Hi" });
    expect(result.name).toBeNull();
    expect(result.email).toBeNull();
    expect(result.message).toBe("Hi");
  });

  test("drops an email that is not a valid address with its reason, and never repairs it", async () => {
    for (const bad of ["jane@acme", "Jane <jane@acme.io>", "mailto:jane@acme.io", "jane at acme.io", "jane@@acme.io", "jane@acme.io, bob@acme.io"]) {
      const result = await mapped({ email: bad, phone: "+14155552671" });
      expect(result.email).toBeNull();
      expect(result.emailRejected).toEqual({ field: "email", value: bad, reason: `“${bad}” is not a valid email address` });
      expect(result.phone).toBe("+14155552671");
    }
  });

  test("only trims and lowercases a valid email", async () => {
    expect((await mapped({ email: "  Jane.Doe+Quotes@Acme.IO " })).email).toBe("jane.doe+quotes@acme.io");
  });

  test("joins first and last name when there is no full name", async () => {
    expect((await mapped({ first_name: "Ada", last_name: "Lovelace" })).name).toBe("Ada Lovelace");
    expect((await mapped({ last_name: "Lovelace" })).name).toBe("Lovelace");
    expect((await mapped({ name: "A. L.", first_name: "Ada" })).name).toBe("A. L.");
  });

  test("truncates long values", async () => {
    const result = await mapped({ message: "m".repeat(LIMITS.message + 50), name: "n".repeat(500), note: "x".repeat(LIMITS.value * 2) });
    expect(result.message).toHaveLength(LIMITS.message);
    expect(result.message!.endsWith("…")).toBe(true);
    expect(result.name).toHaveLength(LIMITS.name);
    expect(result.extras.note).toHaveLength(LIMITS.value);
  });

  test("keeps a clashing field name under its path", async () => {
    const result = await mapped({ email: "a@b.co", data: { email: "c@d.co" } });
    expect(result.email).toBe("c@d.co");
    expect(result.fields).toEqual({ email: "a@b.co", "data.email": "c@d.co" });
    expect(result.extras).toEqual({ email: "a@b.co" });
  });
});

describe("parseSubmittedAt", () => {
  test("reads ISO 8601, Unix seconds and milliseconds, and dates with a month name", () => {
    expect(parseSubmittedAt("2026-10-15T08:30:00+05:30", NOW)?.toISOString()).toBe("2026-10-15T03:00:00.000Z");
    expect(parseSubmittedAt("2026-10-15 08:30:00Z", NOW)?.toISOString()).toBe("2026-10-15T08:30:00.000Z");
    expect(parseSubmittedAt("1760500000", NOW)?.toISOString()).toBe(new Date(1760500000 * 1000).toISOString());
    expect(parseSubmittedAt("1760500000123", NOW)?.toISOString()).toBe(new Date(1760500000123).toISOString());
    expect(parseSubmittedAt("15 October 2026", NOW)?.getUTCMonth()).toBe(9);
  });

  test("does not guess ambiguous, future or implausible dates", () => {
    expect(parseSubmittedAt("05/10/2026", NOW)).toBeNull();
    expect(parseSubmittedAt("yesterday", NOW)).toBeNull();
    expect(parseSubmittedAt("2027-01-01", NOW)).toBeNull();
    expect(parseSubmittedAt("1990-01-01", NOW)).toBeNull();
    expect(parseSubmittedAt("", NOW)).toBeNull();
    expect(parseSubmittedAt(null, NOW)).toBeNull();
  });
});

describe("inquiryDedupeKey", () => {
  test("is the form's submission id, namespaced by endpoint", async () => {
    const result = await mapped({ submission_id: "abc-1", email: "a@b.co" });
    expect(inquiryDedupeKey(ENDPOINT, result)).toBe(`${ENDPOINT}:id:abc-1`);
    expect(inquiryDedupeKey("22222222-2222-4222-8222-222222222222", result)).not.toBe(inquiryDedupeKey(ENDPOINT, result));
  });

  test("hashes a very long submission id", async () => {
    const key = inquiryDedupeKey(ENDPOINT, await mapped({ submission_id: "x".repeat(400) }));
    expect(key).toMatch(new RegExp(`^${ENDPOINT}:id:[0-9a-f]{64}$`));
  });

  test("without one, is a hash of the normalized content, stable for retries", async () => {
    const body = { email: "Jane@Acme.io", phone: "+1 (415) 555-2671", message: "Need  a quote\n", date: "2026-10-15" };
    const first = inquiryDedupeKey(ENDPOINT, await mapped(body));
    expect(first).toMatch(new RegExp(`^${ENDPOINT}:sha256:[0-9a-f]{64}$`));
    expect(inquiryDedupeKey(ENDPOINT, await mapped(body))).toBe(first);
    expect(inquiryDedupeKey(ENDPOINT, await mapped({ ...body, email: " jane@acme.io", phone: "14155552671", message: "Need a quote", utm: "x" }))).toBe(first);
    expect(inquiryDedupeKey(ENDPOINT, await mapped({ ...body, message: "Need a quote for 40" }))).not.toBe(first);
    expect(inquiryDedupeKey(ENDPOINT, await mapped({ ...body, date: "2026-10-16" }))).not.toBe(first);
  });

  test("an invalid email still tells submissions apart", async () => {
    const a = inquiryDedupeKey(ENDPOINT, await mapped({ email: "x@y", message: "hi" }));
    const b = inquiryDedupeKey(ENDPOINT, await mapped({ email: "z@y", message: "hi" }));
    expect(a).not.toBe(b);
  });

  test("with none of email, phone, message or date, hashes every field so unrelated submissions do not collapse", async () => {
    const a = inquiryDedupeKey(ENDPOINT, await mapped({ name: "Ann" }));
    const b = inquiryDedupeKey(ENDPOINT, await mapped({ name: "Bob" }));
    expect(a).not.toBe(b);
    expect(inquiryDedupeKey(ENDPOINT, await mapped({ name: "Ann" }))).toBe(a);
  });
});

describe("cleanFieldMap", () => {
  test("keeps known keys with a value, trimmed", () => {
    expect(cleanFieldMap({ email: "  Work Email ", phone: "", message: 4, bogus: "x", name: "n".repeat(300) })).toEqual({
      email: "Work Email",
      name: "n".repeat(LIMITS.fieldMapValue),
    });
    expect(cleanFieldMap(null)).toEqual({});
    expect(cleanFieldMap(["email"])).toEqual({});
  });
});

describe("normalizeFieldName", () => {
  test("ignores case and separators, keeps letters in any script", () => {
    expect(normalizeFieldName("Your E-mail_Address")).toBe("youremailaddress");
    expect(normalizeFieldName("Téléphone")).toBe("téléphone");
  });
});
