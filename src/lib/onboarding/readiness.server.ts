import "server-only";

import { and, count, eq, gt, inArray, isNotNull, isNull, max, ne } from "drizzle-orm";
import { db } from "@/lib/db";
import { can, type OrgContext } from "@/lib/auth/context";
import { ROLE_LABELS } from "@/lib/auth/permissions";
import { invitations, members } from "@/lib/auth/schema";
import { getByokSettings } from "@/lib/ai/byok";
import { getAiConnection } from "@/lib/ai/connections";
import { people } from "@/lib/leads/schema";
import { campaigns as linkedinCampaigns, linkedInAccounts, messages as linkedinMessages } from "@/lib/linkedin/schema";
import { crmConversationMessages, crmConversations } from "@/lib/crm/schema";
import { orgLeadIds } from "@/lib/outreach/orgScope";
import { chatInOrg } from "@/lib/whatsapp/messages";
import { loadNavBadges } from "@/lib/nav/badges.server";
import { mailboxes, outreachCampaigns, outreachEmails } from "@/lib/outreach/schema";
import { listPlatformStatus } from "@/lib/platform/credentials";
import { inOrg } from "@/lib/tenancy/scope";
import { whatsappAccounts, whatsappCampaigns, whatsappChats, whatsappMessages } from "@/lib/whatsapp/schema";
import { buildReadiness, type ReadinessFacts, type ReadinessItem, type ReplyChannel, type TrafficFacts } from "./readiness";

const iso = (value: Date | string | null | undefined) => (value ? new Date(value).toISOString() : null);

/**
 * The last message sent and the last reply received per channel. Replies are
 * the CRM's inbound conversation messages (every channel's inbound path ends
 * there); sends are each channel's own store, since cold campaign messages
 * reach the CRM only once someone answers.
 */
async function loadTraffic(): Promise<Record<ReplyChannel, TrafficFacts>> {
  const replies = await db
    .select({ channel: crmConversationMessages.channel, at: max(crmConversationMessages.sentAt) })
    .from(crmConversationMessages)
    .innerJoin(crmConversations, eq(crmConversations.id, crmConversationMessages.conversationId))
    .where(and(inOrg(crmConversations), eq(crmConversationMessages.direction, "inbound")))
    .groupBy(crmConversationMessages.channel);
  const lastReply = (channel: ReplyChannel) => iso(replies.find((row) => row.channel === channel)?.at);
  const [email] = await db
    .select({ at: max(outreachEmails.sentAt) })
    .from(outreachEmails)
    .where(and(inArray(outreachEmails.leadId, orgLeadIds()), eq(outreachEmails.status, "sent")));
  const [linkedin] = await db
    .select({ at: max(linkedinMessages.createdAt) })
    .from(linkedinMessages)
    .where(and(inOrg(linkedinMessages), isNotNull(linkedinMessages.linkedinMessageId), ne(linkedinMessages.type, "RECEIVED")));
  const [whatsapp] = await db
    .select({ at: max(whatsappMessages.sentAt) })
    .from(whatsappMessages)
    .innerJoin(whatsappChats, eq(whatsappChats.id, whatsappMessages.chatId))
    .where(and(chatInOrg(), eq(whatsappMessages.direction, "outbound")));
  return {
    email: { lastSentAt: iso(email?.at), lastReplyAt: lastReply("email") },
    linkedin: { lastSentAt: iso(linkedin?.at), lastReplyAt: lastReply("linkedin") },
    whatsapp: { lastSentAt: iso(whatsapp?.at), lastReplyAt: lastReply("whatsapp") },
  };
}

/** Status → count, from a grouped count query. */
function tally<S extends string>(rows: { status: S; n: number }[]): Partial<Record<S, number>> {
  const out: Partial<Record<S, number>> = {};
  for (const row of rows) out[row.status] = (out[row.status] ?? 0) + Number(row.n);
  return out;
}

/**
 * Gathers the facts Getting Started is computed from, for the organization
 * in scope (call inside runInOrganization). Reads stored state only: no live
 * calls to providers, no secrets decrypted. Every scoped table is filtered by
 * organization; the auth tables by the context's organization id.
 */
