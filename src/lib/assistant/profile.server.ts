import "server-only";

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { createKnowledgeDocument, getKnowledgeDocument, updateKnowledgeDocument } from "@/lib/crm/knowledge-service";
import { currentOrganizationId } from "@/lib/tenancy/scope";
import { mergeProfile, profileKnowledgeText } from "./profile";
import { assistantProfiles, type BusinessProfile } from "./schema";

/**
 * The organization's business profile (one row per organization). Every
 * change is also written to a knowledge document marked "always include",
 * so the CRM's reply drafts know the business as well as the assistant does.
 */

const PROFILE_DOCUMENT_TITLE = "Business profile (from the assistant)";

export async function getBusinessProfile(): Promise<BusinessProfile> {
  const [row] = await db.select({ profile: assistantProfiles.profile }).from(assistantProfiles)
    .where(eq(assistantProfiles.organizationId, currentOrganizationId())).limit(1);
  return row?.profile ?? {};
}

async function syncKnowledge(profile: BusinessProfile, documentId: string | null): Promise<string | null> {
  const content = profileKnowledgeText(profile);
  if (!content) return documentId;
  if (documentId) {
    const existing = await getKnowledgeDocument(documentId).catch(() => null);
    if (existing) {
      await updateKnowledgeDocument(documentId, { content, active: true, alwaysInclude: true });
      return documentId;
    }
  }
  const created = await createKnowledgeDocument({
    title: PROFILE_DOCUMENT_TITLE,
    kind: "company",
    tags: ["assistant", "business-profile"],
    alwaysInclude: true,
    content,
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
