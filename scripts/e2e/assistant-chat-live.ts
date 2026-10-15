/**
 * The owner's own conversations, replayed against the real model (no
 * stand-in AI): greetings, "any city", a WhatsApp number typed in the chat,
 * questions about Instagram, and a link to read. Checks what the assistant
 * did (tool records), not how it phrased it.
 *
 *   AI_SOURCE_ORGANIZATION_ID=<org with AI Settings> GMAPS_SCRAPER_URL=http://127.0.0.1:8080 \
 *     bun run --conditions=react-server scripts/e2e/assistant-chat-live.ts
 *
 * Runs on a throwaway organization of a LOCAL database (it refuses any
 * other). Lead searches are only queued (no worker runs here) and then
 * cancelled; nothing is sent: no sending account is connected.
 */
import { and, eq, inArray } from "drizzle-orm";

if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run: DATABASE_URL must point at a local, disposable database.");
  process.exit(2);
}
const aiSource = process.env.AI_SOURCE_ORGANIZATION_ID?.trim();
if (!aiSource) {
  console.error("Set AI_SOURCE_ORGANIZATION_ID to an organization with saved AI Settings.");
  process.exit(2);
}
if (!process.env.GMAPS_SCRAPER_URL) {
  console.error("Set GMAPS_SCRAPER_URL (searches are queued, not run, but lead search must be available).");
  process.exit(2);
}

const { db } = await import("@/lib/db");
const { organizations } = await import("@/lib/auth/schema");
const { runInOrganization } = await import("@/lib/tenancy/scope");
const { runAgentTurn } = await import("@/lib/assistant/agent.server");
const { createThread, listMessages } = await import("@/lib/assistant/threads.server");
const { updateBusinessProfile } = await import("@/lib/assistant/profile.server");
const { assistantJobs } = await import("@/lib/assistant/schema");
const { copyAiSettings } = await import("./copyAiSettings");

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const stamp = Date.now();
const [org] = await db.insert(organizations).values({ name: `Chat live ${stamp}`, slug: `chat-live-${stamp}` }).returning();
await copyAiSettings(aiSource, org!.id);
console.log(`Organization ${org!.name} (${org!.id})`);

type Row = Awaited<ReturnType<typeof listMessages>>[number];
const visible = (rows: Row[]) => rows.filter((row) => !(row.toolResult as { hidden?: boolean } | null)?.hidden);
const shown = (row: Row) => row.role === "tool" ? `  [${row.tool} → ${row.status}] ${String((row.toolResult as { display?: string } | null)?.display ?? row.content).slice(0, 200)}` : `  ${row.role.toUpperCase()}: ${row.content.slice(0, 400)}`;

await runInOrganization(org!.id, async () => {
  await updateBusinessProfile({
    businessName: "Sparkle Home Services",
    offer: "Deep cleaning for homes and offices, including move-out cleaning",
    targetCustomers: "real estate agents",
    locations: "United States",
    senderName: "Ravi",
  }, null);

  /** One owner message and the assistant's turn; returns what the turn added. */
  async function say(threadId: string, text: string): Promise<Row[]> {
    const before = (await listMessages(threadId)).length;
    await runAgentTurn({ threadId, userId: null, text });
    const added = (await listMessages(threadId)).slice(before);
    console.log(`OWNER: ${text}`);
    for (const row of added.slice(1)) console.log(shown(row));
    return added.slice(1);
  }
  const tools = (rows: Row[], name: string) => visible(rows).filter((row) => row.tool === name);
  const words = (rows: Row[]) => rows.filter((row) => row.role === "assistant").map((row) => row.content).join(" ");

  // 1. The owner's city conversation.
  const a = await createThread(null);
  const greeting = await say(a.id, "hi");
  check("a greeting runs no tools and gets an answer", !greeting.some((row) => row.role === "tool") && greeting.some((row) => row.role === "assistant"));
  const first = await say(a.id, "hey can u find some leads for me niche should be in real estates");
  const second = first.some((row) => row.tool === "find_leads" && row.status === "ok") ? [] : await say(a.id, "any city where we get mos tof leads");
  const searches = tools([...first, ...second], "find_leads").filter((row) => row.status === "ok");
  const places = new Set(searches.map((row) => String((row.toolInput as { where?: string } | null)?.where ?? "").toLowerCase()));
  check("left to choose the place, the assistant picks cities itself and starts several searches", searches.length >= 2 && places.size >= 2, [...places].join(" | "));
  check("it never claims it can search only one city at a time", !/only (?:search )?one city/i.test(words([...first, ...second])));
  check("no refused call is shown to the owner", !visible([...greeting, ...first, ...second]).some((row) => row.role === "tool" && /^Not run:/.test(row.content)));

  // 2. A WhatsApp number typed in the chat.
  const b = await createThread(null);
  const ask = await say(b.id, "he can u do outreach to a people on whatsapp num is 8084794983 tery to sell him our products or pitch them");
  const countryAsked = /country|\+91|india|\+1\b|code/i.test(words(ask));
  check("a number typed in the chat is taken as a contact, and without a country code the owner is asked which country", tools(ask, "add_contacts").length > 0 || countryAsked, words(ask).slice(0, 200));
  const answer = await say(b.id, "its india +91");
  const added = tools([...ask, ...answer], "add_contacts").filter((row) => row.status === "ok");
  check("with the country, the contact is added with its country code", added.some((row) => /\+918084794983/.test(row.content)), added.map((row) => row.content.slice(0, 160)).join(" | "));
  const plan = tools([...ask, ...answer], "prepare_outreach");
  check("outreach is then prepared for that list, or the assistant says what stops it (WhatsApp not connected)", plan.length > 0 && (plan.some((row) => row.status === "ok") || /whatsapp/i.test(words(answer))), plan.map((row) => row.content.slice(0, 160)).join(" | "));

  // 3. Questions about other sources, and a link to read.
  const c = await createThread(null);
  const insta = await say(c.id, "can you find leads on instagram?");
  check("asked about Instagram, it says it cannot and runs nothing", !insta.some((row) => row.role === "tool") && /instagram/i.test(words(insta)) && /(cannot|can't|can not|not able|unable|don't|do not)/i.test(words(insta)), words(insta).slice(0, 200));
  const site = await say(c.id, "read this page and tell me what it is about https://example.com");
  check("a link the owner gives is opened and read", tools(site, "read_webpage").some((row) => row.status === "ok"), words(site).slice(0, 160));

  // Searches were only queued: cancel them.
  await db.update(assistantJobs).set({ status: "cancelled" }).where(and(eq(assistantJobs.organizationId, org!.id), inArray(assistantJobs.status, ["queued", "running"])));
});

console.log(failures ? `\n${failures} check(s) failed.` : "\nChat checks passed.");
process.exit(failures ? 1 : 0);
