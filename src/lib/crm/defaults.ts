import { and, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { currentOrganizationId, inOrg } from "@/lib/tenancy/scope";
import { slugifySubcategoryKey } from "./categories";
import { crmPipelines, crmSettings, crmSubcategories, type CrmCategoryKey } from "./schema";

/**
 * The CRM an organization starts with: one default pipeline, its settings row
 * and the reply taxonomy (subcategories only — the sequences scripts/
 * seed-crm-response-taxonomy.ts writes are one company's copy, so a new
 * organization writes its own).
 *
 * Created lazily, on the first thing that needs "the default pipeline", so
 * nothing depends on a sign-up hook having run. Idempotent and race-safe: the
 * per-organization unique index crm_pipelines_org_one_default_uq arbitrates,
 * and the pipeline, settings and taxonomy commit together, so a caller that
 * loses the race sees the finished set. Subcategories are seeded only by the
 * call that creates the pipeline, so ones an operator later deletes stay gone.
 */
export const DEFAULT_PIPELINE_NAME = "Default";

type DefaultSubcategory = {
  categoryKey: CrmCategoryKey;
  name: string;
  description: string;
  classificationGuidance: string;
  sortOrder: number;
  stageRank: number | null;
};

const DEFAULT_SUBCATEGORIES: readonly DefaultSubcategory[] = [
  {
    categoryKey: "not_interested",
    name: "Do Not Contact",
    description: "The person explicitly asked not to be contacted again or requested removal from outreach.",
    classificationGuidance: "Use only for an explicit unsubscribe, stop-contact, removal, or do-not-contact request. This must suppress outreach; no reply sequence is assigned and no message of any kind is sent.",
    sortOrder: 10,
    stageRank: null,
  },
  {
    categoryKey: "not_interested",
    name: "Not Required Right Now",
    description: "The person does not need the offering at present but may be open to a future conversation.",
    classificationGuidance: "Use when the person says the offering is not needed now, timing is not right, priorities are elsewhere, or asks to reconnect later without rejecting future contact.",
    sortOrder: 20,
    stageRank: null,
  },
  {
    categoryKey: "not_interested",
    name: "Already Using a Tool — Not Required",
    description: "The person already uses another tool or process and does not currently see a need to change.",
    classificationGuidance: "Use when the person says an existing vendor, product, agency, or internal process already covers the need and our tool is therefore not required.",
    sortOrder: 30,
    stageRank: null,
  },
  {
    categoryKey: "interested",
    name: "Information Requested",
    description: "The person asked for product, pricing, feature, implementation, or company information.",
    classificationGuidance: "Use when the primary request is for more information or answers, and the person has not specifically requested a case study, meeting, demo, or trial.",
    sortOrder: 10,
    stageRank: 1,
  },
  {
    categoryKey: "interested",
    name: "Case Study",
    description: "The person asked for a case study, customer example, proof point, or relevant results.",
    classificationGuidance: "Use when the person explicitly requests a case study, reference, customer story, proof of results, or an example from a similar company or use case.",
    sortOrder: 20,
    stageRank: 1,
  },
  {
    categoryKey: "interested",
    name: "Meeting Requested",
    description: "The person wants to schedule a call or meeting and needs a calendar link or available times.",
    classificationGuidance: "Use when the person asks to book, schedule, or arrange a call or meeting, including requests for availability or a calendar link.",
    sortOrder: 30,
    stageRank: 2,
  },
  {
    categoryKey: "interested",
    name: "Meeting No Show",
    description: "A scheduled meeting did not happen because the prospect did not attend.",
    classificationGuidance: "Use after a confirmed meeting time passes and the external participant did not attend or explicitly says they missed the meeting.",
    sortOrder: 40,
    stageRank: 2,
  },
  {
    categoryKey: "interested",
    name: "Meeting Done",
    description: "The meeting was completed and the person should receive a recap and agreed next steps.",
    classificationGuidance: "Use when the meeting has taken place and the next response should recap discussion, decisions, responsibilities, or follow-up actions.",
    sortOrder: 50,
    stageRank: 3,
  },
  {
    categoryKey: "interested",
    name: "Demo Request",
    description: "The person asked to see a product demonstration or receive demo material.",
    classificationGuidance: "Use when the person explicitly asks for a demo, walkthrough, product tour, recording, or demonstration call.",
    sortOrder: 60,
    stageRank: 1,
  },
  {
    categoryKey: "interested",
    name: "Trial Requested",
    description: "The person wants to begin a trial or asks how to get trial access.",
    classificationGuidance: "Use when the person asks to start, activate, access, or learn the next steps for a product trial.",
    sortOrder: 70,
    stageRank: 4,
  },
  {
    categoryKey: "interested",
    name: "Trial User",
    description: "The person is actively using the trial and needs help progressing through setup or integration.",
    classificationGuidance: "Use for an active trial user discussing setup, activation, usage, onboarding, or integration rather than requesting initial trial access.",
    sortOrder: 80,
    stageRank: 5,
  },
  {
    categoryKey: "customer",
    name: "Customer",
    description: "The person represents an active customer relationship and is requesting billing or account follow-up.",
    classificationGuidance: "Use when the person is an existing customer and the conversation concerns an active account, especially invoices, billing, renewal, or ongoing service.",
    sortOrder: 10,
    stageRank: 6,
  },
  {
    categoryKey: "other",
    name: "Did Not Connect to Different POC",
    description: "The person is not the right contact and has not yet provided or connected us with the appropriate point of contact.",
    classificationGuidance: "Use when the recipient says they are not the correct person, but no alternate contact or introduction has been provided.",
    sortOrder: 10,
    stageRank: null,
  },
  {
    categoryKey: "other",
    name: "Wrong Number",
    description: "The number, address or profile reached someone other than the intended lead.",
    classificationGuidance: "Use when the person who replied says this is a wrong number or that they are not the person we meant to reach, without referring us to the right contact. Outreach to this route stops; at most one brief apology is sent, never a sales message. If they also ask to stop or unsubscribe, use Do Not Contact instead.",
    sortOrder: 15,
    stageRank: null,
  },
  {
    categoryKey: "other",
    name: "Connected to Different POC",
    description: "A contact has referred us to or shared details for a different person who is the appropriate point of contact.",
    classificationGuidance: "Use when the recipient provides another person's contact information, copies them into the conversation, or makes a direct introduction to the correct point of contact.",
    sortOrder: 20,
    stageRank: null,
  },
  {
    categoryKey: "other",
    name: "Left Company",
    description: "The person is no longer employed by the target company.",
    classificationGuidance: "Use when an auto-response, colleague, or other reliable message states that the person has left the company.",
    sortOrder: 30,
    stageRank: null,
  },
  {
    categoryKey: "other",
    name: "Out of Office",
    description: "The person is temporarily unavailable and an out-of-office or leave message was received.",
    classificationGuidance: "Use for temporary out-of-office, vacation, leave, or unavailable notices. Do not use when the message says the person permanently left the company.",
    sortOrder: 40,
    stageRank: null,
  },
  {
    categoryKey: "other",
    name: "Other",
    description: "The reply does not fit any other subcategory and needs a context-specific response.",
    classificationGuidance: "Use only when no other subcategory fits the latest message. Prefer a specific subcategory whenever the intent is reasonably clear.",
    sortOrder: 50,
    stageRank: null,
  },
];

/** The id of the organization in scope's default pipeline, creating the defaults if it has none. */
export async function ensureCrmDefaults(): Promise<{ pipelineId: string; created: boolean }> {
  const findDefault = async () => {
    const [pipeline] = await db
      .select({ id: crmPipelines.id })
      .from(crmPipelines)
      .where(and(inOrg(crmPipelines), eq(crmPipelines.isDefault, true)))
      .limit(1);
    return pipeline?.id ?? null;
  };
  const existing = await findDefault();
  if (existing) return { pipelineId: existing, created: false };

  const organizationId = currentOrganizationId();
  const created = await db.transaction(async (tx) => {
    const [pipeline] = await tx
      .insert(crmPipelines)
      .values({ organizationId, name: DEFAULT_PIPELINE_NAME, isDefault: true, active: true })
      .onConflictDoNothing()
      .returning({ id: crmPipelines.id });
    if (!pipeline) return null;
    await tx.insert(crmSettings).values({ pipelineId: pipeline.id }).onConflictDoNothing();
    await tx
      .insert(crmSubcategories)
      .values(DEFAULT_SUBCATEGORIES.map((entry) => ({
        pipelineId: pipeline.id,
        categoryKey: entry.categoryKey,
        key: slugifySubcategoryKey(entry.name),
        name: entry.name,
        description: entry.description,
        classificationGuidance: entry.classificationGuidance,
        sortOrder: entry.sortOrder,
        stageRank: entry.stageRank,
      })))
      .onConflictDoNothing();
    return pipeline.id;
  });
  if (created) return { pipelineId: created, created: true };

  // Lost the race (or the name is taken by a non-default pipeline): the
  // winner's transaction has committed by the time the insert gave up.
  const winner = await findDefault();
  if (!winner) throw new Error("The organization's default CRM pipeline could not be created");
  return { pipelineId: winner, created: false };
}
