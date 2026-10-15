import "server-only";

import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/lib/db";
import { getByokSettings } from "@/lib/ai/byok";
import { getAiConnection } from "@/lib/ai/connections";
import { retrieveKnowledge } from "@/lib/crm/knowledge";
import { discoveryAvailability, DiscoveryUnavailableError, normalizeCriteria, startDiscovery } from "@/lib/discovery/discovery.server";
import { searchAreaProblem } from "@/lib/discovery/geocode";
import { extractContacts, visibleText } from "@/lib/discovery/contacts";
import { fetchPublicPage } from "@/lib/discovery/websiteContacts.server";
import type { ImportRow } from "@/lib/leads/importRows";
import { importPeopleRows } from "@/lib/leads/peopleImport.server";
import { people } from "@/lib/leads/schema";
import { geocoderUrl, lookupPlace } from "@/lib/discovery/geocode.server";
import { linkedinSearchAvailability, startLinkedinSearch } from "./linkedinSearch.server";
import { inOrg } from "@/lib/tenancy/scope";
import { addAudienceMembers, createAudience, listAudiences, summarizeAudience } from "./audiences.server";
import { outreachRequested, outreachRequestProblem } from "./agent";
import { answerDecision, DecisionError, listOpenDecisions } from "./decisions.server";
import { channelAvailability, listRuns, OutreachError, prepareOutreach, reportRun, setRunPaused, setRunReplyMode, stopRun } from "./outreach.server";
import { mergeProfile, missingForDiscovery, missingForOutreach, PROFILE_LABELS, profileChanges } from "./profile";
import { getBusinessProfile, updateBusinessProfile } from "./profile.server";
import { PERIOD_KINDS, type PeriodKind } from "./results";
import { results, resultsText } from "./results.server";
import { assistantJobs, outreachRuns, type AudienceChannel } from "./schema";

/**
 * What the assistant can do, and nothing else. Each tool is a call into an
 * existing service, with its arguments checked here before anything runs;
 * its result is stored on the chat (assistant_messages, role "tool") and
 * shown as a card, so what the owner reads about an action is what the
 * server recorded. Starting outreach is deliberately not a tool: only the
 * owner's Start button does that (POST /api/assistant/runs/[id]/start).
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
  /** Set when the server itself prepares outreach the owner already asked for (a "find and contact" search finished). */
  authorizedBy?: "search" | null;
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
  run: (args: Record<string, unknown>, context: ToolContext) => Promise<ToolResult>;
};

