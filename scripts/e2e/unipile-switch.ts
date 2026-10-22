/**
 * Switching an organization's Unipile connection to another Unipile account,
 * end to end against the database, with Unipile's API replaced by a stand-in
 * (global fetch is intercepted for one fake host; nothing leaves the
 * machine). It runs the real account syncs and the re-read that follows a
 * saved connection.
 *
 * The owner's report (22 Oct 2026): after disconnecting the old Unipile and
 * connecting a new one with no LinkedIn linked, the old LinkedIn account
 * still showed as connected. The LinkedIn sync only added or updated what
 * the current Unipile lists; WhatsApp, Instagram and email already marked the
 * rest disconnected.
 *
 *   bun run --conditions=react-server scripts/e2e/unipile-switch.ts
 *
 * It creates two organizations ("Unipile switch check …") and leaves them
 * behind. Refuses a non-local DATABASE_URL.
 */
import { and, eq } from "drizzle-orm";

if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run: DATABASE_URL must point at a local, disposable database.");
  process.exit(2);
}

// ------------------------------------------------------------ fake Unipile
const FAKE = "https://unipile-switch-check.invalid";
let accounts: Record<string, unknown>[] = [];
let malformed = false;
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (url.origin !== FAKE) return realFetch(input, init);
  const method = (init?.method ?? "GET").toUpperCase();
  const path = url.pathname.replace(/^\/api\/v1/, "");
  if (method === "GET" && path === "/accounts") return json(200, malformed ? { object: "AccountList", cursor: null } : { object: "AccountList", items: accounts, cursor: null });
  if (path.startsWith("/webhooks")) return method === "POST" ? json(201, { object: "WebhookCreated", webhook_id: "wh-1" }) : json(200, { items: [] });
  return json(404, { title: `No fake for ${method} ${path}`, status: 404 });
}) as typeof fetch;

// ------------------------------------------------------------ app modules
const { db } = await import("@/lib/db");
const { organizations } = await import("@/lib/auth/schema");
const { linkedInAccounts } = await import("@/lib/linkedin/schema");
const { whatsappAccounts } = await import("@/lib/whatsapp/schema");
const { gridProviderCredentials, gridProviders } = await import("@/lib/grid/schema");
const { encryptIntegrationCredentials } = await import("@/lib/integrations/credentials");
const { runInOrganization, currentOrganizationId } = await import("@/lib/tenancy/scope");
const { syncAllAccounts } = await import("@/functions/syncAllAccounts");
const { resyncUnipileAccounts } = await import("@/lib/platform/unipileAccounts.server");

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const stamp = Date.now();
const linkedin = (id: string, username: string, status = "OK") => ({
  object: "Account", type: "LINKEDIN", id, name: `Ravi ${username}`,
  connection_params: { im: { id: `li-${username}`, publicIdentifier: username, username } }, sources: [{ id: `s-${id}`, status }],
});
const whatsapp = (id: string, phone: string) => ({
  object: "Account", type: "WHATSAPP", id, name: phone,
  connection_params: { im: { id: phone, phone_number: phone, username: phone } }, sources: [{ id: `s-${id}`, status: "OK" }],
});

const [orgA] = await db.insert(organizations).values({ name: `Unipile switch check A ${stamp}`, slug: `unipile-switch-a-${stamp}` }).returning();
const [orgB] = await db.insert(organizations).values({ name: `Unipile switch check B ${stamp}`, slug: `unipile-switch-b-${stamp}` }).returning();

// Another organization's LinkedIn account, never touched by A's syncs.
const otherId = `other-${stamp}`;
await runInOrganization(orgB!.id, async () => {
  await db.insert(linkedInAccounts).values({ organizationId: currentOrganizationId(), linkedinId: otherId, name: "Other org", username: `other-${stamp}`, status: "CONNECTED", updatedAt: new Date() });
});

