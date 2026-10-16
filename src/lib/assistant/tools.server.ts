import "server-only";

import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { getByokSettings } from "@/lib/ai/byok";
import { getAiConnection } from "@/lib/ai/connections";
import { retrieveKnowledge } from "@/lib/crm/knowledge";
import { discoveryAvailability, DiscoveryUnavailableError, normalizeCriteria, startDiscovery, startInstagramProspects, startSocialProspects } from "@/lib/discovery/discovery.server";
import { searchAreaProblem } from "@/lib/discovery/geocode";
import { extractContacts, visibleText } from "@/lib/discovery/contacts";
import { fetchPublicPage } from "@/lib/discovery/websiteContacts.server";
import { normalizeWebCriteria, startWebDiscovery, WebDiscoveryUnavailableError } from "@/lib/discovery/webDiscovery.server";
import { webSearchAvailability, webSearchAvailabilityFrom } from "@/lib/discovery/webSearch.server";
import type { FeatureState } from "@/lib/features/catalog";
import { featureEnabled, FeatureDisabledError } from "@/lib/features/flags.server";
import type { ImportRow } from "@/lib/leads/importRows";
import { importPeopleRows } from "@/lib/leads/peopleImport.server";
import { people } from "@/lib/leads/schema";
import { geocoderUrl, lookupPlace } from "@/lib/discovery/geocode.server";
import { linkedinSearchAvailability, startLinkedinSearch } from "./linkedinSearch.server";
import { inOrg } from "@/lib/tenancy/scope";
import { addAudienceMembers, createAudience, listAudiences, summarizeAudience } from "./audiences.server";
import { inquiryRepliesRequested, outreachRequested, outreachRequestProblem } from "./agent";
import { answerDecision, DecisionError, listOpenDecisions } from "./decisions.server";
import { channelAvailability, listRuns, OutreachError, prepareOutreach, reportRun, setRunPaused, setRunReplyMode, stopRun } from "./outreach.server";
import { mergeProfile, PROFILE_LABELS, profileChanges } from "./profile";
import { businessContext } from "./businessContext";
import { businessSources } from "./businessContext.server";
import { getBusinessProfile, updateBusinessProfile } from "./profile.server";
import { PERIOD_KINDS, type PeriodKind } from "./results";
import { results, resultsText } from "./results.server";
import { assistantJobs, outreachRuns, type AudienceChannel } from "./schema";
import { featureState } from "@/lib/features/flags.server";
import { createExistingLeadsAudience, inquiryOverview, MAX_EXISTING_LEADS } from "./existingLeads.server";
import { isExistingLeadsFrom } from "./existingLeads";
import { inquiryRunReadiness, InquiryRunError, prepareInquiryReplies } from "./inquiryRuns.server";
import { audienceProspects } from "./qualification.server";

/**
 * What the assistant can do, and nothing else. Each tool is a call into an
 * existing service, with its arguments checked here before anything runs;
 * its result is stored on the chat (assistant_messages, role "tool") and
 * shown as a card, so what the owner reads about an action is what the
 * server recorded. Starting outreach is deliberately not a tool: the
 * owner's Start button does that (POST /api/assistant/runs/[id]), or, in a
 * chat the owner put in Autonomous mode, the server right after a plan is
 * prepared, within the daily caps (autonomy.server.ts).
 */

export type ToolContext = {
  threadId: string;
  userId: string | null;
  /** What the owner wrote in this turn (or, after a background event, their latest message): outreach needs it to ask for outreach. */
  ownerText: string;
  /** The assistant's last message before the owner's: a "yes" to its offer of outreach counts as asking. */
  lastAssistantText?: string | null;
  /** The owner's words asking for outreach that nothing has acted on yet (agent.ts pendingOutreachRequest); null when there are none. */
  outreachRequest?: string | null;
  /** The id of the owner's message holding that request: the plans it leads to share it (one Start may cover them, requestApproval.ts). */
  outreachRequestId?: string | null;
  /** Set when the server itself prepares outreach the owner already asked for (a "find and contact" search finished). */
  authorizedBy?: "search" | null;
  /** The chat is in Autonomous mode (autonomy.ts): a prepared plan starts on its own when the caps allow. */
  autonomous?: boolean;
};

/**
 * `summary` is what the model reads (ids included, for later tool calls);
 * `display` is the owner's version of it when the summary carries ids; `data`
 * is what the chat card shows.
 */
export type ToolResult = {
  ok: boolean;
  summary: string;
  display?: string;
  data?: Record<string, unknown>;
  /** Refused for its arguments before doing anything: the model's mistake, kept for the model and hidden from the owner. */
  refused?: boolean;
};

type Tool = {
  description: string;
  /** Argument names and meanings, for the model. */
  arguments: string;
  /** Offered to the model only while this holds for the organization's optional features (always, without it). */
  available?: (features: FeatureState) => boolean;
  run: (args: Record<string, unknown>, context: ToolContext) => Promise<ToolResult>;
};

class ToolArgumentError extends Error {}

/** The page's <title> text, found with plain searches (linear on any page, unlike a lazy regex on hostile HTML). */
function pageTitle(html: string): string {
  // ASCII-only lowercase keeps every index in place ("İ".toLowerCase() is two characters).
  const lower = html.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
  const open = lower.indexOf("<title");
  if (open < 0) return "";
  const start = lower.indexOf(">", open);
  if (start < 0) return "";
  const end = lower.indexOf("</title>", start);
  return end < 0 ? "" : html.slice(start + 1, end);
}

const MAX_CHAT_CONTACTS = 50;
/** Sites that need a login and forbid automated reading. */
const LOGIN_WALLED = /(?:^|\.)(?:instagram\.com|facebook\.com|fb\.com|x\.com|twitter\.com|tiktok\.com|linkedin\.com|threads\.net)$/i;

/** The owner's request for outreach in this turn, or a refusal for the model. */
function requireOutreachRequest(context: ToolContext): string {
  const request = context.outreachRequest !== undefined
    ? context.outreachRequest
    : outreachRequested(context.ownerText, context.lastAssistantText) ? context.ownerText : null;
  if (!request) throw new ToolArgumentError(outreachRequestProblem("", null)!);
  return request;
}

/**
 * Why a Google Maps search of `where` cannot run well now, or null: a whole
 * country is too wide, and while the map lookup is down a search would fall
 * back to a mode that returns almost nothing. An unknown place is left to
 * the scraper, and with geocoding switched off the check is skipped.
 */
async function checkSearchArea(where: string, language: string): Promise<{ problem: string; refused: boolean } | null> {
  if (!geocoderUrl()) return null;
  const { area, unavailable } = await lookupPlace(where, language);
  if (unavailable) return { problem: `The map lookup for “${where}” is not answering right now, so the search was not started. Try again in a minute.`, refused: false };
  const problem = area ? searchAreaProblem(area, where) : null;
  return problem ? { problem, refused: true } : null;
}

