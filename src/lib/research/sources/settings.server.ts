import "server-only";

import { db } from "@/lib/db";
import { isMissingTable } from "@/lib/features/flags.server";
import { quotaState, usedToday } from "@/lib/quota/quota.server";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";
import { researchSettings } from "../sourcesSchema";
import {
  HACKER_NEWS_LIMITS,
  HACKER_NEWS_PROVIDER,
  HACKER_NEWS_SCOPE,
  REDDIT_NOTE_MAX,
  RESEARCH_API_PRODUCT,
  STACK_EXCHANGE_LIMITS,
  STACK_EXCHANGE_PROVIDER,
  STACK_EXCHANGE_SCOPE,
  type ResearchSourceUsage,
  type ResearchSourcesView,
} from "./catalog";
import { redditClientHint } from "./reddit";

/**
 * Settings → Lead research → Research sources: Hacker News and Stack
 * Exchange use (nothing to configure), and the organization's record of
 * Reddit's approval. Recording approval enables nothing: there is no Reddit
 * reader.
 */

export class ResearchSourcesSettingsError extends Error {}

type SettingsRow = typeof researchSettings.$inferSelect;

async function settingsRow(): Promise<SettingsRow | null> {
  try {
    const [row] = await db.select().from(researchSettings).where(inOrg(researchSettings)).limit(1);
    return row ?? null;
  } catch (error) {
    if (isMissingTable(error)) return null;
    throw error;
  }
}

/** Whether this organization recorded Reddit's approval (read_webpage says so when refusing Reddit). */
export async function redditApprovalRecorded(): Promise<boolean> {
  return Boolean((await settingsRow())?.redditApprovalRecordedAt);
}

async function usage(provider: string, scopeKey: string): Promise<ResearchSourceUsage> {
  const [mine, server] = await Promise.all([usedToday(provider, RESEARCH_API_PRODUCT), quotaState(scopeKey, provider, RESEARCH_API_PRODUCT)]);
  return {
    usedToday: mine,
    serverUsedToday: server.dayUsed,
    waitingUntil: server.blockedUntil?.toISOString() ?? null,
    waitingReason: server.blockedReason,
  };
}

export async function researchSourcesView(): Promise<ResearchSourcesView> {
  const [row, hackerNews, stackExchange] = await Promise.all([
    settingsRow(),
    usage(HACKER_NEWS_PROVIDER, HACKER_NEWS_SCOPE),
    usage(STACK_EXCHANGE_PROVIDER, STACK_EXCHANGE_SCOPE),
  ]);
  return {
    hackerNews: { ...hackerNews, perMinute: HACKER_NEWS_LIMITS.perMinute },
    stackExchange: { ...stackExchange, perDay: STACK_EXCHANGE_LIMITS.perDay },
    reddit: {
      readerBuilt: false,
      approvalRecordedAt: row?.redditApprovalRecordedAt?.toISOString() ?? null,
      approvalNote: row?.redditApprovalNote ?? null,
      clientHint: row?.redditClientHint ?? null,
      updatedAt: row?.updatedAt.toISOString() ?? null,
    },
  };
}

/**
 * Records or withdraws Reddit's approval. `redditClientId`, when given, is
 * kept only as its last four characters; an empty string clears it.
 */
export async function saveResearchSources(
  input: { redditApproved?: unknown; redditApprovalNote?: unknown; redditClientId?: unknown },
  userId: string | null,
): Promise<ResearchSourcesView> {
  const current = await settingsRow();
  let recordedAt = current?.redditApprovalRecordedAt ?? null;
  if (input.redditApproved !== undefined) {
    if (typeof input.redditApproved !== "boolean") throw new ResearchSourcesSettingsError("Reddit approval must be on or off");
    // Keep the original time while it stays recorded.
    recordedAt = input.redditApproved ? (recordedAt ?? new Date()) : null;
  }
  let note = current?.redditApprovalNote ?? null;
  if (input.redditApprovalNote !== undefined) {
    if (input.redditApprovalNote !== null && typeof input.redditApprovalNote !== "string") throw new ResearchSourcesSettingsError("The note must be text");
    const text = (input.redditApprovalNote ?? "").trim();
    if (text.length > REDDIT_NOTE_MAX) throw new ResearchSourcesSettingsError(`The note can be at most ${REDDIT_NOTE_MAX} characters`);
    note = text || null;
  }
  let hint = current?.redditClientHint ?? null;
  if (input.redditClientId !== undefined) {
    if (input.redditClientId !== null && typeof input.redditClientId !== "string") throw new ResearchSourcesSettingsError("The client id must be text");
    const id = (input.redditClientId ?? "").trim();
    if (id.length > 100 || /\s/.test(id)) throw new ResearchSourcesSettingsError("That does not look like a Reddit client id");
    hint = redditClientHint(id);
  }
  const values = { redditApprovalRecordedAt: recordedAt, redditApprovalNote: note, redditClientHint: hint, updatedBy: userId, updatedAt: new Date() };
  await db.insert(researchSettings).values({ organizationId: currentOrganizationId(), ...values })
    .onConflictDoUpdate({ target: researchSettings.organizationId, set: values });
  return researchSourcesView();
}