export async function loadReadinessFacts(ctx: OrgContext): Promise<ReadinessFacts> {
  const now = new Date();
  // One query at a time: the pool is small and shared (DB_POOL_MAX), and this
  // page is opened rarely, so it should not hold several connections at once.
  const platforms = await listPlatformStatus();
  const mailboxRows = await db.select({ status: mailboxes.status, n: count() }).from(mailboxes).where(inOrg(mailboxes)).groupBy(mailboxes.status);
  const linkedinRows = await db
    .select({ status: linkedInAccounts.status, n: count() })
    .from(linkedInAccounts)
    .where(inOrg(linkedInAccounts))
    .groupBy(linkedInAccounts.status);
  const whatsappRows = await db
    .select({ status: whatsappAccounts.status, n: count() })
    .from(whatsappAccounts)
    .where(inOrg(whatsappAccounts))
    .groupBy(whatsappAccounts.status);
  const byok = await getByokSettings();
  const [{ n: peopleCount }] = await db.select({ n: count() }).from(people).where(inOrg(people));
  const emailCampaignRows = await db
    .select({ status: outreachCampaigns.status, n: count() })
    .from(outreachCampaigns)
    .where(inOrg(outreachCampaigns))
    .groupBy(outreachCampaigns.status);
  const linkedinCampaignRows = await db
    .select({ status: linkedinCampaigns.status, n: count() })
    .from(linkedinCampaigns)
    .where(inOrg(linkedinCampaigns))
    .groupBy(linkedinCampaigns.status);
  const whatsappCampaignRows = await db
    .select({ status: whatsappCampaigns.status, n: count() })
    .from(whatsappCampaigns)
    .where(and(inOrg(whatsappCampaigns), isNull(whatsappCampaigns.archivedAt)))
    .groupBy(whatsappCampaigns.status);
  const badges = await loadNavBadges();
  const traffic = await loadTraffic();
  // members and invitations are auth tables (not organization-scoped by inOrg): filter by the context's organization.
  const [{ n: memberCount }] = await db.select({ n: count() }).from(members).where(eq(members.organizationId, ctx.organizationId));
  const [{ n: pendingInvitations }] = await db
    .select({ n: count() })
    .from(invitations)
    .where(and(eq(invitations.organizationId, ctx.organizationId), eq(invitations.status, "pending"), gt(invitations.expiresAt, now)));

  const google = platforms.find((platform) => platform.key === "google");
  const unipile = platforms.find((platform) => platform.key === "unipile");
  const aiConnection = byok.connectionId ? await getAiConnection(byok.connectionId) : null;
  const defaultModel = byok.defaultModel;

  const mailboxCounts = tally(mailboxRows);
  const linkedinCounts = tally(linkedinRows);
  const whatsappCounts = tally(whatsappRows);
  const emailCampaigns = tally(emailCampaignRows);
  const linkedinCampaignCounts = tally(linkedinCampaignRows);
  const whatsappCampaignCounts = tally(whatsappCampaignRows);
  const whatsappConnected = whatsappCounts.connected ?? 0;
  const whatsappTotal = Object.values(whatsappCounts).reduce((sum, n) => sum + (n ?? 0), 0);
  const role = ctx.roles.includes("owner") ? "owner" : ctx.roles.includes("admin") ? "admin" : "member";

  return {
    workspace: {
      organizationName: ctx.organizationName,
      roleLabel: ROLE_LABELS[role],
      members: Number(memberCount),
      pendingInvitations: Number(pendingInvitations),
      authEmailConfigured: Boolean(process.env.RESEND_API_KEY && process.env.AUTH_EMAIL_FROM),
    },
    canManage: can(ctx, { integrations: ["manage"] }) && can(ctx, { aiSettings: ["manage"] }),
    google: {
      connected: Boolean(google?.connected),
      verifiedAt: google?.verifiedAt ?? null,
      replySyncTopicSet: Boolean(google?.values.gmailWatchTopic?.trim()),
      gmailWatch: google?.gmailWatch ?? null,
    },
    mailboxes: {
      connected: mailboxCounts.connected ?? 0,
      connecting: mailboxCounts.connecting ?? 0,
      failed: mailboxCounts.failed ?? 0,
      disabled: mailboxCounts.disabled ?? 0,
    },
    unipile: {
      connected: Boolean(unipile?.connected),
      verifiedAt: unipile?.verifiedAt ?? null,
      webhooks: unipile?.webhooks ? { status: unipile.webhooks.status, message: unipile.webhooks.message } : null,
    },
    linkedinAccounts: { connected: linkedinCounts.CONNECTED ?? 0, disconnected: linkedinCounts.DISCONNECTED ?? 0 },
    whatsappAccounts: { connected: whatsappConnected, notConnected: whatsappTotal - whatsappConnected },
    ai: {
      provider: aiConnection?.providerKey === "openrouter" || aiConnection?.providerKey === "aimlapi" ? aiConnection.providerKey : null,
      connectionSaved: Boolean(aiConnection),
      connectionVerified: Boolean(aiConnection?.verified && (aiConnection.providerKey === "openrouter" || aiConnection.providerKey === "aimlapi")),
      providers: byok.providers.length,
      defaultModel,
      defaultModelEnabled: Boolean(
        defaultModel && byok.providers.includes(defaultModel.provider) && byok.modelsByProvider[defaultModel.provider]?.includes(defaultModel.modelId),
      ),
      routingConfirmed: byok.byokOnlyConfirmed,
      researchModel: byok.researchModel?.modelId ?? null,
    },
    people: Number(peopleCount),
    campaigns: {
      email: {
        active: emailCampaigns.active ?? 0,
        paused: emailCampaigns.paused ?? 0,
        draft: emailCampaigns.draft ?? 0,
        completed: emailCampaigns.completed ?? 0,
      },
      linkedin: { active: linkedinCampaignCounts.ACTIVE ?? 0, paused: linkedinCampaignCounts.PAUSED ?? 0 },
      whatsapp: { active: whatsappCampaignCounts.active ?? 0, paused: whatsappCampaignCounts.paused ?? 0 },
    },
    replies: { actionRequired: badges.actionRequired, draftsAwaitingReview: badges.draftsAwaitingReview },
    traffic,
  };
}

export async function loadReadiness(ctx: OrgContext): Promise<ReadinessItem[]> {
  return buildReadiness(await loadReadinessFacts(ctx));
}
