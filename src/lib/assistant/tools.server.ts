import "server-only";

import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { getByokSettings } from "@/lib/ai/byok";
import { getAiConnection } from "@/lib/ai/connections";
import { retrieveKnowledge } from "@/lib/crm/knowledge";
import { discoveryAvailability, DiscoveryUnavailableError, normalizeCriteria, sourceLabel, startDiscovery, startInstagramProspects, startSocialProspects } from "@/lib/discovery/discovery.server";
import { coverageLine } from "./coverage";
import { requestCoverageFor } from "./coverage.server";
import { searchAreaProblem } from "@/lib/discovery/geocode";
import { extractContacts, publicLinks, visibleText } from "@/lib/discovery/contacts";
import { assertPublicPageUrl, fetchPublicPage, LOGIN_WALLED_HOST, PageRedirectRefusedError } from "@/lib/discovery/websiteContacts.server";
import { normalizeWebCriteria, startWebDiscovery, WebDiscoveryLimitError, WebDiscoveryUnavailableError } from "@/lib/discovery/webDiscovery.server";
import { normalizeSocialCriteria, SocialResearchUnavailableError, startSocialResearch, urlFinderName } from "@/lib/discovery/socialResearch.server";
import { brightdataSettingsView } from "@/lib/brightdata/brightdata.server";
import { BRIGHTDATA_LIMITS, PLATFORM_NAMES } from "@/lib/brightdata/catalog";
import { generalWebSearch, webSearchAvailability, webSearchAvailabilityFrom, webSearchProviderName, WebSearchUnavailableError } from "@/lib/discovery/webSearch.server";
import { fetchFailureText } from "@/lib/tinyfish/catalog";
import { fetchWithTinyfish, tinyfishConnection, TinyfishWaitError } from "@/lib/tinyfish/tinyfish.server";
import { browserAct, BrowserUnavailableError, closeBrowser, openBrowser, type BrowserAction } from "@/lib/browser/browser.server";
import { BROWSER_LIMITS, formatSnapshot, type PageSnapshot } from "@/lib/browser/snapshot";
import type { ResearchEvidence } from "@/lib/research/sources/catalog";
import { readResearchSource } from "@/lib/research/sources/read.server";
import { isRedditHost, redditRefusal } from "@/lib/research/sources/reddit";
import { redditApprovalRecorded } from "@/lib/research/sources/settings.server";
import { discussionNote } from "@/lib/research/sources/sources";
import type { FeatureState } from "@/lib/features/catalog";
import { featureEnabled, FeatureDisabledError } from "@/lib/features/flags.server";
import { compactResult, describeEndpoint, TREG_LIMITS } from "@/lib/treg/catalog";
import { callTregEndpoint, searchTreg, TregUnavailableError } from "@/lib/treg/treg.server";
import { tavilyConnection } from "@/lib/tavily/tavily.server";
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
import { channelList, channelPolicy, planChannelsLine } from "./channelPolicy";
import { typedByOwner } from "./leadFit";
import { markGivenByOwner } from "./qualify.server";
import { mergeProfile, PROFILE_LABELS, profileChanges } from "./profile";
import { businessContext } from "./businessContext";
import { businessSources } from "./businessContext.server";
import { getBusinessProfile, updateBusinessProfile } from "./profile.server";
import { ORGANIZATION_SCOPE, PERIOD_KINDS, RESULTS_SCOPE_KINDS, scopeIsEmpty, type PeriodKind, type ResultsScopeKind } from "./results";
import { requestScope, results, resultsText, runScope, threadScope } from "./results.server";
import { assistantJobs, outreachRuns, type AudienceChannel } from "./schema";
import { featureState } from "@/lib/features/flags.server";
import { createExistingLeadsAudience, inquiryOverview, MAX_EXISTING_LEADS } from "./existingLeads.server";
import { isExistingLeadsFrom } from "./existingLeads";
import { inquiryRunReadiness, InquiryRunError, prepareInquiryReplies } from "./inquiryRuns.server";
import { audienceProspects } from "./qualification.server";
import { diagnoseDelivery } from "./deliveryDiagnostics.server";
import { parseInstagramContacts } from "./instagramContacts";
import { createInstagramContactsAudience } from "./instagramContacts.server";
import { controlsSentence, ensureObjective, objectiveForRequest, objectiveLine, objectiveStartProblem, requestHoldReason, requestSpendCap, requestSpendGuard, setObjectiveState, threadObjectives } from "./objective.server";

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
  /** The owner's latest message, by id: searches started for it carry it, so its per-platform coverage can be told. */
  requestMessageId?: string | null;
  /** The request this turn's searches serve, decided once per turn (agent.ts searchRequestFor). */
  searchRequestId?: string | null;
};

/**
 * The request a search serves: as the turn decided it (agent.ts
 * searchRequestFor), else the outreach request when there is one (its plans
 * share it), else the owner's latest message.
 */
export function searchRequestId(context: ToolContext): string | null {
  return context.searchRequestId ?? context.outreachRequestId ?? context.requestMessageId ?? null;
}

/**
 * The request a search serves, pursued as an objective (objective.server.ts):
 * created with its first search (its controls from the owner's words, else
 * the defaults), and refusing new searches once it is paused, stopped or at
 * a limit. `line` tells the model the controls, once, with the first search.
 */
async function searchObjective(context: ToolContext): Promise<{ problem: string | null; line: string | null }> {
  const requestId = searchRequestId(context);
  const ensured = await ensureObjective({ requestMessageId: requestId, threadId: context.threadId, userId: context.userId });
  if (!ensured) return { problem: null, line: null };
  const problem = await objectiveStartProblem(requestId);
  return { problem, line: ensured.created ? controlsSentence(ensured.objective) : null };
}

/** A search refused by its request's objective, as a result the model reads (not the model's mistake). */
function objectiveRefusal(problem: string): ToolResult {
  return { ok: false, summary: `Not started: ${problem}.` };
}

/** A result's summary with the request's controls appended, the first time. */
function withControls(result: ToolResult, line: string | null): ToolResult {
  return line ? { ...result, summary: `${result.summary} ${line}` } : result;
}

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
/** Sites that need a login and forbid automated reading (the direct reader will not follow a redirect to one either). */
const LOGIN_WALLED = LOGIN_WALLED_HOST;

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

/** Which channels the plan a search prepares will use, from the policy that plan applies (channelPolicy.ts). */
function followUpChannels(contactAfter: { channels: AudienceChannel[] | null; ownerRequest: string }): string {
  const policy = channelPolicy({ requested: contactAfter.channels ?? [], ownerText: contactAfter.ownerRequest });
  return policy.restricted ? `only on ${channelList(policy.order)}, because ${policy.note}` : "with each lead on its best ready channel";
}

function channels(args: Record<string, unknown>): AudienceChannel[] | undefined {
  const value = args.channels;
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((channel) => !["email", "whatsapp", "linkedin", "instagram"].includes(String(channel)))) {
    throw new ToolArgumentError("channels must list email, whatsapp, linkedin or instagram");
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
  const tinyfish = await tinyfishConnection();
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
      instagram: availability.instagram,
    },
    leadDiscovery: discovery,
    /** Website and directory search: the optional feature, and its web search (Tavily, else the organization's web-searching AI provider). */
    webDiscovery: { enabled: webDiscoveryOn, ...webSearchAvailabilityFrom(byok, connection, { connected: Boolean(await tavilyConnection()) }, tinyfish ? { connected: true, useForWebSearch: tinyfish.useForWebSearch } : null) },
    /** The assistant's own web_search and page reading: TinyFish when connected. */
    webAccess: { tinyfish: Boolean(tinyfish), searchProvider: tinyfish?.useForWebSearch ? "TinyFish" : (await tavilyConnection()) ? "Tavily" : null, browserMinutesPerDay: tinyfish?.browserMinutesPerDay ?? 0 },
    ai: { connected: Boolean(connection?.verified), defaultModel: byok.defaultModel?.modelId ?? null },
    /** Optional features (Settings → Providers & features), all off by default, and whether new inquiries can be answered. */
    features: await featureState(),
    inquiryReplies: { problem: await inquiryRunReadiness() },
    /** Running runs in Automatic reply mode (each answers only its own conversations). */
    automaticRuns: automaticRuns.length,
  };
}

const AUDIENCE_SOURCE_WORD: Record<string, string> = { discovery: "found", list: "uploaded" };

