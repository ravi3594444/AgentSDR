import "server-only";

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { createKnowledgeDocument, getKnowledgeDocument, updateKnowledgeDocument } from "@/lib/crm/knowledge-service";
import { currentOrganizationId } from "@/lib/tenancy/scope";
import { EMPTY_PROFILE_KNOWLEDGE_TEXT, mergeProfile, profileKnowledgeText } from "./profile";
import { assistantProfiles, type BusinessProfile } from "./schema";

/**
 * The organization's business profile (one row per organization), edited in
 * the chat (save_business_info) and in Settings → Your business. Every
 * change is also written to a knowledge document marked "always include",
 * so the CRM's reply drafts know the business as well as the assistant does.
 * That copy is read-only everywhere else (updateKnowledgeDocument refuses it).
 */

const PROFILE_DOCUMENT_TITLE = "Business profile";

export async function getBusinessProfile(): Promise<BusinessProfile> {
  const [row] = await db.select({ profile: assistantProfiles.profile }).from(assistantProfiles)
    .where(eq(assistantProfiles.organizationId, currentOrganizationId())).limit(1);
  return row?.profile ?? {};
}

/** The stored row for Settings → Your business: the profile, its Knowledge copy and when it last changed. */
export async function businessProfileRecord(): Promise<{ profile: BusinessProfile; knowledgeDocumentId: string | null; updatedAt: Date | null }> {
  const [row] = await db.select().from(assistantProfiles).where(eq(assistantProfiles.organizationId, currentOrganizationId())).limit(1);
  return { profile: row?.profile ?? {}, knowledgeDocumentId: row?.knowledgeDocumentId ?? null, updatedAt: row?.updatedAt ?? null };
}

/**
 * Rewrite the Knowledge copy from `profile`. A cleared field leaves the copy
 * with it; a profile with nothing left turns the copy into a note saying so,
 * archived and no longer in every draft, rather than keeping the old text.
 */
async function syncKnowledge(profile: BusinessProfile, documentId: string | null): Promise<string | null> {
  const text = profileKnowledgeText(profile);
  if (documentId) {
    const existing = await getKnowledgeDocument(documentId).catch(() => null);
    if (existing) {
      await updateKnowledgeDocument(
        documentId,
        { title: PROFILE_DOCUMENT_TITLE, content: text || EMPTY_PROFILE_KNOWLEDGE_TEXT, active: Boolean(text), alwaysInclude: Boolean(text) },
        { businessProfileSync: true },
      );
      return documentId;
    }
  }
  if (!text) return null;
  const created = await createKnowledgeDocument({
    title: PROFILE_DOCUMENT_TITLE,
    kind: "company",
    tags: ["assistant", "business-profile"],
    alwaysInclude: true,
    content: text,
  });
  return created.id;
}

export async function updateBusinessProfile(patch: Record<string, unknown>, userId: string | null): Promise<{ profile: BusinessProfile; problems: string[] }> {
  const organizationId = currentOrganizationId();
  const [row] = await db.select().from(assistantProfiles).where(eq(assistantProfiles.organizationId, organizationId)).limit(1);
  const { profile, problems } = mergeProfile(row?.profile ?? {}, patch);
  const documentId = await syncKnowledge(profile, row?.knowledgeDocumentId ?? null);
  await db.insert(assistantProfiles)
    .values({ organizationId, profile, knowledgeDocumentId: documentId, updatedBy: userId, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: assistantProfiles.organizationId,
      set: { profile, knowledgeDocumentId: documentId, updatedBy: userId, updatedAt: new Date() },
    });
  return { profile, problems };
}

/** Saves a document's text as a knowledge document drafts can cite; returns its id. */
export async function saveDocumentKnowledge(title: string, text: string): Promise<{ id: string; title: string }> {
  const document = await createKnowledgeDocument({
    title: title.slice(0, 200),
    kind: "custom",
    tags: ["assistant", "uploaded"],
    alwaysInclude: false,
    content: text,
  });
  return { id: document.id, title: document.title };
}
