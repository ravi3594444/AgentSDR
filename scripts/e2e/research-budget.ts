/** Request-budget regression: local disposable database, no providers or sends. */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL ?? "")) throw new Error("Use a local disposable DATABASE_URL");
globalThis.fetch = Object.assign(async () => { throw new Error("No network calls are allowed in this check"); }, { preconnect: () => {} });

const { and, eq, sql } = await import("drizzle-orm");
const { db } = await import("@/lib/db");
const { organizations, users, members } = await import("@/lib/auth/schema");
const { assistantObjectives } = await import("@/lib/assistant/schema");
const { runInOrganization, inOrg } = await import("@/lib/tenancy/scope");
const { createThread, addMessage } = await import("@/lib/assistant/threads.server");
const { saveChannelRules } = await import("@/lib/channels/rules.server");
const { checkBrief } = await import("@/lib/assistant/brief");
const { ensureObjective, objectiveDefaults, objectiveForRequest, objectiveSpendGuard, requestSpendGuard, setObjectiveBrief, setObjectiveState } = await import("@/lib/assistant/objective.server");
let passed = 0;
let failed = 0;
function check(label: string, ok: boolean) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (ok) passed++; else failed++;
}
const stamp = crypto.randomUUID();
const [org] = await db.insert(organizations).values({ name: `Budget check ${stamp}`, slug: `budget-${stamp}` }).returning();
const [user] = await db.insert(users).values({ name: "Budget owner", email: `budget-${stamp}@test.invalid`, emailVerified: true }).returning();
await db.insert(members).values({ organizationId: org!.id, userId: user!.id, role: "owner" });
let foreignRequestId: string | null = null;

await runInOrganization(org!.id, async () => {
  const thread = await createThread(user!.id);
  async function ask(content: string) {
    return addMessage({ threadId: thread.id, role: "user", content, createdBy: user!.id });
  }
  const old = await ask("Find owners, spend up to $1");
  const original = await ensureObjective({ requestMessageId: old.id, threadId: thread.id, userId: user!.id });
  if (!original) throw new Error("Could not create migration fixture");
  // Simulate the older NOT NULL schema, then run the real migration twice.
  await db.execute(sql`ALTER TABLE assistant_objectives ALTER COLUMN spend_cap_usd SET NOT NULL`);
  const ddl = await readFile(join(import.meta.dir, "../../db/migrations/20261024-optional-research-budget.sql"), "utf8");
  await db.execute(sql.raw(ddl));
  await db.execute(sql.raw(ddl));
  check("re-running the upgrade preserves an existing explicit cap", (await objectiveForRequest(old.id))?.spendCapUsd === 1);

  await saveChannelRules("general", { objectiveSpendUsd: 0 }, user!.id);
  const words = "Find successful business owners and DM them asking what costs them the most money, then see whether AI could help";
  const request = await ask(words);
  foreignRequestId = request.id;
  const raw = { goal: words, contact: true, channels: null, leadTarget: null, timeLimitMinutes: null, spendCapUsd: 0 };
  const checked = checkBrief(raw, words, await objectiveDefaults());
  if (!checked.ok) throw new Error(checked.error);
  const saved = await setObjectiveBrief({ requestMessageId: request.id, threadId: thread.id, userId: user!.id, brief: checked.brief, controls: checked.controls });
  if ("problem" in saved) throw new Error(saved.problem);
  check("a model's invented zero and a saved zero do not restrict a normal request", saved.objective.spendCapUsd === null && saved.objective.controls.named?.spend === false);
  const guard = await objectiveSpendGuard(request.id);
  if (!guard) throw new Error("An objective must keep its lifecycle guard");
  const dollars = await db.transaction(tx => guard(tx, 10));
  const credits = await db.transaction(tx => guard(tx, 0, { credits: true }));
  check("metered provider reservations pass the request guard without a default allowance", dollars.ok && dollars.maxUsd === Number.POSITIVE_INFINITY);
  check("credit-based provider reservations also pass", credits.ok);
  await setObjectiveState(saved.objective.id, "pause", { name: "Owner" });
  const paused = await db.transaction(tx => guard(tx, 1));
  check("uncapped does not bypass Pause", !paused.ok && paused.wait && /paused/.test(paused.reason));
  await setObjectiveState(saved.objective.id, "resume", { name: "Owner" });
  check("Resume permits research again", (await db.transaction(tx => guard(tx, 1))).ok);
  await setObjectiveState(saved.objective.id, "cancel", { name: "Owner" });
  check("uncapped does not bypass Stop", !(await db.transaction(tx => guard(tx, 1))).ok);

  const free = await ask("Find clinics, use only free tools");
  const freeObjective = await ensureObjective({ requestMessageId: free.id, threadId: thread.id, userId: user!.id });
  const freeGuard = await objectiveSpendGuard(free.id);
  check("an explicitly free-only request still has a zero cap", freeObjective?.objective.spendCapUsd === 0);
  check("an explicitly free-only request refuses metered work", Boolean(freeGuard) && !(await db.transaction(tx => freeGuard!(tx, 1))).ok);
  check("an explicitly free-only request refuses credit-based work", Boolean(freeGuard) && !(await db.transaction(tx => freeGuard!(tx, 0, { credits: true }))).ok);

  const next = await ask("Find cleaning company owners and contact them");
  const nextObjective = await ensureObjective({ requestMessageId: next.id, threadId: thread.id, userId: user!.id });
  check("a different request in the same chat does not inherit free-only", nextObjective?.objective.spendCapUsd === null);
  const direct = await ask("Research owners using the browser");
  check("individual tools without an objective do not get a saved allowance", (await requestSpendGuard(direct.id)) === undefined);
  const directFree = await ask("Research owners, free sources only");
  const directGuard = await requestSpendGuard(directFree.id);
  check("individual tools still honor an explicit zero", Boolean(directGuard) && !(await db.transaction(tx => directGuard!(tx, 1))).ok);

  const oldGuard = await objectiveSpendGuard(old.id);
  const over = await db.transaction(tx => oldGuard!(tx, 2));
  check("an explicit positive cap still blocks a reservation above it", !over.ok);
  await db.update(assistantObjectives).set({ deadlineAt: new Date(Date.now() - 1_000) }).where(and(inOrg(assistantObjectives), eq(assistantObjectives.id, nextObjective!.objective.id)));
  const expiredGuard = await objectiveSpendGuard(next.id);
  check("uncapped does not bypass the request's deadline", !(await db.transaction(tx => expiredGuard!(tx, 1))).ok);
});

const [other] = await db.insert(organizations).values({ name: `Other ${stamp}`, slug: `other-${stamp}` }).returning();
await runInOrganization(other!.id, async () => {
  const objective = await objectiveForRequest(foreignRequestId);
  const guard = await objectiveSpendGuard(foreignRequestId);
  check("the second organization cannot load the first organization's request or its guard", objective === null && guard === undefined);
});
console.log(`${passed} passed, ${failed} failed. Research budget checks complete.`);
process.exit(failed ? 1 : 0);
