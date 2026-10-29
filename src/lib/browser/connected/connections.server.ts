import "server-only";

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";
import { and, asc, desc, eq, gt, inArray, lt, ne, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { members, organizations, users } from "@/lib/auth/schema";
import { currentOrganizationId, inOrg, runInOrganization } from "@/lib/tenancy/scope";
import {
  accessDomains,
  BROWSER_DEVICE_HEADER,
  RESEARCH_LIMITS,
  researchSites,
  type BrowserCommandResultRequest,
  type BrowserConnectionState,
  type BrowserConnectionView,
  type BrowserPairRequest,
  type BrowserPairResponse,
  type BrowserPollRequest,
  type BrowserPollResponse,
  type BrowserResearchAction,
  type BrowserResearchCommand,
  type BrowserResearchResult,
  type BrowserScreenshot,
  type BrowserScreenshotFacts,
  type ResearchAttention,
  type ResearchElement,
  type ResearchField,
  type ResearchSnapshot,
  type SharedTab,
} from "./contract";
import { browserCommands, browserConnections } from "./schema";

/**
 * The server half of connected-browser research (contract.ts has the flow).
 *
 * A connection belongs to one person in one workspace and one device: the
 * pairing code is minted for the signed-in person, the device token is
 * accepted only beside the device id it was paired with, and only while that
 * person is still a member. The assistant's tools queue a command on the
 * acting person's own connection and wait for its answer; the extension
 * takes commands from its long poll and answers each once. A command is
 * delivered once and never sent again: one the extension lost (a restart,
 * sleep) expires, and the model decides what to do next. Passwords, cookies
 * and sign-ins stay in the browser; only what a page shows comes back.
 */

export type BrowserConnectionRow = typeof browserConnections.$inferSelect;

/** For the bridge routes: an HTTP status and a message the extension may show. */
export class BrowserBridgeError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "BrowserBridgeError";
    this.status = status;
  }
}

export type BrowserConnectionProblem = "none" | "offline" | "paused" | "timeout" | "cancelled";

/** For the assistant's tools: why the browser could not take the step. */
export class BrowserConnectionError extends Error {
  readonly kind: BrowserConnectionProblem;
  constructor(kind: BrowserConnectionProblem, message: string) {
    super(message);
    this.name = "BrowserConnectionError";
    this.kind = kind;
  }
}

const PAIRING_TTL_MS = 10 * 60_000;
/** A poll answers within POLL_WAIT_MS and the next starts at once; a suspended worker is woken by its alarm within a minute. */
export const ONLINE_WITHIN_MS = 80_000;
const POLL_WAIT_MS = 20_000;
/** An answer arriving this long after its deadline is still too late; the deadline the extension sees is the same one. */
const ANSWER_GRACE_MS = 1_500;
const ATTENTION_TTL_MS = 30 * 60_000;

const hash = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

function sameSecret(given: string, expected: string): boolean {
  const left = Buffer.from(given);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

// Wakes a waiting poll or tool in this process at once; other processes find the row on their next look.
const bus = ((globalThis as typeof globalThis & { __agentsdrBrowserBus?: EventEmitter }).__agentsdrBrowserBus ??= new EventEmitter().setMaxListeners(0));

function waitFor(event: string, ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      bus.off(event, done);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, Math.max(0, ms));
    bus.once(event, done);
    signal?.addEventListener("abort", done, { once: true });
  });
}

async function isMember(userId: string): Promise<boolean> {
  const [row] = await db.select({ id: members.id }).from(members)
    .where(and(eq(members.organizationId, currentOrganizationId()), eq(members.userId, userId))).limit(1);
  return Boolean(row);
}

// --- Pairing ----------------------------------------------------------------

/**
 * A one-time code that pairs a browser with this person in this workspace.
 * An earlier unused code of theirs stops working; the page hands the code to
 * the extension and never shows it.
 */
export async function createPairing(userId: string, now = new Date()): Promise<{ code: string; expiresAt: Date }> {
  const code = randomBytes(24).toString("base64url");
  const expiresAt = new Date(now.getTime() + PAIRING_TTL_MS);
  await db.update(browserConnections).set({ status: "revoked", pairingCodeHash: null, revokedAt: now })
    .where(and(inOrg(browserConnections), eq(browserConnections.userId, userId), eq(browserConnections.status, "pending")));
  await db.insert(browserConnections).values({ organizationId: currentOrganizationId(), userId, status: "pending", pairingCodeHash: hash(code), pairingExpiresAt: expiresAt });
  return { code, expiresAt };
}

