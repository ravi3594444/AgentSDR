import "server-only";

import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { crmKnowledgeDocuments, crmPipelines, crmSettings } from "@/lib/crm/schema";
import { isMissingTable } from "@/lib/features/flags.server";
import { instagramAccounts } from "@/lib/instagram/schema";
import { linkedInAccounts } from "@/lib/linkedin/schema";
import { mailboxes } from "@/lib/outreach/schema";
import { inOrg } from "@/lib/tenancy/scope";
import { whatsappAccounts } from "@/lib/whatsapp/schema";
import { businessContext, type BusinessContext, type BusinessSources, type SenderIdentity } from "./businessContext";
import { getBusinessProfile } from "./profile.server";
import type { BusinessProfile } from "./schema";

/**
 * Reads what businessContext.ts weighs. Read-only: it never creates a
 * default pipeline or any other row (crm_settings is read through the
 * existing default pipeline only).
 */
export async function businessSources(): Promise<BusinessSources> {
  const [documents, mailboxRows, linkedinRows, whatsappRows, instructions] = await Promise.all([
    db.select({ title: crmKnowledgeDocuments.title, kind: crmKnowledgeDocuments.kind }).from(crmKnowledgeDocuments)
      .where(and(inOrg(crmKnowledgeDocuments), eq(crmKnowledgeDocuments.active, true))).limit(40),
    db.select({ name: mailboxes.displayName }).from(mailboxes).where(and(inOrg(mailboxes), eq(mailboxes.status, "connected"))).limit(20),
    db.select({ name: linkedInAccounts.name }).from(linkedInAccounts).where(and(inOrg(linkedInAccounts), eq(linkedInAccounts.status, "CONNECTED"))).limit(20),
    db.select({ name: whatsappAccounts.name, status: whatsappAccounts.status }).from(whatsappAccounts).where(inOrg(whatsappAccounts)).limit(20),
    db.select({ blocks: crmSettings.draftInstructions }).from(crmSettings)
      .innerJoin(crmPipelines, eq(crmPipelines.id, crmSettings.pipelineId))
      .where(and(inOrg(crmPipelines), eq(crmPipelines.isDefault, true))).limit(1),
  ]);
  let instagramRows: { name: string | null }[] = [];
  try {
    instagramRows = await db.select({ name: instagramAccounts.name }).from(instagramAccounts)
      .where(and(inOrg(instagramAccounts), eq(instagramAccounts.status, "connected"))).limit(20);
  } catch (error) {
    if (!isMissingTable(error)) throw error;
  }
  const senders: SenderIdentity[] = [
    ...mailboxRows.flatMap((row) => (row.name?.trim() ? [{ name: row.name.trim(), source: "mailbox" as const }] : [])),
    ...linkedinRows.flatMap((row) => (row.name?.trim() ? [{ name: row.name.trim(), source: "LinkedIn" as const }] : [])),
    ...whatsappRows.filter((row) => row.status === "connected").flatMap((row) => (row.name?.trim() ? [{ name: row.name.trim(), source: "WhatsApp" as const }] : [])),
    ...instagramRows.flatMap((row) => (row.name?.trim() ? [{ name: row.name.trim(), source: "Instagram" as const }] : [])),
  ];
  return {
    documents: documents.map((row) => ({ title: row.title, kind: row.kind })),
    senders,
    instructions: (instructions[0]?.blocks ?? []).map((block) => block.title?.trim() || "Untitled instruction").slice(0, 10),
  };
}

/** The organization's profile with what is already known elsewhere, and what is still missing. */
export async function loadBusinessContext(): Promise<{ profile: BusinessProfile; context: BusinessContext }> {
  const [profile, sources] = await Promise.all([getBusinessProfile(), businessSources()]);
  return { profile, context: businessContext(profile, sources) };
}

/**
 * The profile outreach is written from: the saved profile, with the sender
 * name every connected account already uses when the profile has none (the
 * plan's samples show it before the owner presses Start).
 */
export async function effectiveBusinessProfile(): Promise<BusinessProfile> {
  const { profile, context } = await loadBusinessContext();
  return context.sender && !profile.senderName?.trim() ? { ...profile, senderName: context.sender.name } : profile;
}
