import "server-only";

import { and, eq, inArray, lt, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { decryptIntegrationCredential, encryptIntegrationCredential } from "@/lib/integrations/credentials";
import { reserveQuota, settleQuota, usedToday } from "@/lib/quota/quota.server";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";
import { TINYFISH_PROVIDER, tinyfishConnection } from "@/lib/tinyfish/tinyfish.server";
import { createTinyfishBrowserSession, deleteTinyfishBrowserSession, TinyfishError } from "@/services/tinyfish";
import { connectBrowser, type BrowserPage } from "./driver.server";
import { browserSessions } from "./schema";
import { BROWSER_LIMITS, fillProblem, minutesBetween, type PageSnapshot } from "./snapshot";

/**
 * The assistant's remote browser: one TinyFish Browser session at a time
 * per organization, only while its owner allows browser minutes for the day
 * (Settings → Organization → TinyFish; 0, the default, keeps it off). A
 * session reserves its longest life (BROWSER_LIMITS.maxSessionMinutes) in
 * provider_usage when it opens, is closed when idle, at the end of the chat
 * turn or after that time, and settles the minutes it actually used.
 * TinyFish also ends a session after BROWSER_LIMITS.idleTimeoutSeconds of
 * silence, so a crash here cannot leave a browser billing for long.
 */

export class BrowserUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrowserUnavailableError";
  }
}

type SessionRow = typeof browserSessions.$inferSelect;

/** Live connections in this process, by session id; another process reconnects from the stored CDP URL. */
const pages = new Map<string, BrowserPage>();

export type BrowserAllowance = { available: boolean; reason: string | null; minutesPerDay: number; usedToday: number };

export async function browserAllowance(): Promise<BrowserAllowance> {
  const connection = await tinyfishConnection();
  if (!connection) return { available: false, reason: "TinyFish is not connected (Settings → Organization → TinyFish)", minutesPerDay: 0, usedToday: 0 };
  const used = await usedToday(TINYFISH_PROVIDER, "browser");
  if (connection.browserMinutesPerDay <= 0) {
    return { available: false, reason: "the browser is off: an owner or admin sets browser minutes a day in Settings → Organization → TinyFish (it is paid by the minute)", minutesPerDay: 0, usedToday: used };
  }
  const left = connection.browserMinutesPerDay - used;
  if (left < BROWSER_LIMITS.maxSessionMinutes) {
    return { available: false, reason: `today's browser allowance (${connection.browserMinutesPerDay} minutes) has ${Math.max(0, left)} left, less than one session's ${BROWSER_LIMITS.maxSessionMinutes}; it renews at 00:00 UTC`, minutesPerDay: connection.browserMinutesPerDay, usedToday: used };
  }
  return { available: true, reason: null, minutesPerDay: connection.browserMinutesPerDay, usedToday: used };
}

async function endSession(row: SessionRow, outcome: { failed?: string } = {}): Promise<number> {
  const live = pages.get(row.id);
  pages.delete(row.id);
  await live?.disconnect().catch(() => undefined);
  let error = outcome.failed ?? null;
  if (row.providerSessionId) {
    const connection = await tinyfishConnection();
    if (connection) {
      await deleteTinyfishBrowserSession(connection.key, row.providerSessionId).catch((cause: unknown) => {
        // TinyFish still ends it after its idle timeout.
        error = `${error ? `${error}; ` : ""}ending it at TinyFish failed (${cause instanceof Error ? cause.message : String(cause)}); TinyFish ends it when idle`;
      });
    }
  }
  const now = new Date();
  const minutes = row.providerSessionId ? Math.min(BROWSER_LIMITS.maxSessionMinutes, minutesBetween(row.startedAt, now)) : 0;
  const [closed] = await db.update(browserSessions)
    .set({ status: outcome.failed ? "failed" : "closed", endedAt: now, minutesUsed: minutes, error })
    .where(and(inOrg(browserSessions), eq(browserSessions.id, row.id), inArray(browserSessions.status, ["opening", "open"])))
    .returning({ id: browserSessions.id });
  // Closed by someone else first: its minutes are already settled.
  if (closed && row.usageId) await settleQuota(row.usageId, { status: "settled", usedUnits: minutes, detail: { sessionId: row.id } });
  return minutes;
}