/** Website and directory search's readiness, in a sentence for check_setup. */
function webDiscoveryLine(web: { enabled: boolean; available: boolean; provider: string | null; model: string | null; reason: string | null }): string {
  if (!web.enabled) return "Website and directory search: off (an owner or admin can turn it on in Settings → Providers & features).";
  return web.available
    ? `Website and directory search: ready (${webSearchProviderName(web.provider)}, ${web.model}).`
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

/** Where a browser navigation ended: a public website without a login wall, or why not. */
async function browserNavigationProblem(raw: string): Promise<string | null> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return `the browser is on “${raw}”, which is not a web page`;
  }
  if (url.protocol === "about:") return null;
  if (LOGIN_WALLED.test(url.hostname) || isRedditHost(url.hostname)) return `${url.hostname} needs a login or may not be read; nothing from it is used — go back or open another page`;
  try {
    await assertPublicPageUrl(url.toString());
  } catch {
    return `${url.hostname} is not a public website; nothing from it is used`;
  }
  return null;
}

/** A browser step's result for the model: the page now, numbered elements to act on, and any problem with where it ended. */
function browserResult(verb: string, snapshot: PageSnapshot, problem: string | null, extra = ""): ToolResult {
  if (problem) return { ok: false, summary: `${verb}: ${problem}.` };
  const host = (() => {
    try {
      return new URL(snapshot.url).hostname.replace(/^www\./, "");
    } catch {
      return snapshot.url;
    }
  })();
  return {
    ok: true,
    summary: `${verb}${extra}.\n${formatSnapshot(snapshot)}`,
    display: `${verb} · ${host}${snapshot.title ? ` · ${snapshot.title.slice(0, 80)}` : ""} · ${snapshot.elements.length} elements`,
    data: { url: snapshot.url, title: snapshot.title, elements: snapshot.elements.length },
  };
}

/**
 * The browser is paid by the minute for the request it serves: while that
 * request's research is paused, or once it stopped or its time passed, no
 * step runs and the chat's browser is closed, so it stops costing.
 */
async function browserHold(context: ToolContext): Promise<ToolResult | null> {
  const reason = await requestHoldReason(searchRequestId(context));
  if (!reason) return null;
  const minutes = await closeBrowser(context.threadId);
  return { ok: false, summary: `Not run: ${reason}.${minutes === null ? "" : " The chat's browser was closed."}` };
}

/**
 * The web tools serve the same request as the searches: while its research
 * is paused, or once it stopped or its time passed, they do not run either,
 * with the same reason, so the two paths never disagree about the request.
 */
async function webToolHold(context: ToolContext): Promise<ToolResult | null> {
  const reason = await requestHoldReason(searchRequestId(context));
  return reason ? { ok: false, summary: `Not run: ${reason}.` } : null;
}

async function runBrowserStep(context: ToolContext, verb: string, action: BrowserAction): Promise<ToolResult> {
  const held = await browserHold(context);
  if (held) return held;
  try {
    const { snapshot, problem } = await browserAct(context.threadId, action, browserNavigationProblem);
    return browserResult(verb, snapshot, problem);
  } catch (error) {
    if (error instanceof BrowserUnavailableError) return { ok: false, summary: error.message };
    throw error;
  }
}

function elementNumber(args: Record<string, unknown>): number {
  const n = Number(args.n);
  if (!Number.isInteger(n) || n < 1) throw new ToolArgumentError("n must be the number of an element from the latest page reading");
  return n;
}

/** The per-platform coverage of the request this turn serves, when it named several platforms. */
async function requestCoverageLine(context: ToolContext): Promise<string | null> {
  const id = searchRequestId(context);
  return id ? coverageLine(await requestCoverageFor(id)) : null;
}

/**
 * Why a page that ended somewhere other than the link may not be used, or
 * null: a redirect to Reddit or to a login-walled site is refused like a link
 * to one, whoever followed it (TinyFish or the direct reader).
 */
async function redirectRefusal(requested: URL, finalUrl: string): Promise<ToolResult | null> {
  let host: string;
  try {
    host = new URL(finalUrl).hostname;
  } catch {
    return null;
  }
  if (isRedditHost(host)) return { ok: false, summary: `${requested.toString()} leads to ${host}. ${redditRefusal(await redditApprovalRecorded())}` };
  if (LOGIN_WALLED.test(host)) return { ok: false, summary: `${requested.toString()} leads to ${host}, which needs a login and does not allow automated reading, so it cannot be opened. LinkedIn people can be found with find_linkedin_leads; other networks are not supported.` };
  return null;
}

/**
 * A page read for the model: text, contacts and the links it may follow
 * next. A page on a discussion site (Hacker News, Stack Exchange) carries
 * its evidence rule instead of contacts: its authors are pseudonymous and
 * are not leads.
 */