class ToolArgumentError extends Error {}

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
  const [profile, availability, automaticRuns, byok] = await Promise.all([
    getBusinessProfile(),
    channelAvailability(),
    db.select({ id: outreachRuns.id }).from(outreachRuns).where(and(inOrg(outreachRuns), eq(outreachRuns.autopilot, true), eq(outreachRuns.status, "running"))),
    getByokSettings(),
  ]);
  const connection = byok.connectionId ? await getAiConnection(byok.connectionId) : null;
  const discovery = discoveryAvailability();
  return {
    profile,
    missingForDiscovery: missingForDiscovery(profile),
    missingForOutreach: missingForOutreach(profile),
    channels: {
      email: availability.email,
      whatsapp: availability.whatsapp,
      linkedin: availability.linkedin,
    },
    leadDiscovery: discovery,
    ai: { connected: Boolean(connection?.verified), defaultModel: byok.defaultModel?.modelId ?? null },
    /** Running runs in Automatic reply mode (each answers only its own conversations). */
    automaticRuns: automaticRuns.length,
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
        summary: `${channelLine}. Lead discovery: ${setup.leadDiscovery.available ? "Google Maps ready" : setup.leadDiscovery.reason}. AI: ${setup.ai.connected ? "connected" : "not connected"}. Runs answering replies automatically: ${setup.automaticRuns}. Profile missing for discovery: ${setup.missingForDiscovery.join(", ") || "nothing"}; for outreach: ${setup.missingForOutreach.join(", ") || "nothing"}.`,
        data: setup as unknown as Record<string, unknown>,
      };
    },
  },

  save_business_info: {
    description: "Remember what the owner said about the business, customers, places, offer, sender or preferences. Saved for every later conversation and used by every message the AI writes. Call it as soon as the owner gives such information.",
    arguments: "any of: businessName, website, offer, targetCustomers, locations, outreachInstructions, senderName, senderRole, bookingDetails, language (two letters), notes (all text); preferredChannels (array of email|whatsapp|linkedin). An empty string clears a field.",
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
    description: "Search public Google Maps business listings for leads matching the owner's target customers, then read each business's own website for published contact details. Takes a few minutes and runs in the background; the chat shows its progress and announces the result. Costs nothing per search (self-hosted). Only businesses with a public listing are found.",
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
      const contactAfter = request ? { channels: channels(args) ?? null, ownerRequest: request } : null;
      try {
        const started = await startDiscovery(criteria, context, { contactAfter });
        return {
          ok: true,
          summary: `Search started for “${started.phrase}” (up to ${criteria.maxResults} businesses); job ${started.jobId}, audience ${started.audienceId}. It runs in the background; results are announced in the chat when done.${contactAfter ? " The outreach plan will be prepared automatically when it finishes." : ""}`,
          data: { jobId: started.jobId, audienceId: started.audienceId, phrase: started.phrase, criteria },
        };
      } catch (error) {
        if (error instanceof DiscoveryUnavailableError) return { ok: false, summary: error.message };
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
      const title = visibleText(page.html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").trim().slice(0, 200);
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
        contactAfter: args.contactAfter === true ? { channels: ["linkedin"], ownerRequest: requireOutreachRequest(context) } : null,
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
    description: "The progress or result of a lead search.",
    arguments: "jobId (optional; the latest search when left out)",
    run: async (args) => {
      const jobId = uuid(args, "jobId", false);
      const [job] = await db.select().from(assistantJobs)
        .where(and(inOrg(assistantJobs), inArray(assistantJobs.kind, ["discovery", "linkedin_search"]), ...(jobId ? [eq(assistantJobs.id, jobId)] : [])))
        .orderBy(desc(assistantJobs.createdAt)).limit(1);
      if (!job) return { ok: false, summary: "No lead search found." };
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
        display: audiences.length ? audiences.map((a) => `“${a.name}” (${a.source === "discovery" ? "found" : "uploaded"}): ${a.eligible} of ${a.total} can be contacted`).join("\n") : "No lead lists yet.",
        data: { audiences },
      };
    },
  },

  describe_audience: {
    description: "One lead list in detail: how many leads per channel, who was left out and why, and a few examples with where their contact details came from.",
    arguments: "audienceId",
    run: async (args) => {
      const summary = await summarizeAudience(uuid(args, "audienceId")!);
      if (!summary) return { ok: false, summary: "No such lead list." };
      return {
        ok: true,
        summary: `“${summary.name}”: ${summary.eligible} contactable of ${summary.total} (email ${summary.byChannel.email}, WhatsApp ${summary.byChannel.whatsapp}, LinkedIn ${summary.byChannel.linkedin}). Left out: ${summary.excluded.map((e) => `${e.count} × ${e.reason}`).join("; ") || "none"}.`,
        data: summary as unknown as Record<string, unknown>,
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
          summary: `Plan ${proposal.runId} ready for “${proposal.name}”: ${plan.assignments.length} leads (${Object.entries(perChannel).map(([c, n]) => `${c} ${n}`).join(", ")}), about ${plan.estimate.days ?? "?"} days, AI cost about ${plan.estimate.aiCostUsd === null ? "unknown" : `$${plan.estimate.aiCostUsd}`}.${sorted} It is shown to the owner with sample messages and a Start button; nothing is sent until they press Start.`,
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

/** The tools as the model reads them. */
export function toolCatalog(): string {
  return Object.entries(TOOLS).map(([name, tool]) => `- ${name}: ${tool.description} Arguments: ${tool.arguments}.`).join("\n");
}

export { setupSnapshot };
