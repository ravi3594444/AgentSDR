import "server-only";

import { and, eq, sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { runDiscoveryStep, sourceLabel } from "@/lib/discovery/discovery.server";
import { runWebDiscoveryStep } from "@/lib/discovery/webDiscovery.server";
import { inOrg } from "@/lib/tenancy/scope";
import { continueAfterEvent, runToolInThread } from "./agent.server";
import { coverageLineForJob } from "./coverage.server";
import { autoStartPlan, threadAutonomy } from "./autonomy.server";
import { runLinkedinSearchStep } from "./linkedinSearch.server";
import { failObjective, nudgeObjective, objectiveForJob, objectiveHold, postObjectiveReport } from "./objective.server";
import { runObjectiveStep } from "./objectiveDriver.server";
import { runOutreachStartStep } from "./outreach.server";
import { applyRequestApproval } from "./requestApproval.server";
import { assistantJobs } from "./schema";
import { addMessage, claimThread, releaseThread, touchThread } from "./threads.server";
import { claimJobReport, followUpDue, onAssistantJobFinished, registerAssistantJobHandler, type AssistantJob, type StepHandler } from "./worker";

/**
 * Wires the assistant's background jobs to the worker, and reports each
 * finished job into its chat thread as an EVENT the owner reads and the
 * model sees. The wording is built from the job's own result, never by the
 * model, so it says exactly what happened, and covers that job only: one
 * search finishing never says the whole request is done (the coverage line
 * says what of the request is still open). Each report is posted once,
 * with the job marked reported in the same transaction; a report a restart
 * lost is posted by the worker's reconciliation, with what follows it, and
 * so is the plan a "find and contact" search promised when a restart came
 * after its report (owed from the report's commit, see followUpDue).
 *
 * A search of a request pursued as an objective (objective.server.ts) wakes
 * that objective's driver when it finishes, and leaves continuing the
 * request to it: the driver resumes the turn once the request's searches are
 * done and its target is not met, and posts the request's one final report.
 * A search of a paused request waits before it starts; one of a stopped
 * request ends as not searched.
 */

/** A finished website and directory search, from its result. */
function webDiscoveryMessage(job: AssistantJob): string {
  if (job.status === "failed") return `The web search for leads failed: ${job.error ?? "unknown error"}`;
  const result = (job.result ?? {}) as Record<string, unknown>;
  const found = Number(result.found ?? 0);
  if (!found) return String(result.note ?? "The web search found no businesses.");
  const count = (key: string) => Number(result[key] ?? 0);
  const extra: string[] = [];
  if (count("excluded")) extra.push(`${count("excluded")} left out with the reason recorded`);
  if (count("instagramOnly")) extra.push(`${count("instagramOnly")} of them reachable only on Instagram (a connected sender and approved DM plan are required)`);
  if (count("needSignals")) extra.push(`${count("needSignals")} asked for something like this in their own words`);
  if (count("alreadyKnown")) extra.push(`${count("alreadyKnown")} already in your leads (reused, not duplicated)`);
  if (count("duplicates")) extra.push(`${count("duplicates")} duplicates skipped`);
  const cost = typeof result.costUsd === "number" ? ` Search cost $${result.costUsd.toFixed(4)}.` : "";
  return `The web search for “${String(result.phrase ?? "")}” finished: ${found} found on business websites, directories and public pages, ${count("eligible")} can be contacted (${count("withEmail")} by email, ${count("withPhoneOnly")} by phone only, ${count("withInstagram")} with Instagram profiles)${extra.length ? `; ${extra.join(", ")}` : ""}.${result.note ? ` ${String(result.note)}` : ""}${cost}`;
}

/** A finished Instagram prospect search (Apify): who was found, and who can actually be contacted. */
function instagramProspectMessage(job: AssistantJob): string {
  if (job.status === "failed") return `The Instagram prospect search failed: ${job.error ?? "unknown error"}`;
  const result = (job.result ?? {}) as Record<string, unknown>;
  const found = Number(result.found ?? 0);
  const providerNote = typeof result.providerNote === "string" && result.providerNote ? ` ${result.providerNote}` : "";
  if (!found) return `${String(result.note ?? "The Instagram prospect search found no accounts.")}${providerNote}`;
  const count = (key: string) => Number(result[key] ?? 0);
  return `The Instagram prospect search for ${String(result.phrase ?? "")} (through Apify) finished: ${found} accounts found — potential matches, not interested customers. ${count("eligible")} have a contact route for an approved plan (${count("withEmail")} by email, ${count("withPhoneOnly")} by phone only, ${count("withInstagram")} with Instagram profiles); ${count("excluded")} were left out with the reason recorded${count("duplicates") ? `; ${count("duplicates")} duplicates skipped` : ""}.${providerNote}`;
}

function discoveryMessage(job: AssistantJob): string {
  if (job.kind === "web_discovery") return webDiscoveryMessage(job);
  if (job.kind === "apify_instagram") return instagramProspectMessage(job);
  if (job.status === "failed") return `The lead search failed: ${job.error ?? "unknown error"}`;
  const result = (job.result ?? {}) as Record<string, unknown>;
  const found = Number(result.found ?? 0);
  const providerNote = typeof result.providerNote === "string" && result.providerNote ? ` ${result.providerNote}` : "";
  if (!found) return `${String(result.note ?? "The lead search found no businesses.")}${result.note ? "" : providerNote}`;
  const eligible = Number(result.eligible ?? 0);
  const payload = (job.payload ?? {}) as { target?: "maps" | "facebook" | "linkedin"; provider?: "apify" | "scraper" };
  const target = result.target === "facebook" || result.target === "linkedin" ? result.target : payload.target === "facebook" || payload.target === "linkedin" ? payload.target : "maps";
  const source = sourceLabel(target, (result.provider === "apify" || result.provider === "scraper" ? result.provider : payload.provider) ?? null);
  const parts = [
    job.kind === "linkedin_search"
      ? `The LinkedIn search for “${String(result.phrase ?? "")}” finished: ${found} profiles found, ${eligible} can be contacted on LinkedIn`
      : `The lead search for “${String(result.phrase ?? "")}” finished: ${found} businesses found on ${source}, ${eligible} can be contacted`,
    job.kind === "linkedin_search" ? "" : `(${Number(result.withEmail ?? 0)} by email, ${Number(result.withPhoneOnly ?? 0)} by phone only)`,
  ];
  const extra: string[] = [];
  if (Number(result.excluded ?? 0)) extra.push(`${Number(result.excluded)} left out with the reason recorded`);
  if (Number(result.duplicates ?? 0)) extra.push(`${Number(result.duplicates)} duplicates skipped`);
  return `${parts.filter(Boolean).join(" ")}${extra.length ? `; ${extra.join(", ")}` : ""}.${providerNote}`;
}

function outreachMessage(job: AssistantJob): string {
  if (job.status === "failed") return `Starting the outreach failed: ${job.error ?? "unknown error"}`;
  const result = (job.result ?? {}) as { launches?: { channel: string; added: number; skipped: number; problem: string | null }[]; autopilot?: boolean };
  const lines = (result.launches ?? []).map((launch) => launch.problem
    ? `${launch.channel}: not started — ${launch.problem}`
    : `${launch.channel}: started with ${launch.added} leads${launch.skipped ? ` (${launch.skipped} skipped)` : ""}`);
  return `Outreach started. ${lines.join("; ")}.${result.autopilot ? " Ordinary replies will be answered automatically; anything unusual waits for you in Action required." : " Replies wait for you in Action required."} Messages go out within each channel's sending hours and daily limits.`;
}

let registered = false;

/** A search's steps, held before its first stage while its request is paused (or ended when it stopped). */
function held(handler: StepHandler): StepHandler {
  return async (job, heartbeat) => (await objectiveHold(job)) ?? handler(job, heartbeat);
}

export function registerAssistantJobs(): void {
  if (registered) return;
  registered = true;
  registerAssistantJobHandler("discovery", held(runDiscoveryStep));
  registerAssistantJobHandler("outreach_start", runOutreachStartStep);
  registerAssistantJobHandler("linkedin_search", held(runLinkedinSearchStep));
  registerAssistantJobHandler("web_discovery", held(runWebDiscoveryStep));
  // Instagram prospects through Apify run on the discovery job's stages (discovery.server.ts).
  registerAssistantJobHandler("apify_instagram", held(runDiscoveryStep));
  registerAssistantJobHandler("objective", runObjectiveStep);
  onAssistantJobFinished(reportFinishedJob);
}

type ContactAfter = { channels: string[] | null; ownerRequest?: string; requestId?: string };

/** The job's progress with `followUp` set (and, while preparing, its lease time), keeping the rest. */
function followUpPatch(state: "owed" | "preparing" | "done"): SQL {
  return state === "preparing"
    ? sql`${assistantJobs.progress} || jsonb_build_object('followUp', 'preparing', 'followUpAt', now())`
    : sql`${assistantJobs.progress} || jsonb_build_object('followUp', ${state}::text)`;
}

/** Takes the job's follow-up under a lease: false when it is not owed, is done, or another process holds it. */
async function takeFollowUp(job: AssistantJob): Promise<boolean> {
  const taken = await db.update(assistantJobs).set({ progress: followUpPatch("preparing") })
    .where(and(inOrg(assistantJobs), eq(assistantJobs.id, job.id), followUpDue()))
    .returning({ id: assistantJobs.id });
  return taken.length > 0;
}

async function renewFollowUp(job: AssistantJob): Promise<void> {
  await db.update(assistantJobs).set({ progress: followUpPatch("preparing") })
    .where(and(inOrg(assistantJobs), eq(assistantJobs.id, job.id), sql`${assistantJobs.progress} ->> 'followUp' = 'preparing'`));
}

async function finishFollowUp(job: AssistantJob): Promise<void> {
  await db.update(assistantJobs).set({ progress: followUpPatch("done") }).where(and(inOrg(assistantJobs), eq(assistantJobs.id, job.id)));
}

/**
 * A finished job's report in its chat, then what follows it (the plan a
 * "find and contact" search asked for, or the next step in Autonomous
 * mode). Posted at most once per job, however often it is called: a
 * duplicate callback, or the worker's reconciliation after a restart,
 * finds it reported and posts nothing. The promised plan is recorded as
 * owed in the report's own commit, so a restart before it is made hands
 * the job back (worker.ts followUpDue) and the plan is still prepared,
 * once.
 */
export async function reportFinishedJob(job: AssistantJob): Promise<void> {
  if (job.kind === "objective") {
    // The driver's outcome is the objective's report, posted under the objective's own key; its job owes nothing more.
    await claimJobReport(job, async () => undefined);
    const objectiveId = typeof job.payload.objectiveId === "string" ? job.payload.objectiveId : null;
    if (objectiveId) {
      if (job.status === "failed") await failObjective(objectiveId, job.error ?? "unknown error");
      else await postObjectiveReport(objectiveId);
    }
    return;
  }
  if (!job.threadId) {
    await claimJobReport(job, async () => undefined);
    return;
  }
  const threadId = job.threadId;
  const search = job.kind === "discovery" || job.kind === "linkedin_search" || job.kind === "web_discovery" || job.kind === "apify_instagram";
  const found = search && job.status === "succeeded" && Boolean(job.audienceId) && Number((job.result ?? {}).eligible ?? 0) > 0;
  // The owner asked to contact what is found: the plan is prepared here,
  // not left to the model's judgement. It still waits for the owner's Start.
  const contactAfter = found ? (job.payload as { contactAfter?: ContactAfter | null }).contactAfter ?? null : null;
  const coverage = search ? await coverageLineForJob(job).catch(() => null) : null;
  // The request this search serves, when it is pursued as an objective: its driver continues it, not this report.
  const objective = search ? await objectiveForJob(job).catch(() => null) : null;
  const content = `${search ? discoveryMessage(job) : outreachMessage(job)}${coverage ? ` ${coverage}` : ""}`;
  const posted = await claimJobReport(job, async (tx) => {
    await addMessage({ threadId, role: "event", content, toolResult: { reportKey: job.reportKey } }, tx);
    if (contactAfter) await tx.update(assistantJobs).set({ progress: followUpPatch("owed") }).where(and(inOrg(assistantJobs), eq(assistantJobs.id, job.id)));
  });
  if (objective) await nudgeObjective(objective.id).catch((error) => console.error("[assistant] waking a request's objective failed:", error));
  const driven = Boolean(objective);
  if (!posted) {
    // Reported already (a duplicate callback, or the reconciliation): what follows it runs only while it
    // is still owed and nobody is working on it (followUpSearch takes it), so at most once.
    if (contactAfter) void followUpSearch(job, threadId, contactAfter, driven);
    return;
  }
  if (search && !found) {
    // Autonomous mode: a search that failed or found nobody still wakes the assistant, to try elsewhere
    // (an objective's driver does that for its own request, once its searches are done).
    if (!driven && (await threadAutonomy(job.threadId)).on) void continueAfterEvent(job.threadId);
    return;
  }
  if (!search || job.status !== "succeeded" || !job.audienceId) return;
  if (driven && !contactAfter) return;
  // Not awaited: writing the plan takes model calls, and the worker moves on.
  void followUpSearch(job, job.threadId, contactAfter, driven);
}

/** `driven`: the search serves an objective, whose driver continues the request afterwards (not this follow-up). */
async function followUpSearch(job: AssistantJob, threadId: string, contactAfter: ContactAfter | null, driven = false): Promise<void> {
  try {
    // The promised plan is taken under a lease: made once, and a restart part-way leaves it to the reconciliation.
    if (contactAfter && !(await takeFollowUp(job))) return;
    let autonomous = (await threadAutonomy(threadId)).on;
    if (contactAfter) {
      // The lease is renewed while waiting for the chat and writing the plan; a stop leaves it to go stale.
      const lease = setInterval(() => void renewFollowUp(job).catch(() => undefined), 60_000);
      let prepared;
      try {
        // Wait for a turn in progress to end, so the plan is made once.
        let claimed = false;
        for (let attempt = 0; attempt < 60 && !claimed; attempt += 1) {
          claimed = await claimThread(threadId);
          if (!claimed) await new Promise((resolve) => setTimeout(resolve, 2_000));
        }
        // Writing a plan can take minutes: keep the claim fresh meanwhile.
        const heartbeat = claimed ? setInterval(() => void touchThread(threadId).catch(() => undefined), 60_000) : null;
        // The switch as it is now, after the wait.
        autonomous = (await threadAutonomy(threadId)).on;
        // Made or refused, it is no longer owed (recorded before the chat is released, so whoever takes it next sees it done).
        let finished = false;
        const finish = async () => {
          if (finished) return;
          finished = true;
          await finishFollowUp(job).catch((error) => console.error("[assistant] recording a search's follow-up as done failed:", error));
        };
        try {
          prepared = await runToolInThread(
            { threadId, userId: job.createdBy, ownerText: contactAfter.ownerRequest ?? "", authorizedBy: "search", outreachRequestId: contactAfter.requestId ?? null, autonomous },
            "prepare_outreach",
            { audienceId: job.audienceId, ownerRequest: contactAfter.ownerRequest ?? null, ...(contactAfter.channels?.length ? { channels: contactAfter.channels } : {}), ...(autonomous ? { autopilot: true } : {}) },
          );
          // Done as soon as the plan is written: a stop during what follows (the start, the approval, the event)
          // must not leave it owed, or the reconciliation would prepare a second plan.
          await finish();
          if (prepared.ok) {
            const runId = typeof prepared.data?.runId === "string" ? prepared.data.runId : null;
            // Autonomous mode: every start goes through the capped path (autoStartPlan posts why one waits).
            const tried = autonomous && runId ? await autoStartPlan(threadId, runId) : null;
            // Switched off at the last moment: treated as without Autonomous mode.
            const auto = tried && !tried.off ? tried : null;
            // Otherwise it starts on its own when the owner already approved this request on another of its plans.
            const approval: { started: boolean; reason: string | null; closed?: boolean } = auto
              ? { started: auto.started, reason: auto.reason, closed: auto.closed }
              : runId ? await applyRequestApproval(runId) : { started: false, reason: null };
            // A reason from autoStartPlan was already posted; with none (switched off meanwhile) the plan waits as usual.
            // A plan closed for having nobody new to contact was reported as such: it is not offered for Start.
            if (!approval.started && !approval.closed && !(auto && auto.reason)) {
              await addMessage({
                threadId,
                role: "event",
                content: approval.reason
                  ? `The outreach plan for these leads is ready below. It was not started with the rest of your request because ${approval.reason}: check it and press Start. Nothing is sent before that.`
                  : "The outreach plan for these leads is ready below. Check the audience, the sample messages and the limits, then press Start. Nothing is sent before that.",
              });
            }
          }
        } finally {
          if (heartbeat) clearInterval(heartbeat);
          // Also when writing the plan failed.
          await finish();
          if (claimed) await releaseThread(threadId);
        }
      } finally {
        clearInterval(lease);
      }
      // Autonomous mode keeps working toward the owner's goal (the next search, a report); otherwise the plan waits.
      if (prepared.ok && !autonomous) return;
    }
    // The objective's driver continues its request once the plan is made (it waits for owed plans).
    if (driven) return;
    // Otherwise (or when the plan could not be made) the assistant picks up where the owner left it.
    await continueAfterEvent(threadId);
  } catch (error) {
    console.error("[assistant] following up a finished search failed:", error);
  }
}