function text(value: unknown, field: string, max: number, pattern?: RegExp): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || (pattern && !pattern.test(value))) throw new BrowserBridgeError(400, `${field} is missing or invalid`);
  return value.trim();
}

const VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
const DEVICE_ID = /^[A-Za-z0-9-]{16,64}$/;

export function parsePairRequest(value: unknown): BrowserPairRequest {
  const body = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  return {
    code: text(body.code, "code", 100, /^[A-Za-z0-9_-]+$/),
    deviceId: text(body.deviceId, "deviceId", 64, DEVICE_ID),
    deviceLabel: text(body.deviceLabel, "deviceLabel", 80),
    extensionVersion: text(body.extensionVersion, "extensionVersion", 20, VERSION),
    sites: researchSites(body.sites),
    domains: accessDomains(body.domains),
  };
}

/**
 * Pairs the extension that holds `code`. The code names its person and
 * workspace: the claim below is the one deliberately unscoped write of
 * browser_connections, and everything after it runs in that workspace. One
 * connected browser per person and workspace: the newest pairing replaces
 * the earlier one.
 */
export async function pairDevice(input: BrowserPairRequest, now = new Date()): Promise<BrowserPairResponse> {
  const token = randomBytes(32).toString("base64url");
  const [row] = await db.update(browserConnections).set({
    status: "active",
    pairingCodeHash: null,
    pairingExpiresAt: null,
    tokenHash: hash(token),
    deviceId: input.deviceId,
    deviceLabel: input.deviceLabel,
    extensionVersion: input.extensionVersion,
    sites: input.sites,
    domains: input.domains ?? [],
    pairedAt: now,
    lastSeenAt: now,
  }).where(and(eq(browserConnections.pairingCodeHash, hash(input.code)), eq(browserConnections.status, "pending"), gt(browserConnections.pairingExpiresAt, now))).returning();
  if (!row) throw new BrowserBridgeError(401, "This connect link expired or was already used. Press Connect browser in the chat again.");
  return runInOrganization(row.organizationId, async () => {
    if (!(await isMember(row.userId))) {
      await revoke(row.id, now);
      throw new BrowserBridgeError(403, "That person is no longer a member of this workspace.");
    }
    const replaced = await db.update(browserConnections).set({ status: "revoked", tokenHash: null, revokedAt: now })
      .where(and(inOrg(browserConnections), eq(browserConnections.userId, row.userId), eq(browserConnections.status, "active"), ne(browserConnections.id, row.id)))
      .returning({ id: browserConnections.id });
    if (replaced.length) await expireOpenCommands(replaced.map((item) => item.id), now);
    const [organization] = await db.select({ name: organizations.name }).from(organizations).where(eq(organizations.id, row.organizationId)).limit(1);
    const [user] = await db.select({ email: users.email }).from(users).where(eq(users.id, row.userId)).limit(1);
    return { connectionId: row.id, token, organizationName: organization?.name ?? "", userEmail: user?.email ?? "" };
  });
}

async function revoke(connectionId: string, now: Date): Promise<void> {
  await db.update(browserConnections).set({ status: "revoked", tokenHash: null, pairingCodeHash: null, revokedAt: now })
    .where(and(inOrg(browserConnections), eq(browserConnections.id, connectionId), ne(browserConnections.status, "revoked")));
  await expireOpenCommands([connectionId], now);
}

async function expireOpenCommands(connectionIds: string[], now: Date): Promise<void> {
  if (!connectionIds.length) return;
  const ended = await db.update(browserCommands).set({ status: "expired", finishedAt: now, error: "the browser was disconnected" })
    .where(and(inOrg(browserCommands), inArray(browserCommands.connectionId, connectionIds), inArray(browserCommands.status, ["pending", "delivered"])))
    .returning({ id: browserCommands.id });
  for (const command of ended) bus.emit(`finished:${command.id}`);
}

/** The person's own Disconnect in the chat: their active connection here stops working. */
export async function disconnectBrowser(userId: string, now = new Date()): Promise<boolean> {
  const rows = await db.select({ id: browserConnections.id }).from(browserConnections)
    .where(and(inOrg(browserConnections), eq(browserConnections.userId, userId), inArray(browserConnections.status, ["active", "pending"])));
  for (const row of rows) await revoke(row.id, now);
  return rows.length > 0;
}

