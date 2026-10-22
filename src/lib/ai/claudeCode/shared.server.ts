import "server-only";

import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { organizations } from "@/lib/auth/schema";
import { gridProviders } from "@/lib/grid/schema";
import { isOrganizationOwner, isPlatformOperatorUser, operatorOrganizationId } from "@/lib/auth/operator.server";
import { currentOrganizationId, runInOrganization } from "@/lib/tenancy/scope";
import { serviceMode } from "@/lib/managed/modes.server";
import { getManagedAiSettings, PlatformCredentialError } from "@/lib/managed/store.server";
import type { ManagedAiSettings } from "@/lib/managed/catalog";
import { accountAuthStatus, hasOwnLogin, accountPaths } from "./cli.server";
import { getClaudeEngine, normalizeClaudeEngine } from "./engine.server";
import { isClaudeCodeModel, type ClaudeCodeModel, type ClaudeCodeModelCheck } from "./contract";
import { accountUsage, ClaudeCodeError } from "./runner.server";

/** Global configuration is operator-only; the borrowing workspace's scope never changes. */
export function sharedClaudeApproved(settings: ManagedAiSettings, organizationId: string): boolean {
  return settings.engine === "claude-code" && Boolean(settings.sharedClaude?.approvedOrganizationIds.includes(organizationId));
}

async function sourceValid(settings: ManagedAiSettings): Promise<boolean> {
  const source = settings.sharedClaude;
  return Boolean(source && source.organizationId === await operatorOrganizationId()
    && await isPlatformOperatorUser(source.userId)
    && await isOrganizationOwner(source.organizationId, source.userId));
}

/** Called only by the guarded operator PUT; never accepts another operator's login. */
export async function validateSharedClaudeSettings(settings: ManagedAiSettings, userId: string): Promise<void> {
  const source = settings.sharedClaude;
  if (!source || source.userId !== userId || !await sourceValid(settings)) throw new PlatformCredentialError("Use your own Claude Code login in the server's original workspace.");
  if (!source.approvedOrganizationIds.length) throw new PlatformCredentialError("Select at least one private test workspace.");
  const rows = await db.select({ id: organizations.id }).from(organizations).where(inArray(organizations.id, source.approvedOrganizationIds));
  if (rows.length !== source.approvedOrganizationIds.length) throw new PlatformCredentialError("One of the selected workspaces no longer exists.");
  const engine = await runInOrganization(source.organizationId, () => getClaudeEngine());
  const model = settings.defaultModel?.modelId;
  if (!isClaudeCodeModel(model) || !engine.checks[userId]?.[model]?.ok) throw new PlatformCredentialError("Check this model on your Claude Code account first.");
  if ((await accountAuthStatus(source)).state !== "in" || accountUsage(source).signedOutAt) throw new PlatformCredentialError("Sign in to Claude Code first.");
}

/** A managed request resolves only its credential binding, never another workspace's prompts or data. */
export async function sharedClaudeBinding() {
  if (await serviceMode("ai") !== "managed") return null;
  const settings = await getManagedAiSettings();
  if (settings.engine !== "claude-code") return null;
  const unavailable = () => new ClaudeCodeError("error", "The included private-test AI is unavailable for this workspace. Ask the platform operator to check its access and connection. No paid API was used.");
  if (!sharedClaudeApproved(settings, currentOrganizationId()) || !await sourceValid(settings)) throw unavailable();
  const account = settings.sharedClaude!;
  // Credential-binding metadata only, after approval and source-owner checks.
  // Never enter the source organization's scope: the task's scope is immutable.
  const [row] = await db.select({ config: gridProviders.config }).from(gridProviders)
    .where(and(eq(gridProviders.organizationId, account.organizationId), eq(gridProviders.key, "claude-code-engine"))).limit(1);
  const engine = normalizeClaudeEngine(row?.config);
  const model = settings.defaultModel?.modelId;
  if (!isClaudeCodeModel(model) || !engine.checks[account.userId]?.[model]?.ok || !hasOwnLogin(accountPaths(account, false))) throw unavailable();
  return { account: { organizationId: account.organizationId, userId: account.userId }, model, shared: true as const };
}

/** The source workspace may also test with friends as members, when explicitly approved. */
export async function sharedClaudeSourceApproved(organizationId: string, userId: string): Promise<boolean> {
  const settings = await getManagedAiSettings();
  return sharedClaudeApproved(settings, organizationId) && settings.sharedClaude?.organizationId === organizationId
    && settings.sharedClaude.userId === userId && await sourceValid(settings);
}

/** Only the source owner sees this, so their personal controls cannot misreport a global switch. */
export async function sharedClaudeAccountPublished(organizationId: string, userId: string): Promise<boolean> {
  const settings = await getManagedAiSettings();
  return settings.engine === "claude-code" && settings.sharedClaude?.organizationId === organizationId
    && settings.sharedClaude.userId === userId && await sourceValid(settings);
}

/** Operator-only status. This route returns no secrets or account tokens. */
export async function privateClaudeStatus(userId: string) {
  const workspaces = await db.select({ id: organizations.id, name: organizations.name }).from(organizations).orderBy(organizations.name);
  const organizationId = await operatorOrganizationId();
  if (!organizationId || !await isOrganizationOwner(organizationId, userId)) {
    return { source: null, checks: {} as Partial<Record<ClaudeCodeModel, ClaudeCodeModelCheck>>, workspaces, limits: [], problem: "Sign in as an owner of the server's original workspace to share your Claude Code login." };
  }
  const source = { organizationId, userId };
  const engine = await runInOrganization(organizationId, () => getClaudeEngine());
  const auth = await accountAuthStatus(source);
  const usage = accountUsage(source);
  return { source, checks: engine.checks[userId] ?? {}, workspaces, limits: usage.limits, problem: auth.state !== "in" || usage.signedOutAt ? "Sign in to Claude Code in AI provider settings, then check the model you want to use." : null };
}
