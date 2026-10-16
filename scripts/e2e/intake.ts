/**
 * Inquiry intake, end to end against the local database: the real public
 * webhook route (POST /api/intake/form, called as Next would call it), the
 * real person matching and creation, the endpoint management functions,
 * recordInstagramInquiry, and the proxy's handling of the route.
 *
 *   bun run --conditions=react-server scripts/e2e/intake.ts
 *
 * It creates its own organizations ("Intake check A/B/C …"), turns Inquiry
 * intake on for A and B (setFeature, as Settings → Organization does) and
 * leaves C off, and leaves them behind. Nothing leaves the machine: global
 * fetch is replaced by one that throws. Refuses a non-local DATABASE_URL.
 *
 * What it cannot prove: that a given form tool (Zapier, Make, Webflow, a
 * WordPress plugin) sends exactly these bodies; the shapes follow their
 * documentation and are covered by src/lib/intake/fields.test.ts.
 */
import { and, count, eq, inArray, sql } from "drizzle-orm";
import { NextRequest } from "next/server";

if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run: DATABASE_URL must point at a local, disposable database.");
  process.exit(2);
}

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
  throw new Error(`No network in this check (${typeof input === "string" ? input : input instanceof URL ? input.href : input.url})`);
}) as typeof fetch;

const { db } = await import("@/lib/db");
const { organizations } = await import("@/lib/auth/schema");
const { companies, people } = await import("@/lib/leads/schema");
const { inquiries, intakeEndpoints } = await import("@/lib/intake/schema");
const { instagramAccounts, instagramChats } = await import("@/lib/instagram/schema");
const { setFeature } = await import("@/lib/features/flags.server");
const { saveChannelRules } = await import("@/lib/channels/rules.server");
const { createIntakeEndpoint, deleteIntakeEndpoint, listInquiries, rotateIntakeEndpointToken, updateIntakeEndpoint } = await import("@/lib/intake/endpoints.server");
const { recordInstagramInquiry } = await import("@/lib/intake/instagram.server");
const { createProvisionalPerson, upsertCompany, upsertPerson, withLeadTransaction } = await import("@/lib/leads/records");
const { generateIntakeToken } = await import("@/lib/intake/tokens");
const { runInOrganization } = await import("@/lib/tenancy/scope");
const { demoRequestBlock } = await import("@/lib/demo/mode");
const { migrationMutationBlockReason } = await import("@/lib/migration/controls");
const { proxy } = await import("@/proxy");
const { POST } = await import("@/app/api/intake/form/route");

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const stamp = Date.now().toString(36);
const URL_BASE = "http://localhost/api/intake/form";

async function newOrganization(label: string) {
  const [org] = await db.insert(organizations).values({ name: `Intake check ${label} ${stamp}`, slug: `intake-check-${label.toLowerCase()}-${stamp}` }).returning();
  return org!;
}

type Reply = { status: number; body: { ok?: boolean; inquiryId?: string; duplicate?: boolean; status?: string; error?: string } };

/** Calls the route handler the way Next does. */
async function deliver(
  body: BodyInit | null,
  options: { token?: string | null; via?: "header" | "bearer" | "query"; contentType?: string | null; query?: string } = {},
): Promise<Reply> {
  const via = options.via ?? "header";
  const params = new URLSearchParams(options.query ?? "");
  if (options.token && via === "query") params.set("token", options.token);
  const headers = new Headers();
  if (options.token && via === "header") headers.set("x-agentsdr-token", options.token);
  if (options.token && via === "bearer") headers.set("authorization", `Bearer ${options.token}`);
  if (options.contentType) headers.set("content-type", options.contentType);
  const search = params.toString();
  const response = await POST(new NextRequest(`${URL_BASE}${search ? `?${search}` : ""}`, { method: "POST", headers, body }));
  return { status: response.status, body: await response.json() };
}

const json = (value: unknown, token: string, extra: Parameters<typeof deliver>[1] = {}) =>
  deliver(JSON.stringify(value), { token, contentType: "application/json", ...extra });