await runInOrganization(orgA!.id, async () => {
  const [provider] = await db.insert(gridProviders).values({ organizationId: currentOrganizationId(), key: "platform-unipile", name: "Unipile (switch check)" }).returning();
  await db.insert(gridProviderCredentials).values({
    providerId: provider!.id,
    encryptedPayload: encryptIntegrationCredentials({ baseUrl: FAKE, apiKey: "switch-check", notifySecret: "switch-check-secret" }),
  });
  const username = `ravi-${stamp}`;
  const accountRow = async () => (await db.select().from(linkedInAccounts).where(and(eq(linkedInAccounts.organizationId, orgA!.id), eq(linkedInAccounts.username, username))));

  // ------------------------------------------------------------ the old Unipile lists the LinkedIn account
  accounts = [linkedin(`old-${stamp}`, username), whatsapp(`wa-${stamp}`, `+1555${String(stamp).slice(-7)}`)];
  await resyncUnipileAccounts(orgA!.id);
  let rows = await accountRow();
  check("the old Unipile's LinkedIn account and WhatsApp number are synced as connected", rows.length === 1 && rows[0]!.status === "CONNECTED" && rows[0]!.linkedinId === `old-${stamp}`, JSON.stringify(rows.map((row) => row.status)));

  // ------------------------------------------------------------ a reply without an account list changes nothing
  malformed = true;
  const failed = await syncAllAccounts().then(() => null, (error: unknown) => error);
  malformed = false;
  rows = await accountRow();
  check("a Unipile reply without an account list is an error, not \"no accounts\"", failed instanceof Error && rows[0]!.status === "CONNECTED", failed instanceof Error ? failed.message : "no error");

  // ------------------------------------------------------------ the new Unipile lists no LinkedIn account
  accounts = [whatsapp(`wa-${stamp}`, `+1555${String(stamp).slice(-7)}`)];
  await syncAllAccounts();
  rows = await accountRow();
  check("an account the new Unipile does not list is marked disconnected", rows.length === 1 && rows[0]!.status === "DISCONNECTED", JSON.stringify(rows.map((row) => row.status)));
  check("…and kept (its leads and history stay)", rows.length === 1);
  const sendable = await db.select({ id: linkedInAccounts.id }).from(linkedInAccounts).where(and(eq(linkedInAccounts.organizationId, orgA!.id), eq(linkedInAccounts.status, "CONNECTED")));
  check("…so no LinkedIn send or search picks it (they take connected accounts only)", sendable.length === 0);
  const [other] = await db.select().from(linkedInAccounts).where(eq(linkedInAccounts.linkedinId, otherId));
  check("another organization's LinkedIn account is untouched", other?.status === "CONNECTED");

  // ------------------------------------------------------------ the same profile linked to the new Unipile
  accounts = [linkedin(`new-${stamp}`, username)];
  await syncAllAccounts();
  rows = await accountRow();
  check("linking the same profile to the new Unipile reconnects the same row, with the new id", rows.length === 1 && rows[0]!.status === "CONNECTED" && rows[0]!.linkedinId === `new-${stamp}`, JSON.stringify(rows.map((row) => [row.status, row.linkedinId])));

  // ------------------------------------------------------------ saving the connection re-reads every account list
  accounts = [whatsapp(`wa2-${stamp}`, `+1666${String(stamp).slice(-7)}`)];
  await resyncUnipileAccounts(orgA!.id);
  rows = await accountRow();
  const numbers = await db.select({ unipileAccountId: whatsappAccounts.unipileAccountId, status: whatsappAccounts.status }).from(whatsappAccounts).where(eq(whatsappAccounts.organizationId, orgA!.id));
  check("after a saved connection the LinkedIn list is read again: the unlisted account is disconnected", rows[0]?.status === "DISCONNECTED");
  check("…and so is WhatsApp's: the old number disconnected, the new one added", numbers.some((row) => row.unipileAccountId === `wa-${stamp}` && row.status === "disconnected") && numbers.some((row) => row.unipileAccountId === `wa2-${stamp}`), JSON.stringify(numbers));
});

globalThis.fetch = realFetch;
console.log(failures ? `\n${failures} check(s) failed.` : "\nAll Unipile switch checks passed.");
process.exit(failures ? 1 : 0);