// --- The device ------------------------------------------------------------

/**
 * Every /api/browser-bridge route but pairing starts here instead of a
 * cookie check: the bearer device token, beside the device id it was paired
 * with, names the connection. The lookup is the one deliberately unscoped
 * read of browser_connections; withBrowserDevice runs the rest in its
 * workspace. A person who left the workspace loses the connection here.
 */
export async function authorizeBrowserDevice(request: Request): Promise<BrowserConnectionRow> {
  const match = /^Bearer\s+([A-Za-z0-9_-]{20,200})$/.exec(request.headers.get("authorization") ?? "");
  const device = request.headers.get(BROWSER_DEVICE_HEADER) ?? "";
  if (!match || !DEVICE_ID.test(device)) throw new BrowserBridgeError(401, "This browser is not connected.");
  const [row] = await db.select().from(browserConnections).where(eq(browserConnections.tokenHash, hash(match[1]!))).limit(1);
  if (!row || row.status !== "active" || !row.deviceId || !sameSecret(device, row.deviceId)) throw new BrowserBridgeError(401, "This browser is no longer connected.");
  const member = await runInOrganization(row.organizationId, () => isMember(row.userId));
  if (!member) {
    await runInOrganization(row.organizationId, () => revoke(row.id, new Date()));
    throw new BrowserBridgeError(401, "This browser is no longer connected: its person left the workspace.");
  }
  return row;
}

export async function withBrowserDevice<T>(request: Request, fn: (row: BrowserConnectionRow) => Promise<T>): Promise<T> {
  const row = await authorizeBrowserDevice(request);
  return runInOrganization(row.organizationId, () => fn(row));
}

/** The extension's own Disconnect (or a reset): its token stops working. */
export async function disconnectDevice(row: BrowserConnectionRow): Promise<void> {
  await revoke(row.id, new Date());
}

function sharedTabs(value: unknown): SharedTab[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, RESEARCH_LIMITS.maxSharedTabs).flatMap((item) => {
    const tab = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    if (typeof tab.tabId !== "number" || !Number.isSafeInteger(tab.tabId) || typeof tab.url !== "string" || !/^https:\/\//i.test(tab.url)) return [];
    return [{ tabId: tab.tabId, url: tab.url.slice(0, 2_000), title: typeof tab.title === "string" ? tab.title.slice(0, 300) : "" }];
  });
}

export function parsePollRequest(value: unknown): BrowserPollRequest {
  const body = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  return {
    extensionVersion: text(body.extensionVersion, "extensionVersion", 20, VERSION),
    sites: researchSites(body.sites),
    domains: accessDomains(body.domains),
    sharedTabs: sharedTabs(body.sharedTabs),
    lastSeq: typeof body.lastSeq === "number" && Number.isSafeInteger(body.lastSeq) && body.lastSeq >= 0 ? body.lastSeq : 0,
    paused: body.paused === true,
  };
}

function toCommand(row: typeof browserCommands.$inferSelect): BrowserResearchCommand {
  return { id: row.id, seq: row.seq, requestId: row.requestId, issuedAt: row.createdAt.toISOString(), expiresAt: row.expiresAt.toISOString(), action: row.action };
}

/** Ends commands whose deadline passed unanswered, so their waiting tool hears it now. */
async function expireOverdue(connectionId: string, now: Date): Promise<void> {
  const ended = await db.update(browserCommands).set({ status: "expired", finishedAt: now, error: "not answered in time" })
    .where(and(inOrg(browserCommands), eq(browserCommands.connectionId, connectionId), inArray(browserCommands.status, ["pending", "delivered"]), lt(browserCommands.expiresAt, new Date(now.getTime() - ANSWER_GRACE_MS))))
    .returning({ id: browserCommands.id });
  for (const command of ended) bus.emit(`finished:${command.id}`);
}

/**
 * The extension's heartbeat: records what it reports, then waits up to
 * POLL_WAIT_MS for commands and hands each one over once. While the owner has
 * pressed Stop nothing is handed over.
 */