async function inOrg<T>(orgId: string, fn: () => Promise<T>): Promise<T> {
  return runInOrganization(orgId, fn);
}

async function peopleCount(orgId: string): Promise<number> {
  const [row] = await db.select({ total: count() }).from(people).where(eq(people.organizationId, orgId));
  return Number(row!.total);
}

async function inquiryCount(orgId: string): Promise<number> {
  const [row] = await db.select({ total: count() }).from(inquiries).where(eq(inquiries.organizationId, orgId));
  return Number(row!.total);
}

async function inquiry(id: string | undefined) {
  if (!id) return null;
  const [row] = await db.select().from(inquiries).where(eq(inquiries.id, id)).limit(1);
  return row ?? null;
}

async function person(id: string | null | undefined) {
  if (!id) return null;
  const [row] = await db.select().from(people).where(eq(people.id, id)).limit(1);
  return row ?? null;
}

// ------------------------------------------------------------ setup
const orgA = await newOrganization("A");
const orgB = await newOrganization("B");
const orgC = await newOrganization("C");
console.log(`Organizations A ${orgA.id}, B ${orgB.id}, C ${orgC.id} (C keeps Inquiry intake off)`);

const endpointA = await inOrg(orgA.id, () => createIntakeEndpoint({ name: "Contact page" }, null));
const mappedA = await inOrg(orgA.id, () => createIntakeEndpoint({ name: "Footer form (custom names)", fieldMap: { email: "Contact Address", message: "notes", name: "WHO" } }, null));
const endpointB = await inOrg(orgB.id, () => createIntakeEndpoint({ name: "B's form" }, null));
let tokenA = endpointA.token;

// ------------------------------------------------------------ proxy
{
  const publicResponse = proxy(new NextRequest(URL_BASE, { method: "POST" }));
  check("proxy lets POST /api/intake/form through without a session cookie", publicResponse.headers.get("x-middleware-next") === "1");
  const privateResponse = proxy(new NextRequest("http://localhost/api/intake/endpoints", { method: "GET" }));
  check("proxy keeps /api/intake/endpoints behind sign-in", privateResponse.status === 401, String(privateResponse.status));
  const inquiriesResponse = proxy(new NextRequest("http://localhost/api/intake/inquiries", { method: "GET" }));
  check("proxy keeps /api/intake/inquiries behind sign-in", inquiriesResponse.status === 401, String(inquiriesResponse.status));
  check("the read-only demo refuses the webhook (it never writes)", demoRequestBlock("/api/intake/form", "POST", { DEMO_MODE: "true" })?.kind === "refuse");
  check("the People migration switch leaves the inbound webhook running", migrationMutationBlockReason("/api/intake/form", "POST", { PEOPLE_MIGRATION_MODE: "true" }) === null);
}

// ------------------------------------------------------------ authentication
{
  const sample = { email: `auth-${stamp}@shop.test`, message: "hello" };
  const missing = await deliver(JSON.stringify(sample), { contentType: "application/json" });
  check("no token → 401", missing.status === 401, JSON.stringify(missing.body));
  const malformed = await json(sample, "not-a-token");
  check("a malformed token → 401", malformed.status === 401);
  const unknown = await json(sample, generateIntakeToken().token);
  check("an unknown token → 401", unknown.status === 401, JSON.stringify(unknown.body));
}

// ------------------------------------------------------------ feature off
{
  const before = { people: await peopleCount(orgA.id), inquiries: await inquiryCount(orgA.id) };
  const off = await json({ name: "Too Early", email: `early-${stamp}@shop.test`, message: "Are you open?" }, tokenA);
  check("Inquiry intake off → 409", off.status === 409, JSON.stringify(off.body));
  check("…and nothing is stored", (await peopleCount(orgA.id)) === before.people && (await inquiryCount(orgA.id)) === before.inquiries);
  const [endpointRow] = await db.select().from(intakeEndpoints).where(eq(intakeEndpoints.id, endpointA.endpoint.id));
  check("…and the endpoint has not heard anything", endpointRow?.lastReceivedAt === null);
}

