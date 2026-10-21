import "server-only";

import { and, eq, ne, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { gridProviders } from "@/lib/grid/schema";
import { isOrganizationOwner, operatorOrganizationId } from "@/lib/auth/operator.server";
import { members } from "@/lib/auth/schema";
import type { OrgRole } from "@/lib/auth/permissions";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";
import { accountAuthStatus, cliVersion, type ClaudeAccount } from "./cli.server";
import { isClaudeCodeModel, type ClaudeCodeModel, type ClaudeCodeModelCheck, type ClaudeCodeStatus } from "./contract";
import { loginController } from "./login.server";
import { accountUsage, ClaudeCodeError, runGeneration, runningOn } from "./runner.server";

/**
 * Whether an organization's AI steps run on Claude Code, and on whose login.
 *
 * One `grid_providers` row per organization keyed `claude-code-engine`
 * (no credentials in it: the CLI keeps its own login on disk). Selecting the
 * engine binds the organization to the owner who signed in; only that
 * person's login ever answers for it, and only while they are still an
 * owner. Until an owner selects it, nothing changes: the API provider and
 * its default model stay in use.
 *
 * Owner-only pilot: only an owner of the platform operator's organization
 * (the team running this server) can sign in or select it, and only while
 * that owner is the organization's only member, so one person's
 * subscription never answers for anyone else's work.
 */

const KEY = "claude-code-engine";

export type ClaudeEngine = {
  selected: boolean;
  ownerUserId: string | null;
  model: ClaudeCodeModel;
  /** Model checks per person: each login's own results, never shared. */
  checks: Record<string, Partial<Record<ClaudeCodeModel, ClaudeCodeModelCheck>>>;
};

const EMPTY: ClaudeEngine = { selected: false, ownerUserId: null, model: "default", checks: {} };

function normalizeCheck(value: unknown): ClaudeCodeModelCheck | null {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : null;
  if (!record || typeof record.checkedAt !== "string") return null;
  if (record.ok === true && typeof record.modelId === "string") return { ok: true, modelId: record.modelId, checkedAt: record.checkedAt };
  if (record.ok === false && typeof record.error === "string") return { ok: false, error: record.error, checkedAt: record.checkedAt };
  return null;
}

export function normalizeClaudeEngine(value: unknown): ClaudeEngine {
  const raw = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const checks: ClaudeEngine["checks"] = {};
  const byUser = raw.checks && typeof raw.checks === "object" ? raw.checks as Record<string, unknown> : {};
  for (const [userId, models] of Object.entries(byUser)) {
    if (!models || typeof models !== "object") continue;
    for (const [model, check] of Object.entries(models as Record<string, unknown>)) {
      const normalized = normalizeCheck(check);
      if (normalized && isClaudeCodeModel(model)) (checks[userId] ??= {})[model] = normalized;
    }
  }
  const ownerUserId = typeof raw.ownerUserId === "string" && raw.ownerUserId ? raw.ownerUserId : null;
  return {
    selected: raw.selected === true && ownerUserId !== null,
    ownerUserId,
    model: isClaudeCodeModel(raw.model) ? raw.model : "default",
    checks,
  };
}

/** Read on every structured call, so cached per organization for 30 s like other settings; a save here updates it at once. */
const ENGINE_CACHE_MS = 30_000;
/** Membership changes reach the gate within this. */
const MEMBERS_CACHE_MS = 10_000;
// On globalThis: route handlers and the workers started from instrumentation.ts can load separate copies of this module.
type EngineCaches = { engines: Map<string, { engine: ClaudeEngine; at: number }>; members: Map<string, { count: number; at: number }>; operator: { id: string | null; at: number } | null };
const cacheHolder = globalThis as typeof globalThis & { __agentsdrClaudeEngineCaches?: EngineCaches };
const caches = (cacheHolder.__agentsdrClaudeEngineCaches ??= { engines: new Map(), members: new Map(), operator: null });
const engineCache = caches.engines;
const membersCache = caches.members;

export async function getClaudeEngine(): Promise<ClaudeEngine> {
  const organizationId = currentOrganizationId();
  const cached = engineCache.get(organizationId);
  if (cached && Date.now() - cached.at < ENGINE_CACHE_MS) return cached.engine;
  const [row] = await db.select({ config: gridProviders.config }).from(gridProviders)
    .where(and(inOrg(gridProviders), eq(gridProviders.key, KEY))).limit(1);
  const engine = row ? normalizeClaudeEngine(row.config) : EMPTY;
  engineCache.set(organizationId, { engine, at: Date.now() });
  return engine;
}

export async function saveClaudeEngine(engine: ClaudeEngine): Promise<ClaudeEngine> {
  const value = normalizeClaudeEngine(engine);
  await db.insert(gridProviders)
    .values({ organizationId: currentOrganizationId(), key: KEY, name: "Claude Code engine", config: value, enabled: true })
    .onConflictDoUpdate({ target: [gridProviders.organizationId, gridProviders.key], set: { config: value, updatedAt: new Date() } });
  engineCache.set(currentOrganizationId(), { engine: value, at: Date.now() });
  return value;
}

let operatorOverride: string | null = null;
/** e2e: a disposable database already has an operator organization; the check runs in its own. */
export function setOperatorOrganizationForTests(id: string | null): void {
  operatorOverride = id;
  resetClaudeEngineCachesForTests();
}
export function resetClaudeEngineCachesForTests(): void {
  engineCache.clear();
  membersCache.clear();
}
async function operatorOrganization(): Promise<string | null> {
  if (operatorOverride) return operatorOverride;
  if (caches.operator && Date.now() - caches.operator.at < 60_000) return caches.operator.id;
  const id = await operatorOrganizationId();
  caches.operator = { id, at: Date.now() };
  return id;
}

/** The pilot gate for one person in their active organization. */
export async function claudeCodeAccess(ctx: { organizationId: string; roles: readonly OrgRole[] }): Promise<{ allowed: boolean; reason?: string }> {
  if (!ctx.roles.includes("owner")) return { allowed: false, reason: "Only an owner can connect Claude Code." };
  if (ctx.organizationId !== (await operatorOrganization())) {
    return { allowed: false, reason: "Claude Code is a pilot for the organization that runs this server; each person uses their own Claude account." };
  }
  return { allowed: true };
}

/**
 * Why this organization cannot run on `ownerUserId`'s login, or null. While
 * anyone else is a member, their chats and the work they start would run on
 * that one person's Claude account, which the pilot does not allow.
 */
export async function claudeCodeBlocked(organizationId: string, ownerUserId: string): Promise<string | null> {
  const others = await otherMembers(organizationId, ownerUserId);
  if (!others) return null;
  return `This organization has ${others} other ${others === 1 ? "member" : "members"}. Their chats and the work they start would run on one person's Claude account, so Claude Code is only for an organization whose only member is the owner who signs in. Use an API provider, or remove the other members first.`;
}

async function otherMembers(organizationId: string, userId: string): Promise<number> {
  const key = `${organizationId}:${userId}`;
  const cached = membersCache.get(key);
  if (cached && Date.now() - cached.at < MEMBERS_CACHE_MS) return cached.count;
  const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(members)
    .where(and(eq(members.organizationId, organizationId), ne(members.userId, userId)));
  const count = row?.count ?? 0;
  membersCache.set(key, { count, at: Date.now() });
  return count;
}

/**
 * The login that answers this organization's AI steps, or null when Claude
 * Code is not selected (the API provider answers, as before). Selected but
 * unusable is an error, never a quiet switch to a paid API.
 */
export async function claudeCodeBinding(): Promise<{ account: ClaudeAccount; model: ClaudeCodeModel } | null> {
  const engine = await getClaudeEngine();
  if (!engine.selected || !engine.ownerUserId) return null;
  const organizationId = currentOrganizationId();
  if (organizationId !== (await operatorOrganization())) {
    throw new ClaudeCodeError("error", "Claude Code is selected, but it is a pilot for the organization that runs this server only. Choose an AI provider in Settings → AI provider.");
  }
  if (!(await isOrganizationOwner(organizationId, engine.ownerUserId))) {
    throw new ClaudeCodeError("not_signed_in", "Claude Code is selected, but the person whose Claude login it uses is no longer an owner here. An owner must sign in with their own account or choose another AI provider in Settings → AI provider.");
  }
  const blocked = await claudeCodeBlocked(organizationId, engine.ownerUserId);
  if (blocked) throw new ClaudeCodeError("error", `Claude Code is selected, but it cannot run here: ${blocked}`);
  return { account: { organizationId, userId: engine.ownerUserId }, model: engine.model };
}

let versionCache: { version: string | null; at: number } | null = null;
async function cachedVersion(): Promise<string | null> {
  if (versionCache && Date.now() - versionCache.at < 60_000) return versionCache.version;
  const version = await cliVersion().catch(() => null);
  versionCache = { version, at: Date.now() };
  return version;
}

/** Everything the settings card shows for this person. */
export async function claudeCodeStatus(ctx: { organizationId: string; userId: string; roles: readonly OrgRole[] }): Promise<ClaudeCodeStatus> {
  const access = await claudeCodeAccess(ctx);
  const engine = await getClaudeEngine();
  const base: ClaudeCodeStatus = {
    allowed: access.allowed,
    ...(access.reason ? { reason: access.reason } : {}),
    cli: null,
    account: { signedIn: null, method: null, expired: false },
    signIn: null,
    engine: { selected: engine.selected, ownerUserId: engine.ownerUserId, ownedByYou: engine.ownerUserId === ctx.userId, model: engine.model, checks: engine.checks[ctx.userId] ?? {}, blocked: null },
    running: 0,
    limits: [],
    windows: [],
    windowsReportedAt: null,
  };
  if (!access.allowed) return base;
  const account = { organizationId: ctx.organizationId, userId: ctx.userId };
  const blocked = await claudeCodeBlocked(ctx.organizationId, ctx.userId);
  const version = await cachedVersion();
  if (!version) return { ...base, engine: { ...base.engine, blocked }, cliError: "Claude Code is not installed on this server, or will not run. See docs/plans/CLAUDE_CODE_LOGIN.md to install it." };
  const auth = await accountAuthStatus(account);
  const usage = accountUsage(account);
  // A generation refused as signed out outranks a status that still says signed in.
  const expired = usage.signedOutAt !== null;
  return {
    ...base,
    cli: { version },
    account: { signedIn: auth.state === "unknown" ? null : auth.state === "in" && !expired, method: auth.own ? auth.method : null, expired },
    engine: { ...base.engine, blocked },
    signIn: loginController(account, () => runningOn(account)).current(),
    running: usage.running,
    limits: usage.limits,
    windows: usage.windows,
    windowsReportedAt: usage.windowsAt,
  };
}

const CHECK_SCHEMA = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false };

/**
 * Whether this login can use `model`: one short generation on the person's
 * own account (it counts toward their usage like any other), recording the
 * model id the CLI actually ran, or why it could not.
 */
export async function checkClaudeModel(account: ClaudeAccount, model: ClaudeCodeModel): Promise<ClaudeCodeModelCheck> {
  const checkedAt = new Date().toISOString();
  try {
    const result = await runGeneration({
      account,
      model,
      systemPrompt: "You are answering a connection check. Set ok to true.",
      userPrompt: "Connection check.",
      jsonSchema: CHECK_SCHEMA,
      timeoutMs: 90_000,
      ignoreHolds: true,
    });
    const answer: unknown = JSON.parse(result.text || "null");
    if (!answer || typeof answer !== "object" || (answer as { ok?: unknown }).ok !== true) {
      return { ok: false, error: "The model answered, but not with the check's answer.", checkedAt };
    }
    return { ok: true, modelId: result.modelId ?? model, checkedAt };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error), checkedAt };
  }
}