function pageResult(page: { url: string; title: string; body: string; contacts: { kind: string; value: string }[]; links: string[]; via: string; evidence?: ResearchEvidence[] }): ToolResult {
  const title = page.title.slice(0, 200);
  const host = new URL(page.url).hostname.replace(/^www\./, "");
  const links = page.links.filter((link) => {
    const linkHost = new URL(link).hostname;
    return !LOGIN_WALLED.test(linkHost) && !isRedditHost(linkHost);
  }).slice(0, 40);
  const note = discussionNote(new URL(page.url).hostname);
  const contacts = note ? [] : page.contacts;
  return {
    ok: true,
    summary: `Read ${page.url}${title ? ` “${title}”` : ""} via ${page.via} (${page.body.length.toLocaleString("en-US")} characters).${note ? ` ${note}` : ""} Contacts on the page: ${contacts.map((contact) => `${contact.kind} ${contact.value}`).join(", ") || "none"}. Links on the page: ${links.join(" ") || "none"}. Text: ${page.body.slice(0, 6_000)}`,
    display: note
      ? `${host}${title ? ` · ${title}` : ""} · evidence of a stated need or problem; authors are pseudonymous, not leads`
      : `${host}${title ? ` · ${title}` : ""} · ${contacts.length} contact${contacts.length === 1 ? "" : "s"} found`,
    data: { url: page.url, title, contacts, links, ...(page.evidence?.length ? { evidence: page.evidence } : {}) },
  };
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
    arguments: "any of: businessName, website, offer, problemsSolved (the problems the offer solves and how), nextStep (what an interested lead is offered next: a call, a visit, a quote), prices (prices, packages or rates as the owner gave them), targetCustomers, locations, outreachInstructions, senderName, senderRole, bookingDetails, language (two letters), notes (all text); preferredChannels (array of email|whatsapp|linkedin|instagram). An empty string clears a field.",
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
    description: "Search public Google Maps business listings for leads matching the owner's target customers, then read each business's own website for published contact details. Takes a few minutes and runs in the background; the chat shows its progress and announces the result. It runs on the built-in Google Maps scraper (no cost per search). Apify's Google Maps Actor (paid from the owner's Apify account) is used only when the owner asks for Apify (provider 'apify'), or as the fallback the organization approved when the built-in scraper is not set up or fails; with neither, website search takes it when that is on. The result names the source and provider, and the reason. Google Maps is one source however many cities or providers search it. Only businesses with a public listing are found.",
    arguments: "what (kind of business, e.g. 'dental clinics'), where (city/region/country), maxResults (5-200, default 50), language (two letters, optional), provider (optional: 'apify' only when the owner asked for Apify), contactAfter (true only when the owner asked to contact, email or message the leads found: the outreach plan is then prepared automatically when the search finishes), channels (optional, with contactAfter: array of email|whatsapp|linkedin|instagram, only when the owner's own words named how to contact them; otherwise leave it out and each lead gets its best ready route)",
    run: async (args, context) => {
      const profile = await getBusinessProfile();
      const criteria = normalizeCriteria(args, profile.language ?? "en");
      if ("error" in criteria) throw new ToolArgumentError(criteria.error);
      if (args.contactAfter !== undefined && typeof args.contactAfter !== "boolean") throw new ToolArgumentError("contactAfter must be true or false");
      const request = args.contactAfter === true ? requireOutreachRequest(context) : null;
      const area = await checkSearchArea(criteria.where, criteria.language);
      if (area?.refused) throw new ToolArgumentError(area.problem);
      if (area) return { ok: false, summary: area.problem };
      if (args.provider !== undefined && args.provider !== null && args.provider !== "apify") throw new ToolArgumentError("provider may only be 'apify' (when the owner asked for Apify); leave it out otherwise");
      const contactAfter = request ? { channels: channels(args) ?? null, ownerRequest: request, requestId: searchRequestId(context) ?? undefined } : null;
      const objective = await searchObjective(context);
      if (objective.problem) return objectiveRefusal(objective.problem);
      try {
        const started = await startDiscovery(criteria, context, { contactAfter, provider: args.provider === "apify" ? "apify" : null, requestMessageId: searchRequestId(context) });
        const source = started.provider === "website" ? "business websites and directories (no Google Maps search is available)" : sourceLabel("maps", started.provider);
        return withControls({
          ok: true,
          summary: `${started.waiting ? "Queued" : "Search started"} for “${started.phrase}” on ${source} (up to ${criteria.maxResults} businesses); job ${started.jobId}, audience ${started.audienceId}. It runs in the background; results are announced in the chat when done.${contactAfter ? ` The outreach plan will be prepared automatically when it finishes, ${followUpChannels(contactAfter)}.` : ""}${started.note ? ` ${started.note}` : ""}`,
          display: `${started.waiting ? "Queued" : "Searching"} ${source} for “${started.phrase}”`,
          data: { jobId: started.jobId, audienceId: started.audienceId, phrase: started.phrase, criteria, provider: started.provider, source, waiting: Boolean(started.waiting), note: started.note },
        }, objective.line);
      } catch (error) {
        if (error instanceof DiscoveryUnavailableError) return { ok: false, summary: error.message };
        throw error;
      }
    },
  },

  find_instagram_prospects: {
    available: (features) => features.apify_discovery,
    description: "Find Instagram accounts that post about the owner's kind of customers in a place, through Apify (the organization's approved Instagram Actors, within its budget; paid from the owner's Apify account): public posts under hashtags made from the customer type and place (plus any the owner names), then the accounts' public profiles and the websites they list, for emails and phones they publish. Instagram profiles can receive one initial DM through a connected Unipile Instagram account after the outreach plan is approved, within Instagram sending rules; recipient restrictions may still prevent delivery. Published emails and phones remain alternative channels. Hashtags do not filter by place: accounts whose post or profile does not name the place are marked location unknown. Without Apify available, website search takes the request when it is on (same request), else it says nothing was searched. Runs in the background and announces the result.",
    arguments: "what (kind of customer or business, e.g. 'home bakers'), where (city/area), hashtags (optional array of hashtags the owner named), maxResults (5-100 accounts, default 30), contactAfter (true only when the owner asked to contact the people found: the plan uses Instagram when connected, or the requested supported contact channels), channels (optional, with contactAfter: array of instagram|email|whatsapp|linkedin, only when the owner's own words named how to contact them; otherwise leave it out and each lead gets its best ready route)",
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
      const contactAfter = request ? { channels: channels(args) ?? ["instagram", "email", "whatsapp"], ownerRequest: request, requestId: searchRequestId(context) ?? undefined } : null;
      const objective = await searchObjective(context);
      if (objective.problem) return objectiveRefusal(objective.problem);
      try {
        const started = await startInstagramProspects({ what: what.slice(0, 200), where: where.slice(0, 200), hashtags, maxResults, language: profile.language ?? "en" }, context, { contactAfter, requestMessageId: searchRequestId(context) });
        const via = started.provider !== "apify"
          ? `Instagram was NOT searched (Apify cannot run it now); website and directory search started instead for “${what}” in ${where}, which is not an Instagram search`
          : started.waiting
            ? `Instagram search for ${started.phrase} through Apify is queued: it waits for a free Apify run slot and starts by itself`
            : `Instagram search started for ${started.phrase} through Apify`;
        return withControls({
          ok: true,
          summary: `${via}; job ${started.jobId}, audience ${started.audienceId}. Results are announced in the chat when done.${contactAfter ? ` The outreach plan will be prepared automatically for those who can be contacted, ${followUpChannels(contactAfter)}.` : ""} ${started.note ?? ""}`.trim(),
          data: { jobId: started.jobId, audienceId: started.audienceId, phrase: started.phrase, provider: started.provider, note: started.note },
        }, objective.line);
      } catch (error) {
        if (error instanceof DiscoveryUnavailableError) return { ok: false, summary: error.message };
        throw error;
      }
    },
  },

  find_social_leads: {
    available: (features) => features.apify_discovery,
    description: "Find businesses on a social platform by keyword and place, through Apify (the organization's approved Actors, within its budget; paid from the owner's Apify account): platform 'facebook' — Facebook business pages with the phone, email, website and address each publishes; 'linkedin' — LinkedIn companies (no emails on LinkedIn: contacts come from reading each company's own website; the Actor reads LinkedIn without logging in, which LinkedIn's terms do not allow, so the owner approves it knowingly); 'instagram' — Instagram accounts from Instagram's own account search, then their public profiles. Each lead's website is read for the contacts it publishes. Finding a page or account is NOT a way to contact it: Facebook pages need a published email or phone. Instagram profiles can receive one initial DM through a connected Unipile Instagram account after plan approval, subject to sending rules and recipient restrictions. When the platform's Actor is not approved or the budget is used, it says so and nothing is searched. Runs in the background and announces the result.",
    arguments: "platform (facebook|linkedin|instagram), what (kind of business, e.g. 'real estate agencies'), where (city/area), maxResults (5-100, default 30), contactAfter (true only when the owner asked to contact the people found), channels (optional, with contactAfter: array of email|whatsapp|linkedin|instagram, only when the owner's own words named how to contact them; otherwise leave it out and each lead gets its best ready route)",
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
      const contactAfter = request ? { channels: channels(args) ?? (platform === "instagram" ? ["instagram", "email", "whatsapp"] : null), ownerRequest: request, requestId: searchRequestId(context) ?? undefined } : null;
      const objective = await searchObjective(context);
      if (objective.problem) return objectiveRefusal(objective.problem);
      try {
        const started = await startSocialProspects(platform, { what: what.slice(0, 200), where: where.slice(0, 200), maxResults, language: profile.language ?? "en" }, context, { contactAfter, requestMessageId: searchRequestId(context) });
        const name = platform === "facebook" ? "Facebook" : platform === "linkedin" ? "LinkedIn" : "Instagram";
        return withControls({
          ok: true,
          summary: `${name} search ${started.waiting ? "queued (it waits for a free Apify run slot and starts by itself)" : "started"} for “${what}” in ${where} through Apify (up to ${maxResults}); job ${started.jobId}, audience ${started.audienceId}. Results are announced in the chat when done.${contactAfter ? ` The outreach plan will be prepared automatically for those who can be contacted, ${followUpChannels(contactAfter)}.` : ""} ${started.note ?? ""}`.trim(),
          data: { jobId: started.jobId, audienceId: started.audienceId, phrase: started.phrase, provider: started.provider, note: started.note },
        }, objective.line);
      } catch (error) {
        if (error instanceof DiscoveryUnavailableError) return { ok: false, summary: error.message };
        throw error;
      }
    },
  },

  find_customers_on_web: {
    available: (features) => features.web_discovery,
    description: "Find customers matching the owner's description of them with a real web search provider (TinyFish when connected, free within its daily allowance; else Tavily when the organization saved a Tavily key; else its OpenRouter connection with its web plugin, or AI/ML API's web research model; never a model answering from memory): only the pages the provider returned are used. It reads the businesses' own websites and the local directories or lists the search returned (and the business websites those directories link to) for the emails and phones they publish, and keeps each contact with the page it came from; it never guesses an email, phone, person or page, and people already in the leads are reused, not duplicated. Public Instagram profiles and posts the search returns are read (a profile's website, a post's comments) only when Instagram is connected (the Instagram feature on and an account linked); otherwise they are skipped. Instagram-only profiles can receive an initial DM after plan approval when an Instagram sender is connected. Up to 3 searches (free on TinyFish, paid on the others); runs in the background, waits when TinyFish's free allowance asks it to, and announces the result in the chat. Needs the Website and directory search feature.",
    arguments: "customers (who the customers are, from the owner's words or the business profile), where (city/area/region), maxResults (5-40 business websites to read, default 20), contactAfter (true only when the owner asked to contact, email or message the leads found: the outreach plan is then prepared automatically when the search finishes), channels (optional, with contactAfter: array of email|whatsapp|linkedin|instagram, only when the owner's own words named how to contact them; otherwise leave it out and each lead gets its best ready route)",
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
      const contactAfter = request ? { channels: channels(args) ?? null, ownerRequest: request, requestId: searchRequestId(context) ?? undefined } : null;
      const objective = await searchObjective(context);
      if (objective.problem) return objectiveRefusal(objective.problem);
      try {
        const started = await startWebDiscovery(criteria, context, { contactAfter, requestMessageId: searchRequestId(context) });
        const instagram = started.instagram.usable ? " Public Instagram profiles and posts it returns are read too." : ` Instagram pages are skipped (${started.instagram.reason}).`;
        const provider = webSearchProviderName(started.provider);
        return withControls({
          ok: true,
          summary: `Web search started for “${started.phrase}” with ${provider} (${started.model}): ${started.queries.length} searches, up to ${criteria.maxResults} business websites; job ${started.jobId}, audience ${started.audienceId}.${instagram} Results are announced in the chat when done.${contactAfter ? ` The outreach plan will be prepared automatically when it finishes, ${followUpChannels(contactAfter)}.` : ""}`,
          display: `Searching the web for “${started.phrase}” (${provider}, ${started.queries.length} searches, up to ${criteria.maxResults} websites).${instagram}`,
          data: { jobId: started.jobId, audienceId: started.audienceId, phrase: started.phrase, queries: started.queries, provider: started.provider, model: started.model, instagram: started.instagram, criteria },
        }, objective.line);
      } catch (error) {
        // Its open searches are a wait, not a limit: a request pursued on its own tries again when one finishes.
        if (error instanceof WebDiscoveryLimitError && error.slotsFull) return { ok: false, summary: error.message, data: { waiting: true } };
        if (error instanceof WebDiscoveryUnavailableError) return { ok: false, summary: error.message };
        throw error;
      }
    },
  },

  research_social_sources: {
    available: (features) => features.brightdata,
    description: "Research what people say on social platforms through Bright Data (metered from the owner's Bright Data account: one credit per record, within the monthly limit set in Settings): Reddit posts with their comments, found by keyword and in named subreddits — only when the owner turned Reddit research on in the Bright Data settings (the result says when it is off) — and X, Instagram and Facebook posts, profiles and pages that a web search returns for the terms, read through Bright Data. Every finding keeps its link, the words quoted, who wrote them and when it was read. A relevant discussion is research evidence, not a lead: someone can be contacted only when their own profile or page, or the website it lists, publishes an email or phone (or, on Instagram, by one DM through a connected Instagram sender after plan approval); everyone else stays in the list as excluded, with the reason, and AgentSDR never messages anyone on Reddit, X or Facebook. Use it for discussions and stated needs (people asking for, complaining about or recommending what the owner sells). For Facebook business pages or Instagram accounts by keyword and place, find_social_leads (Apify) is the right tool when it is on; never run both for the same question. Runs in the background and announces the result.",
    arguments: `platforms (array of reddit|x|instagram|facebook), customers (who the customers are, from the owner's words or the business profile), need (what they would be asking about or struggling with, in plain words: the search terms come from it), where (optional city or area; leave it out for a topic without a place), subreddits (optional array of subreddit names the owner named, without r/), keywords (optional array of up to 3 exact search phrases the owner gave), maxResults (5-${BRIGHTDATA_LIMITS.maxRecordsPerSearch.max} records across the job, default 40; the organization's own cap applies), contactAfter (true only when the owner asked to contact the people found), channels (optional, with contactAfter: array of email|whatsapp|linkedin|instagram, only when the owner's own words named how to contact them)`,
    run: async (args, context) => {
      if (!(await featureEnabled("brightdata"))) return { ok: false, summary: new FeatureDisabledError("brightdata").message };
      const [profile, settings] = await Promise.all([getBusinessProfile(), brightdataSettingsView()]);
      if (!settings.connected) return { ok: false, summary: "Bright Data research is not available: no Bright Data key is saved (Settings → Providers & features → Bright Data)." };
      const criteria = normalizeSocialCriteria({
        platforms: args.platforms,
        customers: text(args, "customers") ?? profile.targetCustomers,
        need: args.need,
        where: args.where,
        subreddits: args.subreddits,
        keywords: args.keywords,
        maxResults: args.maxResults,
        language: profile.language,
      }, { maxRecordsPerSearch: settings.maxRecordsPerSearch }, profile.language ?? "en");
      if ("error" in criteria) throw new ToolArgumentError(criteria.error);
      if (args.contactAfter !== undefined && typeof args.contactAfter !== "boolean") throw new ToolArgumentError("contactAfter must be true or false");
      const request = args.contactAfter === true ? requireOutreachRequest(context) : null;
      const contactAfter = request ? { channels: channels(args) ?? (criteria.platforms.includes("instagram") ? ["instagram", "email", "whatsapp"] as AudienceChannel[] : null), ownerRequest: request, requestId: searchRequestId(context) ?? undefined } : null;
      const objective = await searchObjective(context);
      if (objective.problem) return objectiveRefusal(objective.problem);
      try {
        const started = await startSocialResearch(criteria, context, { contactAfter, requestMessageId: searchRequestId(context) });
        const lines = started.sources.map((source) => `${PLATFORM_NAMES[source.platform]}: ${source.state === "pending" ? `searching for ${source.queries.map((query) => `“${query}”`).join(", ")}` : `NOT searched (${source.reason})`}`);
        const searching = started.sources.filter((source) => source.state === "pending").map((source) => PLATFORM_NAMES[source.platform]);
        const finder = started.sources.some((source) => source.state === "pending" && source.platform !== "reddit") ? ` X, Instagram and Facebook pages are found with ${urlFinderName(started.urlFinder)}, then read through Bright Data.` : "";
        return withControls({
          ok: true,
          summary: `Social research started for “${started.phrase}” through Bright Data (up to ${criteria.maxResults} records): ${lines.join("; ")}.${finder} Job ${started.jobId}, audience ${started.audienceId}. Results are announced in the chat when done; discussions are evidence, and only people whose own profile, page or website publishes a contact route can be contacted.${contactAfter ? ` The outreach plan will be prepared automatically for those who can be contacted, ${followUpChannels(contactAfter)}.` : ""}`,
          display: `Researching ${searching.join(", ") || "social platforms"} for “${started.phrase}” (Bright Data, up to ${criteria.maxResults} records).`,
          data: { jobId: started.jobId, audienceId: started.audienceId, phrase: started.phrase, criteria, sources: started.sources, urlFinder: started.urlFinder, provider: "brightdata" },
        }, objective.line);
      } catch (error) {
        if (error instanceof SocialResearchUnavailableError && error.slotsFull) return { ok: false, summary: error.message, data: { waiting: true } };
        if (error instanceof SocialResearchUnavailableError) return { ok: false, summary: error.message };
        throw error;
      }
    },
  },

  treg_search: {
    available: (features) => features.treg,
    description: "Find the right paid tool in Treg's catalog (treg.to; beta) for a lookup the other tools cannot do: a person's work email from their name and company domain, verifying an email, a phone number, enriching a person or company, a public social profile. Free. Returns endpoint ids with their price per unit and parameters (* = required); call one with treg_call.",
    arguments: "task (what you need, in plain words, e.g. 'find work email from full name and company domain')",
    run: async (args) => {
      const task = text(args, "task", true)!;
      try {
        const endpoints = await searchTreg(task);
        if (!endpoints.length) return { ok: true, summary: `Treg's catalog has nothing for “${task}”.`, display: "Nothing found in Treg's catalog." };
        return {
          ok: true,
          summary: `Treg endpoints for “${task}” (call one with treg_call):\n${endpoints.map(describeEndpoint).join("\n")}`,
          display: endpoints.map((endpoint) => endpoint.summary || endpoint.id).slice(0, 3).join(" · "),
          data: { endpoints: endpoints.map((endpoint) => ({ id: endpoint.id, summary: endpoint.summary, usd: endpoint.usd, unit: endpoint.unit })) },
        };
      } catch (error) {
        if (error instanceof TregUnavailableError) return { ok: false, summary: error.message };
        throw error;
      }
    },
  },

  treg_call: {
    available: (features) => features.treg,
    description: `Call one Treg catalog endpoint that treg_search returned (beta; paid from the owner's Treg balance, never more than $${TREG_LIMITS.maxUsdPerCall} a call and only within the organization's daily Treg cap). Its price and method are read from Treg's catalog, not from you. Returns the provider's answer and what the call cost. Emails, phones and profiles in a successful answer may then be added with add_contacts.`,
    arguments: "endpointId (a catalog id from treg_search, e.g. treg.people.email.find), query (object of the endpoint's query parameters; {} for none), body (object of its body parameters, for POST endpoints)",
    run: async (args, context) => {
      if (args.query !== undefined && (typeof args.query !== "object" || args.query === null || Array.isArray(args.query))) throw new ToolArgumentError("query must be an object");
      if (args.body !== undefined && args.body !== null && (typeof args.body !== "object" || Array.isArray(args.body))) throw new ToolArgumentError("body must be an object");
      const query: Record<string, string | string[]> = {};
      for (const [name, value] of Object.entries((args.query ?? {}) as Record<string, unknown>)) {
        const scalar = (item: unknown) => (typeof item === "string" || typeof item === "number" || typeof item === "boolean" ? String(item) : null);
        const values = Array.isArray(value) ? value.map(scalar) : [scalar(value)];
        if (values.some((item) => item === null)) throw new ToolArgumentError(`query.${name} must be text, a number or a list of them`);
        query[name] = Array.isArray(value) ? (values as string[]) : values[0]!;
      }
      const body = (args.body ?? null) as Record<string, unknown> | null;
      if (body && JSON.stringify(body).length > 4_000) throw new ToolArgumentError("body is too large (4,000 characters at most)");
      try {
        const requestId = searchRequestId(context);
        // The request's spend cap applies with or without a lead search behind it (requestSpendGuard).
        const outcome = await callTregEndpoint({ endpointId: args.endpointId, query, body, threadId: context.threadId, requestId, spendGuard: await requestSpendGuard(requestId) });
        const id = outcome.endpoint?.id ?? String(args.endpointId ?? "");
        if (!outcome.ok) {
          return { ok: false, summary: `Treg ${id} not used: ${outcome.reason}.${outcome.costUsd ? ` Counted: $${outcome.costUsd}.` : ""}`, display: `Not used: ${outcome.reason}` };
        }
        const cost = `$${outcome.costUsd.toFixed(4)} ($${outcome.leftTodayUsd.toFixed(3)} left of today's cap)`;
        return {
          ok: true,
          summary: `Treg ${id} answered; charged ${cost}. Answer: ${compactResult(outcome.body)}`,
          display: `${outcome.endpoint.summary || id} — charged ${cost}`,
          data: { endpointId: id, costUsd: outcome.costUsd, leftTodayUsd: outcome.leftTodayUsd },
        };
      } catch (error) {
        if (error instanceof TregUnavailableError) return { ok: false, summary: error.message };
        throw error;
      }
    },
  },

  add_instagram_contacts: {
    available: (features) => features.instagram,
    description: "Save the Instagram usernames or profile URLs the owner supplied as a lead list, without a search or a message. Use this for a named Instagram recipient instead of asking for an email, phone, city or website. Keeps the exact username, including underscores. No Apify or web-search connection is needed. Set contactAfter true only when the owner asked to message/contact/pitch these accounts: an Instagram outreach plan follows using the normal Start or Autonomous mode controls. Account, recipient, opt-out and sending-hour checks still apply.",
    arguments: "usernames (array of 1-50 owner-supplied usernames, @handles or Instagram profile URLs); listName (optional); contactAfter (optional boolean, true when the owner asked to contact these recipients on Instagram)",
    run: async (args, context) => {
      if (!(await featureEnabled("instagram"))) return { ok: false, summary: new FeatureDisabledError("instagram").message };
      if (args.contactAfter !== undefined && typeof args.contactAfter !== "boolean") throw new ToolArgumentError("contactAfter must be true or false");
      if (args.contactAfter === true) requireOutreachRequest(context);
      let usernames: string[];
      try { usernames = parseInstagramContacts(args.usernames); }
      catch (error) { throw new ToolArgumentError(error instanceof Error ? error.message : String(error)); }
      const saved = await createInstagramContactsAudience({ usernames, listName: text(args, "listName"), threadId: context.threadId, userId: context.userId });
      const names = saved.usernames.map((username) => `@${username}`).join(", ");
      return {
        ok: true,
        summary: `Saved ${names} as lead list ${saved.audienceId}. No message was sent. ${args.contactAfter === true ? "The Instagram outreach plan is prepared next; sending still requires the normal approval or Autonomous authorization and delivery checks." : "Prepare an Instagram outreach plan only when the owner asks."}`,
        display: `Saved ${names}. No message sent yet.`,
        data: saved,
      };
    },
  },

  add_contacts: {
    description: "Add people the owner gave in the chat (phone numbers, emails or LinkedIn profile links, with a name or company when given) as a new lead list, so outreach can be prepared for them (contactAfter true when the owner asked for it: the plan follows automatically). Only contacts the owner wrote, that are on a page read with read_webpage, or that a successful treg_call returned. A phone number without + and a country code is refused unless the organization has a Default phone country: ask the owner which country, never guess it.",
    arguments: "contacts (array of objects with name, phone, email, linkedinUrl, company; each needs a phone, email or linkedinUrl; up to 50), listName (optional), contactAfter (true when the owner asked to contact, message or pitch these people: the outreach plan is then prepared right after), channels (optional, with contactAfter: array of email|whatsapp|linkedin|instagram, only when the owner's own words named how to contact them; otherwise leave it out and each lead gets its best ready route)",
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
        // The request it serves: contacts found while pursuing it count toward its lead target.
        criteria: { source: "chat", requestId: searchRequestId(context), imported: { created: result.created, updated: result.updated, failed: result.failed.length, skippedNoIdentity: result.skippedNoIdentity } },
        threadId: context.threadId,
        userId: context.userId,
      });
      await addAudienceMembers(audienceId, result.personIds.map((personId) => ({ personId, source: "list" })));
      // The ones the owner typed themselves count as a match; those found on a page are judged against the request.
      const typed = rows.flatMap((row) => (result.rowPersonIds[row.rowNumber] && typedByOwner(row, context.ownerText ?? "") ? [result.rowPersonIds[row.rowNumber]!] : []));
      await markGivenByOwner(audienceId, typed, searchRequestId(context));
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
        summary: `Lead list ${a.id} “${a.name}”: ${a.eligible} contactable of ${a.total} (email ${a.byChannel.email}, WhatsApp ${a.byChannel.whatsapp}, LinkedIn ${a.byChannel.linkedin}, Instagram ${a.byChannel.instagram}).${a.excluded.length ? ` Left out: ${a.excluded.map((e) => `${e.count} × ${e.reason}`).join("; ")}.` : ""}${result.alreadyInRuns ? ` ${result.alreadyInRuns} already in a running outreach run were not added.` : ""} Nobody was contacted.`,
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
    description: "Propose answering new Instagram inquiries: from when the owner presses Start, people whose first message arrives on an Instagram account that treats new messages as inquiries get replies drafted from the owner's saved information — sent automatically in Automatic mode, or waiting for the owner in the Inbox (Needs you) in Review mode — with every existing check, limit and handoff. It never answers imported history, earlier chats or anyone else, and sends nothing first. Only when the owner asked for their inquiries or Instagram messages to be answered.",
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

  web_search: {
    description: "Search the web for pages that match a query: businesses' own websites, directories and member lists, public profiles, news and public discussions. Returns titles, URLs and snippets from TinyFish Search (free within its daily allowance), or Tavily when only Tavily is connected. A result is a candidate, not a verified lead or buyer: read the promising pages with read_webpage (results become links you may open) and check fit, location and contact route there. Refine the query and use page for more results when the first ones do not fit; stop when a few searches find nothing new. Keyword queries work best (e.g. 'real estate agency Pune', 'wholesale tile distributors Lagos list').",
    arguments: "query (keywords), country (optional 2-letter code where results should come from, e.g. IN), page (optional 0–3, for more results), purpose (optional: why you are searching, one sentence)",
    run: async (args, context) => {
      const query = text(args, "query", true)!.trim();
      if (query.length < 2) throw new ToolArgumentError("query is empty");
      const country = text(args, "country");
      if (country && !/^[A-Za-z]{2}$/.test(country)) throw new ToolArgumentError("country must be a 2-letter code such as IN or US");
      const page = args.page === undefined ? 0 : Number(args.page);
      if (!Number.isInteger(page) || page < 0 || page > 3) throw new ToolArgumentError("page must be a whole number from 0 to 3");
      const held = await webToolHold(context);
      if (held) return held;
      try {
        const requestId = searchRequestId(context);
        // A free-only request ($0 cap) searches only with TinyFish's free searches, never Tavily's paid credits.
        const freeOnly = (await requestSpendCap(requestId)) === 0;
        const { provider, hits } = await generalWebSearch({ query, country: country?.toUpperCase() ?? null, page, purpose: text(args, "purpose") }, { threadId: context.threadId, requestId, freeOnly });
        const name = webSearchProviderName(provider);
        const lines = hits.map((hit, index) => `${index + 1}. ${hit.title ?? "(no title)"} — ${hit.url}${hit.snippet ? ` — ${hit.snippet}` : ""}${hit.date ? ` (${hit.date})` : ""}`);
        return {
          ok: true,
          summary: hits.length
            ? `${name} for “${query}”${page ? ` (page ${page})` : ""}: ${hits.length} results (candidates; read a page before relying on it).\n${lines.join("\n")}`
            : `${name} for “${query}” returned nothing. Try different keywords or another source.`,
          display: `Searched the web (${name}) for “${query}”: ${hits.length} result${hits.length === 1 ? "" : "s"}`,
          data: { query, page, provider, results: hits },
        };
      } catch (error) {
        if (error instanceof TinyfishWaitError) return { ok: false, summary: `Web search is waiting: ${error.message}. Use another source meanwhile, or tell the owner when it resumes.`, data: { waiting: true, until: error.until.toISOString() } };
        if (error instanceof WebSearchUnavailableError) return { ok: false, summary: `Web search is not available: ${error.message}.` };
        throw error;
      }
    },
  },

  read_webpage: {
    description: "Open one public web page and read its text, the emails, phones and LinkedIn links on it, and the links it contains (which you may open next): a link the owner gave, a result of web_search, or a link on a page already read. Read through TinyFish when it is connected (it renders pages that need JavaScript), else directly. Hacker News threads (news.ycombinator.com/item?id=…) and Stack Exchange questions (Stack Overflow, Super User, Server Fault, Ask Ubuntu, *.stackexchange.com) are read through their public APIs, with authors and dates, as evidence of a stated need or problem: never buying intent, and their pseudonymous authors are not leads. It cannot log in, so Instagram, Facebook, X, TikTok and LinkedIn pages cannot be read, and Reddit cannot be read at all.",
    arguments: "url",
    run: async (args, context) => {
      const raw = text(args, "url", true)!.trim();
      const held = await webToolHold(context);
      if (held) return held;
      let url: URL;
      try {
        url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
      } catch {
        throw new ToolArgumentError(`“${raw}” is not a web address`);
      }
      if (LOGIN_WALLED.test(url.hostname)) {
        return { ok: false, summary: `${url.hostname} needs a login and does not allow automated reading, so it cannot be opened. LinkedIn people can be found with find_linkedin_leads; other networks are not supported.` };
      }
      // No Reddit reader and no workaround (src/lib/research/sources/reddit.ts): refused before anything is looked up or sent.
      if (isRedditHost(url.hostname)) return { ok: false, summary: redditRefusal(await redditApprovalRecorded()) };
      // A private or internal address is refused before anything leaves the server, TinyFish included.
      try {
        await assertPublicPageUrl(url.toString());
      } catch (error) {
        return { ok: false, summary: `Could not open ${url.toString()}: ${error instanceof Error ? error.message : String(error)}` };
      }
      // Why the usual reader was not used, said in "via" so the model knows which source read the page.
      const notes: string[] = [];
      const requestId = searchRequestId(context);
      const source = await readResearchSource(url, { threadId: context.threadId, requestId });
      if (source?.kind === "page") return pageResult({ ...source.page, contacts: [] });
      if (source?.kind === "missing") return { ok: false, summary: `Could not open ${url.toString()}: ${source.summary}` };
      if (source?.kind === "fallback") notes.push(source.note);
      const via = (reader: "TinyFish" | "direct") => (notes.length ? `${reader} (${notes.join("; ")}; read ${reader === "TinyFish" ? "through TinyFish" : "directly"} instead)` : reader);
      if (await tinyfishConnection()) {
        try {
          const { pages, failures } = await fetchWithTinyfish([url.toString()], { threadId: context.threadId, ...(requestId ? { detail: { requestId } } : {}) });
          const page = pages[0];
          if (page) {
            const refused = await redirectRefusal(url, page.finalUrl);
            if (refused) return refused;
            const contacts = extractContacts(`${page.contactLinks.map((link) => `<a href="${link.replace(/"/g, "")}"></a>`).join("")}${page.text}`, page.finalUrl).slice(0, 60);
            return pageResult({ url: page.finalUrl, title: page.title ?? "", body: page.text, contacts, links: page.links, via: via("TinyFish") });
          }
          if (failures[0] && ["page_not_found", "login_required", "invalid_url", "invalid_redirect_url"].includes(failures[0].code)) {
            return { ok: false, summary: `Could not open ${url.toString()}: ${fetchFailureText(failures[0])}.` };
          }
          if (failures[0]) notes.push(`TinyFish: ${fetchFailureText(failures[0])}`);
        } catch (error) {
          if (!(error instanceof TinyfishWaitError)) throw error;
          notes.push(`TinyFish is waiting: ${error.reason}`);
        }
      }
      const note = notes.length ? ` (${notes.join("; ")})` : "";
      let page: { url: string; html: string } | null;
      try {
        page = await fetchPublicPage(url.toString());
      } catch (error) {
        // A redirect to Reddit or a login wall stopped before that host was asked for anything: refused like a link to it.
        const refused = error instanceof PageRedirectRefusedError ? await redirectRefusal(url, error.destination.toString()) : null;
        if (refused) return refused;
        return { ok: false, summary: `Could not open ${url.toString()}${note}: ${error instanceof Error ? error.message : String(error)}` };
      }
      if (!page) return { ok: false, summary: `${url.toString()} is not a readable web page${note}.` };
      const refused = await redirectRefusal(url, page.url);
      if (refused) return refused;
      return pageResult({
        url: page.url,
        title: visibleText(pageTitle(page.html)).trim(),
        body: visibleText(page.html).trim(),
        contacts: extractContacts(page.html, page.url).slice(0, 60),
        links: publicLinks(page.html, page.url, 40),
        via: via("direct"),
      });
    },
  },

  browser_open: {
    description: `Open a page in a remote browser (TinyFish Browser), when reading a page with read_webpage is not enough: a search form, filters, "load more" buttons, pagination by clicking, or a page that shows content only after interaction. It is paid by the minute (about $0.002) within the owner's daily browser minutes (Settings → Lead research → TinyFish; off unless set), one browser per organization, each session at most ${BROWSER_LIMITS.maxSessionMinutes} minutes; it closes when the turn ends. The URL follows the same rule as read_webpage (a link the owner gave, a web_search result, or a link on a page already read). It never logs in, never types passwords, and cannot use Instagram, Facebook, X, TikTok, LinkedIn or Reddit. Returns the page text and its numbered elements for browser_click and browser_fill.`,
    arguments: "url",
    run: async (args, context) => {
      const raw = text(args, "url", true)!.trim();
      let url: URL;
      try {
        url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
      } catch {
        throw new ToolArgumentError(`“${raw}” is not a web address`);
      }
      const blocked = await browserNavigationProblem(url.toString());
      if (blocked) return { ok: false, summary: `Not opened: ${blocked}.` };
      try {
        const requestId = searchRequestId(context);
        const held = await browserHold(context);
        if (held) return held;
        const opened = await openBrowser(url.toString(), context.threadId, browserNavigationProblem, { requestId, spendGuard: await requestSpendGuard(requestId) });
        const allowance = opened.allowance;
        return browserResult(opened.reused ? "Opened in the chat's browser" : "Opened a browser", opened.snapshot, opened.problem, opened.reused ? "" : ` (paid by the minute; ${allowance.usedToday} of today's ${allowance.minutesPerDay} browser minutes reserved or used)`);
      } catch (error) {
        if (error instanceof BrowserUnavailableError) return { ok: false, summary: error.message };
        throw error;
      }
    },
  },

  browser_read: {
    description: "Read the page open in the chat's browser again: its text and numbered elements.",
    arguments: "none",
    run: async (_args, context) => runBrowserStep(context, "Read the browser page", { kind: "read" }),
  },

  browser_click: {
    description: "Click an element of the page open in the browser, by its number from the latest reading (a link, a button, a \"next\" or \"load more\" control). Returns the page afterwards.",
    arguments: "n (element number)",
    run: async (args, context) => runBrowserStep(context, `Clicked element ${String(args.n)}`, { kind: "click", n: elementNumber(args) }),
  },

  browser_fill: {
    description: "Type into a text field of the page open in the browser (a search box or a filter), by its number from the latest reading; submit true presses Enter. Never a password or login field.",
    arguments: "n (element number), text (what to type, up to 200 characters), submit (optional true/false)",
    run: async (args, context) => {
      const value = text(args, "text", true)!;
      if (value.length > 200) throw new ToolArgumentError("text must be at most 200 characters");
      if (args.submit !== undefined && typeof args.submit !== "boolean") throw new ToolArgumentError("submit must be true or false");
      return runBrowserStep(context, `Typed into element ${String(args.n)}`, { kind: "fill", n: elementNumber(args), text: value, submit: args.submit === true });
    },
  },

  browser_scroll: {
    description: "Scroll the page open in the browser (to load more results on pages that load as you scroll).",
    arguments: "direction (down|up, default down)",
    run: async (args, context) => {
      const direction = args.direction === "up" ? "up" : "down";
      return runBrowserStep(context, `Scrolled ${direction}`, { kind: "scroll", direction });
    },
  },

  browser_close: {
    description: "Close the chat's browser when you are done with it (it also closes when the turn ends or after a few idle minutes).",
    arguments: "none",
    run: async (_args, context) => {
      const minutes = await closeBrowser(context.threadId);
      return minutes === null
        ? { ok: true, summary: "No browser was open." }
        : { ok: true, summary: `Browser closed after ${minutes} minute${minutes === 1 ? "" : "s"}.`, display: `Browser closed (${minutes} min)` };
    },
  },

  find_linkedin_leads: {
    description: "Search LinkedIn for people by keywords (a job title, profession or industry, plus a place), with the organization's connected LinkedIn account through Unipile and its daily search allowance. Runs in the background; the profiles found can be contacted on LinkedIn only (LinkedIn gives no email or phone). Use for people (owners, managers, professionals); use find_leads for businesses with a public Maps listing. LinkedIn matches the words anywhere on a profile, so a broad query ('founder') returns unrelated people: put the owner's kind of business and their place into the keywords ('real estate agency founder Austin'), and expect only those whose headline and place show the fit to count toward the request.",
    arguments: "keywords (the role, the kind of business and the place, e.g. 'dental clinic owner Pune'), maxResults (5-200, default 50), contactAfter (true only when the owner asked to contact them)",
    run: async (args, context) => {
      const keywords = text(args, "keywords", true)!.trim().slice(0, 200);
      const requested = Number(args.maxResults ?? 50);
      const maxResults = Number.isFinite(requested) ? Math.min(200, Math.max(5, Math.round(requested))) : 50;
      if (args.contactAfter === true) {
        requireOutreachRequest(context);
      }
      const availability = await linkedinSearchAvailability();
      if (!availability.available) return { ok: false, summary: `LinkedIn search is not available: ${availability.reason}` };
      const objective = await searchObjective(context);
      if (objective.problem) return objectiveRefusal(objective.problem);
      const started = await startLinkedinSearch({ keywords, maxResults }, context, {
        contactAfter: args.contactAfter === true ? { channels: ["linkedin"], ownerRequest: requireOutreachRequest(context), requestId: searchRequestId(context) ?? undefined } : null,
        requestMessageId: searchRequestId(context),
      });
      return withControls({
        ok: true,
        summary: `LinkedIn search started for “${keywords}” (up to ${maxResults} people); job ${started.jobId}, audience ${started.audienceId}. Results are announced in the chat when done.${args.contactAfter === true ? " The outreach plan will be prepared automatically when it finishes, on LinkedIn: the only route these profiles have." : ""}`,
        display: `LinkedIn search started for “${keywords}” (up to ${maxResults} people).`,
        data: { jobId: started.jobId, audienceId: started.audienceId, keywords },
      }, objective.line);
    },
  },

  lead_search_status: {
    description: "The progress or result of a lead search (Google Maps, Instagram, Facebook, LinkedIn or web), and for a request that named several platforms, each platform's state (searched, searching, waiting, not searched, not started) with its reason.",
    arguments: "jobId (optional; the latest search when left out)",
    run: async (args, context) => {
      const [platforms, objective] = await Promise.all([requestCoverageLine(context), objectiveLine(searchRequestId(context))]);
      const coverage = [platforms, objective].filter(Boolean).join(" ") || null;
      const jobId = uuid(args, "jobId", false);
      const [job] = await db.select().from(assistantJobs)
        .where(and(inOrg(assistantJobs), inArray(assistantJobs.kind, ["discovery", "linkedin_search", "web_discovery", "apify_instagram"]), ...(jobId ? [eq(assistantJobs.id, jobId)] : [])))
        .orderBy(desc(assistantJobs.createdAt)).limit(1);
      if (!job) return { ok: false, summary: "No lead search found." };
      if (job.kind === "web_discovery") {
        return {
          ok: true,
          summary: `Web search ${job.id}: ${job.status} (${job.stage}). Progress ${JSON.stringify(job.progress)}.${job.error ? ` Error: ${job.error}` : ""}${job.result ? ` Result: ${JSON.stringify(job.result)}` : ""}${coverage ? ` ${coverage}` : ""}`,
          display: `${webDiscoveryProgress(job)}${coverage ? `\n${coverage}` : ""}`,
          data: { jobId: job.id, kind: job.kind, status: job.status, stage: job.stage, progress: job.progress, result: job.result, error: job.error, audienceId: job.audienceId },
        };
      }
      const progress = job.progress as { found?: number; websitesChecked?: number; websitesToCheck?: number; saved?: number; source?: string; waiting?: { reason?: string } };
      const result = (job.result ?? {}) as { found?: number; eligible?: number; note?: string | null; notSearched?: boolean };
      const display = progress.waiting && job.status !== "succeeded" && job.status !== "failed"
        ? `Waiting to start ${progress.source ?? "the search"}: ${progress.waiting.reason ?? "a provider asked to wait"}.`
        : job.status === "failed"
        ? `The search failed: ${job.error ?? "unknown error"}`
        : job.status === "succeeded"
          ? result.note ?? `Finished: ${result.found ?? 0} businesses found, ${result.eligible ?? 0} can be contacted.`
          : job.stage === "enriching"
            ? `Reading websites for contact details: ${progress.websitesChecked ?? 0} of ${progress.websitesToCheck ?? "?"} done (${progress.found ?? 0} businesses found).`
            : job.stage === "saving"
              ? `Saving leads: ${progress.saved ?? 0} of ${progress.found ?? "?"}.`
              : `Searching ${progress.source ?? "Google Maps"} (usually 3–10 minutes)…`;
      return {
        ok: true,
        summary: `Search ${job.id}: ${job.status} (${job.stage}). Progress ${JSON.stringify(job.progress)}.${job.error ? ` Error: ${job.error}` : ""}${job.result ? ` Result: ${JSON.stringify(job.result)}` : ""}${coverage ? ` ${coverage}` : ""}`,
        display: `${display}${coverage ? `\n${coverage}` : ""}`,
        data: { jobId: job.id, status: job.status, stage: job.stage, progress: job.progress, result: job.result, error: job.error, audienceId: job.audienceId },
      };
    },
  },

  control_research: {
    description: "Pause, resume or cancel the background research of the owner's request (its searches and the work that continues it toward its lead target, time limit and spend cap), only when the owner asks. Pausing or cancelling starts nothing new; searches already running finish, and every lead already saved is kept. Cancelling ends it with its final report. It does not touch outreach plans (pause_outreach and stop_outreach do).",
    arguments: "action (pause | resume | cancel); requestId (optional: the request's message id; the latest research in this chat when left out)",
    run: async (args, context) => {
      const action = args.action;
      if (action !== "pause" && action !== "resume" && action !== "cancel") throw new ToolArgumentError("action must be pause, resume or cancel");
      const requestId = uuid(args, "requestId", false);
      const objective = requestId
        ? await objectiveForRequest(requestId)
        : (await threadObjectives(context.threadId, 5)).find((row) => (action === "resume" ? row.status === "paused" : row.status !== "stopped")) ?? null;
      if (!objective || objective.threadId !== context.threadId) return { ok: false, summary: action === "resume" ? "No paused research in this chat." : "No research is running in this chat." };
      const { changed, objective: after } = await setObjectiveState(objective.id, action, { name: null });
      const state = after?.status ?? objective.status;
      return {
        ok: changed,
        summary: changed
          ? action === "cancel"
            ? "Research cancelled: nothing new starts, searches already running finish, every lead found is kept, and its final report follows."
            : action === "pause" ? "Research paused: nothing new starts until it is resumed; searches already running finish and their leads are kept. Its time limit keeps counting." : "Research resumed."
          : `Nothing changed: the research is ${state}.`,
        data: { objectiveId: objective.id, status: state },
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
        summary: `“${summary.name}”: ${summary.eligible} contactable of ${summary.total} (email ${summary.byChannel.email}, WhatsApp ${summary.byChannel.whatsapp}, LinkedIn ${summary.byChannel.linkedin}, Instagram ${summary.byChannel.instagram}). Left out: ${summary.excluded.map((e) => `${e.count} × ${e.reason}`).join("; ") || "none"}.${qualification}`,
        data: { ...summary, ...(counts ? { qualification: counts } : {}) } as unknown as Record<string, unknown>,
      };
    },
  },

  prepare_outreach: {
    description: "Write the outreach for a lead list and plan the run. It first sorts the leads by itself: what kind of lead each is (each kind gets its own messages), which leads deserve a first message written for them alone, and which clearly do not fit the owner's offer (left out with the reason). Then it plans which channel each lead gets, the messages (with real samples), daily limits, how long it takes and the AI cost. Creates nothing and sends nothing; the owner reviews the plan, chooses Automatic or Review replies and presses Start. Only when the owner asked for outreach (or said yes to your offer of it). To contact more people with an earlier run's messages, pass basedOnRunId (a new plan the owner approves again).",
    arguments: "audienceId; channels (optional array of email|whatsapp|linkedin|instagram, only when the owner's own words named how to contact them; otherwise leave it out and each lead gets its best ready route: a list the owner did not ask for only changes the order); maxLeads (optional, default up to 100); autopilot (optional true/false: propose Automatic replies); instructions (optional text, e.g. tone or angle for this run); basedOnRunId (optional: reuse that run's messages); includeSkipped (optional true: also contact the leads the sorting leaves out, when the owner asks)",
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
        const plan = proposal.plan;
        const sorted = plan.groups?.length
          ? ` Sorted into ${plan.groups.map((group) => `“${group.label}” (${group.count})`).join(", ")}; ${plan.personal?.length ?? 0} written to individually; ${plan.skipped?.length ?? 0} left out${plan.skipped?.length ? ` (${[...new Set(plan.skipped.map((item) => item.reason))].slice(0, 3).join("; ")})` : ""}.`
          : "";
        const dropped = plan.droppedSteps?.length
          ? ` Left out of the sequence because they kept a claim your information does not back: ${plan.droppedSteps.map((item) => `${item.channel} message ${item.step} for “${item.group}” (${item.problem})`).join("; ")}.`
          : "";
        return {
          ok: true,
          summary: `Plan ${proposal.runId} ready for “${proposal.name}”: ${planChannelsLine(plan)}, about ${plan.estimate.days ?? "?"} days, AI cost about ${plan.estimate.aiCostUsd === null ? "unknown" : `$${plan.estimate.aiCostUsd}`}.${sorted}${dropped}${context.autonomous ? " Autonomous mode: it starts on its own right after this unless a daily cap stops it; the next event line says which." : " It is shown to the owner with sample messages and a Start button; nothing is sent until they press Start."}`,
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
    description: "Results from what was recorded: leads found and imported, duplicates, people contacted, emails/WhatsApp/LinkedIn requests and messages sent, replies, interested people, what waits for the owner (replies to review, reply decisions, and plans waiting for Start, counted apart), pending follow-ups, stopped and failed sends, AI spending and remaining limits. scope says whose work is counted: request (the plans and searches of the owner's request this turn serves; the default when it serves one that has any recorded), thread (this chat), run (one plan; needs runId) or organization (everything; the default otherwise). Say which scope the figures cover. With runId, also that run's per-channel counts.",
    arguments: "period (optional: today | yesterday | last_7_days | last_30_days | all_time; default last_7_days, all_time for one run); scope (optional: request | thread | run | organization); runId (optional)",
    run: async (args, context) => {
      const runId = uuid(args, "runId", false);
      const requested = (RESULTS_SCOPE_KINDS as readonly string[]).includes(String(args.scope)) ? args.scope as ResultsScopeKind : null;
      const requestId = searchRequestId(context);
      // The request this turn serves, by default; else (or asked) the whole organization.
      let scopeKind: ResultsScopeKind = runId ? "run" : requested ?? (context.outreachRequestId ? "request" : "organization");
      if (scopeKind === "run" && !runId) return { ok: false, summary: "scope run needs a runId (list_runs shows them)." };
      if (scopeKind === "request" && !requestId) return { ok: false, summary: "This turn serves no request to report on; use scope thread or organization." };
      let scope = scopeKind === "run" ? await runScope(runId!)
        : scopeKind === "request" ? await requestScope(context.outreachRequestId ?? requestId!)
          : scopeKind === "thread" ? await threadScope(context.threadId)
            : ORGANIZATION_SCOPE;
      if (!scope) return { ok: false, summary: "No such run." };
      // The default request with nothing of it recorded: often the results question itself ("how many did we
      // send?" reads as a request to contact). The organization's figures answer it; asked for, the request is kept.
      if (!requested && !runId && scopeKind === "request" && scopeIsEmpty(scope)) {
        scope = ORGANIZATION_SCOPE;
        scopeKind = "organization";
      }
      const period = (PERIOD_KINDS as readonly string[]).includes(String(args.period)) ? args.period as PeriodKind : scopeKind === "run" ? "all_time" : "last_7_days";
      const r = await results(period, new Date(), scope);
      if (runId) {
        const report = await reportRun(runId);
        if (!report) return { ok: false, summary: "No such run." };
        return {
          ok: true,
          summary: `“${report.name}” is ${report.status} (${report.autopilot ? "Automatic" : "Review"} replies): ${report.channels.map((c) => `${c.channel}: ${c.contacted} contacted, ${c.messagesSent === null ? "" : `${c.messagesSent} sent, `}${c.replied} replied, ${c.finished} finished, ${c.stopped} stopped`).join("; ") || "no campaign launched yet, nothing sent"}.${report.error ? ` Problems: ${report.error}` : ""}\n${resultsText(r)}`,
          data: { ...report, results: r } as unknown as Record<string, unknown>,
        };
      }
      return { ok: true, summary: resultsText(r), data: { results: r } as unknown as Record<string, unknown> };
    },
  },

  diagnose_delivery: {
    description: "Explain queued email and Instagram outreach using recorded sender settings, active queues, campaign/run status, sending hours and timezone, throttling, capacity and recent delivery failures. Read-only; does not change limits, rebuild a queue, send messages or measure worker liveness. Use once when asked why messages are not sending; report unknowns instead of guessing.",
    arguments: "runId (optional: diagnose a specific run; otherwise the organization's current senders and campaigns)",
    run: async (args) => {
      const diagnostics = await diagnoseDelivery(uuid(args, "runId", false));
      return { ok: true, summary: diagnostics.summary, data: diagnostics };
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
        return { ok: result.changed.length > 0, summary: `Resumed ${result.changed.join(", ") || "nothing"}.${result.notes.length ? ` Note: ${result.notes.join("; ")}` : ""}${result.problems.length ? ` Problems: ${result.problems.join("; ")}` : ""}`, data: result };
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
    description: "Stop answering replies automatically for a run (or every run): replies then wait for the owner in the Inbox (Needs you). Switching a run to Automatic is the owner's button on the run card, not a tool.",
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

/**
 * The request a follow-up joins (sameRequest): the newest research in this
 * chat that is still running or paused, so "use Instagram too" adds a source
 * to that request and shares its target, time and spend cap. Never one that
 * stopped: a new message after that is a new request.
 */
async function joinedRequest(context: ToolContext): Promise<{ requestId: string } | { problem: string }> {
  const current = searchRequestId(context);
  const [latest] = await threadObjectives(context.threadId, 1);
  if (!latest) return { problem: "Not started: no earlier request's research is running or paused in this chat, so there is nothing to add this search to. Search again without sameRequest; it starts a new request." };
  if (latest.requestMessageId === current) return { requestId: latest.requestMessageId };
  if (latest.status === "stopped") {
    return { problem: `Not started: the earlier request's research has stopped (${latest.stopDetail ?? latest.stopReason?.replace(/_/g, " ") ?? "stopped"}), so it takes no more searches. Search again without sameRequest; it starts a new request with its own limits.` };
  }
  return { requestId: latest.requestMessageId };
}

/** A search tool a follow-up may add to the request still running in its chat (sameRequest), else as it is. */
function joinable(tool: Tool): Tool {
  return {
    ...tool,
    arguments: `${tool.arguments}, sameRequest (optional true: only when the owner's new message adds to a request whose research is still running in this chat, e.g. "use Instagram too"; the search then counts toward that request's target, time and spend cap)`,
    run: async (args, context) => {
      if (args.sameRequest === undefined || args.sameRequest === false) return tool.run(args, context);
      if (args.sameRequest !== true) throw new ToolArgumentError("sameRequest must be true or false");
      const joined = await joinedRequest(context);
      if ("problem" in joined) return { ok: false, summary: joined.problem };
      return tool.run(args, { ...context, searchRequestId: joined.requestId });
    },
  };
}

for (const name of ["find_leads", "find_instagram_prospects", "find_social_leads", "find_customers_on_web", "find_linkedin_leads", "research_social_sources"]) TOOLS[name] = joinable(TOOLS[name]!);

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
