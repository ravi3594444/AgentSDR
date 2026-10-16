import "server-only";

import { and, desc, eq, isNull, lt, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";
import { threadTitleFrom } from "./agent";
import { assistantMessages, assistantThreads, type AssistantAttachment, type AssistantRole, type AssistantToolStatus } from "./schema";

/** Chat threads and their messages, scoped to the organization in scope. */

const BUSY_TIMEOUT_MS = 5 * 60_000;

export async function getThread(threadId: string) {
  const [thread] = await db.select().from(assistantThreads).where(and(inOrg(assistantThreads), eq(assistantThreads.id, threadId))).limit(1);
  return thread ?? null;
}

/** The given thread, else the latest one, else a new one. */
export async function resolveThread(threadId: string | null, userId: string | null) {
  if (threadId) {
    const thread = await getThread(threadId);
    if (thread) return thread;
  }
  const [latest] = await db.select().from(assistantThreads).where(inOrg(assistantThreads)).orderBy(desc(assistantThreads.updatedAt)).limit(1);
  if (latest && !threadId) return latest;
  return createThread(userId);
}

export async function createThread(userId: string | null) {
  const [thread] = await db.insert(assistantThreads).values({ organizationId: currentOrganizationId(), createdBy: userId }).returning();
  return thread!;
}

export async function listThreads(limit = 20) {
  return db.select({ id: assistantThreads.id, title: assistantThreads.title, updatedAt: assistantThreads.updatedAt })
    .from(assistantThreads).where(inOrg(assistantThreads)).orderBy(desc(assistantThreads.updatedAt)).limit(limit);
}

export async function listMessages(threadId: string, limit = 300) {
  const rows = await db.select().from(assistantMessages)
    .where(and(inOrg(assistantMessages), eq(assistantMessages.threadId, threadId)))
    .orderBy(desc(assistantMessages.createdAt), desc(assistantMessages.id))
    .limit(limit);
  return rows.reverse();
}

export async function addMessage(input: {
  threadId: string;
  role: AssistantRole;
  content?: string;
  tool?: string | null;
  toolInput?: Record<string, unknown> | null;
  toolResult?: Record<string, unknown> | null;
  status?: AssistantToolStatus | null;
  attachments?: AssistantAttachment[];
  createdBy?: string | null;
}) {
  const [message] = await db.insert(assistantMessages).values({
    organizationId: currentOrganizationId(),
    threadId: input.threadId,
    role: input.role,
    content: input.content ?? "",
    tool: input.tool ?? null,
    toolInput: input.toolInput ?? null,
    toolResult: input.toolResult ?? null,
    status: input.status ?? null,
    attachments: input.attachments ?? [],
    createdBy: input.createdBy ?? null,
  }).returning();
  // A greeting does not name the conversation; its first real request does.
  const title = input.role === "user" ? threadTitleFrom(input.content) : null;
  await db.update(assistantThreads)
    .set({
      updatedAt: new Date(),
      ...(title ? { title: sql`case when ${assistantThreads.title} = 'Conversation' then ${title} else ${assistantThreads.title} end` } : {}),
    })
    .where(and(inOrg(assistantThreads), eq(assistantThreads.id, input.threadId)));
  return message!;
}

export async function updateMessage(id: string, patch: { status?: AssistantToolStatus; toolResult?: Record<string, unknown>; content?: string }) {
  await db.update(assistantMessages).set(patch).where(and(inOrg(assistantMessages), eq(assistantMessages.id, id)));
}

/** Takes the thread for one turn; false when another turn is still working on it. */
export async function claimThread(threadId: string): Promise<boolean> {
  const staleBefore = new Date(Date.now() - BUSY_TIMEOUT_MS);
  const rows = await db.update(assistantThreads).set({ busySince: new Date() })
    .where(and(inOrg(assistantThreads), eq(assistantThreads.id, threadId), or(isNull(assistantThreads.busySince), lt(assistantThreads.busySince, staleBefore))))
    .returning({ id: assistantThreads.id });
  return rows.length > 0;
}

/** Keeps a long turn's claim fresh, so it is not taken as abandoned after BUSY_TIMEOUT_MS. */
export async function touchThread(threadId: string): Promise<void> {
  await db.update(assistantThreads).set({ busySince: new Date() }).where(and(inOrg(assistantThreads), eq(assistantThreads.id, threadId)));
}

export async function releaseThread(threadId: string): Promise<void> {
  await db.update(assistantThreads).set({ busySince: null }).where(and(inOrg(assistantThreads), eq(assistantThreads.id, threadId)));
}

export async function threadBusy(threadId: string): Promise<boolean> {
  const thread = await getThread(threadId);
  return Boolean(thread?.busySince && thread.busySince.getTime() > Date.now() - BUSY_TIMEOUT_MS);
}

