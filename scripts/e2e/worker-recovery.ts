/**
 * The assistant worker's bounded recovery (src/lib/assistant/worker.ts), end
 * to end against the local database with the real worker, claims and
 * finished-job reports. The job's step is a stand-in handler registered for
 * the outreach_start kind; nothing leaves the machine and nothing is sent.
 *
 * - a step's result with NUL bytes and lone surrogates (which Postgres
 *   refuses) is saved cleaned, and the job goes on to finish;
 * - a step whose result the database refuses (a trigger stands in for the
 *   refusal) runs again with backoff and reads as "Retrying" with the
 *   reason, keeps the payload earlier steps saved, and after five attempts
 *   fails with a plain error and one report: the step ran five times, not
 *   forever; a result that cannot be written at all (a BigInt) recovers the
 *   same way once the step returns something saveable;
 * - a job claimed again and again without a step finishing (its process
 *   stopped mid-step) fails at the claim ceiling without running its step,
 *   and one claim below the ceiling still runs.
 *
 *   bun run --conditions=react-server scripts/e2e/worker-recovery.ts
 *
 * Creates its own organization ("Worker recovery check …") and leaves it
 * behind; the refusal trigger is dropped at the end. Refuses a non-local
 * DATABASE_URL.
 */
import { and, eq, sql } from "drizzle-orm";

if (!/@(localhost|127\.0\.0\.1)[:/]/.test(process.env.DATABASE_URL ?? "")) {
  console.error("Refusing to run: DATABASE_URL must point at a local, disposable database.");
  process.exit(2);
}

const { db } = await import("@/lib/db");
const { organizations, users, members } = await import("@/lib/auth/schema");
const { runInOrganization } = await import("@/lib/tenancy/scope");
const { assistantJobs, assistantMessages } = await import("@/lib/assistant/schema");
const { createThread } = await import("@/lib/assistant/threads.server");
const { registerAssistantJobs, reportFinishedJob } = await import("@/lib/assistant/register.server");
const { registerAssistantJobHandler, runOneAssistantStep } = await import("@/lib/assistant/worker");
const { jobState } = await import("@/lib/activity/status");
type StepOutcome = import("@/lib/assistant/worker").StepOutcome;

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const stamp = Date.now();
const [org] = await db.insert(organizations).values({ name: `Worker recovery check ${stamp}`, slug: `worker-recovery-${stamp}` }).returning();
const [owner] = await db.insert(users).values({ name: "Owner", email: `owner-${stamp}@worker-recovery.test`, emailVerified: true }).returning();
await db.insert(members).values({ organizationId: org!.id, userId: owner!.id, role: "owner" });

// The database refusing a step's result: any write whose progress carries this marker.
await db.execute(sql.raw(`
  create or replace function e2e_refuse_marked_job() returns trigger language plpgsql as $$
  begin
    if new.progress ? 'e2eRefuse' then raise exception 'refused by the recovery check''s trigger'; end if;
    return new;
  end $$;
  drop trigger if exists e2e_refuse_marked_job on assistant_jobs;
  create trigger e2e_refuse_marked_job before update on assistant_jobs for each row execute function e2e_refuse_marked_job();
`));

// The real job wiring and reports; the outreach_start step is replaced by the stand-in below.
registerAssistantJobs();
let step: (job: { id: string; stage: string; payload: Record<string, unknown> }) => Promise<StepOutcome> = async () => ({ next: "failed", error: "no step" });
let calls = 0;
registerAssistantJobHandler("outreach_start", async (job) => {
  calls += 1;
  return step(job);
});

type Job = typeof assistantJobs.$inferSelect;
const read = async (id: string): Promise<Job> => (await db.select().from(assistantJobs).where(eq(assistantJobs.id, id)))[0]!;
/** Makes a queued job due now (the backoff is real; the check does not wait it out). */
const due = (id: string) => db.update(assistantJobs).set({ runAfter: new Date() }).where(eq(assistantJobs.id, id));
const reports = async (threadId: string) =>
  (await db.select().from(assistantMessages).where(and(eq(assistantMessages.threadId, threadId), eq(assistantMessages.role, "event")))).map((row) => row.content);