await inOrg(orgA.id, async () => {
  await setFeature("inquiry_intake", true, null);
  await saveChannelRules("general", { defaultPhoneCountry: "US" }, null);
});
await inOrg(orgB.id, () => setFeature("inquiry_intake", true, null));

// ------------------------------------------------------------ a JSON submission, then its retry
const janeEmail = `jane.doe+${stamp}@acme-${stamp}.test`;
const janeMessage = "Do you deliver 40 chairs to Pune by Friday?\nWe need them for an event.";
const janeBody = { data: { name: "Jane Doe", email: janeEmail.toUpperCase(), phone: "(415) 555-2671", message: janeMessage, company: "Acme Events" }, form: "Contact" };
{
  const peopleBefore = await peopleCount(orgA.id);
  const first = await json(janeBody, tokenA);
  check("a JSON submission → 202 received", first.status === 202 && first.body.ok === true && first.body.duplicate === false && first.body.status === "received", JSON.stringify(first.body));
  const row = await inquiry(first.body.inquiryId);
  check("…stores one inquiry with the message word for word", row?.message === janeMessage && row?.source === "website_form" && row?.organizationId === orgA.id, JSON.stringify(row?.message));
  check("…with the email normalized and the phone in E.164 (organization's default country)", row?.email === janeEmail && row?.phone === "+14155552671", `${row?.email} ${row?.phone}`);
  const jane = await person(row?.personId);
  check("…and creates one person, source intake:website-form", (await peopleCount(orgA.id)) === peopleBefore + 1 && jane?.email === janeEmail && jane?.source === "intake:website-form" && jane?.fullName === "Jane Doe" && jane?.phone === "+14155552671", JSON.stringify({ email: jane?.email, source: jane?.source, name: jane?.fullName, phone: jane?.phone }));
  check("…keeping the company typed in the form by name", jane?.raw?.companyName === "Acme Events" && jane?.companyId === null, JSON.stringify(jane?.raw));
  const [endpointRow] = await db.select().from(intakeEndpoints).where(eq(intakeEndpoints.id, endpointA.endpoint.id));
  check("…and marks when the endpoint last received", endpointRow?.lastReceivedAt instanceof Date);

  const retry = await json(janeBody, tokenA);
  check("the same submission again → 202 duplicate with the original inquiry id", retry.status === 202 && retry.body.duplicate === true && retry.body.inquiryId === first.body.inquiryId, JSON.stringify(retry.body));
  const [{ total: janeInquiries }] = await db.select({ total: count() }).from(inquiries).where(and(eq(inquiries.organizationId, orgA.id), eq(inquiries.email, janeEmail)));
  check("…still one person and one inquiry", (await peopleCount(orgA.id)) === peopleBefore + 1 && Number(janeInquiries) === 1);

  const concurrent = await Promise.all([1, 2, 3].map(() => json({ ...janeBody, data: { ...janeBody.data, message: "Racing retries" } }, tokenA)));
  const ids = new Set(concurrent.map((reply) => reply.body.inquiryId));
  check("three concurrent deliveries of one submission record it once", ids.size === 1 && concurrent.filter((reply) => reply.body.duplicate === false).length === 1, JSON.stringify(concurrent.map((reply) => reply.body)));
}

