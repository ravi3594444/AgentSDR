import type { OpenRouterModelSelection } from "@/lib/ai/openrouter-types";
import type { CompletionBudget } from "@/lib/ai/server/structuredCompletion";
import type { CrmCategoryKey, CrmChannel } from "../schema";
import type { ClassificationApplicationDecision } from "../stateMachine";

export type ClassificationCategory = {
  key: CrmCategoryKey;
  label: string;
  description?: string | null;
};

export type ClassificationSubcategory = {
  id: string;
  categoryKey: CrmCategoryKey;
  key: string;
  name: string;
  description?: string | null;
  classificationGuidance?: string | null;
  reviewRequired: boolean;
  /** Funnel rank; null when the subcategory is not a funnel stage. */
  stageRank?: number | null;
};

export type ClassificationPersonProfile = {
  id?: string | null;
  fullName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  linkedinUrl?: string | null;
  title?: string | null;
  attributes?: Record<string, string | number | boolean | null>;
};

export type ClassificationCompanyProfile = {
  id?: string | null;
  name?: string | null;
  domain?: string | null;
  linkedinUrl?: string | null;
  description?: string | null;
  attributes?: Record<string, string | number | boolean | null>;
};

export type ClassificationMessage = {
  id: string;
  /**
   * "whatsapp_call" is a call's transcript standing in for a reply
   * (src/lib/calls/leadStage.ts); it is only ever classified, never drafted to.
   */
  channel: CrmChannel | "whatsapp_call";
  direction: "inbound" | "outbound";
  sentAt: Date | string;
  subject?: string | null;
  bodyText: string;
  /** Email only: who the message came from and was addressed to, so a reply can account for everyone on the thread. */
  participants?: MessageParticipants;
};

export type MessageParticipants = { from: string | null; to: string[]; cc: string[] };

export type ClassificationCampaignSummary = {
  channel?: CrmChannel | null;
  campaignId?: string | null;
  name?: string | null;
  status?: string | null;
  source?: string | null;
  summary?: string | null;
  attributes?: Record<string, string | number | boolean | null>;
};

export type CurrentClassification = {
  categoryKey: CrmCategoryKey | null;
  subcategoryKey: string | null;
  categorySource?: "ai" | "human" | "integration" | null;
  categoryLocked: boolean;
  /** Funnel rank of the current subcategory; null when unranked. */
  stageRank?: number | null;
};

/** A single always-included Knowledge document, snapshotted for the classification prompt. */
export type ClassificationKnowledgeDocument = {
  documentId: string;
  title: string;
  kind: string | null;
  content: string;
};

export type ClassificationContextInput = {
  categories: readonly ClassificationCategory[];
  subcategories: readonly ClassificationSubcategory[];
  person: ClassificationPersonProfile;
  company?: ClassificationCompanyProfile | null;
  currentClassification: CurrentClassification;
  latestInboundMessage: ClassificationMessage;
  recentConversation: readonly ClassificationMessage[];
  campaignSummary?: ClassificationCampaignSummary | null;
  knowledge?: readonly ClassificationKnowledgeDocument[] | null;
};

export type ClassificationContextSnapshot = {
  taxonomy: {
    categories: Array<{
      key: CrmCategoryKey;
      label: string;
      description: string | null;
    }>;
    subcategories: Array<{
      categoryKey: CrmCategoryKey;
      key: string;
      name: string;
      description: string | null;
      classificationGuidance: string | null;
      reviewRequired: boolean;
    }>;
  };
  person: ClassificationPersonProfile;
  company: ClassificationCompanyProfile | null;
  currentClassification: CurrentClassification;
  campaignSummary: ClassificationCampaignSummary | null;
  latestInboundMessage: ClassificationMessage & { sentAt: string };
  recentConversation: Array<ClassificationMessage & { sentAt: string }>;
  knowledge: Array<{ documentId: string; title: string; kind: string | null; content: string }>;
};

export type BuiltClassificationContext = {
  snapshot: ClassificationContextSnapshot;
  prompt: string;
  estimatedTokens: number;
  maxTokens: number;
  truncated: boolean;
  omittedMessageCount: number;
};

export type CrmClassifierOutput = {
  categoryKey: CrmCategoryKey;
  subcategoryKey: string | null;
  confidence: number;
  reasoning: string;
  suggestedNextActionAt: string | null;
};

export type ClassificationPolicy = {
  autoApplyConfidence: number;
  reviewOther: boolean;
  customerRequiresReview: boolean;
};

export type ClassificationCompletionInput = {
  systemPrompt: string;
  userPrompt: string;
  jsonSchema: Record<string, unknown>;
  /** Rejects an attempt by throwing; the completion may then try again. */
  accept?: (text: string) => void;
  requestedModel?: OpenRouterModelSelection;
  timeoutMs: number;
  maxOutputTokens: number;
  signal?: AbortSignal;
  /** The reply job's shared budget, when this call runs inside one. */
  budget?: CompletionBudget;
};

export type ClassificationCompletionResult = {
  text: string;
  provider: string;
  model: string;
  request: Record<string, unknown>;
  response: unknown;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
};

export type ClassificationCompletion = (
  input: ClassificationCompletionInput,
) => Promise<ClassificationCompletionResult>;

export type ClassifyCrmReplyInput = ClassificationContextInput & {
  policy: ClassificationPolicy;
  /** crm_settings.classification_instructions; appended to the system prompt. */
  instructions?: string | null;
  requestedModel?: OpenRouterModelSelection;
  maxContextTokens?: number;
  maxOutputTokens?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type CrmClassificationResult = CrmClassifierOutput & {
  subcategoryId: string | null;
  subcategoryReviewRequired: boolean;
  decision: ClassificationApplicationDecision;
  requiresReview: boolean;
  applicationTarget: {
    categoryKey: CrmCategoryKey;
    subcategoryId: string | null;
  } | null;
  provider: string;
  model: string;
  request: Record<string, unknown>;
  response: unknown;
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
  };
  context: BuiltClassificationContext;
};
