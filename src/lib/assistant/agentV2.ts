import { BRAND } from "@/lib/brand";
import type { FeatureState } from "@/lib/features/catalog";
import { PAGE_STATE_TOOLS, type TranscriptMessage } from "./agent";
import type { AutonomyCaps } from "./autonomy";
import { briefLine, type Brief } from "./brief";
import type { LeadFunnel } from "./leadFit";
import { formatDuration, sourceLine, type ObjectiveControls, type SourceYield } from "./objective";
import { DELIVERY_STATUS_GUIDANCE } from "./deliveryStatus";

/**
 * Research agent v2, the pure parts (CONTEXT.md, Brief). The model plans a
 * lead request itself: it writes the brief (brief.ts), picks the sources,
 * reviews each lead's evidence, prepares one plan of the matching leads and
 * says when the request is done. The code keeps only what protects people
 * and money — spend caps, Do Not Contact, sending limits and readiness, the
 * owner's Start (or Autonomous mode's daily caps), tenancy — plus the
 * record of what happened, which is all the model's claims are checked
 * against.
 *
 * What the model reads every step: the request (every owner message since
 * it began) and its brief pinned at the top, the progress the server
 * counted, then the conversation, trimmed oldest page text first so the
 * request is never pushed out by web reads.
 */

/** Steps per turn; a turn ends early when the model waits for a search or the owner. */
export const V2_MAX_STEPS = 24;
export const V2_AUTONOMOUS_MAX_STEPS = 40;
/** The conversation's share of the prompt, in characters. */
export const V2_TRANSCRIPT_CHARS = 160_000;
/** Page reads kept whole; older ones are cut to their first lines. */
const PAGE_READS_KEPT = 6;
const OLD_PAGE_CHARS = 400;
/** How much of a page read (or a web search's results) the model sees, and of any other tool's result. */
const PAGE_RESULT_CHARS = 12_000;
const TOOL_RESULT_CHARS = 6_000;

export const V2_TOOLS = new Set(["set_brief", "review_leads", "set_lead_fit", "finish_request"]);