// ------------------------------------------------------------ existing people are reused
{
  const existingEmail = `existing-${stamp}@shop.test`;
  const existing = await inOrg(orgA.id, () => withLeadTransaction((tx) => upsertPerson(tx, { email: existingEmail, fullName: "Existing Name", source: "manual" })));
  const peopleBefore = await peopleCount(orgA.id);
  const reply = await json({ name: "Someone Else", email: existingEmail.toUpperCase(), message: "Second visit" }, tokenA);
  const row = await inquiry(reply.body.inquiryId);
  const after = await person(existing.id);
  check("an existing person with that email (any case) is reused", reply.status === 202 && row?.personId === existing.id && (await peopleCount(orgA.id)) === peopleBefore, JSON.stringify(reply.body));
  check("…and keeps their own name and source", after?.fullName === "Existing Name" && after?.source === "manual", `${after?.fullName} ${after?.source}`);

  const phoneOnly = await inOrg(orgA.id, () => withLeadTransaction((tx) => createProvisionalPerson(tx, { phone: "+16502530000", source: "call-campaign-contact" })));
  const withPhoneOnly = await peopleCount(orgA.id);
  const byPhone = await deliver(new URLSearchParams({ "your-name": "Caller", "your-phone": "(650) 253-0000", "your-message": "Call me back" }).toString(), { token: tokenA, contentType: "application/x-www-form-urlencoded" });
  const phoneRow = await inquiry(byPhone.body.inquiryId);
  const phonePerson = await person(phoneOnly.id);
  check("an existing phone-only person is matched by E.164 phone", byPhone.status === 202 && phoneRow?.personId === phoneOnly.id && (await peopleCount(orgA.id)) === withPhoneOnly, JSON.stringify(byPhone.body));
  check("…and only their empty name is filled in", phonePerson?.fullName === "Caller" && phonePerson?.phone === "+16502530000" && phonePerson?.source === "call-campaign-contact", `${phonePerson?.fullName} ${phonePerson?.source}`);

  // A shared number (a switchboard): someone with another email is someone else.
  const colleague = await inOrg(orgA.id, () => withLeadTransaction((tx) => upsertPerson(tx, { email: `front-desk-${stamp}@clinic.test`, phone: "+14155550123", fullName: "Front Desk", source: "manual" })));
  const withColleague = await peopleCount(orgA.id);
  const sharedPhone = await json({ name: "Dr Rao", email: `dr.rao-${stamp}@clinic.test`, phone: "(415) 555-0123", message: "Booking for the clinic" }, tokenA);
  const sharedRow = await inquiry(sharedPhone.body.inquiryId);
  const rao = await person(sharedRow?.personId);
  check("a phone match with a different email is a different person, not merged", sharedRow?.personId !== colleague.id && rao?.email === `dr.rao-${stamp}@clinic.test` && rao?.phone === "+14155550123" && (await peopleCount(orgA.id)) === withColleague + 1 && (await person(colleague.id))?.fullName === "Front Desk", JSON.stringify(sharedPhone.body));
}

// ------------------------------------------------------------ companies
{
  const domain = `bakery-${stamp}.test`;
  const company = await inOrg(orgA.id, () => withLeadTransaction((tx) => upsertCompany(tx, { domain, name: "The Real Bakery Ltd", source: "manual" })));
  const reply = await json({ name: "Baker", email: `owner@${domain}`, company: "bakery", message: "Wholesale flour?" }, tokenA);
  const baker = await person((await inquiry(reply.body.inquiryId))?.personId);
  const [after] = await db.select().from(companies).where(eq(companies.id, company!.id));
  check("an existing company (by the email's domain) is linked, and a name typed in a form never renames it", baker?.companyId === company!.id && after?.name === "The Real Bakery Ltd", `${baker?.companyId} ${after?.name}`);
}

// ------------------------------------------------------------ form-urlencoded with a field map
{
  const ravi = `ravi-${stamp}@shop.test`;
  const reply = await deliver(new URLSearchParams({ WHO: "Ravi K", "contact address": ravi, Notes: "Need a quote for 200 mugs", email: `decoy-${stamp}@shop.test` }).toString(), { token: mappedA.token, contentType: "application/x-www-form-urlencoded" });
  const row = await inquiry(reply.body.inquiryId);
  const created = await person(row?.personId);
  check("form-urlencoded with a custom field map → mapped fields", reply.status === 202 && row?.email === ravi && row?.message === "Need a quote for 200 mugs" && row?.name === "Ravi K" && row?.endpointId === mappedA.endpoint.id, JSON.stringify({ email: row?.email, message: row?.message, name: row?.name }));
  check("…the person is the mapped email, not a look-alike field", created?.email === ravi && row?.fields?.email === `decoy-${stamp}@shop.test`);
}

