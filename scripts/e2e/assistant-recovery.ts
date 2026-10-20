/**
 * Recovery from unusable model answers, end to end against the local
 * database with the real chat turn (runAgentTurn) and a stand-in for the
 * model (the structured-completion module is replaced; nothing leaves the
 * machine):
 *
 * - while the model is asked again, the chat shows one "Retrying" note,
 *   hidden once a usable answer arrives;
 * - when every attempt fails, the chat gets a plain summary (no schema
 *   wording or raw model output) with a Retry flag, and nothing runs;
 * - Retry (a turn with no new message) answers the same request, and the
 *   Retry offer is not repeated;
 * - a turn that started a search and then got no usable answer (pilot F08):
 *   the summary does not say nothing was started, and a Retry whose model
 *   repeats the same search starts no second one.
 *
 *   bun run --conditions=react-server scripts/e2e/assistant-recovery.ts
 *
 * Creates its own organization ("Recovery check …") and leaves it behind.
 * Refuses a non-local DATABASE_URL.
 */
import { mock } from "bun:test";
import { join } from "node:path";

if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run: DATABASE_URL must point at a local, disposable database.");
  process.exit(2);
}

const root = join(import.meta.dir, "..", "..");
// A search can be started (its job is recorded); nothing runs it here, so the scraper is never called.
process.env.GMAPS_SCRAPER_URL = "http://scraper.recovery-check.test";
process.env.GEOCODER_URL = "off";
type Input = { userPrompt: string; accept: (text: string) => void; onRetry?: (info: { attempt: number; maxAttempts: number; reason: string }) => Promise<void> | void };
let script: (input: Input) => Promise<string> = async () => {
  throw new Error("unexpected model call");
};
const prompts: string[] = [];
mock.module(join(root, "src/lib/ai/server/structuredCompletion.ts"), () => ({
  completeStructured: async (input: Input) => {
    prompts.push(input.userPrompt);
    const text = await script(input);
    input.accept(text);
    return { text, model: "fixture", provider: "fixture", request: {}, response: {}, usage: {}, attempts: 1 };
  },
}));

const { db } = await import("@/lib/db");
const { organizations, users, members } = await import("@/lib/auth/schema");
const { runInOrganization } = await import("@/lib/tenancy/scope");
const { runAgentTurn } = await import("@/lib/assistant/agent.server");
const { createThread, listMessages } = await import("@/lib/assistant/threads.server");
const { assistantJobs } = await import("@/lib/assistant/schema");
const { and, eq } = await import("drizzle-orm");

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const stamp = Date.now();
const [org] = await db.insert(organizations).values({ name: `Recovery check ${stamp}`, slug: `recovery-check-${stamp}` }).returning();
const [owner] = await db.insert(users).values({ name: "Owner", email: `owner-${stamp}@recovery-check.test`, emailVerified: true }).returning();
await db.insert(members).values({ organizationId: org!.id, userId: owner!.id, role: "owner" });

const reply = (message: string) => JSON.stringify({ message, actions: [], suggestions: [] });
const visible = (rows: Awaited<ReturnType<typeof listMessages>>) => rows.filter((row) => !(row.toolResult as { hidden?: boolean } | null)?.hidden);