/** Closes sessions past their longest life, idle ones, and opens that never finished. */
export async function sweepBrowserSessions(now = new Date()): Promise<number> {
  const stale = await db.select().from(browserSessions).where(and(
    inOrg(browserSessions),
    or(
      and(eq(browserSessions.status, "open"), or(
        lt(browserSessions.startedAt, new Date(now.getTime() - BROWSER_LIMITS.maxSessionMinutes * 60_000)),
        lt(browserSessions.lastUsedAt, new Date(now.getTime() - BROWSER_LIMITS.idleCloseMinutes * 60_000)),
      )),
      and(eq(browserSessions.status, "opening"), lt(browserSessions.startedAt, new Date(now.getTime() - 2 * 60_000))),
    ),
  ));
  for (const row of stale) await endSession(row, row.status === "opening" ? { failed: "it never finished opening" } : {});
  return stale.length;
}

async function threadSession(threadId: string): Promise<SessionRow | null> {
  const [row] = await db.select().from(browserSessions)
    .where(and(inOrg(browserSessions), eq(browserSessions.threadId, threadId), eq(browserSessions.status, "open")))
    .limit(1);
  return row ?? null;
}

async function livePage(row: SessionRow): Promise<BrowserPage> {
  const live = pages.get(row.id);
  if (live) return live;
  if (!row.encryptedCdpUrl) throw new BrowserUnavailableError("the browser session has no connection; open the page again");
  const page = await connectBrowser(decryptIntegrationCredential(row.encryptedCdpUrl));
  pages.set(row.id, page);
  return page;
}

async function touch(row: SessionRow, url: string): Promise<void> {
  await db.update(browserSessions).set({ lastUsedAt: new Date(), currentUrl: url.slice(0, 2_000) })
    .where(and(inOrg(browserSessions), eq(browserSessions.id, row.id)));
}

/** Where a navigation ended, checked by the caller (public address, no login wall); a problem closes nothing but is reported. */
export type NavigationCheck = (url: string) => Promise<string | null>;

/**
 * Opens `url` in the chat's browser: the session it already has, or a new
 * one when the organization's allowance and its one-at-a-time rule permit.
 */