function text(args: Record<string, unknown>, key: string, required = false): string | undefined {
  const value = args[key];
  if (value === undefined || value === null || value === "") {
    if (required) throw new ToolArgumentError(`${key} is required`);
    return undefined;
  }
  if (typeof value !== "string") throw new ToolArgumentError(`${key} must be text`);
  return value;
}

function uuid(args: Record<string, unknown>, key: string, required = true): string | undefined {
  const value = text(args, key, required);
  if (value !== undefined && !/^[0-9a-f-]{36}$/i.test(value)) throw new ToolArgumentError(`${key} must be an id from an earlier result`);
  return value;
}

function channels(args: Record<string, unknown>): AudienceChannel[] | undefined {
  const value = args.channels;
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((channel) => !["email", "whatsapp", "linkedin"].includes(String(channel)))) {
    throw new ToolArgumentError("channels must list email, whatsapp or linkedin");
  }
  return value as AudienceChannel[];
}

async function setupSnapshot() {
  const [profile, availability, automaticRuns, byok, webDiscoveryOn] = await Promise.all([
    getBusinessProfile(),
    channelAvailability(),
    db.select({ id: outreachRuns.id }).from(outreachRuns).where(and(inOrg(outreachRuns), eq(outreachRuns.autopilot, true), eq(outreachRuns.status, "running"))),
    getByokSettings(),
    featureEnabled("web_discovery"),
  ]);
  const connection = byok.connectionId ? await getAiConnection(byok.connectionId) : null;
  const discovery = discoveryAvailability();
  const known = businessContext(profile, await businessSources());
  return {
    profile,
    missingForDiscovery: known.missingForDiscovery,
    missingForOutreach: known.missingForOutreach,
    /** What is already known outside the profile (documents, prices, sender, instructions), and what is worth asking once. */
    knownElsewhere: known.summary,
    optionalToAsk: known.optional,
    channels: {
      email: availability.email,
      whatsapp: availability.whatsapp,
      linkedin: availability.linkedin,
    },
    leadDiscovery: discovery,
    /** Website and directory search: the optional feature, and the organization's web-searching AI provider. */
    webDiscovery: { enabled: webDiscoveryOn, ...webSearchAvailabilityFrom(byok, connection) },
    ai: { connected: Boolean(connection?.verified), defaultModel: byok.defaultModel?.modelId ?? null },
    /** Optional features (Settings → Organization), all off by default, and whether new inquiries can be answered. */
    features: await featureState(),
    inquiryReplies: { problem: await inquiryRunReadiness() },
    /** Running runs in Automatic reply mode (each answers only its own conversations). */
    automaticRuns: automaticRuns.length,
  };
}

const AUDIENCE_SOURCE_WORD: Record<string, string> = { discovery: "found", list: "uploaded" };

/** Website and directory search's readiness, in a sentence for check_setup. */
function webDiscoveryLine(web: { enabled: boolean; available: boolean; provider: string | null; model: string | null; reason: string | null }): string {
  if (!web.enabled) return "Website and directory search: off (an owner or admin can turn it on in Settings → Organization).";
  return web.available
    ? `Website and directory search: ready (${web.provider === "openrouter" ? "OpenRouter web search" : "AI/ML API web research model"}, ${web.model}).`
    : `Website and directory search: not ready — ${web.reason}`;
}

/** What a website and directory search is doing, for lead_search_status. */
function webDiscoveryProgress(job: typeof assistantJobs.$inferSelect): string {
  const progress = job.progress as { searches?: number; searchesDone?: number; candidates?: number; read?: number; found?: number; saved?: number };
  const result = (job.result ?? {}) as { found?: number; eligible?: number; note?: string | null };
  if (job.status === "failed") return `The web search failed: ${job.error ?? "unknown error"}`;
  if (job.status === "succeeded") {
    return result.found
      ? `Finished: ${result.found} found on websites, directories and public pages, ${result.eligible ?? 0} can be contacted.${result.note ? ` ${result.note}` : ""}`
      : result.note ?? "Finished: nothing found.";
  }
  if (job.stage === "reading") return `Reading websites and directories: ${progress.read ?? 0} of ${progress.candidates ?? "?"} pages done (${progress.found ?? 0} found so far).`;
  if (job.stage === "saving") return `Saving leads: ${progress.saved ?? 0} of ${progress.found ?? "?"}.`;
  return `Searching the web (${progress.searchesDone ?? 0} of ${progress.searches ?? "?"} searches done)…`;
}

