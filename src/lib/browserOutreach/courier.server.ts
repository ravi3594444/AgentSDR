import "server-only";

import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { completeStructured } from "@/lib/ai/server/structuredCompletion";
import { recordUsage } from "@/lib/assistant/usage.server";
import { outreachRuns } from "@/lib/assistant/schema";
import { BrowserConnectionError, browserConnection, releaseBrowserTabs, runBrowserAction } from "@/lib/browser/connected/connections.server";
import { BROWSER_TASK_MIN_VERSION, type BrowserResearchAction, type BrowserResearchResult, type ResearchSiteKey, type ResearchSnapshot } from "@/lib/browser/connected/contract";
import { formatResearchSnapshot } from "@/lib/browser/connected/format";
import { isOlderVersion } from "@/lib/calls/recorderRelease";
import { channelRules } from "@/lib/channels/rules.server";
import { newLeadAllowance, recordNewLead, releaseNewLead } from "@/lib/channels/dailyLeadLimit.server";
import { isMissingTable } from "@/lib/features/flags.server";
import { crmPersonContactPolicies } from "@/lib/crm/schema";
import { people } from "@/lib/leads/schema";
import { isMigrationControlPaused } from "@/lib/migration/controls";
import { currentOrganizationId, inOrg, runInOrganization } from "@/lib/tenancy/scope";
import {
  accountOnPage, COURIER_MAX_STEPS, COURIER_PROMPT, COURIER_SCHEMA, courierStepPrompt, courierStepVerdict, messageOnPage,
  type CourierOutcome, type CourierStep,
} from "./courier";
import { recordBrowserOutboundInCrm } from "./crm.server";
import { MESSAGING_SITE_NAMES, type MessagingSite } from "./routes";
import { browserOutreachReady, setRouteState } from "./routes.server";
import { browserContactRoutes, browserOutreachSends, browserSenderAccounts, type CourierLogEntry } from "./schema";

/**
 * The browser courier: delivers queued browser messages (queue.server.ts)
 * through each sender's own connected Chrome, one at a time per browser.
 * An in-process tick like the Instagram sender, production only,
 * PAUSE_BROWSER_OUTBOUND. Every send is claimed under the browser's lock,
 * within its Sending rules ("browser"), the daily new-lead limit and Do Not
 * Contact, with the run still running and approved. A send whose answer was
 * lost, or whose text the page did not show afterwards, is "uncertain" and
 * never sent again. When it cannot send yet, the row says why
 * (`wait_reason`) and when it is looked at again: Chrome offline, stopped,
 * a sign-in only the owner can do, the pacing, the day's allowance.
 */

const CLAIM_MS = 15 * 60_000;
const OPEN_MS = 45_000;
const STEP_MS = 30_000;
const MINUTE = 60_000;

type SendRow = typeof browserOutreachSends.$inferSelect;
type RouteRow = typeof browserContactRoutes.$inferSelect;

type Delivery = {
  outcome: "sent" | "blocked" | "wait" | "uncertain" | "failed";
  detail: string;
  account: string | null;
  threadUrl: string | null;
  routeState?: "messageable" | "not_messageable" | "not_found";
  retryInMs?: number;
};

function minutesFromNow(ms: number): Date {
  return new Date(Date.now() + ms);
}

const clock = (at: Date) => at.toISOString().slice(11, 16) + " UTC";

/** Why `userId`'s browser cannot send right now, and when to look again; null when it can. */
async function browserWait(userId: string, site: MessagingSite): Promise<{ reason: string; retryInMs: number } | null> {
  const { row, state } = await browserConnection(userId);
  if (!row) return { reason: "the sender's browser is no longer connected to this workspace: connect it again from the chat (Connect browser)", retryInMs: 30 * MINUTE };
  if (!row.extensionVersion || isOlderVersion(row.extensionVersion, BROWSER_TASK_MIN_VERSION)) {
    return { reason: `the 22nd x ai Browser Assistant (${row.extensionVersion ?? "unknown version"}) is older than ${BROWSER_TASK_MIN_VERSION}: update it from Settings → WhatsApp → Integrations`, retryInMs: 30 * MINUTE };
  }
  if (!(row.sites as ResearchSiteKey[]).includes(site)) return { reason: `the browser's website access does not include ${MESSAGING_SITE_NAMES[site]}: change it from the extension's popup`, retryInMs: 30 * MINUTE };
  if (state === "offline") return { reason: `Chrome is offline (${row.lastSeenAt ? `last seen ${clock(row.lastSeenAt)}` : "never seen"}); it sends when the browser is back`, retryInMs: 2 * MINUTE };
  if (state === "paused") return { reason: "the owner pressed Stop in the 22nd x ai Browser Assistant; it sends after Resume", retryInMs: 2 * MINUTE };
  if (state === "needs_attention") return { reason: `the browser needs the owner: ${row.attention?.detail ?? "a sign-in or a check"}`, retryInMs: 5 * MINUTE };
  return null;
}

