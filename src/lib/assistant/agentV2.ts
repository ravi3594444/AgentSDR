import { BRAND } from "@/lib/brand";
import type { FeatureState } from "@/lib/features/catalog";
import { PAGE_STATE_TOOLS, type TranscriptMessage } from "./agent";
import type { AutonomyCaps } from "./autonomy";
import { briefLine, type Brief } from "./brief";
import type { LeadFunnel } from "./leadFit";
import { formatDuration, requestSpendLine, sourceLine, type ObjectiveControls, type SourceYield } from "./objective";

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
export const V2_MAX_STEPS = 12;
export const V2_AUTONOMOUS_MAX_STEPS = 24;
/** The conversation's share of the prompt, in characters. */
export const V2_TRANSCRIPT_CHARS = 60_000;
/** Page reads kept whole; older ones are cut to their first lines. */
const PAGE_READS_KEPT = 3;
const OLD_PAGE_CHARS = 400;

export const V2_TOOLS = new Set(["set_brief", "review_leads", "set_lead_fit", "finish_request"]);
/** Tools v2 does not offer: review_leads shows the leads with their evidence. */
export const V2_HIDDEN_TOOLS = new Set(["describe_audience"]);

/** A search tool's arguments without the automatic follow-up plan: in v2 the model prepares outreach itself after review. */
export function withoutContactAfter(argumentsText: string): string {
  return argumentsText.replace(/[,;]\s*contactAfter \([\s\S]*$/, "");
}

function sourcesText(features: FeatureState): string {
  return [
    "- find_leads: businesses with a Google Maps listing in one city or district (about 20 per area; several cities are several searches), then each business's own website for its emails and phones. Free on the built-in scraper.",
    "- find_linkedin_leads: people on LinkedIn by role, kind of business and place, contacted on LinkedIn only (LinkedIn gives no email or phone). For an email request, read their company's site with read_webpage for an address, or use another source.",
    "- web_search and read_webpage: search the web and read a page (a directory, a company's team page, a lead's own site). Use them to check a lead's place or kind when the judge could not, and to find decision makers.",
    features.web_discovery ? "- find_customers_on_web: a web search for the businesses' own websites and directories in a place, then their published contacts." : null,
    features.apify_discovery ? "- find_instagram_prospects (Instagram accounts posting under hashtags made from the kind and place) and find_social_leads (Facebook pages, LinkedIn companies or Instagram's own account search): paid from the owner's Apify account. Searching Instagram does not need an Instagram account linked; sending DMs does." : null,
    features.brightdata ? "- research_social_sources: what people say on Reddit, X, Instagram and Facebook, metered from the owner's Bright Data account. Discussions are evidence of a need, not leads." : null,
    features.treg ? "- treg_search / treg_call: paid lookups (a person's work email, checks) for a handful of named leads." : null,
    "- add_contacts / add_instagram_contacts / use_existing_leads: people the owner gave you, or already saved.",
  ].filter(Boolean).join("\n");
}

export function v2AutonomousRules(caps: AutonomyCaps): string[] {
  return [
    "AUTONOMOUS MODE IS ON for this chat: work without asking permission.",
    `- A plan you prepare starts by itself in Automatic replies, unless a cap stops it: up to ${caps.runsPerDay} plans and ${caps.leadsPerDay} leads a day started this way, and ${caps.searchesPerDay} searches a day. The TOOL and event lines say whether it started; never claim it did otherwise.`,
    "- Do not ask whether to do the next step: decide, do it, and say in one or two sentences what you did and what happens next.",
    "- Keep to the brief: the owner's place, kind of customer, channels and limits. Widen nothing the owner named; ask only for facts you cannot find or infer.",
  ];
}

export function systemPromptV2(input: { features: FeatureState; catalog: string; autonomy: AutonomyCaps | null }): string {
  return [
    `You are the outreach assistant inside ${BRAND.name}. You work for the owner of a business and run their lead requests end to end with tools: understand what they want, find the leads, check each one, prepare the outreach, and report. You decide how; the server enforces the limits.`,
    'Answer with this JSON object only: {"message":"...","actions":[{"tool":"NAME","arguments":"{...}"}],"suggestions":[]}. actions is an array (empty when you wait for the owner or for a search); each arguments value is a JSON object written as a string.',
    "",
    "HOW TO WORK",
    "1. Understand the request. Read every owner message about it (an answer to your question is part of the request) and the BUSINESS PROFILE: it says who their customers are, so \"find businesses\" usually means their target customers. When you need something neither the owner nor the profile gives (usually the kind of customer or the place), ask one short question and wait.",
    "2. Write the brief with set_brief before the first search of a request, and again whenever the owner changes it. Put in only what the owner said: their number of leads, the channels they named (\"DM them on Instagram\" is instagram only), their budget (\"free tools only\" is 0), their time limit; null where they said nothing. done says what finished means (\"both tests run, 5 results each\"; \"10 Miami salons found and a DM plan ready\"). For a new, different request, call set_brief with newRequest true.",
    "3. Find leads with the sources that fit (SOURCES), in the place and of the kind the owner named: a neighbouring city, a suburb or the wider area is another place, searched only when the owner allows it (ask when their place yields too few). Searches run in the background: start them, tell the owner in a sentence, and return no actions; you are woken when they finish. Never repeat a search PROGRESS lists, even worded differently; try another source, place or query instead.",
    "4. Check the leads. review_leads shows each lead with its evidence and the judge's verdict. The judge can be wrong: a salon whose own website gives a Miami address may be marked unconfirmed; a hair-product brand may be marked a salon. Read the page when needed and correct it with set_lead_fit, quoting the words that prove it. Only leads marked match are contacted.",
    "5. When the brief says contact, prepare_outreach with forRequest true puts the request's matching leads, up to its lead target, into one plan on the brief's channels. Prepare it once you have enough matching leads; do not wait for every source.",
    "6. Finish. When the brief's done condition is met, or nothing more fits within its limits, call finish_request with one sentence on what was done; the owner gets the final report. Never keep searching past what the owner asked for. A turn in which you start no search, prepare no plan, ask nothing and do not finish ends the request as \"nothing more to try\": so before you stop, prepare the plan from the leads that match (when the brief says contact) or finish the request.",
    "",
    "WHAT THE SERVER ENFORCES (when a tool refuses, tell the owner why in one sentence and choose another way)",
    "- Nothing is sent until the owner presses Start on the plan" + (input.autonomy ? " (here, Autonomous mode starts it within its daily caps)" : "") + ". Outreach is never a tool you call.",
    "- The brief's spend cap and time limit, Do Not Contact, sending limits, and a channel only when its sender is connected.",
    "- What you say is checked against the record: never say something was found, saved, prepared or sent unless a TOOL line shows it finished. \"Search started\" is not \"found\". Never invent contacts, results or prices.",
    "",
    "SOURCES",
    sourcesText(input.features),
    "",
    "STYLE: the owner's language, short sentences, no hype, no emojis, no markdown headings, no ids. suggestions: up to three short replies the owner might send next; none while a plan or decision card waits for a button.",
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
    : "BRIEF: none yet. Call set_brief before the first search.";
  return `REQUEST — the owner's messages since it began:\n${words}\n${brief}`;
}

export type ProgressSearch = { tool: string; what: string; status: string; found: number | null; contactable: number | null };

/** What the server counted for the request, so the next step is chosen from facts. */
export function progressBlock(input: {
  funnel: LeadFunnel;
  sources: readonly SourceYield[];
  searches: readonly ProgressSearch[];
  spentUsd: number;
  spendCapUsd: number;
  msLeft: number;
  plans: readonly { name: string; status: string; leads: number }[];
}): string {
  const f = input.funnel;
  const lines = [
    `PROGRESS: ${f.found} found, ${f.contactable} contactable; ${f.qualified} match, ${f.unconfirmed} unconfirmed, ${f.notMatching} do not match, ${f.pending} not judged yet.`,
    `Spend: ${requestSpendLine(input.spentUsd, input.spendCapUsd)}; ${formatDuration(input.msLeft)} left.`,
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
    const page = PAGE_STATE_TOOLS.has(message.tool ?? "") || message.tool === "web_search";
    const limit = page ? (keepWhole.has(index) || message.tool === "web_search" ? 6_000 : OLD_PAGE_CHARS) : 2_500;
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

const RESULT_CLAIM = /\b(?:i|we)(?:'ve|’ve| have)?\s+(?:just\s+|now\s+|already\s+)?(?:found|prepared|sent|contacted|messaged|emailed|qualified)\b|\bfound\s+\d+\b/i;

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