export async function pollCommands(row: BrowserConnectionRow, body: BrowserPollRequest, signal?: AbortSignal): Promise<BrowserPollResponse> {
  const now = new Date();
  await db.update(browserConnections).set({ lastSeenAt: now, extensionVersion: body.extensionVersion, sites: body.sites, domains: body.domains ?? [], sharedTabs: body.sharedTabs, paused: body.paused })
    .where(and(inOrg(browserConnections), eq(browserConnections.id, row.id), eq(browserConnections.status, "active")));
  await expireOverdue(row.id, now);
  const deadline = Date.now() + POLL_WAIT_MS;
  while (!body.paused && !signal?.aborted) {
    const claimed = await db.update(browserCommands).set({ status: "delivered", deliveredAt: new Date() })
      .where(and(inOrg(browserCommands), eq(browserCommands.connectionId, row.id), eq(browserCommands.status, "pending"), gt(browserCommands.expiresAt, new Date())))
      .returning();
    if (claimed.length) return { commands: claimed.sort((a, b) => a.seq - b.seq).map(toCommand), serverTime: new Date().toISOString() };
    const left = deadline - Date.now();
    if (left <= 0) break;
    await waitFor(`queued:${row.id}`, Math.min(1_000, left), signal);
  }
  return { commands: [], serverTime: new Date().toISOString() };
}

const clip = (value: unknown, max: number) => (typeof value === "string" ? value.slice(0, max) : "");

function attentionOf(value: unknown): ResearchAttention | null {
  const attention = (value && typeof value === "object" ? value : null) as Record<string, unknown> | null;
  const kinds = ["captcha", "login", "blocked", "frozen", "empty", "permission"];
  return attention && typeof attention.kind === "string" && kinds.includes(attention.kind)
    ? { kind: attention.kind as ResearchAttention["kind"], detail: clip(attention.detail, 300) }
    : null;
}

function fieldOf(value: unknown): ResearchField | undefined {
  if (!value || typeof value !== "object") return undefined;
  const field = value as Record<string, unknown>;
  if (typeof field.type !== "string") return undefined;
  const sensitive = field.sensitive === true;
  return {
    type: clip(field.type, 30),
    // A sensitive field's value is never kept, whatever the extension sent.
    value: sensitive ? "" : clip(field.value, 300),
    ...(typeof field.checked === "boolean" ? { checked: field.checked } : {}),
    ...(Array.isArray(field.options) ? { options: field.options.slice(0, 30).map((option) => clip(option, 80)) } : {}),
    ...(field.disabled === true ? { disabled: true } : {}),
    ...(field.required === true ? { required: true } : {}),
    ...(sensitive ? { sensitive: true } : {}),
  };
}

const SCREENSHOT_MAX_BASE64 = 3_500_000;

function screenshotOf(value: unknown): BrowserScreenshot | undefined {
  if (!value || typeof value !== "object") return undefined;
  const shot = value as Record<string, unknown>;
  const viewport = (shot.viewport && typeof shot.viewport === "object" ? shot.viewport : {}) as Record<string, unknown>;
  const positive = (item: unknown, max: number) => typeof item === "number" && Number.isFinite(item) && item > 0 && item <= max;
  const finite = (item: unknown) => (typeof item === "number" && Number.isFinite(item) ? item : 0);
  if (typeof shot.id !== "string" || !/^[0-9a-f-]{36}$/i.test(shot.id)) return undefined;
  if (shot.mediaType !== "image/jpeg" && shot.mediaType !== "image/png") return undefined;
  if (typeof shot.data !== "string" || !shot.data || shot.data.length > SCREENSHOT_MAX_BASE64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(shot.data)) return undefined;
  if (!positive(shot.width, 4_096) || !positive(shot.height, 4_096) || !positive(shot.scale, 4) || !positive(viewport.width, 20_000) || !positive(viewport.height, 20_000)) return undefined;
  return {
    id: shot.id,
    url: clip(shot.url, 2_000),
    title: clip(shot.title, 300),
    mediaType: shot.mediaType,
    data: shot.data,
    width: Math.round(shot.width as number),
    height: Math.round(shot.height as number),
    scale: shot.scale as number,
    viewport: { width: viewport.width as number, height: viewport.height as number, scrollX: finite(viewport.scrollX), scrollY: finite(viewport.scrollY), zoom: positive(viewport.zoom, 10) ? viewport.zoom as number : 1 },
    takenAt: typeof shot.takenAt === "string" && Number.isFinite(Date.parse(shot.takenAt)) ? new Date(shot.takenAt).toISOString() : new Date().toISOString(),
  };
}