// ------------------------------------------------------------ multipart, bearer and ?token=
{
  const form = new FormData();
  form.append("name", "Lee Studio");
  form.append("email", `lee-${stamp}@studio.test`);
  form.append("message", "Logo quote?");
  form.append("brief", new Blob(["%PDF-1.4"], { type: "application/pdf" }), "brief.pdf");
  const multipart = await deliver(form, { token: tokenA, via: "bearer" });
  const row = await inquiry(multipart.body.inquiryId);
  check("multipart text fields, token as Authorization: Bearer → 202", multipart.status === 202 && row?.email === `lee-${stamp}@studio.test` && row?.message === "Logo quote?" && !("brief" in (row?.fields ?? {})), JSON.stringify(multipart.body));
  const query = await json({ email: `query-${stamp}@shop.test`, message: "Via query token" }, tokenA, { via: "query" });
  check("?token= fallback → 202", query.status === 202 && query.body.status === "received", JSON.stringify(query.body));
}

// ------------------------------------------------------------ what cannot become a contact
{
  const peopleBefore = await peopleCount(orgA.id);
  const badEmail = await json({ name: "Bad Email", email: "not-an-email@", phone: "+44 20 7946 0958", message: "Typo in my address" }, tokenA);
  const row = await inquiry(badEmail.body.inquiryId);
  const created = await person(row?.personId);
  const dropped = (row?.raw?.dropped ?? []) as { field: string; value: string; reason: string }[];
  check("an invalid email is dropped with its reason, never repaired", badEmail.status === 202 && row?.email === null && dropped[0]?.field === "email" && dropped[0]?.value === "not-an-email@" && /not a valid email/.test(dropped[0]?.reason ?? ""), JSON.stringify(dropped));
  check("…the phone is kept and the person is reachable by it", row?.status === "received" && row?.phone === "+442079460958" && created?.phone === "+442079460958" && created?.email === null && (await peopleCount(orgA.id)) === peopleBefore + 1, JSON.stringify({ phone: row?.phone, person: created?.phone }));

  const nothing = await json({ name: "Nobody", message: "Call me maybe" }, tokenA);
  const nothingRow = await inquiry(nothing.body.inquiryId);
  check("no email and no phone → stored as unusable with a reason, no person", nothing.status === 202 && nothing.body.status === "unusable" && nothingRow?.status === "unusable" && Boolean(nothingRow?.reason) && nothingRow?.personId === null && (await peopleCount(orgA.id)) === peopleBefore + 1, nothingRow?.reason ?? "");

  const badPhone = await json({ name: "Short Phone", phone: "12345", message: "?" }, tokenA);
  const badPhoneRow = await inquiry(badPhone.body.inquiryId);
  check("…an unusable phone is never guessed: its reason is kept", badPhone.body.status === "unusable" && /too short/.test(badPhoneRow?.reason ?? ""), badPhoneRow?.reason ?? "");
}

// ------------------------------------------------------------ historical backfill
{
  const reply = await json({ email: `old-${stamp}@shop.test`, message: "From last year", submitted_at: "2025-03-01T10:00:00Z" }, tokenA, { query: "historical=1" });
  const row = await inquiry(reply.body.inquiryId);
  check("?historical=1 → stored as historical, with its submitted-at", reply.status === 202 && row?.historical === true && row?.submittedAt?.toISOString() === "2025-03-01T10:00:00.000Z", JSON.stringify(reply.body));
  const live = await inOrg(orgA.id, () => listInquiries({ limit: 200 }));
  const all = await inOrg(orgA.id, () => listInquiries({ limit: 200, includeHistorical: true }));
  check("…left out of the default listing, shown when asked for", !live.some((item) => item.id === row?.id) && all.some((item) => item.id === row?.id && item.historical));
}