/** The courier's pacing and daily allowance for this browser and site; null when a send may start now. */
async function pacingWait(send: SendRow, site: MessagingSite): Promise<{ reason: string; retryInMs: number } | null> {
  const rules = await channelRules("browser");
  const [last] = await db.select({ at: sql<Date | null>`max(${browserOutreachSends.attemptedAt})` }).from(browserOutreachSends)
    .where(and(inOrg(browserOutreachSends), eq(browserOutreachSends.userId, send.userId)));
  const gap = Number(rules.secondsBetweenSends) * 1000;
  if (last?.at && new Date(last.at).getTime() + gap > Date.now()) {
    const at = new Date(new Date(last.at).getTime() + gap);
    return { reason: `next browser message at ${clock(at)} (the time between messages)`, retryInMs: at.getTime() - Date.now() };
  }
  if (send.kind !== "step" || send.step !== 0) return null;
  const [day] = await db.select({ n: sql<number>`count(*)::int`, oldest: sql<Date | null>`min(${browserOutreachSends.attemptedAt})` }).from(browserOutreachSends)
    .innerJoin(browserContactRoutes, eq(browserContactRoutes.id, browserOutreachSends.routeId))
    .where(and(inOrg(browserOutreachSends), eq(browserOutreachSends.userId, send.userId), eq(browserOutreachSends.kind, "step"), eq(browserOutreachSends.step, 0),
      eq(browserContactRoutes.site, site), sql`${browserOutreachSends.attemptedAt} > now() - interval '24 hours'`));
  if (Number(day?.n ?? 0) >= Number(rules.newChatsPerDay)) {
    const at = new Date(new Date(day!.oldest!).getTime() + 24 * 3_600_000);
    return { reason: `today's ${rules.newChatsPerDay} new ${MESSAGING_SITE_NAMES[site]} conversations from this browser are used; the next starts at ${clock(at)}`, retryInMs: at.getTime() - Date.now() };
  }
  return null;
}

async function setWait(sendId: string, reason: string, retryInMs: number): Promise<void> {
  await db.update(browserOutreachSends).set({ waitReason: reason.slice(0, 400), nextCheckAt: minutesFromNow(Math.max(30_000, retryInMs)), updatedAt: new Date() })
    .where(and(inOrg(browserOutreachSends), eq(browserOutreachSends.id, sendId)));
}

/**
 * Claims `send` for delivery: under the browser's lock, with the run still
 * running and approved, the person not on Do Not Contact and not already
 * answered, and (a first message) a place under the daily new-lead limit.
 * Writes the attempt time: from here the send counts.
 */