function snapshotOf(value: unknown): ResearchSnapshot | undefined {
  if (!value || typeof value !== "object") return undefined;
  const page = value as Record<string, unknown>;
  const scroll = (page.scroll && typeof page.scroll === "object" ? page.scroll : {}) as Record<string, unknown>;
  const number = (item: unknown) => (typeof item === "number" && Number.isFinite(item) ? Math.max(0, Math.round(item)) : 0);
  const elements = (Array.isArray(page.elements) ? page.elements : []).slice(0, RESEARCH_LIMITS.maxElements).flatMap((item): ResearchElement[] => {
    const element = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
    if (typeof element.n !== "number" || !Number.isSafeInteger(element.n)) return [];
    const kind = ["link", "button", "input", "select", "tab", "other"].includes(String(element.kind)) ? element.kind as ResearchElement["kind"] : "other";
    const href = typeof element.href === "string" && /^https?:\/\//i.test(element.href) ? element.href.slice(0, 2_000) : null;
    const field = fieldOf(element.field);
    return [{ n: element.n, kind, label: clip(element.label, RESEARCH_LIMITS.maxLabelChars), href, write: element.write === true, search: element.search === true, ...(field ? { field } : {}) }];
  });
  return {
    url: clip(page.url, 2_000),
    title: clip(page.title, 300),
    text: clip(page.text, RESEARCH_LIMITS.maxTextChars),
    elements,
    scroll: { y: number(scroll.y), height: number(scroll.height), viewport: number(scroll.viewport) },
    attention: attentionOf(page.attention),
    readAt: typeof page.readAt === "string" && Number.isFinite(Date.parse(page.readAt)) ? new Date(page.readAt).toISOString() : new Date().toISOString(),
  };
}

/** What the extension answered, with every field bounded and typed; page text stays untrusted data. */
export function parseResultRequest(value: unknown): BrowserCommandResultRequest {
  const body = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  if (typeof body.seq !== "number" || !Number.isSafeInteger(body.seq)) throw new BrowserBridgeError(400, "seq is missing");
  const result = (body.result && typeof body.result === "object" ? body.result : {}) as Record<string, unknown>;
  const tabId = typeof result.tabId === "number" && Number.isSafeInteger(result.tabId) ? result.tabId : undefined;
  if (result.ok !== true) {
    return { seq: body.seq, result: { ok: false, error: clip(result.error, 500) || "the browser could not do it", ...(tabId === undefined ? {} : { tabId }), attention: attentionOf(result.attention) } };
  }
  const tabs = Array.isArray(result.tabs)
    ? result.tabs.slice(0, 40).flatMap((item) => {
      const tab = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
      return typeof tab.tabId === "number" && Number.isSafeInteger(tab.tabId)
        ? [{ tabId: tab.tabId, url: clip(tab.url, 2_000), title: clip(tab.title, 300), shared: tab.shared === true, attention: attentionOf(tab.attention) }]
        : [];
    })
    : undefined;
  return {
    seq: body.seq,
    result: {
      ok: true,
      ...(tabId === undefined ? {} : { tabId }),
      ...(result.snapshot ? { snapshot: snapshotOf(result.snapshot) } : {}),
      ...(tabs ? { tabs } : {}),
      ...(typeof result.closed === "number" && Number.isSafeInteger(result.closed) ? { closed: result.closed } : {}),
      ...(screenshotOf(result.screenshot) ? { screenshot: screenshotOf(result.screenshot) } : {}),
      ...(typeof result.note === "string" && result.note ? { note: clip(result.note, 500) } : {}),
    },
  };
}

function hostOf(url: string | undefined): string | null {
  try {
    return url ? new URL(url).hostname.replace(/^www\./, "") : null;
  } catch {
    return null;
  }
}

/**
 * The extension's answer to command `commandId`: accepted once, from the
 * browser it was handed to, before its deadline. Anything else (a replay, a
 * late answer, another browser's command) is refused and changes nothing.
 */