// ------------------------------------------------------------ request errors
{
  const huge = await json({ email: `huge-${stamp}@shop.test`, message: "x".repeat(70 * 1024) }, tokenA);
  check("a body above 64 KB → 413", huge.status === 413, JSON.stringify(huge.body));
  const plain = await deliver("email=a@b.co", { token: tokenA, contentType: "text/plain" });
  check("an unsupported content type → 415", plain.status === 415, JSON.stringify(plain.body));
  const empty = await json({}, tokenA);
  check("a body with no fields → 400", empty.status === 400, JSON.stringify(empty.body));
  const broken = await deliver("{not json", { token: tokenA, contentType: "application/json" });
  check("unreadable JSON → 400", broken.status === 400);
}

// ------------------------------------------------------------ disabled endpoint, rotation
{
  await inOrg(orgA.id, () => updateIntakeEndpoint(endpointA.endpoint.id, { enabled: false }));
  const before = await inquiryCount(orgA.id);
  const disabled = await json({ email: `off-${stamp}@shop.test`, message: "Are you there?" }, tokenA);
  check("a disabled endpoint → 403, nothing stored", disabled.status === 403 && (await inquiryCount(orgA.id)) === before, JSON.stringify(disabled.body));
  await inOrg(orgA.id, () => updateIntakeEndpoint(endpointA.endpoint.id, { enabled: true }));

  const rotated = await inOrg(orgA.id, () => rotateIntakeEndpointToken(endpointA.endpoint.id));
  const old = await json({ email: `rotated-${stamp}@shop.test`, message: "Old token" }, tokenA);
  tokenA = rotated!.token;
  const fresh = await json({ email: `rotated-${stamp}@shop.test`, message: "New token" }, tokenA);
  check("after rotation the old token → 401 and the new one works", old.status === 401 && fresh.status === 202 && rotated!.endpoint.tokenHint === tokenA.slice(-4), `${old.status} ${fresh.status}`);
}

// ------------------------------------------------------------ isolation between organizations
{
  const aPeople = await peopleCount(orgA.id);
  const aInquiries = await inquiryCount(orgA.id);
  const reply = await json({ ...janeBody, data: { ...janeBody.data, message: "Same person, other business" } }, endpointB.token);
  const row = await inquiry(reply.body.inquiryId);
  const bPerson = await person(row?.personId);
  check("B's token writes into B only, even for A's contact", reply.status === 202 && row?.organizationId === orgB.id && bPerson?.organizationId === orgB.id && (await peopleCount(orgA.id)) === aPeople && (await inquiryCount(orgA.id)) === aInquiries, JSON.stringify(reply.body));

  const bList = await inOrg(orgB.id, () => listInquiries({ limit: 200, includeHistorical: true }));
  const aIds = (await db.select({ id: inquiries.id }).from(inquiries).where(eq(inquiries.organizationId, orgA.id))).map((item) => item.id);
  check("B's listing shows none of A's inquiries", bList.length === 1 && !bList.some((item) => aIds.includes(item.id)), `${bList.length} listed`);
  const aList = await inOrg(orgA.id, () => listInquiries({ limit: 200, includeHistorical: true }));
  check("…and A's shows none of B's", !aList.some((item) => item.id === row?.id));

  const foreignUpdate = await inOrg(orgB.id, () => updateIntakeEndpoint(endpointA.endpoint.id, { enabled: false }));
  const foreignRotate = await inOrg(orgB.id, () => rotateIntakeEndpointToken(endpointA.endpoint.id));
  const foreignDelete = await inOrg(orgB.id, () => deleteIntakeEndpoint(endpointA.endpoint.id));
  const [stillThere] = await db.select().from(intakeEndpoints).where(eq(intakeEndpoints.id, endpointA.endpoint.id));
  check("B cannot change, rotate or delete A's endpoint (not found)", foreignUpdate === null && foreignRotate === null && foreignDelete === false && stillThere?.enabled === true);
}