async function claim(send: SendRow, token: string): Promise<{ ok: true; counted: boolean } | { ok: false; reason: string | null; cancel: boolean; retryInMs?: number }> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`browser-send:${send.userId}`}, 0))`);
    const [row] = await tx.select().from(browserOutreachSends).where(and(inOrg(browserOutreachSends), eq(browserOutreachSends.id, send.id))).for("update");
    if (!row || row.status !== "queued") return { ok: false, reason: null, cancel: false };
    if (row.kind === "step") {
      const [run] = await tx.select({ status: outreachRuns.status, approvedAt: outreachRuns.approvedAt, approvedBy: outreachRuns.approvedBy }).from(outreachRuns)
        .where(and(inOrg(outreachRuns), eq(outreachRuns.id, row.runId!)));
      if (!run || !run.approvedAt || !run.approvedBy) return { ok: false, reason: "the run is not approved", cancel: true };
      if (run.status === "paused") return { ok: false, reason: "the run is paused; it sends after Resume", cancel: false, retryInMs: 5 * MINUTE };
      if (run.status !== "running") return { ok: false, reason: `the run is ${run.status}`, cancel: true };
    }
    const [policy] = await tx.select({ dnc: crmPersonContactPolicies.doNotContact }).from(crmPersonContactPolicies)
      .where(eq(crmPersonContactPolicies.personId, row.personId)).limit(1);
    if (policy?.dnc) return { ok: false, reason: "on Do Not Contact", cancel: true };
    if (row.kind === "step") {
      // They answered on any channel since the run queued this: no more outreach steps.
      const answered = await tx.execute<{ n: number }>(sql`select count(*)::int as n from crm_conversation_messages m
        join crm_conversations c on c.id = m.conversation_id
        where c.organization_id = ${currentOrganizationId()} and m.person_id = ${row.personId} and m.direction = 'inbound' and m.sent_at >= ${row.createdAt.toISOString()}::timestamptz`);
      if (Number(answered[0]?.n ?? 0) > 0) return { ok: false, reason: "They replied", cancel: true };
    }
    let counted = false;
    if (row.kind === "step" && row.step === 0) {
      const allowance = await newLeadAllowance(tx, { personId: row.personId });
      if (!allowance.ok) return { ok: false, reason: allowance.reason, cancel: false, retryInMs: Math.max(5 * MINUTE, allowance.resetsAt.getTime() - Date.now()) };
      counted = allowance.counted;
    }
    const now = new Date();
    await tx.update(browserOutreachSends).set({ status: "sending", lockedBy: token, lockedUntil: new Date(now.getTime() + CLAIM_MS), attemptedAt: now, waitReason: null, nextCheckAt: null, updatedAt: now })
      .where(eq(browserOutreachSends.id, row.id));
    if (counted) await recordNewLead(tx, { personId: row.personId, channel: "browser", at: now });
    return { ok: true, counted };
  });
}

/** One browser step for this delivery: the result, or why it could not be asked (`lost`: taken and never answered). */
async function browserStep(send: SendRow, action: BrowserResearchAction, timeoutMs: number): Promise<{ result: BrowserResearchResult } | { error: string; lost: boolean }> {
  try {
    return { result: await runBrowserAction({ userId: send.userId, threadId: null, requestId: send.id, action, timeoutMs }) };
  } catch (error) {
    if (error instanceof BrowserConnectionError) return { error: error.message, lost: /browser took the step/.test(error.message) };
    throw error;
  }
}

async function senderAccount(userId: string, site: MessagingSite): Promise<string | null> {
  const [row] = await db.select({ handle: browserSenderAccounts.handle }).from(browserSenderAccounts)
    .where(and(inOrg(browserSenderAccounts), eq(browserSenderAccounts.userId, userId), eq(browserSenderAccounts.site, site))).limit(1);
  return row?.handle ?? null;
}

/**
 * Delivers one claimed message: opens the recipient's profile, and lets the
 * organization's AI find the way to a message box step by step, every step
 * checked by courierStepVerdict. Ends sent only when the page shows the text.
 */
async function deliver(send: SendRow, route: RouteRow, person: { name: string | null }, log: CourierLogEntry[]): Promise<Delivery> {
  const site = route.site;
  const expected = await senderAccount(send.userId, site);
  const note = (step: string, ok: boolean, detail: string) => log.push({ at: new Date().toISOString(), step, ok, detail: detail.slice(0, 300) });
  const opened = await browserStep(send, { kind: "open", url: route.profileUrl, tabId: null }, OPEN_MS);
  if ("error" in opened) return { outcome: "wait", detail: opened.error, account: null, threadUrl: null, retryInMs: 2 * MINUTE };
  if (!opened.result.ok) {
    note("open profile", false, opened.result.error);
    if (opened.result.attention) return { outcome: "wait", detail: `the browser needs the owner on ${MESSAGING_SITE_NAMES[site]}: ${opened.result.attention.detail}`, account: null, threadUrl: null, retryInMs: 10 * MINUTE };
    return { outcome: "wait", detail: opened.result.error, account: null, threadUrl: null, retryInMs: 10 * MINUTE };
  }
  const tabId = opened.result.tabId!;
  let snapshot: ResearchSnapshot = opened.result.snapshot!;
  note("open profile", true, route.profileUrl);
  if (snapshot.attention && snapshot.attention.kind !== "empty") {
    return { outcome: "wait", detail: `the browser needs the owner on ${MESSAGING_SITE_NAMES[site]}: ${snapshot.attention.detail}`, account: null, threadUrl: null, retryInMs: 10 * MINUTE };
  }
  let account: string | null = null;
  let sent = false;
  let refusal: string | null = null;
  const history: string[] = [`opened ${route.profileUrl}`];
  for (let stepIndex = 0; stepIndex < COURIER_MAX_STEPS; stepIndex++) {
    const completion = await completeStructured({
      timeoutMs: 60_000,
      maxOutputTokens: 600,
      schemaName: "browser_courier_step",
      schemaDescription: "The next step to deliver the approved message.",
      jsonSchema: COURIER_SCHEMA as unknown as Record<string, unknown>,
      systemPrompt: COURIER_PROMPT,
      userPrompt: courierStepPrompt({
        site,
        recipient: { handle: route.handle, name: person.name, profileUrl: route.profileUrl },
        message: send.body,
        expectedAccount: expected,
        history,
        page: formatResearchSnapshot(snapshot, tabId),
        refusal,
      }),
      accept: (text) => {
        JSON.parse(text);
      },
    });
    await recordUsage("browser_courier", completion, send.runId);
    const step = JSON.parse(completion.text) as CourierStep;
    refusal = null;
    // The account the page shows, once the model names it: the same one earlier messages on this site came from.
    if (!account && step.account?.trim()) {
      if (!accountOnPage(snapshot.text, step.account)) refusal = `the page does not show “${step.account}”: give the account as the page shows it`;
      else if (expected && !accountOnPage(step.account, expected) && !accountOnPage(snapshot.text, expected)) {
        return { outcome: "wait", detail: `the browser is signed in to ${MESSAGING_SITE_NAMES[site]} as ${step.account}, but earlier messages there were sent as ${expected}: sign in as ${expected} (or remove that sender account) to continue`, account: step.account, threadUrl: null, retryInMs: 30 * MINUTE };
      } else account = step.account.trim();
    }
    if (refusal) {
      history.push(`refused: ${refusal}`);
      continue;
    }
    const verdict = courierStepVerdict(step, { message: send.body, site, recipient: { handle: route.handle, name: person.name }, snapshot, account: account ?? expected, sent });
    if (verdict.problem !== null) {
      refusal = verdict.problem;
      note(step.do, false, verdict.problem);
      history.push(`${step.do}${step.n !== null ? ` ${step.n}` : ""}: refused (${verdict.problem})`);
      continue;
    }
    if (step.do === "finish") {
      const outcome = step.outcome as CourierOutcome;
      const reason = step.reason?.trim() || step.note;
      note("finish", true, `${outcome}: ${reason}`);
      if (outcome === "sent") {
        const reread = await browserStep(send, { kind: "read", tabId }, STEP_MS);
        const page = "result" in reread && reread.result.ok && reread.result.snapshot ? reread.result.snapshot : snapshot;
        return messageOnPage(page.text, send.body)
          ? { outcome: "sent", detail: "the conversation shows the message", account, threadUrl: page.url, routeState: "messageable" }
          : { outcome: "uncertain", detail: "Send was pressed, but the conversation did not show the message afterwards; it is not sent again", account, threadUrl: page.url };
      }
      if (outcome === "cannot_message") return { outcome: "blocked", detail: `${MESSAGING_SITE_NAMES[site]} does not let the owner message them: ${reason}`, account, threadUrl: null, routeState: "not_messageable" };
      if (outcome === "not_found") return { outcome: "blocked", detail: `the ${MESSAGING_SITE_NAMES[site]} profile was not found: ${reason}`, account, threadUrl: null, routeState: "not_found" };
      if (outcome === "wrong_account") return { outcome: "wait", detail: `the browser is signed in to the wrong ${MESSAGING_SITE_NAMES[site]} account: ${reason}`, account, threadUrl: null, retryInMs: 30 * MINUTE };
      return { outcome: "wait", detail: `the browser needs the owner on ${MESSAGING_SITE_NAMES[site]}: ${reason}`, account, threadUrl: null, retryInMs: 10 * MINUTE };
    }
    if (verdict.sends) {
      // The last checks before anything goes out: still running, still allowed.
      const [current] = await db.select({ status: browserOutreachSends.status }).from(browserOutreachSends).where(and(inOrg(browserOutreachSends), eq(browserOutreachSends.id, send.id)));
      if (current?.status !== "sending") return { outcome: "wait", detail: "the message was cancelled before it was sent", account, threadUrl: null };
      if (send.runId) {
        const [run] = await db.select({ status: outreachRuns.status }).from(outreachRuns).where(and(inOrg(outreachRuns), eq(outreachRuns.id, send.runId)));
        if (run?.status !== "running") return { outcome: "wait", detail: `the run is ${run?.status ?? "gone"}; nothing was sent`, account, threadUrl: null, retryInMs: 5 * MINUTE };
      }
      const [policy] = await db.select({ dnc: crmPersonContactPolicies.doNotContact }).from(crmPersonContactPolicies).where(eq(crmPersonContactPolicies.personId, send.personId)).limit(1);
      if (policy?.dnc) return { outcome: "blocked", detail: "on Do Not Contact; nothing was sent", account, threadUrl: null };
    }
    const kinds = verdict.sends || verdict.opensComposer ? ["interact", "message"] as const : ["interact"] as const;
    const grant = { id: send.id, kinds: [...kinds], purchase: null, expiresAt: new Date(Date.now() + CLAIM_MS).toISOString() };
    const target = step.n === null ? null : snapshot.elements.find((item) => item.n === step.n);
    const action: BrowserResearchAction = step.do === "click" ? { kind: "act", tabId, n: step.n!, label: target!.label, op: "click", value: null, key: null, grant }
      : step.do === "fill" ? { kind: "act", tabId, n: step.n!, label: target!.label, op: "fill", value: step.text ?? "", key: null, grant }
      : step.do === "press" ? { kind: "act", tabId, n: step.n!, label: target!.label, op: "press", value: null, key: step.key ?? "Enter", grant }
      : step.do === "scroll" ? { kind: "scroll", tabId, direction: step.direction ?? "down" }
      : step.do === "open" ? { kind: "open", tabId, url: step.url! }
      : { kind: "read", tabId };
    const done = await browserStep(send, action, step.do === "open" ? OPEN_MS : STEP_MS);
    if ("error" in done) {
      note(step.do, false, done.error);
      // A send whose answer was lost may have gone out: uncertain, never repeated.
      if (verdict.sends || sent) return { outcome: "uncertain", detail: `the browser took the send step but its answer was lost (${done.error}); it is not sent again`, account, threadUrl: snapshot.url };
      return { outcome: "wait", detail: done.error, account, threadUrl: null, retryInMs: 2 * MINUTE };
    }
    if (!done.result.ok) {
      note(step.do, false, done.result.error);
      refusal = done.result.error;
      history.push(`${step.do}${step.n !== null ? ` ${step.n}` : ""}: not done (${done.result.error})`);
      if (done.result.attention) return { outcome: sent ? "uncertain" : "wait", detail: `the browser needs the owner: ${done.result.attention.detail}`, account, threadUrl: null, retryInMs: 10 * MINUTE };
      continue;
    }
    if (done.result.snapshot) snapshot = done.result.snapshot;
    if (verdict.sends) sent = true;
    const label = target ? ` “${target.label || target.kind}”` : "";
    note(step.do, true, `${step.do}${label}${verdict.sends ? " (send)" : ""}`);
    history.push(`${step.do}${step.n !== null ? ` ${step.n}${label}` : step.url ? ` ${step.url}` : ""}${verdict.sends ? " — sent" : ""}: ok. ${step.note.slice(0, 160)}`);
  }
  return sent
    ? (messageOnPage(snapshot.text, send.body)
      ? { outcome: "sent", detail: "the conversation shows the message", account, threadUrl: snapshot.url, routeState: "messageable" }
      : { outcome: "uncertain", detail: `Send was pressed, but after ${COURIER_MAX_STEPS} steps the conversation had not shown the message; it is not sent again`, account, threadUrl: snapshot.url })
    : { outcome: "failed", detail: `no way to message them was found in ${COURIER_MAX_STEPS} steps; nothing was sent`, account, threadUrl: null };
}

/** Records what became of a claimed send; a definite non-send gives its new-lead place back. */
async function settle(send: SendRow, route: RouteRow, token: string, delivery: Delivery, log: CourierLogEntry[], counted: boolean): Promise<void> {
  const now = new Date();
  const owned = and(inOrg(browserOutreachSends), eq(browserOutreachSends.id, send.id), eq(browserOutreachSends.lockedBy, token));
  const base = { lockedBy: null, lockedUntil: null, updatedAt: now, log: sql`${browserOutreachSends.log} || ${JSON.stringify(log)}::jsonb` };
  if (delivery.outcome === "sent") {
    await db.update(browserOutreachSends).set({ ...base, status: "sent", sentAt: now, senderHandle: delivery.account, threadUrl: delivery.threadUrl, error: null, waitReason: null }).where(owned);
    await db.update(browserContactRoutes).set({ state: "messageable", detail: null, checkedAt: now, threadUrl: delivery.threadUrl ?? route.threadUrl, updatedAt: now })
      .where(and(inOrg(browserContactRoutes), eq(browserContactRoutes.id, route.id)));
    if (delivery.account) {
      await db.insert(browserSenderAccounts).values({ organizationId: currentOrganizationId(), userId: send.userId, site: route.site, handle: delivery.account })
        .onConflictDoNothing();
    }
    if (send.kind === "step") await recordBrowserOutboundInCrm({ sendId: send.id, personId: send.personId, routeId: route.id, site: route.site, recipientHandle: route.handle, account: delivery.account ?? "unknown", body: send.body, sentAt: now, threadUrl: delivery.threadUrl });
    return;
  }
  if (delivery.outcome === "uncertain") {
    await db.update(browserOutreachSends).set({ ...base, status: "uncertain", senderHandle: delivery.account, threadUrl: delivery.threadUrl, error: delivery.detail.slice(0, 800) }).where(owned);
    // What follows an uncertain message waits for the owner: never a follow-up to something that may not have arrived.
    await db.update(browserOutreachSends).set({ status: "cancelled", error: "the message before it may not have been delivered; check the conversation", waitReason: null, updatedAt: now })
      .where(and(inOrg(browserOutreachSends), eq(browserOutreachSends.personId, send.personId), send.runId ? eq(browserOutreachSends.runId, send.runId) : isNull(browserOutreachSends.runId), inArray(browserOutreachSends.status, ["waiting", "queued"])));
    return;
  }
  if (delivery.outcome === "wait") {
    await db.update(browserOutreachSends).set({ ...base, status: "queued", attemptedAt: null, waitReason: delivery.detail.slice(0, 400), nextCheckAt: new Date(now.getTime() + (delivery.retryInMs ?? 5 * MINUTE)) }).where(owned);
  } else {
    await db.update(browserOutreachSends).set({ ...base, status: delivery.outcome === "blocked" ? "blocked" : "failed", attemptedAt: null, error: delivery.detail.slice(0, 800), waitReason: null }).where(owned);
    if (delivery.routeState) await setRouteState(route.id, delivery.routeState, delivery.detail);
    await db.update(browserOutreachSends).set({ status: "cancelled", error: "the first message could not be sent", waitReason: null, updatedAt: now })
      .where(and(inOrg(browserOutreachSends), eq(browserOutreachSends.personId, send.personId), send.runId ? eq(browserOutreachSends.runId, send.runId) : isNull(browserOutreachSends.runId), eq(browserOutreachSends.status, "waiting")));
  }
  // Nothing went out: the new-lead place goes back (attempted_at cleared first, so this send no longer holds it).
  if (counted) await releaseNewLead(db, { personId: send.personId, since: send.createdAt });
}

/** Follow-ups whose message before was sent become due after their wait; ones after a message that did not go out stop. */
async function promoteFollowUps(): Promise<void> {
  const org = currentOrganizationId();
  await db.execute(sql`update browser_outreach_sends s
      set status = 'queued', wait_reason = null,
          due_at = p.sent_at + make_interval(days => coalesce((r.plan->'sequences'->'browser'->(s.step)->>'waitDays')::int, 0)),
          updated_at = now()
     from browser_outreach_sends p, outreach_runs r
    where s.organization_id = ${org} and s.status = 'waiting' and s.kind = 'step'
      and p.organization_id = s.organization_id and p.run_id = s.run_id and p.person_id = s.person_id and p.step = s.step - 1 and p.status = 'sent'
      and r.id = s.run_id and r.organization_id = s.organization_id`);
  await db.execute(sql`update browser_outreach_sends s
      set status = 'cancelled', error = 'the message before it was not sent', wait_reason = null, updated_at = now()
     from browser_outreach_sends p
    where s.organization_id = ${org} and s.status = 'waiting' and s.kind = 'step'
      and p.organization_id = s.organization_id and p.run_id = s.run_id and p.person_id = s.person_id and p.step = s.step - 1
      and p.status in ('failed', 'blocked', 'cancelled', 'uncertain')`);
}

/** One organization's turn: recover, promote, then deliver at most one message per browser. */
export async function courierForOrganization(): Promise<{ delivered: number }> {
  if (isMigrationControlPaused("browserOutbound")) return { delivered: 0 };
  const org = currentOrganizationId();
  // A delivery whose worker died: before any attempt it is simply due again; after one, it may have gone out.
  await db.execute(sql`update browser_outreach_sends set
      status = case when attempted_at is null then 'queued' else 'uncertain' end,
      error = case when attempted_at is null then error else 'The courier stopped before the delivery was confirmed; it is not sent again' end,
      locked_by = null, locked_until = null, updated_at = now()
    where organization_id = ${org} and status = 'sending' and locked_until < now()`);
  await promoteFollowUps();
  // Replies are sent by the CRM's own send (sendBrowserReply), which records them; the tick sends run steps.
  const due = await db.select().from(browserOutreachSends)
    .where(and(inOrg(browserOutreachSends), eq(browserOutreachSends.status, "queued"), eq(browserOutreachSends.kind, "step"), lte(browserOutreachSends.dueAt, new Date()),
      or(isNull(browserOutreachSends.nextCheckAt), lte(browserOutreachSends.nextCheckAt, new Date()))))
    .orderBy(asc(browserOutreachSends.dueAt)).limit(25);
  const busy = new Set<string>();
  let delivered = 0;
  for (const send of due) {
    if (busy.has(send.userId)) continue;
    const [route] = await db.select().from(browserContactRoutes).where(and(inOrg(browserContactRoutes), eq(browserContactRoutes.id, send.routeId)));
    if (!route) continue;
    const blocked = (await browserWait(send.userId, route.site)) ?? (await pacingWait(send, route.site));
    if (blocked) {
      await setWait(send.id, blocked.reason, blocked.retryInMs);
      continue;
    }
    busy.add(send.userId);
    const token = randomUUID();
    const claimed = await claim(send, token);
    if (!claimed.ok) {
      if (claimed.cancel) {
        await db.update(browserOutreachSends).set({ status: "cancelled", error: claimed.reason, waitReason: null, updatedAt: new Date() })
          .where(and(inOrg(browserOutreachSends), eq(browserOutreachSends.id, send.id), eq(browserOutreachSends.status, "queued")));
      } else if (claimed.reason) await setWait(send.id, claimed.reason, claimed.retryInMs ?? 5 * MINUTE);
      continue;
    }
    const [person] = await db.select({ name: people.fullName }).from(people).where(and(inOrg(people), eq(people.id, send.personId)));
    const log: CourierLogEntry[] = [];
    let delivery: Delivery;
    try {
      delivery = await deliver({ ...send, status: "sending", lockedBy: token }, route, { name: person?.name ?? null }, log);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // The AI or the database failed between steps: a send step that ran is recorded, otherwise nothing went out.
      const sentStep = log.some((entry) => entry.ok && /\(send\)/.test(entry.detail));
      delivery = sentStep
        ? { outcome: "uncertain", detail: `the courier failed after the send step (${message}); it is not sent again`, account: null, threadUrl: null }
        : { outcome: "wait", detail: `the courier could not continue (${message})`, account: null, threadUrl: null, retryInMs: 10 * MINUTE };
    }
    await settle(send, route, token, delivery, log, claimed.counted);
    await releaseBrowserTabs(send.userId, null, send.id).catch(() => undefined);
    if (delivery.outcome === "sent") delivered += 1;
  }
  return { delivered };
}

export async function runBrowserCourierTick(): Promise<void> {
  if (!(await browserOutreachReady())) return;
  const rows = await db.selectDistinct({ organizationId: browserOutreachSends.organizationId }).from(browserOutreachSends)
    .where(inArray(browserOutreachSends.status, ["queued", "waiting", "sending"]));
  for (const row of rows) {
    try {
      await runInOrganization(row.organizationId, courierForOrganization);
    } catch (error) {
      console.error("[browser/courier] organization tick failed", row.organizationId, error);
    }
  }
}

let timer: ReturnType<typeof setInterval> | null = null;
let working = false;
/** Production only, like every other sender: a dev reload must not run a second courier. */
export function startBrowserCourier(): void {
  if (timer || process.env.NODE_ENV !== "production") return;
  const tick = async () => {
    if (working) return;
    working = true;
    try {
      await runBrowserCourierTick();
    } catch (error) {
      if (!isMissingTable(error)) console.error("[browser/courier] tick failed", error);
    } finally {
      working = false;
    }
  };
  timer = setInterval(() => void tick(), 20_000);
  timer.unref();
  void tick();
}

/** Why a reply through the browser did not go out: `deferred` (try again at `retryAt`), `definite` (nothing was sent), `uncertain` (it may have). */
export class BrowserReplyError extends Error {
  constructor(message: string, readonly outcome: "deferred" | "definite" | "uncertain", readonly retryAt: Date | null = null) {
    super(message);
    this.name = "BrowserReplyError";
  }
}

/**
 * A CRM reply on the browser channel (the CRM's send adapter calls this):
 * delivered now through the browser signed in as the conversation's account,
 * by the same courier, checks and verification as outreach. One row per
 * draft: a draft already sent is not sent again, an uncertain one never.
 */
export async function sendBrowserReply(input: { draftId: string; personId: string; routeId: string; accountRef: string; body: string }): Promise<{ sendId: string; threadUrl: string | null }> {
  const [site, handle] = input.accountRef.split(":", 2) as [MessagingSite, string];
  const [route] = await db.select().from(browserContactRoutes).where(and(inOrg(browserContactRoutes), eq(browserContactRoutes.id, input.routeId)));
  if (!route || route.personId !== input.personId) throw new BrowserReplyError("this conversation's profile is no longer recorded for this person", "definite");
  const [sender] = await db.select({ userId: browserSenderAccounts.userId }).from(browserSenderAccounts)
    .where(and(inOrg(browserSenderAccounts), eq(browserSenderAccounts.site, site), eq(browserSenderAccounts.handle, handle))).limit(1);
  if (!sender) throw new BrowserReplyError(`no connected browser is known to be signed in to ${MESSAGING_SITE_NAMES[site] ?? site} as ${handle}`, "definite");
  await db.insert(browserOutreachSends).values({ organizationId: currentOrganizationId(), personId: input.personId, routeId: route.id, userId: sender.userId, kind: "reply", draftId: input.draftId, body: input.body.trim() })
    .onConflictDoNothing();
  const [row] = await db.select().from(browserOutreachSends).where(and(inOrg(browserOutreachSends), eq(browserOutreachSends.kind, "reply"), eq(browserOutreachSends.draftId, input.draftId)));
  if (!row) throw new BrowserReplyError("the reply could not be queued", "definite");
  if (row.status === "sent") return { sendId: row.id, threadUrl: row.threadUrl };
  if (row.status === "uncertain") throw new BrowserReplyError(`an earlier attempt may have sent this reply (${row.error ?? "its answer was lost"}); check the conversation`, "uncertain");
  if (row.status === "sending") throw new BrowserReplyError("this reply is being sent by the browser right now", "deferred", minutesFromNow(2 * MINUTE));
  // Nothing went out before (queued, waiting for the browser, or a definite failure): this attempt uses the text as it is now.
  await db.update(browserOutreachSends).set({ status: "queued", body: input.body.trim(), attemptedAt: null, error: null, updatedAt: new Date() })
    .where(and(inOrg(browserOutreachSends), eq(browserOutreachSends.id, row.id), inArray(browserOutreachSends.status, ["queued", "waiting", "failed", "blocked", "cancelled"])));
  const send = { ...row, status: "queued" as const, body: input.body.trim() };
  const wait = (await browserWait(send.userId, route.site)) ?? (await pacingWait(send, route.site));
  if (wait) {
    await setWait(send.id, wait.reason, wait.retryInMs);
    throw new BrowserReplyError(wait.reason, "deferred", minutesFromNow(wait.retryInMs));
  }
  const token = randomUUID();
  const claimed = await claim(send, token);
  if (!claimed.ok) {
    if (claimed.cancel) throw new BrowserReplyError(claimed.reason ?? "the reply cannot be sent", "definite");
    throw new BrowserReplyError(claimed.reason ?? "the browser is busy", "deferred", minutesFromNow(claimed.retryInMs ?? 2 * MINUTE));
  }
  const [person] = await db.select({ name: people.fullName }).from(people).where(and(inOrg(people), eq(people.id, send.personId)));
  const log: CourierLogEntry[] = [];
  let delivery: Delivery;
  try {
    delivery = await deliver({ ...send, status: "sending", lockedBy: token }, route, { name: person?.name ?? null }, log);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    delivery = log.some((entry) => entry.ok && /\(send\)/.test(entry.detail))
      ? { outcome: "uncertain", detail: `the courier failed after the send step (${message})`, account: null, threadUrl: null }
      : { outcome: "wait", detail: `the courier could not continue (${message})`, account: null, threadUrl: null, retryInMs: 10 * MINUTE };
  }
  await settle(send, route, token, delivery, log, false);
  await releaseBrowserTabs(send.userId, null, send.id).catch(() => undefined);
  if (delivery.outcome === "sent") return { sendId: send.id, threadUrl: delivery.threadUrl };
  if (delivery.outcome === "uncertain") throw new BrowserReplyError(delivery.detail, "uncertain");
  if (delivery.outcome === "wait") throw new BrowserReplyError(delivery.detail, "deferred", minutesFromNow(delivery.retryInMs ?? 5 * MINUTE));
  throw new BrowserReplyError(delivery.detail, "definite");
}