export async function completeCommand(row: BrowserConnectionRow, commandId: string, body: BrowserCommandResultRequest, now = new Date()): Promise<void> {
  if (!/^[0-9a-f-]{36}$/i.test(commandId)) throw new BrowserBridgeError(404, "No such command.");
  const { result } = body;
  const [done] = await db.update(browserCommands).set({ status: result.ok ? "done" : "failed", result, error: result.ok ? null : result.error, finishedAt: now })
    .where(and(inOrg(browserCommands), eq(browserCommands.id, commandId), eq(browserCommands.connectionId, row.id), eq(browserCommands.seq, body.seq), eq(browserCommands.status, "delivered"), gt(browserCommands.expiresAt, new Date(now.getTime() - ANSWER_GRACE_MS))))
    .returning({ id: browserCommands.id });
  if (!done) throw new BrowserBridgeError(409, "This command is not waiting for an answer from this browser (already answered, expired or not its own).");
  const attention = result.ok ? result.snapshot?.attention ?? null : result.attention ?? null;
  const host = hostOf(result.ok ? result.snapshot?.url : undefined);
  if (attention) {
    await db.update(browserConnections).set({ attention: { ...attention, host, at: now.toISOString() } })
      .where(and(inOrg(browserConnections), eq(browserConnections.id, row.id)));
  } else if (result.ok && result.snapshot && row.attention && (!row.attention.host || row.attention.host === host)) {
    // A page of that site read fine: it no longer needs the owner.
    await db.update(browserConnections).set({ attention: null }).where(and(inOrg(browserConnections), eq(browserConnections.id, row.id)));
  }
  bus.emit(`finished:${commandId}`);
}

// --- The assistant's side -------------------------------------------------------

async function activeConnection(userId: string): Promise<BrowserConnectionRow | null> {
  const [row] = await db.select().from(browserConnections)
    .where(and(inOrg(browserConnections), eq(browserConnections.userId, userId), eq(browserConnections.status, "active")))
    .orderBy(desc(browserConnections.pairedAt)).limit(1);
  return row ?? null;
}

function stateOf(row: BrowserConnectionRow | null, now: Date): BrowserConnectionState {
  if (!row) return "none";
  if (!row.lastSeenAt || now.getTime() - row.lastSeenAt.getTime() > ONLINE_WITHIN_MS) return "offline";
  if (row.paused) return "paused";
  if (row.attention && now.getTime() - Date.parse(row.attention.at) < ATTENTION_TTL_MS) return "needs_attention";
  return "connected";
}

/** The person's browser as the chat shows it. */
export async function browserConnectionView(userId: string, now = new Date()): Promise<BrowserConnectionView> {
  const row = await activeConnection(userId);
  const state = stateOf(row, now);
  return {
    state,
    connectionId: row?.id ?? null,
    deviceLabel: row?.deviceLabel ?? null,
    sites: row?.sites ?? [],
    domains: row?.domains ?? [],
    lastSeenAt: row?.lastSeenAt?.toISOString() ?? null,
    attention: state === "needs_attention" ? row!.attention : null,
    extensionVersion: row?.extensionVersion ?? null,
  };
}

/** The shared tabs and attention the connection last reported (for tools that read without a round trip). */
export async function browserConnection(userId: string): Promise<{ row: BrowserConnectionRow | null; state: BrowserConnectionState }> {
  const row = await activeConnection(userId);
  return { row, state: stateOf(row, new Date()) };
}

function minutesAgo(at: Date | null, now: Date): string {
  if (!at) return "never seen";
  const minutes = Math.round((now.getTime() - at.getTime()) / 60_000);
  return minutes < 1 ? "seen moments ago" : `last seen ${minutes} minute${minutes === 1 ? "" : "s"} ago`;
}

/**
 * Queues `action` on the acting person's own browser for `requestId` and
 * waits for its answer, at most `timeoutMs`. Refuses at once when nothing is
 * connected, the browser is offline or the owner pressed Stop. A command
 * the browser never answered is expired, not repeated.
 */