export const TOOLS: Record<string, Tool> = {
  check_setup: {
    description: "What is connected and what the business profile still lacks. Call it before asking the owner about setup.",
    arguments: "none",
    run: async () => {
      const setup = await setupSnapshot();
      const channelLine = (Object.entries(setup.channels) as [string, { available: boolean; reason: string | null; senders: number }][])
        .map(([name, status]) => `${name}: ${status.available ? `ready (${status.senders} sender${status.senders === 1 ? "" : "s"})` : `not ready — ${status.reason}`}`)
        .join("; ");
      return {
        ok: true,
        summary: `${channelLine}. Lead discovery: ${setup.leadDiscovery.available ? "Google Maps ready" : setup.leadDiscovery.reason}. ${webDiscoveryLine(setup.webDiscovery)} AI: ${setup.ai.connected ? "connected" : "not connected"}. Runs answering replies automatically: ${setup.automaticRuns}. Profile missing for discovery: ${setup.missingForDiscovery.join(", ") || "nothing"}; for outreach: ${setup.missingForOutreach.join(", ") || "nothing"}. Known elsewhere: ${setup.knownElsewhere}. Optional features on: ${Object.entries(setup.features).filter(([, on]) => on).map(([key]) => key).join(", ") || "none"}.${setup.features.instagram || setup.features.inquiry_intake ? ` Answering new inquiries: ${setup.inquiryReplies.problem ?? "ready"}.` : ""}`,
        data: setup as unknown as Record<string, unknown>,
      };
    },
  },

  save_business_info: {
    description: "Remember what the owner said about the business, customers, places, offer, sender or preferences. Saved for every later conversation and used by every message the AI writes. Call it as soon as the owner gives such information.",
    arguments: "any of: businessName, website, offer, problemsSolved (the problems the offer solves and how), nextStep (what an interested lead is offered next: a call, a visit, a quote), prices (prices, packages or rates as the owner gave them), targetCustomers, locations, outreachInstructions, senderName, senderRole, bookingDetails, language (two letters), notes (all text); preferredChannels (array of email|whatsapp|linkedin). An empty string clears a field.",
    run: async (args, context) => {
      const current = await getBusinessProfile();
      // Bad values are reported below; a save of valid values that changes nothing is refused.
      if (!mergeProfile(current, args).problems.length && !profileChanges(current, args).length) throw new ToolArgumentError("nothing new to save");
      const { profile, problems } = await updateBusinessProfile(args, context.userId);
      const saved = Object.keys(args).filter((key) => !problems.some((problem) => problem.startsWith(key)));
      const labels = saved.map((key) => PROFILE_LABELS[key as keyof typeof PROFILE_LABELS] ?? key).join(", ");
      return {
        ok: problems.length === 0,
        summary: problems.length ? `Saved ${saved.join(", ") || "nothing"}; not saved: ${problems.join("; ")}` : `Saved: ${saved.join(", ")}.`,
        display: problems.length ? `Saved ${labels || "nothing"}. Not saved: ${problems.join("; ")}.` : `Remembered: ${labels}.`,
        data: { profile, problems },
      };
    },
  },

  search_knowledge: {
    description: "Read the owner's saved business information and uploaded documents for a topic, to answer a question about the business.",
    arguments: "query (text)",
    run: async (args) => {
      const query = text(args, "query", true)!;
      const selection = await retrieveKnowledge(db, { query, maxTokens: 1_200, limit: 20 });
      const entries = selection.entries.map((entry) => ({ title: entry.title, excerpt: entry.excerpt }));
      return {
        ok: true,
        summary: entries.length ? entries.map((entry) => `“${entry.title}”: ${entry.excerpt.slice(0, 600)}`).join("\n") : "Nothing saved matches that.",
        data: { entries },
      };
    },
  },

  find_leads: {
    description: "Search public Google Maps business listings for leads matching the owner's target customers, then read each business's own website for published contact details. Takes a few minutes and runs in the background; the chat shows its progress and announces the result. It runs on Apify's Google Maps Scraper when the organization set Apify up (approved, within its budget; paid from the owner's Apify account), otherwise on the self-hosted scraper at no cost per search, and when neither is available, on website search when that is on — the result says which, and what the fallback covers less well. Only businesses with a public listing are found.",
    arguments: "what (kind of business, e.g. 'dental clinics'), where (city/region/country), maxResults (5-200, default 50), language (two letters, optional), contactAfter (true only when the owner asked to contact, email or message the leads found: the outreach plan is then prepared automatically when the search finishes), channels (optional, with contactAfter: array of email|whatsapp|linkedin)",
    run: async (args, context) => {
      const profile = await getBusinessProfile();
      const criteria = normalizeCriteria(args, profile.language ?? "en");
      if ("error" in criteria) throw new ToolArgumentError(criteria.error);
      if (args.contactAfter !== undefined && typeof args.contactAfter !== "boolean") throw new ToolArgumentError("contactAfter must be true or false");
      const request = args.contactAfter === true ? requireOutreachRequest(context) : null;
      const area = await checkSearchArea(criteria.where, criteria.language);
      if (area?.refused) throw new ToolArgumentError(area.problem);
      if (area) return { ok: false, summary: area.problem };
      const contactAfter = request ? { channels: channels(args) ?? null, ownerRequest: request, requestId: context.outreachRequestId ?? undefined } : null;
      try {
        const started = await startDiscovery(criteria, context, { contactAfter });
        const via = started.provider === "apify" ? " on Apify's Google Maps Scraper" : started.provider === "website" ? " on website and directory search (no Google Maps search is available)" : "";
        return {
          ok: true,
          summary: `Search started for “${started.phrase}”${via} (up to ${criteria.maxResults} businesses); job ${started.jobId}, audience ${started.audienceId}. It runs in the background; results are announced in the chat when done.${contactAfter ? " The outreach plan will be prepared automatically when it finishes." : ""}${started.note ? ` ${started.note}` : ""}`,
          data: { jobId: started.jobId, audienceId: started.audienceId, phrase: started.phrase, criteria, provider: started.provider, note: started.note },
        };
      } catch (error) {
        if (error instanceof DiscoveryUnavailableError) return { ok: false, summary: error.message };
        throw error;
      }
    },
  },

  find_instagram_prospects: {
    available: (features) => features.apify_discovery,
    description: "Find Instagram accounts that post about the owner's kind of customers in a place, through Apify (the organization's approved Instagram Actors, within its budget; paid from the owner's Apify account): public posts under hashtags made from the customer type and place (plus any the owner names), then the accounts' public profiles and the websites they list, for emails and phones they publish. Finding an account is NOT a way to contact it: AgentSDR cannot start Instagram chats, so only accounts that publish an email or phone can be contacted; the rest are listed with the reason. Hashtags do not filter by place: accounts whose post or profile does not name the place are marked location unknown. Without Apify available, website search takes the request when it is on (same request), else it says nothing was searched. Runs in the background and announces the result.",
    arguments: "what (kind of customer or business, e.g. 'home bakers'), where (city/area), hashtags (optional array of hashtags the owner named), maxResults (5-100 accounts, default 30), contactAfter (true only when the owner asked to contact the people found: the plan then covers those with a published email or phone), channels (optional, with contactAfter: array of email|whatsapp)",
    run: async (args, context) => {
      if (!(await featureEnabled("apify_discovery"))) return { ok: false, summary: new FeatureDisabledError("apify_discovery").message };
      const profile = await getBusinessProfile();
      const what = text(args, "what") ?? profile.targetCustomers?.trim() ?? null;
      const where = text(args, "where") ?? profile.locations?.trim() ?? null;
      if (!what) throw new ToolArgumentError("say what kind of accounts to look for");
      if (!where) throw new ToolArgumentError("say which place (a city or area)");
      if (args.contactAfter !== undefined && typeof args.contactAfter !== "boolean") throw new ToolArgumentError("contactAfter must be true or false");
      const hashtags = Array.isArray(args.hashtags) ? args.hashtags.filter((tag): tag is string => typeof tag === "string").slice(0, 3) : [];
      const requested = Number(args.maxResults ?? 30);
      const maxResults = Number.isFinite(requested) ? Math.min(100, Math.max(5, Math.round(requested))) : 30;
      const request = args.contactAfter === true ? requireOutreachRequest(context) : null;
      const contactAfter = request ? { channels: channels(args) ?? null, ownerRequest: request, requestId: context.outreachRequestId ?? undefined } : null;
      try {
        const started = await startInstagramProspects({ what: what.slice(0, 200), where: where.slice(0, 200), hashtags, maxResults, language: profile.language ?? "en" }, context, { contactAfter });
        const via = started.provider === "apify" ? `Instagram search started for ${started.phrase} through Apify` : `Instagram search through Apify is not available, so website and directory search started instead for “${what}” in ${where}`;
        return {
          ok: true,
          summary: `${via}; job ${started.jobId}, audience ${started.audienceId}. Results are announced in the chat when done.${contactAfter ? " The outreach plan will be prepared automatically for those who can be contacted." : ""} ${started.note ?? ""}`.trim(),
          data: { jobId: started.jobId, audienceId: started.audienceId, phrase: started.phrase, provider: started.provider, note: started.note },
        };
      } catch (error) {
        if (error instanceof DiscoveryUnavailableError) return { ok: false, summary: error.message };
        throw error;
      }
    },
  },

  find_social_leads: {
    available: (features) => features.apify_discovery,
    description: "Find businesses on a social platform by keyword and place, through Apify (the organization's approved Actors, within its budget; paid from the owner's Apify account): platform 'facebook' — Facebook business pages with the phone, email, website and address each publishes; 'linkedin' — LinkedIn companies (no emails on LinkedIn: contacts come from reading each company's own website; the Actor reads LinkedIn without logging in, which LinkedIn's terms do not allow, so the owner approves it knowingly); 'instagram' — Instagram accounts from Instagram's own account search, then their public profiles. Each lead's website is read for the contacts it publishes. Finding a page or account is NOT a way to contact it: AgentSDR never messages anyone on Facebook or Instagram, so only those with an email or phone can be contacted; the rest are listed with the reason. When the platform's Actor is not approved or the budget is used, it says so and nothing is searched. Runs in the background and announces the result.",
    arguments: "platform (facebook|linkedin|instagram), what (kind of business, e.g. 'real estate agencies'), where (city/area), maxResults (5-100, default 30), contactAfter (true only when the owner asked to contact the people found), channels (optional, with contactAfter: array of email|whatsapp|linkedin)",
    run: async (args, context) => {
      if (!(await featureEnabled("apify_discovery"))) return { ok: false, summary: new FeatureDisabledError("apify_discovery").message };
      const platform = args.platform;
      if (platform !== "facebook" && platform !== "linkedin" && platform !== "instagram") throw new ToolArgumentError("platform must be facebook, linkedin or instagram");
      const profile = await getBusinessProfile();
      const what = text(args, "what") ?? profile.targetCustomers?.trim() ?? null;
      const where = text(args, "where") ?? profile.locations?.trim() ?? null;
      if (!what) throw new ToolArgumentError("say what kind of businesses to look for");
      if (!where) throw new ToolArgumentError("say which place (a city or area)");
      if (args.contactAfter !== undefined && typeof args.contactAfter !== "boolean") throw new ToolArgumentError("contactAfter must be true or false");
      const requested = Number(args.maxResults ?? 30);
      const maxResults = Number.isFinite(requested) ? Math.min(100, Math.max(5, Math.round(requested))) : 30;
      const request = args.contactAfter === true ? requireOutreachRequest(context) : null;
      const contactAfter = request ? { channels: channels(args) ?? null, ownerRequest: request, requestId: context.outreachRequestId ?? undefined } : null;
      try {
        const started = await startSocialProspects(platform, { what: what.slice(0, 200), where: where.slice(0, 200), maxResults, language: profile.language ?? "en" }, context, { contactAfter });
        const name = platform === "facebook" ? "Facebook" : platform === "linkedin" ? "LinkedIn" : "Instagram";
        return {
          ok: true,
          summary: `${name} search started for “${what}” in ${where} through Apify (up to ${maxResults}); job ${started.jobId}, audience ${started.audienceId}. Results are announced in the chat when done.${contactAfter ? " The outreach plan will be prepared automatically for those who can be contacted." : ""} ${started.note ?? ""}`.trim(),
          data: { jobId: started.jobId, audienceId: started.audienceId, phrase: started.phrase, provider: started.provider, note: started.note },
        };
      } catch (error) {
        if (error instanceof DiscoveryUnavailableError) return { ok: false, summary: error.message };
        throw error;
      }
    },
  },

  find_customers_on_web: {
    available: (features) => features.web_discovery,
    description: "Find customers matching the owner's description of them with a real web search provider (the organization's OpenRouter connection with its web plugin, or AI/ML API's web research model; never a model answering from memory): only the pages the provider returned are used. It reads the businesses' own websites and the local directories or lists the search returned (and the business websites those directories link to) for the emails and phones they publish, and keeps each contact with the page it came from; it never guesses an email, phone, person or page, and people already in the leads are reused, not duplicated. Public Instagram profiles and posts the search returns are read (a profile's website, a post's comments) only when Instagram is connected (the Instagram feature on and an account linked); otherwise they are skipped. People found only on Instagram are listed but cannot be contacted from here. Up to 3 paid searches; runs in the background and announces the result in the chat. Needs the Website and directory search feature.",
    arguments: "customers (who the customers are, from the owner's words or the business profile), where (city/area/region), maxResults (5-40 business websites to read, default 20), contactAfter (true only when the owner asked to contact, email or message the leads found: the outreach plan is then prepared automatically when the search finishes), channels (optional, with contactAfter: array of email|whatsapp|linkedin)",
    run: async (args, context) => {
      if (!(await featureEnabled("web_discovery"))) return { ok: false, summary: new FeatureDisabledError("web_discovery").message };
      const availability = await webSearchAvailability();
      if (!availability.available) return { ok: false, summary: `Website and directory search is not available: ${availability.reason}` };
      const profile = await getBusinessProfile();
      const criteria = normalizeWebCriteria({
        customers: text(args, "customers") ?? profile.targetCustomers,
        where: text(args, "where") ?? profile.locations,
        maxResults: args.maxResults,
        language: profile.language,
        offer: profile.offer,
        ownWebsite: profile.website,
      }, profile.language ?? "en");
      if ("error" in criteria) throw new ToolArgumentError(criteria.error);
      if (args.contactAfter !== undefined && typeof args.contactAfter !== "boolean") throw new ToolArgumentError("contactAfter must be true or false");
      const request = args.contactAfter === true ? requireOutreachRequest(context) : null;
      const contactAfter = request ? { channels: channels(args) ?? null, ownerRequest: request, requestId: context.outreachRequestId ?? undefined } : null;
      try {
        const started = await startWebDiscovery(criteria, context, { contactAfter });
        const instagram = started.instagram.usable ? " Public Instagram profiles and posts it returns are read too." : ` Instagram pages are skipped (${started.instagram.reason}).`;
        const provider = started.provider === "openrouter" ? "OpenRouter web search" : "AI/ML API web research";
        return {
          ok: true,
          summary: `Web search started for “${started.phrase}” with ${provider} (${started.model}): ${started.queries.length} searches, up to ${criteria.maxResults} business websites; job ${started.jobId}, audience ${started.audienceId}.${instagram} Results are announced in the chat when done.${contactAfter ? " The outreach plan will be prepared automatically when it finishes." : ""}`,
          display: `Searching the web for “${started.phrase}” (${provider}, ${started.queries.length} searches, up to ${criteria.maxResults} websites).${instagram}`,
          data: { jobId: started.jobId, audienceId: started.audienceId, phrase: started.phrase, queries: started.queries, provider: started.provider, model: started.model, instagram: started.instagram, criteria },
        };
      } catch (error) {
        if (error instanceof WebDiscoveryUnavailableError) return { ok: false, summary: error.message };
        throw error;
      }
    },
  },

  add_contacts: {
    description: "Add people the owner gave in the chat (phone numbers, emails or LinkedIn profile links, with a name or company when given) as a new lead list, so outreach can be prepared for them (contactAfter true when the owner asked for it: the plan follows automatically). Only contacts the owner wrote, or that are on a page read with read_webpage. A phone number without + and a country code is refused unless the organization has a Default phone country: ask the owner which country, never guess it.",
    arguments: "contacts (array of objects with name, phone, email, linkedinUrl, company; each needs a phone, email or linkedinUrl; up to 50), listName (optional), contactAfter (true when the owner asked to contact, message or pitch these people: the outreach plan is then prepared right after), channels (optional, with contactAfter: array of email|whatsapp|linkedin)",
    run: async (args, context) => {
      if (!Array.isArray(args.contacts) || !args.contacts.length) throw new ToolArgumentError("contacts must be a non-empty array");
      if (args.contacts.length > MAX_CHAT_CONTACTS) throw new ToolArgumentError(`at most ${MAX_CHAT_CONTACTS} contacts at once; for more, attach a CSV or Excel list`);
      const rows: ImportRow[] = args.contacts.map((item, index) => {
        const contact = (item && typeof item === "object" ? item : {}) as Record<string, unknown>;
        const field = (key: string) => (typeof contact[key] === "string" && contact[key].trim() ? contact[key].trim() : null);
        return { rowNumber: index + 1, fullName: field("name"), phone: field("phone"), email: field("email"), linkedinUrl: field("linkedinUrl"), companyName: field("company"), customFields: { addedVia: "assistant chat" } };
      });
      const result = await importPeopleRows(rows);
      const failures = result.failed.map((failure) => `${failure.identity}: ${failure.error}`);
      // Nothing usable (usually a number without its country code): the assistant asks the owner, no card.
      if (!result.personIds.length) throw new ToolArgumentError(`no contact was added. ${failures.join(" ")}`);
      const name = text(args, "listName")?.slice(0, 200) ?? `Contacts from the chat (${new Date().toISOString().slice(0, 10)})`;
      const audienceId = await createAudience({
        name,
        source: "list",
        criteria: { source: "chat", imported: { created: result.created, updated: result.updated, failed: result.failed.length, skippedNoIdentity: result.skippedNoIdentity } },
        threadId: context.threadId,
        userId: context.userId,
      });
      await addAudienceMembers(audienceId, result.personIds.map((personId) => ({ personId, source: "list" })));
      // Read back what was stored (phones normalized with their country code) so the owner can check it.
      const stored = await db.select({ name: people.fullName, phone: people.phone, email: people.email, linkedinUrl: people.linkedinUrl })
        .from(people).where(and(inOrg(people), inArray(people.id, result.personIds)));
      const saved = stored.map((person) => [person.name, person.phone, person.email, person.linkedinUrl].filter(Boolean).join(" · ")).join("; ");
      return {
        ok: true,
        summary: `Added ${result.personIds.length} contact${result.personIds.length === 1 ? "" : "s"} as lead list ${audienceId} “${name}”: ${saved}.${failures.length ? ` Not added: ${failures.join(" ")}` : ""}`,
        display: `${saved}${failures.length ? `. Not added: ${failures.join(" ")}` : ""}`,
        data: { audienceId, audience: await summarizeAudience(audienceId) },
      };
    },
  },

  use_existing_leads: {
    description: "Make a lead list from people already in the lead database: everyone, the latest import, people matching a word (name, company, title, email or details such as a city), or the people who sent inquiries (website forms, Instagram). It only prepares the list, with why each person is on it and what they wrote when they inquired; nobody is contacted. Then call prepare_outreach for it when the owner asked to contact them (they press Start). People already in a running or paused outreach run are left out, and Do Not Contact or unsubscribed people are excluded with the reason. Imported (historical) inquiries are left out unless the owner asks for them.",
    arguments: "from (all | latest_import | inquiries; default all), search (optional word to match), maxLeads (1-500, default 100), includeHistorical (optional true: inquiries from imported history too), listName (optional)",
    run: async (args, context) => {
      const from = args.from === undefined ? "all" : args.from;
      if (!isExistingLeadsFrom(from)) throw new ToolArgumentError("from must be all, latest_import or inquiries");
      if (args.includeHistorical !== undefined && typeof args.includeHistorical !== "boolean") throw new ToolArgumentError("includeHistorical must be true or false");
      const maxLeads = args.maxLeads === undefined ? undefined : Number(args.maxLeads);
      if (maxLeads !== undefined && (!Number.isFinite(maxLeads) || maxLeads < 1 || maxLeads > MAX_EXISTING_LEADS)) throw new ToolArgumentError(`maxLeads must be between 1 and ${MAX_EXISTING_LEADS}`);
      const result = await createExistingLeadsAudience({
        from,
        search: text(args, "search")?.slice(0, 120) ?? null,
        maxLeads,
        includeHistorical: args.includeHistorical === true,
        listName: text(args, "listName") ?? null,
        threadId: context.threadId,
        userId: context.userId,
      });
      if (!result.audienceId || !result.audience) {
        const why = result.alreadyInRuns ? ` ${result.alreadyInRuns} matching ${result.alreadyInRuns === 1 ? "person is" : "people are"} already in a running or paused outreach run.` : "";
        return { ok: false, summary: `No one in the lead database matches that.${why}` };
      }
      const a = result.audience;
      return {
        ok: true,
        summary: `Lead list ${a.id} “${a.name}”: ${a.eligible} contactable of ${a.total} (email ${a.byChannel.email}, WhatsApp ${a.byChannel.whatsapp}, LinkedIn ${a.byChannel.linkedin}).${a.excluded.length ? ` Left out: ${a.excluded.map((e) => `${e.count} × ${e.reason}`).join("; ")}.` : ""}${result.alreadyInRuns ? ` ${result.alreadyInRuns} already in a running outreach run were not added.` : ""} Nobody was contacted.`,
        display: `“${a.name}”: ${a.eligible} of ${a.total} can be contacted${result.alreadyInRuns ? `; ${result.alreadyInRuns} already in a running outreach run were left out` : ""}.`,
        data: { audienceId: a.id, audience: a },
      };
    },
  },

  list_inquiries: {
    available: (features) => features.inquiry_intake,
    description: "The inquiries received in the last 30 days (website forms, Instagram): how many are new, how many came from imported history, and the latest few with what they wrote.",
    arguments: "none",
    run: async () => {
      const overview = await inquiryOverview(30);
      const latest = overview.latest.map((item) => `${item.at.slice(0, 10)} ${item.source === "instagram" ? "Instagram" : "website form"}: ${item.name ?? "someone"}${item.message ? ` — “${item.message}”` : ""}`).join("\n");
      return {
        ok: true,
        summary: `Last 30 days: ${overview.fresh} new inquiries (${overview.bySource.map((item) => `${item.source === "instagram" ? "Instagram" : "website form"} ${item.count}`).join(", ") || "none"}), ${overview.historical} from imported history, ${overview.unusable} without a usable email or phone.${latest ? `\n${latest}` : ""}`,
        data: overview as unknown as Record<string, unknown>,
      };
    },
  },

  prepare_inquiry_replies: {
    available: (features) => features.instagram && features.inquiry_intake,
    description: "Propose answering new Instagram inquiries: from when the owner presses Start, people whose first message arrives on an Instagram account that treats new messages as inquiries get replies drafted from the owner's saved information — sent automatically in Automatic mode, or waiting in Action required in Review mode — with every existing check, limit and handoff. It never answers imported history, earlier chats or anyone else, and sends nothing first. Only when the owner asked for their inquiries or Instagram messages to be answered.",
    arguments: "autopilot (optional true/false: propose Automatic replies)",
    run: async (args, context) => {
      if (!inquiryRepliesRequested(context.ownerText, context.lastAssistantText)) {
        throw new ToolArgumentError("the owner has not asked for their inquiries to be answered; offer it and wait for a yes");
      }
      const request = context.ownerText;
      if (args.autopilot !== undefined && typeof args.autopilot !== "boolean") throw new ToolArgumentError("autopilot must be true or false");
      try {
        const proposal = await prepareInquiryReplies({ autopilot: args.autopilot as boolean | undefined, ownerRequest: request, threadId: context.threadId, userId: context.userId });
        return {
          ok: true,
          summary: `Inquiry plan ${proposal.runId} ready: “${proposal.name}”, answering new Instagram inquiries on ${proposal.accounts.filter((account) => account.inquiryIntake && account.status === "connected").map((account) => account.username ? `@${account.username}` : "an account").join(", ")}. It is shown to the owner with a Start button and a choice of Automatic or Review; nothing happens until they press Start.`,
          data: { runId: proposal.runId, name: proposal.name, plan: proposal.plan },
        };
      } catch (error) {
        if (error instanceof InquiryRunError) return { ok: false, summary: error.message };
        throw error;
      }
    },
  },

  read_webpage: {
    description: "Open one public web page from a link the owner gave (or a link on a page already read) and read its text and the emails, phones and LinkedIn links on it: for example the owner's own website, to learn about the business, or a page listing people to contact. Not a web search; it cannot log in, so Instagram, Facebook, X, TikTok and LinkedIn pages cannot be read.",
    arguments: "url",
    run: async (args) => {
      const raw = text(args, "url", true)!.trim();
      let url: URL;
      try {
        url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
      } catch {
        throw new ToolArgumentError(`“${raw}” is not a web address`);
      }
      if (LOGIN_WALLED.test(url.hostname)) {
        return { ok: false, summary: `${url.hostname} needs a login and does not allow automated reading, so it cannot be opened. LinkedIn people can be found with find_linkedin_leads; other networks are not supported.` };
      }
      let page: { url: string; html: string } | null;
      try {
        page = await fetchPublicPage(url.toString());
      } catch (error) {
        return { ok: false, summary: `Could not open ${url.toString()}: ${error instanceof Error ? error.message : String(error)}` };
      }
      if (!page) return { ok: false, summary: `${url.toString()} is not a readable web page.` };
      const title = visibleText(pageTitle(page.html)).trim().slice(0, 200);
      const body = visibleText(page.html).trim();
      const contacts = extractContacts(page.html, page.url).slice(0, 60);
      const host = new URL(page.url).hostname.replace(/^www\./, "");
      return {
        ok: true,
        summary: `Read ${page.url}${title ? ` “${title}”` : ""} (${body.length.toLocaleString("en-US")} characters). Contacts on the page: ${contacts.map((contact) => `${contact.kind} ${contact.value}`).join(", ") || "none"}. Text: ${body.slice(0, 6_000)}`,
        display: `${host}${title ? ` · ${title}` : ""} · ${contacts.length} contact${contacts.length === 1 ? "" : "s"} found`,
        data: { url: page.url, title, contacts },
      };
    },
  },

  find_linkedin_leads: {
    description: "Search LinkedIn for people by keywords (a job title, profession or industry, plus a place), with the organization's connected LinkedIn account through Unipile and its daily search allowance. Runs in the background; the profiles found can be contacted on LinkedIn only (LinkedIn gives no email or phone). Use for people (owners, managers, professionals); use find_leads for businesses with a public Maps listing.",
    arguments: "keywords (e.g. 'clinic owner Pune'), maxResults (5-200, default 50), contactAfter (true only when the owner asked to contact them)",
    run: async (args, context) => {
      const keywords = text(args, "keywords", true)!.trim().slice(0, 200);
      const requested = Number(args.maxResults ?? 50);
      const maxResults = Number.isFinite(requested) ? Math.min(200, Math.max(5, Math.round(requested))) : 50;
      if (args.contactAfter === true) {
        requireOutreachRequest(context);
      }
      const availability = await linkedinSearchAvailability();
      if (!availability.available) return { ok: false, summary: `LinkedIn search is not available: ${availability.reason}` };
      const started = await startLinkedinSearch({ keywords, maxResults }, context, {
        contactAfter: args.contactAfter === true ? { channels: ["linkedin"], ownerRequest: requireOutreachRequest(context), requestId: context.outreachRequestId ?? undefined } : null,
      });
      return {
        ok: true,
        summary: `LinkedIn search started for “${keywords}” (up to ${maxResults} people); job ${started.jobId}, audience ${started.audienceId}. Results are announced in the chat when done.`,
        display: `LinkedIn search started for “${keywords}” (up to ${maxResults} people).`,
        data: { jobId: started.jobId, audienceId: started.audienceId, keywords },
      };
    },
  },

  lead_search_status: {
    description: "The progress or result of a lead search (Google Maps, LinkedIn or web).",
    arguments: "jobId (optional; the latest search when left out)",
    run: async (args) => {
      const jobId = uuid(args, "jobId", false);
      const [job] = await db.select().from(assistantJobs)
        .where(and(inOrg(assistantJobs), inArray(assistantJobs.kind, ["discovery", "linkedin_search", "web_discovery", "apify_instagram"]), ...(jobId ? [eq(assistantJobs.id, jobId)] : [])))
        .orderBy(desc(assistantJobs.createdAt)).limit(1);
      if (!job) return { ok: false, summary: "No lead search found." };
      if (job.kind === "web_discovery") {
        return {
          ok: true,
          summary: `Web search ${job.id}: ${job.status} (${job.stage}). Progress ${JSON.stringify(job.progress)}.${job.error ? ` Error: ${job.error}` : ""}${job.result ? ` Result: ${JSON.stringify(job.result)}` : ""}`,
          display: webDiscoveryProgress(job),
          data: { jobId: job.id, kind: job.kind, status: job.status, stage: job.stage, progress: job.progress, result: job.result, error: job.error, audienceId: job.audienceId },
        };
      }
      const progress = job.progress as { found?: number; websitesChecked?: number; websitesToCheck?: number; saved?: number };
      const result = (job.result ?? {}) as { found?: number; eligible?: number; note?: string | null };
      const display = job.status === "failed"
        ? `The search failed: ${job.error ?? "unknown error"}`
        : job.status === "succeeded"
          ? result.note ?? `Finished: ${result.found ?? 0} businesses found, ${result.eligible ?? 0} can be contacted.`
          : job.stage === "enriching"
            ? `Reading websites for contact details: ${progress.websitesChecked ?? 0} of ${progress.websitesToCheck ?? "?"} done (${progress.found ?? 0} businesses found).`
            : job.stage === "saving"
              ? `Saving leads: ${progress.saved ?? 0} of ${progress.found ?? "?"}.`
              : "Searching Google Maps (usually 3–10 minutes)…";
      return {
        ok: true,
        summary: `Search ${job.id}: ${job.status} (${job.stage}). Progress ${JSON.stringify(job.progress)}.${job.error ? ` Error: ${job.error}` : ""}${job.result ? ` Result: ${JSON.stringify(job.result)}` : ""}`,
        display,
        data: { jobId: job.id, status: job.status, stage: job.stage, progress: job.progress, result: job.result, error: job.error, audienceId: job.audienceId },
      };
    },
  },

  list_audiences: {
    description: "The lead lists so far (found or uploaded), newest first, with how many can be contacted.",
    arguments: "none",
    run: async () => {
      const audiences = await listAudiences(15);
      return {
        ok: true,
        summary: audiences.length ? audiences.map((a) => `${a.id}: “${a.name}” (${a.source}) ${a.eligible} contactable of ${a.total}`).join("\n") : "No lead lists yet.",
        display: audiences.length ? audiences.map((a) => `“${a.name}” (${AUDIENCE_SOURCE_WORD[a.source] ?? a.source}): ${a.eligible} of ${a.total} can be contacted`).join("\n") : "No lead lists yet.",
        data: { audiences },
      };
    },
  },

  describe_audience: {
    description: "One lead list in detail: how many leads per channel, who was left out and why, and a few examples with where their contact details came from.",
    arguments: "audienceId",
    run: async (args) => {
      const audienceId = uuid(args, "audienceId")!;
      const summary = await summarizeAudience(audienceId);
      if (!summary) return { ok: false, summary: "No such lead list." };
      const qualified = await audienceProspects(audienceId);
      const counts = qualified?.counts;
      const qualification = counts
        ? ` Qualification: ${counts.potential_match} potential matches (not yet interested), ${counts.inquired} inquired, ${counts.replied} replied, ${counts.interested} interested; ${counts.withNeedEvidence} with words of their own showing a need. Location and budget stay unknown unless the source stated them.`
        : "";
      return {
        ok: true,
        summary: `“${summary.name}”: ${summary.eligible} contactable of ${summary.total} (email ${summary.byChannel.email}, WhatsApp ${summary.byChannel.whatsapp}, LinkedIn ${summary.byChannel.linkedin}). Left out: ${summary.excluded.map((e) => `${e.count} × ${e.reason}`).join("; ") || "none"}.${qualification}`,
        data: { ...summary, ...(counts ? { qualification: counts } : {}) } as unknown as Record<string, unknown>,
      };
    },
  },

  prepare_outreach: {
    description: "Write the outreach for a lead list and plan the run. It first sorts the leads by itself: what kind of lead each is (each kind gets its own messages), which leads deserve a first message written for them alone, and which clearly do not fit the owner's offer (left out with the reason). Then it plans which channel each lead gets, the messages (with real samples), daily limits, how long it takes and the AI cost. Creates nothing and sends nothing; the owner reviews the plan, chooses Automatic or Review replies and presses Start. Only when the owner asked for outreach (or said yes to your offer of it). To contact more people with an earlier run's messages, pass basedOnRunId (a new plan the owner approves again).",
    arguments: "audienceId; channels (optional array of email|whatsapp|linkedin in order of preference); maxLeads (optional, default up to 100); autopilot (optional true/false: propose Automatic replies); instructions (optional text, e.g. tone or angle for this run); basedOnRunId (optional: reuse that run's messages); includeSkipped (optional true: also contact the leads the sorting leaves out, when the owner asks)",
    run: async (args, context) => {
      const request = context.authorizedBy === "search" ? context.ownerText : requireOutreachRequest(context);
      if (args.includeSkipped !== undefined && typeof args.includeSkipped !== "boolean") throw new ToolArgumentError("includeSkipped must be true or false");
      const audienceId = uuid(args, "audienceId")!;
      const basedOnRunId = uuid(args, "basedOnRunId", false) ?? null;
      const maxLeads = args.maxLeads === undefined ? undefined : Number(args.maxLeads);
      if (maxLeads !== undefined && (!Number.isFinite(maxLeads) || maxLeads < 1)) throw new ToolArgumentError("maxLeads must be a positive number");
      if (args.autopilot !== undefined && typeof args.autopilot !== "boolean") throw new ToolArgumentError("autopilot must be true or false");
      try {
        const proposal = await prepareOutreach({
          audienceId,
          channels: channels(args),
          maxLeads,
          autopilot: args.autopilot as boolean | undefined,
          instructions: text(args, "instructions") ?? null,
          basedOnRunId,
          ownerRequest: request || null,
          requestId: context.outreachRequestId ?? null,
          includeSkipped: args.includeSkipped === true,
          threadId: context.threadId,
          userId: context.userId,
        });
        const perChannel = proposal.plan.assignments.reduce<Record<string, number>>((acc, a) => ({ ...acc, [a.channel]: (acc[a.channel] ?? 0) + 1 }), {});
        const plan = proposal.plan;
        const sorted = plan.groups?.length
          ? ` Sorted into ${plan.groups.map((group) => `“${group.label}” (${group.count})`).join(", ")}; ${plan.personal?.length ?? 0} written to individually; ${plan.skipped?.length ?? 0} left out${plan.skipped?.length ? ` (${[...new Set(plan.skipped.map((item) => item.reason))].slice(0, 3).join("; ")})` : ""}.`
          : "";
        return {
          ok: true,
          summary: `Plan ${proposal.runId} ready for “${proposal.name}”: ${plan.assignments.length} leads (${Object.entries(perChannel).map(([c, n]) => `${c} ${n}`).join(", ")}), about ${plan.estimate.days ?? "?"} days, AI cost about ${plan.estimate.aiCostUsd === null ? "unknown" : `$${plan.estimate.aiCostUsd}`}.${sorted}${context.autonomous ? " Autonomous mode: it starts on its own right after this unless a daily cap stops it; the next event line says which." : " It is shown to the owner with sample messages and a Start button; nothing is sent until they press Start."}`,
          data: proposal as unknown as Record<string, unknown>,
        };
      } catch (error) {
        if (error instanceof OutreachError) return { ok: false, summary: error.message };
        throw error;
      }
    },
  },

  list_runs: {
    description: "The outreach runs: proposed, running, paused or finished.",
    arguments: "none",
    run: async () => {
      const runs = await listRuns(10);
      return {
        ok: true,
        summary: runs.length ? runs.map((run) => `${run.id}: “${run.name}” ${run.status} via ${run.channels.join("+")}${run.autopilot ? ", autopilot on" : ""}`).join("\n") : "No outreach runs yet.",
        display: runs.length ? runs.map((run) => `“${run.name}”: ${run.status} via ${run.channels.join(" + ")}${run.autopilot ? ", reply autopilot on" : ""}`).join("\n") : "No outreach runs yet.",
        data: { runs },
      };
    },
  },

  report: {
    description: "Results from what was recorded: leads found and imported, duplicates, people contacted, emails/WhatsApp/LinkedIn requests and messages sent, replies, interested people, what waits for the owner, pending follow-ups, stopped and failed sends, AI spending and remaining limits. With runId, one run's per-channel counts.",
    arguments: "period (optional: today | yesterday | last_7_days | last_30_days | all_time; default last_7_days); runId (optional)",
    run: async (args) => {
      const runId = uuid(args, "runId", false);
      if (runId) {
        const report = await reportRun(runId);
        if (!report) return { ok: false, summary: "No such run." };
        return {
          ok: true,
          summary: `“${report.name}” is ${report.status} (${report.autopilot ? "Automatic" : "Review"} replies): ${report.channels.map((c) => `${c.channel}: ${c.contacted} contacted, ${c.messagesSent === null ? "" : `${c.messagesSent} sent, `}${c.replied} replied, ${c.finished} finished, ${c.stopped} stopped`).join("; ") || "no campaign launched yet"}.${report.error ? ` Problems: ${report.error}` : ""}`,
          data: report as unknown as Record<string, unknown>,
        };
      }
      const kind = (PERIOD_KINDS as readonly string[]).includes(String(args.period)) ? args.period as PeriodKind : "last_7_days";
      const r = await results(kind);
      return { ok: true, summary: resultsText(r), data: { results: r } as unknown as Record<string, unknown> };
    },
  },

  pause_outreach: {
    description: "Pause every campaign of a running outreach run (nothing more is sent until resumed).",
    arguments: "runId",
    run: async (args) => {
      try {
        const result = await setRunPaused(uuid(args, "runId")!, true);
        return { ok: result.changed.length > 0, summary: `Paused ${result.changed.join(", ") || "nothing"}.${result.problems.length ? ` Problems: ${result.problems.join("; ")}` : ""}`, data: result };
      } catch (error) {
        if (error instanceof OutreachError) return { ok: false, summary: error.message };
        throw error;
      }
    },
  },

  resume_outreach: {
    description: "Resume a paused outreach run the owner already approved.",
    arguments: "runId",
    run: async (args) => {
      try {
        const result = await setRunPaused(uuid(args, "runId")!, false);
        return { ok: result.changed.length > 0, summary: `Resumed ${result.changed.join(", ") || "nothing"}.${result.problems.length ? ` Problems: ${result.problems.join("; ")}` : ""}`, data: result };
      } catch (error) {
        if (error instanceof OutreachError) return { ok: false, summary: error.message };
        throw error;
      }
    },
  },

  stop_outreach: {
    description: "End an outreach run for good: its campaigns stop, its leads get nothing more and no automatic replies are sent for it. Cannot be undone (a new plan can be started). Use when the owner asks to stop or cancel a run.",
    arguments: "runId",
    run: async (args) => {
      try {
        const result = await stopRun(uuid(args, "runId")!);
        return { ok: true, summary: `Stopped ${result.stopped.join(", ") || "the run"}.${result.problems.length ? ` Problems: ${result.problems.join("; ")}` : ""}`, data: result };
      } catch (error) {
        if (error instanceof OutreachError) return { ok: false, summary: error.message };
        throw error;
      }
    },
  },

  switch_to_review: {
    description: "Stop answering replies automatically for a run (or every run): replies then wait for the owner in Action required. Switching a run to Automatic is the owner's button on the run card, not a tool.",
    arguments: "runId (optional; every running or paused run when left out)",
    run: async (args) => {
      const runId = uuid(args, "runId", false);
      const targets = runId
        ? [runId]
        : (await db.select({ id: outreachRuns.id }).from(outreachRuns).where(and(inOrg(outreachRuns), eq(outreachRuns.autopilot, true)))).map((row) => row.id);
      for (const id of targets) await setRunReplyMode(id, false).catch(() => undefined);
      return { ok: true, summary: targets.length ? `Review mode for ${targets.length} run${targets.length === 1 ? "" : "s"}: every reply now waits for the owner.` : "No run was answering automatically." };
    },
  },

  list_decisions: {
    description: "The questions and decisions waiting for the owner (missing information, complaints, offers or meetings the assistant may not decide), with the reason for each.",
    arguments: "none",
    run: async () => {
      const decisions = await listOpenDecisions(20);
      return {
        ok: true,
        summary: decisions.length ? decisions.map((d) => `${d.id} [${d.kind}] ${d.reason} — ${d.decision}`).join("\n") : "Nothing is waiting for the owner.",
        display: decisions.length ? decisions.map((d) => `${d.reason} ${d.decision}`).join("\n") : "Nothing is waiting for you.",
        data: { decisions: decisions.map((d) => ({ id: d.id, kind: d.kind, reason: d.reason, decision: d.decision })) },
      };
    },
  },

  answer_decision: {
    description: "Record the owner's answer to an open question or decision (only words the owner actually wrote). The answer is saved for every later conversation, and the waiting reply is rewritten with it and checked again.",
    arguments: "decisionId; answer (the owner's answer, in their words)",
    run: async (args, context) => {
      const answer = text(args, "answer", true)!;
      if (!context.ownerText.toLowerCase().includes(answer.toLowerCase().slice(0, 40))) {
        throw new ToolArgumentError("answer must be the owner's own words from this turn");
      }
      try {
        const result = await answerDecision(uuid(args, "decisionId")!, answer, context.userId);
        return {
          ok: true,
          summary: `Saved the answer for later conversations.${result.rewritten ? " The waiting reply was rewritten with it and goes through the checks again." : ""}${result.problem ? ` The reply could not be rewritten: ${result.problem}` : ""}`,
          data: result,
        };
      } catch (error) {
        if (error instanceof DecisionError) return { ok: false, summary: error.message };
        throw error;
      }
    },
  },
};

export const TOOL_NAMES = Object.keys(TOOLS);

/** The tools offered to the model: a tool of an optional feature that is off is left out entirely. */
export function toolNamesFor(features: FeatureState): string[] {
  return Object.entries(TOOLS).filter(([, tool]) => !tool.available || tool.available(features)).map(([name]) => name);
}

/** Runs one tool; argument problems come back as a failed result the model can correct. */
export async function runTool(name: string, args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
  const tool = TOOLS[name];
  if (!tool) return { ok: false, summary: `There is no tool called ${name}.` };
  try {
    return await tool.run(args, context);
  } catch (error) {
    if (error instanceof ToolArgumentError) return { ok: false, refused: true, summary: `Not run: ${error.message.replace(/\.$/, "")}.` };
    console.error(`[assistant/tools] ${name} failed:`, error);
    return { ok: false, summary: `Failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** The tools as the model reads them, only those `features` allow. */
export function toolCatalog(features: FeatureState): string {
  return toolNamesFor(features).map((name) => `- ${name}: ${TOOLS[name]!.description} Arguments: ${TOOLS[name]!.arguments}.`).join("\n");
}

export { setupSnapshot };
