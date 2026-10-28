/** Review of c472532, fake data only. Expects a disposable local agentsdr_native database. */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { organizations, users, members } from "@/lib/auth/schema";
import { runInOrganization, inOrg } from "@/lib/tenancy/scope";
import { createThread, addMessage, listMessages } from "@/lib/assistant/threads.server";
import { actionsProblem, groundingCorpus } from "@/lib/assistant/agent";
import { runToolInThread } from "@/lib/assistant/agent.server";
import { leadAudienceMembers } from "@/lib/assistant/schema";
import { browserCommands, browserConnections } from "@/lib/browser/connected/schema";
import { createPairing, pairDevice, pollCommands, completeCommand, disconnectBrowser, runBrowserAction } from "@/lib/browser/connected/connections.server";
import { inNativeTool } from "@/lib/ai/claudeCode/nativeToolScope.server";
import { pageEvidence } from "@/lib/assistant/pageEvidence.server";
import { toolNamesFor, type ToolResult } from "@/lib/assistant/tools.server";
import { featureState } from "@/lib/features/flags.server";

if (!/^postgres(?:ql)?:\/\/[^/]+@(localhost|127\.0\.0\.1):\d+\/agentsdr_native$/.test(process.env.DATABASE_URL ?? "")) throw new Error("Requires disposable local agentsdr_native database");
const realFetch = globalThis.fetch;
globalThis.fetch = (() => { throw new Error("No network calls in this review probe"); }) as unknown as typeof fetch;
const root = resolve(import.meta.dir, "../..");
const results: { check: string; passed: boolean; observed?: unknown }[] = [];
const check = (name: string, passed: boolean, observed?: unknown) => { const row = { check: name, passed, observed }; results.push(row); console.log(JSON.stringify(row)); };
const migration = "scripts/create-browser-research-tables.ts";
check("upgrade migration is packaged and in the default deploy list", readFileSync(resolve(root, ".dockerignore"), "utf8").includes(`!${migration}`) && readFileSync(resolve(root, "Dockerfile"), "utf8").includes(`/app/${migration}`) && /DEFAULT_MIGRATIONS=.*create-browser-research-tables/.test(readFileSync(resolve(root, "docker/deploy.sh"), "utf8")));
const stamp = randomUUID();
const [org] = await db.insert(organizations).values({ name: "Browser review fixture", slug: `browser-review-${stamp}` }).returning();
const [user] = await db.insert(users).values({ name: "Reviewer", email: `review-${stamp}@fixture.test`, emailVerified: true }).returning();
await db.insert(members).values({ organizationId: org!.id, userId: user!.id, role: "owner" });
try {
  await runInOrganization(org!.id, async () => {
    const thread = await createThread(user!.id);
    const context = { threadId: thread.id, userId: user!.id, ownerText: "Research only; save matching business contacts. Do not contact anyone.", v2: true };
    const read = async (url: string, body: string) => addMessage({ threadId: thread.id, role: "tool", tool: "browser_tab_read", status: "ok", content: `Page: ${url}\nText: ${body}`, toolResult: { ok: true, summary: `Page: ${url}\nText: ${body}`, data: { url, readAt: new Date().toISOString() } } });
    await read("https://alpha.example.org/about", "Alice runs Alpha Manufacturing. Email alice@alpha.example.org.");
    await read("https://beta.example.org/about", "Bob runs Beta Cleaning. Contact bob@beta.example.org.");
    check("control: a quote actually read is accepted", !("problem" in await pageEvidence(thread.id, "https://alpha.example.org/about", "Alice runs Alpha Manufacturing.")));
    check("control: an unread page is rejected", "problem" in await pageEvidence(thread.id, "https://unread.example.org/", null));
    check("control: an invented body quote is rejected", "problem" in await pageEvidence(thread.id, "https://alpha.example.org/about", "Somebody spends a fortune on software"));
    const args = { contacts: [{ name: "Alice", email: "alice@alpha.example.org", sourceUrl: "https://beta.example.org/about", quote: "Bob runs Beta Cleaning." }], listName: "Wrong source fixture" };
    const problem = actionsProblem([{ tool: "add_contacts", args }], { profile: {}, ownerCorpus: groundingCorpus(await listMessages(thread.id)), outreachRequested: false });
    const saved: ToolResult = problem ? { ok: false, summary: problem } : await runToolInThread(context, "add_contacts", args);
    const audienceId = typeof saved.data?.audienceId === "string" ? saved.data.audienceId : null;
    const bad = audienceId ? await db.select().from(leadAudienceMembers).where(and(inOrg(leadAudienceMembers), eq(leadAudienceMembers.audienceId, audienceId))) : [];
    check("a contact cannot be attributed to a different read page", !saved.ok, bad[0]?.evidence);
    // The source body below deliberately contains no such statement; a URL alone is not a quote.
    await read("https://beta.example.org/about?fact=entirely-invented-token", "Bob runs Beta Cleaning.");
    const quote = await pageEvidence(thread.id, "https://beta.example.org/about?fact=entirely-invented-token", "entirely-invented-token");
    check("a query-string echo cannot become page evidence", "problem" in quote, quote);

    // Exa uses pages[] rather than a single data.url. On an integrated branch it must be usable as evidence too.
    const exaUrl = "https://exa.example.org/contact";
    await addMessage({ threadId: thread.id, role: "tool", tool: "exa_read", status: "ok", content: "Read Exa pages", toolResult: { ok: true, summary: `Read ${exaUrl}. Owner Priya, priya@exa.example.org`, data: { provider: "exa", pages: [{ url: exaUrl, title: "Contact", body: "Owner Priya. Contact priya@exa.example.org.", readAt: new Date().toISOString() }] } } });
    if (toolNamesFor(await featureState()).includes("exa_read")) check("the combined branch accepts a real Exa page as evidence", !("problem" in await pageEvidence(thread.id, exaUrl, "Owner Priya.")));
    else console.log("SKIP Exa evidence integration: this branch does not include Exa");

    const pairing = await createPairing(user!.id);
    const paired = await pairDevice({ code: pairing.code, deviceId: randomUUID(), deviceLabel: "Review fixture", extensionVersion: "0.16.0", sites: ["web"] });
    const directController = new AbortController();
    const direct = runBrowserAction({ userId: user!.id, threadId: thread.id, requestId: thread.id, action: { kind: "tabs" }, timeoutMs: 5_000, signal: directController.signal }).catch((error: unknown) => error);
    let directRow: typeof browserCommands.$inferSelect | undefined;
    for (let i = 0; i < 100 && !directRow; i++) {
      [directRow] = await db.select().from(browserCommands).where(and(inOrg(browserCommands), eq(browserCommands.connectionId, paired.connectionId), eq(browserCommands.status, "pending")));
      if (!directRow) await new Promise((done) => setTimeout(done, 20));
    }
    if (!directRow) throw new Error("No direct command queued");
    directController.abort(new Error("Control cancellation"));
    await direct;
    const [directEnded] = await db.select().from(browserCommands).where(and(inOrg(browserCommands), eq(browserCommands.id, directRow.id)));
    check("control: the queue cancels when the caller supplies the signal", directEnded?.status === "expired" && directEnded.error === "cancelled");
    const controller = new AbortController();
    const wait = inNativeTool({ organizationId: org!.id, userId: user!.id }, controller.signal, () => runToolInThread(context, "browser_tab_read", { tab: 123 }));
    let queued: typeof browserCommands.$inferSelect | undefined;
    for (let i = 0; i < 100 && !queued; i++) {
      [queued] = await db.select().from(browserCommands).where(and(inOrg(browserCommands), eq(browserCommands.connectionId, paired.connectionId), eq(browserCommands.status, "pending")));
      if (!queued) await new Promise((done) => setTimeout(done, 20));
    }
    if (!queued) throw new Error("No browser command queued");
    controller.abort(new Error("Owner cancelled native turn"));
    await new Promise((done) => setTimeout(done, 150));
    const [connection] = await db.select().from(browserConnections).where(and(inOrg(browserConnections), eq(browserConnections.id, paired.connectionId)));
    const taken = await pollCommands(connection!, { extensionVersion: "0.16.0", sites: ["web"], sharedTabs: [], lastSeq: 0, paused: false }, AbortSignal.timeout(100));
    check("a native turn's cancelled step is not delivered afterwards", !taken.commands.some((command) => command.id === queued!.id), taken.commands.map((command) => ({ id: command.id, action: command.action })));
    for (const command of taken.commands) await completeCommand(connection!, command.id, { seq: command.seq, result: { ok: false, error: "Review fixture cleanup" } });
    await disconnectBrowser(user!.id);
    await wait;
  });
} finally { globalThis.fetch = realFetch; }
console.log(`Review probe: ${results.filter((row) => row.passed).length} passed, ${results.filter((row) => !row.passed).length} failed. No live browser/provider used.`);
process.exit(results.every((row) => row.passed) ? 0 : 1);
