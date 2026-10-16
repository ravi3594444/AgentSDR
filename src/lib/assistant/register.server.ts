import "server-only";

import { runDiscoveryStep } from "@/lib/discovery/discovery.server";
import { runWebDiscoveryStep } from "@/lib/discovery/webDiscovery.server";
import { continueAfterEvent, runToolInThread } from "./agent.server";
import { runLinkedinSearchStep } from "./linkedinSearch.server";
import { runOutreachStartStep } from "./outreach.server";
import { addMessage, claimThread, releaseThread } from "./threads.server";
import { onAssistantJobFinished, registerAssistantJobHandler, type AssistantJob } from "./worker";

/**
 * Wires the assistant's background jobs to the worker, and reports each
 * finished job into its chat thread as an EVENT the owner reads and the
 * model sees. The wording is built from the job's own result, never by the
 * model, so it says exactly what happened.
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
  if (count("instagramOnly")) extra.push(`${count("instagramOnly")} of them reachable only on Instagram (open their post or profile to reply yourself)`);
  if (count("needSignals")) extra.push(`${count("needSignals")} asked for something like this in their own words`);
  if (count("alreadyKnown")) extra.push(`${count("alreadyKnown")} already in your leads (reused, not duplicated)`);
  if (count("duplicates")) extra.push(`${count("duplicates")} duplicates skipped`);
  const cost = typeof result.costUsd === "number" ? ` Search cost $${result.costUsd.toFixed(4)}.` : "";
  return `The web search for “${String(result.phrase ?? "")}” finished: ${found} found on business websites, directories and public pages, ${count("eligible")} can be contacted (${count("withEmail")} by email, ${count("withPhoneOnly")} by phone only)${extra.length ? `; ${extra.join(", ")}` : ""}.${result.note ? ` ${String(result.note)}` : ""}${cost}`;
}

function discoveryMessage(job: AssistantJob): string {
  if (job.kind === "web_discovery") return webDiscoveryMessage(job);
  if (job.status === "failed") return `The lead search failed: ${job.error ?? "unknown error"}`;
  const result = (job.result ?? {}) as Record<string, unknown>;
  const found = Number(result.found ?? 0);
  if (!found) return String(result.note ?? "The lead search found no businesses.");
  const eligible = Number(result.eligible ?? 0);
  const parts = [
    job.kind === "linkedin_search"
      ? `The LinkedIn search for “${String(result.phrase ?? "")}” finished: ${found} profiles found, ${eligible} can be contacted on LinkedIn`
      : `The lead search for “${String(result.phrase ?? "")}” finished: ${found} businesses found on Google Maps, ${eligible} can be contacted`,
    job.kind === "linkedin_search" ? "" : `(${Number(result.withEmail ?? 0)} by email, ${Number(result.withPhoneOnly ?? 0)} by phone only)`,
  ];
  const extra: string[] = [];
  if (Number(result.excluded ?? 0)) extra.push(`${Number(result.excluded)} left out with the reason recorded`);
  if (Number(result.duplicates ?? 0)) extra.push(`${Number(result.duplicates)} duplicates skipped`);
  return `${parts.filter(Boolean).join(" ")}${extra.length ? `; ${extra.join(", ")}` : ""}.`;
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

export function registerAssistantJobs(): void {
  if (registered) return;
  registered = true;
  registerAssistantJobHandler("discovery", runDiscoveryStep);
  registerAssistantJobHandler("outreach_start", runOutreachStartStep);
  registerAssistantJobHandler("linkedin_search", runLinkedinSearchStep);
  registerAssistantJobHandler("web_discovery", runWebDiscoveryStep);
  onAssistantJobFinished(async (job) => {
    if (!job.threadId) return;
    const search = job.kind === "discovery" || job.kind === "linkedin_search" || job.kind === "web_discovery";
    const content = search ? discoveryMessage(job) : outreachMessage(job);
    await addMessage({ threadId: job.threadId, role: "event", content });
    if (!search || job.status !== "succeeded" || !job.audienceId || Number((job.result ?? {}).eligible ?? 0) <= 0) return;
    // The owner asked to contact what is found: the plan is prepared here,
    // not left to the model's judgement. It still waits for the owner's Start.
    const contactAfter = (job.payload as { contactAfter?: { channels: string[] | null; ownerRequest?: string } | null }).contactAfter;
    // Not awaited: writing the plan takes model calls, and the worker moves on.
    void followUpSearch(job, job.threadId, contactAfter ?? null);
  });
}

async function followUpSearch(job: AssistantJob, threadId: string, contactAfter: { channels: string[] | null; ownerRequest?: string } | null): Promise<void> {
  try {
    if (contactAfter) {
      // Wait for a turn in progress to end, so the plan is made once.
      let claimed = false;
      for (let attempt = 0; attempt < 60 && !claimed; attempt += 1) {
        claimed = await claimThread(threadId);
        if (!claimed) await new Promise((resolve) => setTimeout(resolve, 2_000));
      }
      let prepared;
      try {
        prepared = await runToolInThread(
          { threadId, userId: job.createdBy, ownerText: contactAfter.ownerRequest ?? "", authorizedBy: "search" },
          "prepare_outreach",
          { audienceId: job.audienceId, ownerRequest: contactAfter.ownerRequest ?? null, ...(contactAfter.channels?.length ? { channels: contactAfter.channels } : {}) },
        );
        if (prepared.ok) {
          await addMessage({ threadId, role: "event", content: "The outreach plan for these leads is ready below. Check the audience, the sample messages and the limits, then press Start. Nothing is sent before that." });
        }
      } finally {
        if (claimed) await releaseThread(threadId);
      }
      if (prepared.ok) return;
    }
    // Otherwise (or when the plan could not be made) the assistant picks up where the owner left it.
    await continueAfterEvent(threadId);
  } catch (error) {
    console.error("[assistant] following up a finished search failed:", error);
  }
}