await runInOrganization(org!.id, async () => {
  // ---------------------------------------------------------- recovered after a retry
  const first = await createThread(owner!.id);
  script = async (input) => {
    await input.onRetry?.({ attempt: 2, maxAttempts: 3, reason: "actions must be an array" });
    return reply("Our offer is AI automations for small businesses.");
  };
  await runAgentTurn({ threadId: first.id, userId: owner!.id, text: "what do we sell?" });
  const recovered = await listMessages(first.id);
  const note = recovered.find((row) => row.role === "event" && /Retrying/.test(row.content));
  check("a retry shows one 'Retrying' note while the model is asked again", Boolean(note), note?.content ?? "none");
  check("…hidden once a usable answer arrived", (note?.toolResult as { hidden?: boolean } | null)?.hidden === true);
  check("…and the answer is shown", visible(recovered).some((row) => row.role === "assistant" && /AI automations/.test(row.content)));

  // ---------------------------------------------------------- every attempt failed
  const thread = await createThread(owner!.id);
  const request = "find real estate agents in Pune and contact them on instagram";
  script = async (input) => {
    await input.onRetry?.({ attempt: 2, maxAttempts: 3, reason: "actions must be an array, including for one tool: {\"message\":\"\",\"actions\":[...]}" });
    await input.onRetry?.({ attempt: 3, maxAttempts: 3, reason: "actions must be an array" });
    throw new Error("assistant_reply failed after 3 attempts: actions must be an array, including for one tool: {\"message\":\"\",\"actions\":[{\"tool\":\"TOOL_NAME\",\"arguments\":\"{}\"}]}");
  };
  await runAgentTurn({ threadId: thread.id, userId: owner!.id, text: request });
  const failed = visible(await listMessages(thread.id));
  const events = failed.filter((row) => row.role === "event");
  const summary = events.at(-1);
  check("one failure summary, not a pile of retry notes", events.length === 1, events.map((row) => row.content).join(" | "));
  check("the summary is plain: no schema wording, JSON or raw model output", Boolean(summary) && !/actions must|TOOL_NAME|\{|assistant_reply/.test(summary!.content), summary?.content ?? "");
  check("…says nothing was started, and offers Retry", /Nothing was started/.test(summary?.content ?? "") && (summary?.toolResult as { data?: { retry?: boolean } } | null)?.data?.retry === true);
  check("nothing ran: no tool results", !failed.some((row) => row.role === "tool"));

  // ---------------------------------------------------------- Retry continues the same request
  const before = prompts.length;
  script = async () => reply("Searching Pune for real estate agents now.");
  await runAgentTurn({ threadId: thread.id, userId: owner!.id, text: null });
  const retried = visible(await listMessages(thread.id));
  check("Retry asks the model about the same request, with no new message from the owner", prompts.length === before + 1 && prompts.at(-1)!.includes(request) && retried.filter((row) => row.role === "user").length === 1);
  check("…and its answer follows the failure summary", retried.at(-1)?.role === "assistant" && /Searching Pune/.test(retried.at(-1)!.content));

  // ---------------------------------------------------------- F08: a search started, then no usable answer; Retry repeats it
  const started = await createThread(owner!.id);
  const search = { tool: "find_leads", arguments: JSON.stringify({ what: "real estate agencies", where: "Pune" }) };
  const searchesOf = () => db.select({ id: assistantJobs.id }).from(assistantJobs).where(and(eq(assistantJobs.threadId, started.id), eq(assistantJobs.kind, "discovery")));
  let call = 0;
  script = async (input) => {
    call += 1;
    if (call === 1) return JSON.stringify({ message: "", actions: [search], suggestions: [] });
    await input.onRetry?.({ attempt: 2, maxAttempts: 3, reason: "actions must be an array" });
    throw new Error("assistant_reply failed after 3 attempts: actions must be an array");
  };
  await runAgentTurn({ threadId: started.id, userId: owner!.id, text: "find real estate agencies in Pune" });
  const afterFailure = visible(await listMessages(started.id));
  const failureSummary = afterFailure.filter((row) => row.role === "event").at(-1);
  check("F08: the search the turn started is kept when the model's next answer fails", (await searchesOf()).length === 1 && afterFailure.some((row) => row.role === "tool" && row.tool === "find_leads" && row.status === "ok"),
    afterFailure.map((row) => `${row.role}:${row.tool ?? ""}:${row.status ?? ""}`).join(", "));
  check("F08: …and the failure summary does not say nothing was started", Boolean(failureSummary) && !/Nothing was started/.test(failureSummary!.content), failureSummary?.content ?? "(none)");
  call = 0;
  script = async () => {
    call += 1;
    return call === 1 ? JSON.stringify({ message: "", actions: [search], suggestions: [] }) : reply("The search for real estate agencies in Pune is running.");
  };
  await runAgentTurn({ threadId: started.id, userId: owner!.id, text: null });
  const afterRetry = visible(await listMessages(started.id));
  const repeated = afterRetry.filter((row) => row.role === "tool" && row.tool === "find_leads").at(-1);
  check("F08: Retry whose model repeats the same search starts no second one", (await searchesOf()).length === 1, `${(await searchesOf()).length} searches; last tool line: ${repeated?.content ?? ""}`);
  check("F08: …and the turn ends with the model's answer", afterRetry.at(-1)?.role === "assistant" && /is running/.test(afterRetry.at(-1)!.content), afterRetry.at(-1)?.content ?? "");
  await db.update(assistantJobs).set({ status: "cancelled" }).where(eq(assistantJobs.threadId, started.id));
});

console.log(failures ? `\n${failures} check(s) failed` : "\nAll recovery checks passed");
process.exit(failures ? 1 : 0);
