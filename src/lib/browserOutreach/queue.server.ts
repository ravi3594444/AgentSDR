import "server-only";

import { and, count, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { outreachRuns } from "@/lib/assistant/schema";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";
import { browserChannelStatus } from "./availability.server";
import { MESSAGING_SITE_NAMES, type MessagingSite } from "./routes";
import { browserRoutesFor, recordRoute, type BrowserRoute } from "./routes.server";
import { browserOutreachSends } from "./schema";

type RunRow = typeof outreachRuns.$inferSelect;

/** The route a lead's messages go to: on a site the plan allows, a checked one first. */
export function chooseRoute(routes: readonly BrowserRoute[], allowed: readonly MessagingSite[]): BrowserRoute | null {
  const usable = routes.filter((route) => allowed.includes(route.site));
  return usable.find((route) => route.state === "messageable") ?? usable[0] ?? null;
}

/**
 * At Start (the approved launch only; nothing is sent here): each browser
 * lead's messages become rows of the send queue, its first due now and each
 * follow-up waiting for the one before it. The browser that sends is the
 * approver's when they have one paired, otherwise the workspace's.
 */
export async function queueBrowserOutreach(run: RunRow, leads: { personId: string; bodies: string[]; waits: number[] }[]): Promise<{ added: number; problem: string | null }> {
  if (run.status !== "starting" || !run.approvedAt || !run.approvedBy || !run.channels.includes("browser")) return { added: 0, problem: "this plan has not been approved for launch" };
  const allowed = new Set(run.plan.assignments.filter((row) => row.channel === "browser").map((row) => row.personId));
  if (leads.some((lead) => !allowed.has(lead.personId))) return { added: 0, problem: "a browser recipient is outside the approved plan" };
  const approver = await browserChannelStatus(run.approvedBy);
  const sender = approver.available ? approver : await browserChannelStatus(null);
  if (!sender.available || !sender.userId) return { added: 0, problem: sender.reason ?? "no browser is connected" };
  const sites = run.plan.browserSites?.length ? run.plan.browserSites.filter((site) => sender.sites.includes(site)) : sender.sites;
  if (!sites.length) return { added: 0, problem: `the sending browser's website access does not cover ${(run.plan.browserSites ?? []).map((site) => MESSAGING_SITE_NAMES[site]).join(" or ")}` };
  const routes = await browserRoutesFor(leads.map((lead) => lead.personId));
  let added = 0;
  const skipped: string[] = [];
  for (const lead of leads) {
    const chosen = chooseRoute(routes.get(lead.personId) ?? [], sites);
    if (!chosen || !lead.bodies[0]?.trim()) {
      skipped.push(chosen ? "an empty first message" : "no profile on a site the browser may use");
      continue;
    }
    const route = chosen.id ? { id: chosen.id } : await recordRoute(lead.personId, chosen, null);
    if (!route) {
      skipped.push("their profile is recorded for someone else in this workspace");
      continue;
    }
    const rows = lead.bodies.map((body, step) => ({
      organizationId: currentOrganizationId(),
      runId: run.id,
      personId: lead.personId,
      routeId: route.id,
      userId: sender.userId!,
      kind: "step" as const,
      step,
      body: body.trim(),
      status: step === 0 ? "queued" as const : "waiting" as const,
      waitReason: step === 0 ? null : `follows ${lead.waits[step] ?? 0} day${lead.waits[step] === 1 ? "" : "s"} after the previous message, if they have not replied`,
    })).filter((row) => row.body);
    const inserted = await db.insert(browserOutreachSends).values(rows).onConflictDoNothing().returning({ step: browserOutreachSends.step });
    if (inserted.some((row) => row.step === 0)) added += 1;
  }
  const problem = added ? null : `no lead could be queued (${[...new Set(skipped)].join("; ") || "none was given"})`;
  return { added, problem };
}

/** Nothing more goes out for these: queued and waiting messages are cancelled with the reason. A message being sent finishes or is recorded uncertain. */
export async function cancelBrowserSends(input: { runId?: string; personId?: string; reason: string }): Promise<number> {
  if (!input.runId && !input.personId) return 0;
  const cancelled = await db.update(browserOutreachSends).set({ status: "cancelled", error: input.reason, waitReason: null, nextCheckAt: null, updatedAt: new Date() })
    .where(and(
      inOrg(browserOutreachSends),
      input.runId ? eq(browserOutreachSends.runId, input.runId) : undefined,
      input.personId ? eq(browserOutreachSends.personId, input.personId) : undefined,
      inArray(browserOutreachSends.status, ["queued", "waiting"]),
    )).returning({ id: browserOutreachSends.id });
  return cancelled.length;
}

/** What a run's browser messages have done, from the queue's own rows (reportRun). */
export async function browserRunReport(runId: string): Promise<{ contacted: number; messagesSent: number; replied: number; finished: number; stopped: number; failed: number }> {
  const statuses = await db.select({ status: browserOutreachSends.status, step: browserOutreachSends.step, n: count() }).from(browserOutreachSends)
    .where(and(inOrg(browserOutreachSends), eq(browserOutreachSends.runId, runId))).groupBy(browserOutreachSends.status, browserOutreachSends.step);
  const by = (names: string[], first = false) => statuses.filter((row) => names.includes(row.status) && (!first || row.step === 0)).reduce((sum, row) => sum + Number(row.n), 0);
  const [people] = await db.execute<{ replied: number; finished: number }>(sql`select
      (select count(distinct s.person_id)::int from browser_outreach_sends s
        join crm_conversation_messages m on m.person_id = s.person_id and m.channel = 'browser' and m.direction = 'inbound' and m.sent_at >= s.created_at
        where s.organization_id = ${currentOrganizationId()} and s.run_id = ${runId} and s.step = 0) as replied,
      (select count(*)::int from browser_outreach_sends f
        where f.organization_id = ${currentOrganizationId()} and f.run_id = ${runId} and f.step = 0 and f.status = 'sent'
          and not exists (select 1 from browser_outreach_sends o where o.run_id = f.run_id and o.person_id = f.person_id and o.status in ('queued', 'waiting', 'sending'))) as finished`);
  return {
    contacted: by(["sent"], true),
    messagesSent: by(["sent"]),
    replied: Number(people?.replied ?? 0),
    finished: Number(people?.finished ?? 0),
    stopped: by(["failed", "uncertain", "blocked", "cancelled"], true),
    failed: by(["failed", "uncertain", "blocked"], true),
  };
}