export async function openBrowser(url: string, threadId: string, check: NavigationCheck): Promise<{ snapshot: PageSnapshot; reused: boolean; problem: string | null; allowance: BrowserAllowance }> {
  await sweepBrowserSessions();
  const existing = await threadSession(threadId);
  if (existing) {
    const page = await livePage(existing);
    await page.goto(url);
    const snapshot = await page.snapshot();
    await touch(existing, snapshot.url);
    return { snapshot, reused: true, problem: await check(snapshot.url), allowance: await browserAllowance() };
  }
  const connection = await tinyfishConnection();
  if (!connection) throw new BrowserUnavailableError("TinyFish is not connected (Settings → Organization → TinyFish)");
  const row = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`browser:${currentOrganizationId()}`}, 0))`);
    const allowance = await browserAllowance();
    if (!allowance.available) throw new BrowserUnavailableError(`The browser cannot open: ${allowance.reason}.`);
    const [busy] = await tx.select({ id: browserSessions.id }).from(browserSessions)
      .where(and(inOrg(browserSessions), inArray(browserSessions.status, ["opening", "open"]))).limit(1);
    if (busy) throw new BrowserUnavailableError(`The organization's one browser is in use by another chat; it frees within ${BROWSER_LIMITS.maxSessionMinutes} minutes.`);
    const [inserted] = await tx.insert(browserSessions).values({ organizationId: currentOrganizationId(), threadId, status: "opening", currentUrl: url.slice(0, 2_000) }).returning();
    return inserted!;
  });
  const reservation = await reserveQuota({ provider: TINYFISH_PROVIDER, product: "browser", scopeKey: null, units: BROWSER_LIMITS.maxSessionMinutes, limits: {}, label: "TinyFish Browser", threadId, detail: { sessionId: row.id } });
  if (!reservation.ok) {
    await endSession(row, { failed: reservation.reason });
    throw new BrowserUnavailableError(reservation.reason);
  }
  row.usageId = reservation.usageId;
  await db.update(browserSessions).set({ usageId: reservation.usageId }).where(and(inOrg(browserSessions), eq(browserSessions.id, row.id)));
  let created;
  try {
    created = await createTinyfishBrowserSession(connection.key, { url, timeoutSeconds: BROWSER_LIMITS.idleTimeoutSeconds });
  } catch (error) {
    const message = error instanceof TinyfishError && error.status === 402
      ? "TinyFish Browser needs funds in the TinyFish Wallet (it is paid by the minute); AgentSDR never tops it up"
      : error instanceof Error ? error.message : String(error);
    await db.update(browserSessions).set({ status: "failed", endedAt: new Date(), minutesUsed: 0, error: message.slice(0, 500) })
      .where(and(inOrg(browserSessions), eq(browserSessions.id, row.id)));
    // A lost answer may have started a browser: keep its minutes counted.
    await settleQuota(reservation.usageId, { status: error instanceof TinyfishError && error.uncertain ? "uncertain" : "failed", usedUnits: 0, error: message });
    throw new BrowserUnavailableError(`The browser could not be opened: ${message}.`);
  }
  await db.update(browserSessions).set({ status: "open", providerSessionId: created.sessionId, encryptedCdpUrl: encryptIntegrationCredential(created.cdpUrl), lastUsedAt: new Date() })
    .where(and(inOrg(browserSessions), eq(browserSessions.id, row.id)));
  const open: SessionRow = { ...row, status: "open", providerSessionId: created.sessionId, encryptedCdpUrl: null };
  try {
    const page = await connectBrowser(created.cdpUrl);
    pages.set(row.id, page);
    await page.goto(url);
    const snapshot = await page.snapshot();
    await touch(open, snapshot.url);
    return { snapshot, reused: false, problem: await check(snapshot.url), allowance: await browserAllowance() };
  } catch (error) {
    await endSession(open, { failed: `the page could not be loaded (${error instanceof Error ? error.message : String(error)})` });
    throw new BrowserUnavailableError(`The browser opened but the page could not be loaded: ${error instanceof Error ? error.message : String(error)}.`);
  }
}

export type BrowserAction =
  | { kind: "read" }
  | { kind: "click"; n: number }
  | { kind: "fill"; n: number; text: string; submit: boolean }
  | { kind: "scroll"; direction: "down" | "up" };

/** One step in the chat's open browser; the page as it is afterwards. */
export async function browserAct(threadId: string, action: BrowserAction, check: NavigationCheck): Promise<{ snapshot: PageSnapshot; problem: string | null }> {
  await sweepBrowserSessions();
  const row = await threadSession(threadId);
  if (!row) throw new BrowserUnavailableError("No browser is open in this chat (it closes after a few idle minutes): open the page with browser_open first.");
  const page = await livePage(row);
  if (action.kind === "fill") {
    const before = await page.snapshot();
    const problem = fillProblem(before.elements.find((element) => element.n === action.n));
    if (problem) throw new BrowserUnavailableError(`Not filled: ${problem}.`);
    await page.fill(action.n, action.text, action.submit);
  } else if (action.kind === "click") {
    await page.click(action.n);
  } else if (action.kind === "scroll") {
    await page.scroll(action.direction);
  }
  const snapshot = await page.snapshot();
  await touch(row, snapshot.url);
  return { snapshot, problem: action.kind === "read" || action.kind === "scroll" ? null : await check(snapshot.url) };
}

/** Ends the chat's browser, if one is open; the minutes it used. */
export async function closeBrowser(threadId: string): Promise<number | null> {
  const row = await threadSession(threadId);
  if (!row) return null;
  return endSession(row);
}