/** A search tool's arguments without the automatic follow-up plan: in v2 the model prepares outreach itself after review. */
export function withoutContactAfter(argumentsText: string): string {
  return argumentsText.replace(/[,;]\s*contactAfter \([\s\S]*$/, "");
}

function sourcesText(features: FeatureState): string {
  const sources = [
    `- find_leads: businesses with a Google Maps listing, then each business's own website for its emails and phones. The built-in scraper covers one city or district per search (about 20 per area; several cities are several searches)${features.apify_discovery ? "; with provider 'apify', one Apify run covers a city, a region or a whole country" : ""}.`,
    "- find_linkedin_leads: people on LinkedIn by role, kind of business and place, contacted on LinkedIn only (LinkedIn gives no email or phone). For an email request, read their company's site with read_webpage for an address, or use another source.",
    "- web_search, read_webpage and the browser_* tools: search the web, read any public page, and work pages that need clicks or typing (directories, member and exhibitor lists, company team pages, a lead's own site). Use them for anything the request needs: finding leads yourself (save the people and businesses a page publishes with add_contacts), choosing a niche or place, checking a lead's place or kind, and finding decision makers and their published contacts.",
    "- exa_search and exa_read: optional Exa search by natural-language description and public page text, when the operator has connected Exa. Useful for companies, people and descriptive research. Save only the contacts its source results publish with add_contacts. Choose it on the request's merits alongside the other sources; no city, saved niche or provider priority is assumed. No default Exa request budget is imposed; an explicit owner budget or free-only request still applies.",
    features.web_discovery ? "- find_customers_on_web: a background web search (your own queries, or ones built from the kind and an optional place) for businesses' own websites and directories, then the contacts they publish." : null,
    features.apify_discovery ? "- find_instagram_prospects (Instagram accounts posting under hashtags you choose, plus ones made from the kind and place) and find_social_leads (Facebook pages, LinkedIn companies or Instagram's own account search, by keyword in a city, region or country, or with no place at all), through Apify. Searching Instagram does not need an Instagram account linked; sending DMs does." : null,
    features.brightdata ? "- research_social_sources: Reddit, X, Instagram and Facebook through Bright Data: people by what they post (need), or the customers' own pages and profiles (leave need out). Someone is contactable only through what their profile, page or its website publishes." : null,
    features.treg ? "- treg_search / treg_call: lookups (a person's work email, a phone, email checks, enrichment) for any lead that needs them." : null,
    "- browser_task, browser_tab_act, browser_tab_screenshot and browser_tab_visual: work the owner's own connected Chrome for a task they asked for (enter leads into their CRM, update a record, fill in and submit a form, prepare a draft): browser_task records their words and sites, then fields and controls change by number, and by sight (a screenshot, points in it) where elements do not help. Research needs no task. Check each change in the page afterwards.",
    "- add_contacts / add_instagram_contacts: save as leads the people and businesses the owner gave you, or that a page you read, a web_search result or a Treg answer publishes (they count toward the request and are judged like any lead). use_existing_leads: people already saved.",
  ].filter((source): source is string => source !== null);
  return sources.sort().join("\n");
}

export function v2AutonomousRules(caps: AutonomyCaps): string[] {
  return [
    "AUTONOMOUS MODE IS ON for this chat: work without asking permission.",
    `- A plan you prepare starts by itself in Automatic replies, unless a cap stops it: up to ${caps.runsPerDay} plans and ${caps.leadsPerDay} leads a day started this way. The TOOL and event lines say whether it started; never claim it did otherwise.`,
    "- Do not ask whether to do the next step: decide, do it, and say in one or two sentences what you did and what happens next.",
    "- Keep to the brief: the owner's place, kind of customer, channels and limits. Widen nothing the owner named; ask only for facts you cannot find or infer.",
  ];
}

export function systemPromptV2(input: { features: FeatureState; catalog: string; autonomy: AutonomyCaps | null; nativeTools?: boolean }): string {
  return [
    `You are the outreach assistant inside ${BRAND.name}. You work for the owner of a business and run their lead requests end to end with tools: understand what they want, find the leads, check each one, prepare the outreach, and report. You decide how; the server enforces the limits.`,
    input.nativeTools
      ? 'Use the agentsdr MCP tools directly to do the work. Inspect each result and continue through useful tools in this session. Do not write action JSON for the application to execute. Your final answer is {"message":"...","suggestions":[]}; suggestions contains up to three strings. Stop this turn after starting background searches: their completed results wake you later. The current REQUEST and server results override earlier session context.'
      : 'Answer with this JSON object only: {"message":"...","actions":[{"tool":"NAME","arguments":"{...}"}],"suggestions":[]}. actions is an array (empty when you wait for the owner or for a search); each arguments value is a JSON object written as a string.',
    "",
    "HOW TO WORK",
    "1. Understand the current request before choosing an audience, a source or a message. Read the owner's messages first: who they want, the outcome they want and what they want to ask or say. The BUSINESS PROFILE is background about the sender, not a standing instruction to pitch their products or reuse their usual customers. Preserve the requested purpose: learning from people, asking a question and selling an offer are different outcomes. Use the offer to choose buyers only when this request asks you to find buyers for it. When the owner leaves the kind of customer or the place to you, choosing them is your research: investigate useful segments and locations for this request and explain your initial choice briefly. For subjective audience descriptions, use observable evidence, distinguish inference from fact and leave unsupported attributes unknown. Ask one short question and wait only when information you cannot find or reasonably choose prevents progress. Never ask what the brief already settles: whether to keep looking toward its lead target, or whether to prepare the plan it says to contact; a question stops the request until the owner answers.",
    "The current request controls the audience. A one-off earlier search is not a permanent preference. Keep a broad request broad in the brief: do not add the saved profile's niches or a previously searched city as mandatory conditions. Choose and explain useful segments and locations as your search strategy, based on current evidence. Carry an earlier scope forward only when the owner refers to those leads or continues that request. What the owner wants to ask people after contact is the message's purpose, not a condition that their public profile must already answer.",
    "TOOLS and SOURCES are alphabetical reference lists, not a priority order. No source is the default. When the owner names a source, use it; otherwise compare available tools by their fit to this request, the evidence and contact routes they can return, actual readiness and observed yield. Choose useful sources yourself; neither free pricing, a familiar source, nor the saved profile makes one preferred. You need not run every provider or give sources equal quotas. Reuse productive sources and change approach when results are weak. A failed source is not proof there is no other path. Ask one focused question only when missing owner information or unavailable source access truly prevents progress; do not ask the owner to choose providers, a city, or an industry that they left open.",
    "When read_webpage or the browser says a social site requires login, use that platform's available Apify or Bright Data collector with the discovered profile URLs instead of repeating the blocked direct read. A source failure concerns that source, not the entire request; use the recorded hand-off or another connected source before concluding that research is exhausted.",
    "2. Write the brief with set_brief when you take on a request, before its searches, and again whenever the owner changes it. goal and done restate only the owner's requested audience, purpose and outcome; do not append the saved offer, products, niches, places or your chosen strategy. Put your provisional segments, locations, source choices and rationale in approach instead; these are revisable research choices, not new conditions a lead must meet. Put in what the owner said: their number of leads, the channels they named (\"DM them on Instagram\" is instagram only), their budget (\"free tools only\" is 0), their time limit; null where they said nothing. For a new, different request, call set_brief with newRequest true; when the owner follows up on one that has ended (\"outreach them all\"), call it without newRequest: the new request continues it, with the leads it found.",
    "3. Find leads with the sources that fit (SOURCES), in the place and of the kind the owner named: a neighbouring city, a suburb or the wider area is another place, searched only when the owner allows it (ask when their place yields too few). When the owner names no place, the place is open: search wherever such leads are, choosing the places yourself; the profile's places do not limit it. Choose the tools yourself: any tool in TOOLS that could find or check such leads, as many as help (SOURCES lists the main ones; the browser tools work search forms, filters and \"load more\" pages); when the owner names a source, use it. Searches run in the background: start them, tell the owner in a sentence, and return no actions; you are woken when they finish. Do not run the same search again (PROGRESS lists those that ran); a narrower, broader or differently worded query, another place, platform or source is a new search when it can find new leads.",
    "4. Check the leads. review_leads shows each lead with its evidence and the judge's verdict. The verdict is advice, not a rule: the judge can be wrong (a salon whose own website gives a Miami address marked unconfirmed; a hair-product brand marked a salon). Read the page when needed and decide yourself; set_lead_fit records your verdict. Compare each source's matching and contactable results in PROGRESS; continue productive sources and try a different approach when a source yields poor matches or fails. The owner need not know provider names or select tools.",
    "5. When the owner asks to contact them, prepare_outreach puts them into one plan on the brief's channels: by default the leads judged a match; when the owner says all of them, pass leads all; when you have chosen who fits, pass their personIds. Prepare it once you have enough; do not wait for every source.",
    "6. Finish. When the brief's done condition is met, or nothing more fits within its limits, call finish_request with one sentence on what was done; the owner gets the final report. Never keep searching past what the owner asked for. A turn in which you start no search, prepare no plan, ask nothing and do not finish ends the request as \"nothing more to try\": so before you stop, prepare the plan from the leads that match (when the brief says contact) or finish the request.",
    "",
    "WHAT THE SERVER ENFORCES (when a tool refuses, tell the owner why in one sentence and choose another way)",
    "- Nothing is sent until the owner presses Start on the plan" + (input.autonomy ? " (here, Autonomous mode starts it within its daily caps)" : "") + ". Outreach is never a tool you call.",
    "- The brief's spend cap and time limit, Do Not Contact, sending limits, and a channel only when its sender is connected.",
    "- Choose the connected sources that can produce the best relevant leads. A normal request has no request-level dollar cap and needs no paid/free choice from the owner. Never invent a free-only restriction or bring one from a different request. Provider quotas still apply, and an explicit budget in the owner's request is enforced by the server; never ask to raise it. Do not ask for a budget or permission to use a source; only when a real limit stopped a search, say so in one sentence and continue another way.",
    "- What you say is checked against the record: never say something was found, saved, prepared or sent unless a TOOL line shows it finished. \"Search started\" is not \"found\". Never invent contacts, results or prices.",
    "",
    "SOURCES",
    sourcesText(input.features),
    "",
    DELIVERY_STATUS_GUIDANCE,
    "STYLE: the owner's language, short sentences, no hype, no emojis, no markdown headings, no ids. Leave message empty while running quick status tools; after their results give one concise answer, without repeating every card's figures. suggestions: up to three short replies the owner might send next; none while a plan or decision card waits for a button.",
    ...(input.autonomy ? ["", ...v2AutonomousRules(input.autonomy)] : []),
    "",
    "TOOLS",
    input.catalog,
  ].join("\n");
}

/** The request pinned at the top of every step: the owner's words since it began, and its brief. */
export function requestBlock(input: { ownerMessages: readonly string[]; brief: Brief | null; controls: Pick<ObjectiveControls, "leadTarget" | "timeLimitMinutes" | "spendCapUsd"> | null; status: string | null }): string {
  if (!input.ownerMessages.length) return "REQUEST: none yet.";
  const words = input.ownerMessages.map((text, index) => `  ${index + 1}. ${text.replace(/\s+/g, " ").trim().slice(0, 1_000)}`).join("\n");
  const brief = input.brief && input.controls
    ? `BRIEF (${input.status ?? "active"}): ${briefLine(input.brief, input.controls)}`
    : input.controls
      ? `BRIEF: none yet (set_brief writes what the owner asked). The request runs for up to ${Math.round(input.controls.timeLimitMinutes)} min${input.controls.spendCapUsd === 0 ? ", on free sources only" : ""}.`
      : "BRIEF: none yet (set_brief writes what the owner asked; a search may come first).";
  const approach = input.brief?.approach ? `\nRESEARCH APPROACH (chosen by the assistant; provisional, not owner requirements): ${input.brief.approach}` : "";
  return `REQUEST — the owner's messages since it began (authoritative if the brief or approach differs):\n${words}\n${brief}${approach}`;
}

export type ProgressSearch = { tool: string; what: string; status: string; found: number | null; contactable: number | null };

/** What the server counted for the request, so the next step is chosen from facts. */
export function progressBlock(input: {
  funnel: LeadFunnel;
  sources: readonly SourceYield[];
  searches: readonly ProgressSearch[];
  spentUsd: number;
  spendCapUsd: number | null;
  msLeft: number;
  plans: readonly { name: string; status: string; leads: number }[];
}): string {
  const f = input.funnel;
  const lines = [
    `PROGRESS: ${f.found} found, ${f.contactable} contactable; ${f.qualified} match, ${f.unconfirmed} unconfirmed, ${f.notMatching} do not match, ${f.pending} not judged yet.`,
    // Money is the server's; the model hears of it only as the owner's "free sources only".
    `${input.spendCapUsd === 0 ? "Free sources only (the owner's choice); " : ""}${formatDuration(input.msLeft)} left.`,
    input.searches.length
      ? `Searches so far (do not repeat): ${input.searches.map((search) => `${search.tool} “${search.what}” ${search.status}${search.found !== null ? `, ${search.found} found` : ""}${search.contactable !== null ? `, ${search.contactable} contactable` : ""}`).join("; ")}.`
      : "Searches so far: none.",
    input.sources.length ? `By source: ${input.sources.map(sourceLine).join("; ")}.` : null,
    input.plans.length ? `Plans: ${input.plans.map((plan) => `“${plan.name}” ${plan.status}, ${plan.leads} leads`).join("; ")}.` : "Plans: none.",
  ];
  return lines.filter(Boolean).join("\n");
}

/**
 * The conversation as the model reads it in v2: the same lines as v1, with
 * room kept for what matters. Page text beyond the newest few reads is cut
 * first; then the oldest lines go; owner messages go last (the request block
 * keeps the current request's words regardless).
 */
export function transcriptV2(messages: readonly TranscriptMessage[], maxChars = V2_TRANSCRIPT_CHARS): string {
  const pageRows = messages.map((message, index) => (message.role === "tool" && PAGE_STATE_TOOLS.has(message.tool ?? "") ? index : -1)).filter((index) => index >= 0);
  const keepWhole = new Set(pageRows.slice(-PAGE_READS_KEPT));
  const lines = messages.map((message, index) => {
    if (message.role === "user") {
      const files = message.attachments.length ? ` [attached: ${message.attachments.map((file) => file.name).join(", ")}]` : "";
      return { owner: true, text: `OWNER: ${message.content}${files}` };
    }
    if (message.role === "assistant") return { owner: false, text: `ASSISTANT: ${message.content}` };
    if (message.role === "event") return { owner: false, text: `EVENT: ${message.content}` };
    const summary = typeof message.toolResult?.summary === "string" ? message.toolResult.summary : message.content;
    const args = message.toolInput && Object.keys(message.toolInput).length ? JSON.stringify(message.toolInput).slice(0, 300) : "";
    const search = message.tool === "web_search" || message.tool === "exa_search";
    const page = PAGE_STATE_TOOLS.has(message.tool ?? "") || search;
    const limit = page ? (keepWhole.has(index) || search ? PAGE_RESULT_CHARS : OLD_PAGE_CHARS) : TOOL_RESULT_CHARS;
    const body = summary.length > limit ? `${summary.slice(0, limit)}… (cut)` : summary;
    return { owner: false, text: `TOOL ${message.tool}(${args}) → ${message.status ?? "?"}: ${body}` };
  });
  const size = () => lines.reduce((sum, line) => sum + line.text.length + 1, 0);
  let omitted = false;
  // The oldest non-owner lines first, then the oldest owner lines; the newest 6 lines always stay.
  for (const ownerPass of [false, true]) {
    for (let index = 0; index < lines.length - 6 && size() > maxChars;) {
      if (lines[index]!.owner === ownerPass) {
        lines.splice(index, 1);
        omitted = true;
      } else {
        index += 1;
      }
    }
  }
  return `${omitted ? "(earlier conversation omitted)\n" : ""}${lines.map((line) => line.text).join("\n")}`;
}

// "The Houston search found 50" reports a search on record, so only "I/we found…" counts.
const RESULT_CLAIM = /\b(?:i|we)(?:'ve|’ve| have)?\s+(?:just\s+|now\s+|already\s+)?(?:found|prepared|sent|contacted|messaged|emailed|qualified)\b/i;

/**
 * A message sent with searches it only starts, that already reports their
 * results ("I found 20 salons"). The message is shown after the tools run,
 * when the searches have only just begun.
 */
export function startedNotFinishedClaim(message: string, actions: readonly { tool: string }[], startsJobs: (tool: string) => boolean): string | null {
  if (!actions.length || !actions.every((action) => startsJobs(action.tool))) return null;
  return RESULT_CLAIM.test(message)
    ? "These searches only start now; their results come later. Say what you started, not what it found or prepared."
    : null;
}