try {
  await runInOrganization(org!.id, async () => {
    const thread = await createThread(owner!.id);
    const newJob = async (values: Partial<typeof assistantJobs.$inferInsert> = {}) => (await db.insert(assistantJobs).values({
      organizationId: org!.id, kind: "outreach_start", threadId: thread.id, createdBy: owner!.id, stage: "personalizing",
      payload: { saved: "by an earlier step" }, progress: { stage: "personalizing" }, ...values,
    }).returning())[0]!;

    // ---------------------------------------------------------- (a) unsafe text is saved clean
    const dirty = await newJob();
    step = async (job) => job.stage === "personalizing"
      ? { next: "stage", stage: "launching", payload: { note: "nul\u0000here", odd: "lone\ud800surrogate", ["key\u0000"]: 1 }, progress: { stage: "launching", text: "p\u0000" } }
      : { next: "done", result: { text: "done\u0000 \udc00" }, progress: { stage: "running" } };
    await runOneAssistantStep({ jobId: dirty.id });
    const cleaned = await read(dirty.id);
    check("(a) a step's result with NUL and lone surrogates is saved, cleaned", cleaned.stage === "launching" && cleaned.payload.note === "nulhere" && cleaned.payload.odd === "lone�surrogate" && "key" in cleaned.payload && cleaned.progress.text === "p", JSON.stringify(cleaned.payload));
    check("…the payload earlier steps saved is kept beside it", cleaned.payload.saved === "by an earlier step");
    await runOneAssistantStep({ jobId: dirty.id });
    const finished = await read(dirty.id);
    check("…and the job goes on to finish", finished.status === "succeeded" && finished.result?.text === "done �", `${finished.status} ${JSON.stringify(finished.result)}`);

    const failedDirty = await newJob();
    step = async () => ({ next: "failed", error: `bad\u0000 ${"x".repeat(5_000)}` });
    await runOneAssistantStep({ jobId: failedDirty.id });
    const failedRow = await read(failedDirty.id);
    check("(a) a failure's error with a NUL is saved clean and clipped", failedRow.status === "failed" && failedRow.error!.startsWith("bad x") && failedRow.error!.length <= 2_000, `${failedRow.status} ${failedRow.error?.length}`);

    // ---------------------------------------------------------- (b) the database refuses the result
    const refused = await newJob();
    calls = 0;
    step = async () => ({ next: "stage", stage: "launching", payload: { lost: true }, progress: { stage: "launching", e2eRefuse: true } });
    const states: string[] = [];
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await due(refused.id);
      await runOneAssistantStep({ jobId: refused.id });
      const row = await read(refused.id);
      states.push(row.status);
      if (attempt === 1) {
        const shown = jobState(row, new Date());
        check("(b) a refused result puts the job back to run again, shown as Retrying with the reason", row.status === "queued" && shown.state === "retrying" && /^Its result could not be saved: .*refused by the recovery check/.test(shown.reason ?? ""), `${row.status} ${shown.state} ${shown.reason}`);
        check("…after a backoff, with the attempt counted", row.runAfter.getTime() > Date.now() + 5_000 && row.attempts === 1 && row.lockedBy === null, `${row.runAfter.toISOString()} attempts ${row.attempts}`);
      }
    }
    const gaveUp = await read(refused.id);
    check("(b) after five refused saves the job fails instead of retrying forever", gaveUp.status === "failed" && states.join(",") === "queued,queued,queued,queued,failed", states.join(","));
    check("…with an error that says why and that earlier work is kept", /^Stopped: its result could not be saved after 5 attempts \(.*refused by the recovery check.*\)\. Work saved before this step is kept\.$/.test(gaveUp.error ?? ""), gaveUp.error ?? "");
    check("…the step ran five times, not more", calls === 5, String(calls));
    check("…nothing of the refused results was kept: payload and stage as the earlier step saved them", JSON.stringify(gaveUp.payload) === JSON.stringify({ saved: "by an earlier step" }) && gaveUp.stage === "personalizing", `${gaveUp.stage} ${JSON.stringify(gaveUp.payload)}`);
    check("…and Activity shows it failed", jobState(gaveUp, new Date()).state === "failed");
    await due(refused.id);
    check("…a finished job is not claimed again", !(await runOneAssistantStep({ jobId: refused.id })) && calls === 5);
    await reportFinishedJob(gaveUp);
    const posted = (await reports(thread.id)).filter((text) => text.includes("could not be saved after 5 attempts"));
    check("(b) one report in the chat, however often it is asked for, naming the reason", posted.length === 1 && /^Starting the outreach failed: Stopped: its result could not be saved/.test(posted[0]!), posted.join(" | "));

    // ---------------------------------------------------------- (b) a result that cannot be written at all
    const unwritable = await newJob();
    calls = 0;
    step = async () => (calls === 1 ? { next: "done", result: { count: BigInt(3) as unknown as number } } : { next: "done", result: { count: 3 } });
    await runOneAssistantStep({ jobId: unwritable.id });
    const afterBigint = await read(unwritable.id);
    check("(b) a result that cannot be written (a BigInt) retries with the reason, it is not left running", afterBigint.status === "queued" && /^Its result could not be saved: .*BigInt/i.test(String(afterBigint.progress.lastError)), `${afterBigint.status} ${String(afterBigint.progress.lastError)}`);
    await due(unwritable.id);
    await runOneAssistantStep({ jobId: unwritable.id });
    const recovered = await read(unwritable.id);
    check("…and finishes once the step returns something saveable, the retry note gone", recovered.status === "succeeded" && recovered.result?.count === 3 && !("lastError" in recovered.progress), `${recovered.status} ${JSON.stringify(recovered.progress)}`);

    // ---------------------------------------------------------- (c) claimed again and again, never finishing
    const stale = new Date(Date.now() - 10 * 60_000);
    const dead = await newJob({ status: "running", lockedBy: "a-worker-that-stopped", heartbeatAt: stale, attempts: 7 });
    calls = 0;
    step = async () => ({ next: "done", result: {} });
    await runOneAssistantStep({ jobId: dead.id });
    const ceiling = await read(dead.id);
    check("(c) a job picked up 7 times without its step finishing fails at the next claim, without running the step", ceiling.status === "failed" && calls === 0 && /^Stopped: it was picked up 7 times without its step finishing/.test(ceiling.error ?? ""), `${ceiling.status} calls ${calls} ${ceiling.error}`);
    check("…its payload and stage untouched", ceiling.stage === "personalizing" && ceiling.payload.saved === "by an earlier step");
    const ceilingReports = (await reports(thread.id)).filter((text) => text.includes("picked up 7 times"));
    check("…and one report says so", ceilingReports.length === 1, ceilingReports.join(" | "));

    const nearly = await newJob({ status: "running", lockedBy: "a-worker-that-stopped", heartbeatAt: stale, attempts: 6 });
    await runOneAssistantStep({ jobId: nearly.id });
    const ranOnce = await read(nearly.id);
    check("(c) one claim below the ceiling still runs its step and finishes", ranOnce.status === "succeeded" && calls === 1, `${ranOnce.status} calls ${calls}`);

    // ---------------------------------------------------------- a step that throws still retries, then fails
    const throwing = await newJob();
    calls = 0;
    step = async () => { throw new Error("socket hang up\u0000"); };
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      await due(throwing.id);
      await runOneAssistantStep({ jobId: throwing.id });
    }
    const thrown = await read(throwing.id);
    check("a step that throws retries with its error, then fails after five tries", thrown.status === "failed" && calls === 5 && thrown.error === "socket hang up", `${thrown.status} calls ${calls} ${thrown.error}`);
  });
} finally {
  await db.execute(sql.raw("drop trigger if exists e2e_refuse_marked_job on assistant_jobs; drop function if exists e2e_refuse_marked_job();"));
}

console.log(failures ? `\n${failures} check(s) failed` : "\nAll worker recovery checks passed");
process.exit(failures ? 1 : 0);