// ------------------------------------------------------------ Instagram
{
  const accountId = `ig-acct-${stamp}`;
  const { chat } = await inOrg(orgA.id, async () => {
    const [account] = await db.insert(instagramAccounts).values({ organizationId: orgA.id, unipileAccountId: accountId, username: "our.shop", inquiryIntake: true }).returning();
    const [created] = await db.insert(instagramChats).values({ accountId: account!.id, unipileChatId: `chat-${stamp}`, providerId: `sender-${stamp}`, username: "jane.buys" }).returning();
    return { chat: created! };
  });
  const sentAt = new Date("2026-10-16T08:00:00Z");
  const input = {
    chatId: chat.id,
    unipileAccountId: accountId,
    providerId: `sender-${stamp}`,
    username: "jane.buys",
    name: null,
    messageText: "Is the blue vase still available?",
    unipileMessageId: `msg-${stamp}-1`,
    sentAt,
  };
  const peopleBefore = await peopleCount(orgA.id);
  const first = await inOrg(orgA.id, () => recordInstagramInquiry(input));
  const row = await inquiry(first.inquiryId ?? undefined);
  const igPerson = await person(first.personId);
  check("recordInstagramInquiry creates one person and one inquiry", Boolean(first.personId && first.inquiryId) && first.duplicate === false && (await peopleCount(orgA.id)) === peopleBefore + 1, JSON.stringify(first));
  check("…the person: no email or phone, named @username, source intake:instagram, raw.instagram", igPerson?.email === null && igPerson?.phone === null && igPerson?.fullName === "@jane.buys" && igPerson?.source === "intake:instagram"
    && JSON.stringify(igPerson?.raw?.instagram) === JSON.stringify({ username: "jane.buys", providerId: `sender-${stamp}` }), JSON.stringify({ name: igPerson?.fullName, raw: igPerson?.raw }));
  check("…the inquiry: source instagram, its chat, the message word for word, sent-at", row?.source === "instagram" && row?.instagramChatId === chat.id && row?.message === input.messageText && row?.submittedAt?.toISOString() === sentAt.toISOString() && row?.dedupeKey === `${accountId}:sender-${stamp}`);
  const again = await inOrg(orgA.id, () => recordInstagramInquiry({ ...input, unipileMessageId: `msg-${stamp}-2`, messageText: "Hello?" }));
  const [{ total }] = await db.select({ total: count() }).from(inquiries).where(and(eq(inquiries.organizationId, orgA.id), eq(inquiries.source, "instagram")));
  check("…the same sender on the same account again → duplicate, same person, nothing new", again.duplicate === true && again.personId === first.personId && again.inquiryId === first.inquiryId && Number(total) === 1 && (await peopleCount(orgA.id)) === peopleBefore + 1, JSON.stringify(again));

  const cPeople = await peopleCount(orgC.id);
  const off = await inOrg(orgC.id, () => recordInstagramInquiry({ ...input, chatId: crypto.randomUUID(), unipileAccountId: `ig-acct-c-${stamp}` }));
  check("with Inquiry intake off it returns nulls and stores nothing", off.personId === null && off.inquiryId === null && off.duplicate === false && (await inquiryCount(orgC.id)) === 0 && (await peopleCount(orgC.id)) === cPeople, JSON.stringify(off));
}

// ------------------------------------------------------------ nothing outside the organizations created here
{
  const ours = [orgA.id, orgB.id, orgC.id];
  const stray = await db.select({ total: count() }).from(people)
    .where(and(sql`${people.source} like 'intake:%'`, sql`${people.email} like ${`%${stamp}%`}`, sql`${people.organizationId} not in (${sql.join(ours.map((id) => sql`${id}`), sql`, `)})`));
  check("no person from this run landed in another organization", Number(stray[0]!.total) === 0);
  const summary = await db.select({ org: inquiries.organizationId, total: count() }).from(inquiries).where(inArray(inquiries.organizationId, ours)).groupBy(inquiries.organizationId);
  console.log(`Inquiries stored: ${summary.map((row) => `${row.org === orgA.id ? "A" : row.org === orgB.id ? "B" : "C"}=${row.total}`).join(", ")}`);
}

globalThis.fetch = realFetch;
console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