export async function runBrowserAction(input: {
  userId: string;
  threadId: string | null;
  requestId: string;
  action: BrowserResearchAction;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<BrowserResearchResult> {
  const now = new Date();
  const connection = await activeConnection(input.userId);
  const state = stateOf(connection, now);
  if (!connection) throw new BrowserConnectionError("none", "No browser is connected: the owner presses Connect browser in the chat once (the AgentSDR extension must be installed in Chrome).");
  if (state === "offline") throw new BrowserConnectionError("offline", `The owner's browser is offline (${minutesAgo(connection.lastSeenAt, now)}): Chrome is closed or asleep, or the extension stopped. Nothing was opened.`);
  if (state === "paused") throw new BrowserConnectionError("paused", "The owner pressed Stop in their browser's extension: nothing runs there until they resume it.");
  if (input.signal?.aborted) throw new BrowserConnectionError("cancelled", "This turn was cancelled; nothing was sent to the browser.");
  const expiresAt = new Date(now.getTime() + input.timeoutMs);
  const command = await db.transaction(async (tx) => {
    const [next] = await tx.update(browserConnections).set({ commandSeq: sql`${browserConnections.commandSeq} + 1` })
      .where(and(inOrg(browserConnections), eq(browserConnections.id, connection.id), eq(browserConnections.status, "active")))
      .returning({ seq: browserConnections.commandSeq });
    if (!next) throw new BrowserConnectionError("none", "The owner's browser was just disconnected.");
    const [row] = await tx.insert(browserCommands).values({
      organizationId: currentOrganizationId(),
      connectionId: connection.id,
      seq: next.seq,
      threadId: input.threadId,
      requestId: input.requestId,
      action: input.action,
      expiresAt,
    }).returning();
    return row!;
  });
  bus.emit(`queued:${connection.id}`);
  while (Date.now() < expiresAt.getTime() + ANSWER_GRACE_MS && !input.signal?.aborted) {
    const [row] = await db.select({ status: browserCommands.status, result: browserCommands.result, error: browserCommands.error })
      .from(browserCommands).where(and(inOrg(browserCommands), eq(browserCommands.id, command.id))).limit(1);
    if (row?.status === "done" || row?.status === "failed") return row.result ?? { ok: false, error: row.error ?? "the browser could not do it" };
    if (row?.status === "expired") break;
    await waitFor(`finished:${command.id}`, 500, input.signal);
  }
  const [ended] = await db.update(browserCommands).set({ status: "expired", finishedAt: new Date(), error: input.signal?.aborted ? "cancelled" : "not answered in time" })
    .where(and(inOrg(browserCommands), eq(browserCommands.id, command.id), inArray(browserCommands.status, ["pending", "delivered"])))
    .returning({ deliveredAt: browserCommands.deliveredAt });
  if (!ended) {
    // Answered between the last look and the expiry, or expired by the poll: read what it says.
    const [row] = await db.select({ status: browserCommands.status, result: browserCommands.result, error: browserCommands.error, deliveredAt: browserCommands.deliveredAt })
      .from(browserCommands).where(and(inOrg(browserCommands), eq(browserCommands.id, command.id))).limit(1);
    if (row?.status === "done" || row?.status === "failed") return row.result ?? { ok: false, error: row.error ?? "the browser could not do it" };
    if (input.signal?.aborted) throw new BrowserConnectionError("cancelled", row?.deliveredAt ? "This turn was cancelled after the browser took the step, before it answered." : "This turn was cancelled before the browser took the step; it was not run.");
    throw new BrowserConnectionError("timeout", row?.deliveredAt
      ? "The owner's browser took the step but did not answer in time (the page may be frozen, or Chrome suspended the extension); it was not repeated."
      : "The owner's browser did not pick the step up in time (asleep, or the extension stopped); it was not run.");
  }
  if (input.signal?.aborted) throw new BrowserConnectionError("cancelled", ended.deliveredAt ? "This turn was cancelled after the browser took the step, before it answered." : "This turn was cancelled before the browser took the step; it was not run.");
  throw new BrowserConnectionError("timeout", ended.deliveredAt
    ? "The owner's browser took the step but did not answer in time (the page may be frozen, or Chrome suspended the extension); it was not repeated."
    : "The owner's browser did not pick the step up in time (asleep, or the extension stopped); it was not run.");
}

/** The latest reading of `tabId` this request got, for checking a click or a search against what the model saw. */
export async function latestTabSnapshot(userId: string, requestId: string, tabId: number): Promise<ResearchSnapshot | null> {
  const connection = await activeConnection(userId);
  if (!connection) return null;
  const rows = await db.select({ result: browserCommands.result }).from(browserCommands)
    .where(and(inOrg(browserCommands), eq(browserCommands.connectionId, connection.id), eq(browserCommands.requestId, requestId), eq(browserCommands.status, "done"), sql`(${browserCommands.result}->>'tabId')::bigint = ${tabId}`, sql`${browserCommands.result} ? 'snapshot'`))
    .orderBy(desc(browserCommands.seq)).limit(1);
  const result = rows[0]?.result;
  return result?.ok ? result.snapshot ?? null : null;
}

/**
 * The latest screenshot of `tabId` this request got, without its image: a
 * visual step must point into it. Null when a later step on that tab that
 * may have changed it (anything but a read) came after, or none was taken.
 */
export async function latestTabScreenshot(userId: string, requestId: string, tabId: number): Promise<BrowserScreenshotFacts | null> {
  const connection = await activeConnection(userId);
  if (!connection) return null;
  const rows = await db.select({ action: browserCommands.action, shot: sql<BrowserScreenshotFacts | null>`(${browserCommands.result}->'screenshot') - 'data'::text` }).from(browserCommands)
    .where(and(inOrg(browserCommands), eq(browserCommands.connectionId, connection.id), eq(browserCommands.requestId, requestId), sql`${browserCommands.action}->>'tabId' = ${String(tabId)}`, ne(sql`${browserCommands.action}->>'kind'`, "read")))
    .orderBy(desc(browserCommands.seq)).limit(1);
  const latest = rows[0];
  return latest && (latest.action.kind === "screenshot" || latest.action.kind === "visual") ? latest.shot ?? null : null;
}

/**
 * A change on `tabId` the browser took but never answered (it may have
 * happened) that no later reading or screenshot of the tab has checked:
 * its label, or null. Another change waits for that look, so a lost
 * acknowledgment is never answered by doing it again blind.
 */
export async function uncheckedChange(userId: string, requestId: string, tabId: number): Promise<string | null> {
  const connection = await activeConnection(userId);
  if (!connection) return null;
  const rows = await db.select({ action: browserCommands.action, status: browserCommands.status, deliveredAt: browserCommands.deliveredAt }).from(browserCommands)
    .where(and(inOrg(browserCommands), eq(browserCommands.connectionId, connection.id), eq(browserCommands.requestId, requestId), sql`${browserCommands.action}->>'tabId' = ${String(tabId)}`))
    .orderBy(desc(browserCommands.seq)).limit(20);
  for (const row of rows) {
    if (row.status === "done" && ["read", "screenshot", "scroll"].includes(row.action.kind)) return null;
    if (row.status === "expired" && row.deliveredAt && (row.action.kind === "act" || (row.action.kind === "visual" && row.action.grant))) {
      return row.action.kind === "act" ? `${row.action.op} on “${row.action.label}”` : `${row.action.op} at (${row.action.x}, ${row.action.y})`;
    }
  }
  return null;
}

/** A screenshot's image is passed to the model once; the row keeps what it was, not the picture of the owner's page. */
export async function dropScreenshotImage(userId: string, requestId: string, shotId: string): Promise<void> {
  const connection = await activeConnection(userId);
  if (!connection) return;
  await db.update(browserCommands).set({ result: sql`jsonb_set(${browserCommands.result}, '{screenshot,data}', '""'::jsonb)` })
    .where(and(inOrg(browserCommands), eq(browserCommands.connectionId, connection.id), eq(browserCommands.requestId, requestId), sql`${browserCommands.result}->'screenshot'->>'id' = ${shotId}`));
}

/**
 * At the end of a turn: the request's tabs close (those waiting for the owner
 * stay). Queued without waiting, and only when this request used the
 * browser and the browser is online; the extension also closes idle tabs
 * itself.
 */
export async function releaseBrowserTabs(userId: string, threadId: string | null, requestId: string): Promise<void> {
  const connection = await activeConnection(userId);
  if (!connection || stateOf(connection, new Date()) === "offline") return;
  const [used] = await db.select({ id: browserCommands.id }).from(browserCommands)
    .where(and(inOrg(browserCommands), eq(browserCommands.connectionId, connection.id), eq(browserCommands.requestId, requestId), gt(browserCommands.createdAt, new Date(Date.now() - 6 * 3_600_000))))
    .orderBy(asc(browserCommands.seq)).limit(1);
  if (!used) return;
  await db.transaction(async (tx) => {
    const [next] = await tx.update(browserConnections).set({ commandSeq: sql`${browserConnections.commandSeq} + 1` })
      .where(and(inOrg(browserConnections), eq(browserConnections.id, connection.id), eq(browserConnections.status, "active")))
      .returning({ seq: browserConnections.commandSeq });
    if (!next) return;
    await tx.insert(browserCommands).values({ organizationId: currentOrganizationId(), connectionId: connection.id, seq: next.seq, threadId, requestId, action: { kind: "release" }, expiresAt: new Date(Date.now() + 2 * 60_000) });
  });
  bus.emit(`queued:${connection.id}`);
}
