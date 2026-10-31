/**
 * The assistant's tool contracts as JSON Schema, keyed by tool name.
 *
 * Native Claude (a personally connected login) reads these as each MCP
 * tool's `inputSchema`; before any tool runs, `coerceToolArguments` reads the
 * model's arguments by the same schema, in one place for both harnesses
 * (runTool, and the harnesses before their own checks). Each tool's prose
 * `arguments` text in tools.server.ts stays the JSON harness's catalog; the
 * descriptions here say the same per property. Ranges and formats stay with
 * each tool (several clamp rather than refuse): what is checked here is the
 * type, the fixed sets (enum) and the required arguments.
 *
 * Adding or replacing a tool's contract is one entry here, or a `schema` on
 * the tool's own definition in tools.server.ts, which wins. Pure: no imports,
 * so client-safe modules may use the coercion.
 */

export type JsonType = "string" | "number" | "integer" | "boolean" | "array" | "object" | "null";

export type JsonSchema = {
  type?: JsonType | readonly JsonType[];
  description?: string;
  enum?: readonly string[];
  items?: JsonSchema;
  properties?: Readonly<Record<string, JsonSchema>>;
  required?: readonly string[];
  anyOf?: readonly JsonSchema[];
  additionalProperties?: boolean;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
};

export type ToolInputSchema = JsonSchema & { type: "object"; properties: Readonly<Record<string, JsonSchema>> };

// ── Sets the tools accept (tests keep them equal to their sources) ──────────

export const SCHEMA_CHANNELS = ["email", "whatsapp", "linkedin", "instagram"] as const;
/** What a plan may contact on: the profile's channels and the owner's own browser. */
export const SCHEMA_OUTREACH_CHANNELS = [...SCHEMA_CHANNELS, "browser"] as const;
export const SCHEMA_PERIODS = ["today", "yesterday", "last_7_days", "last_30_days", "all_time"] as const;
export const SCHEMA_REPORT_SCOPES = ["request", "thread", "run", "organization"] as const;
export const SCHEMA_EXISTING_FROM = ["all", "latest_import", "inquiries"] as const;
export const SCHEMA_SOCIAL_PLATFORMS = ["reddit", "x", "instagram", "facebook"] as const;
export const SCHEMA_TASK_OPS = ["click", "fill", "select", "check", "uncheck", "press"] as const;
export const SCHEMA_VISUAL_OPS = ["click", "double_click", "move", "drag", "scroll", "type", "key"] as const;
export const SCHEMA_ACTION_KINDS = ["interact", "message", "publish", "purchase", "open_tabs"] as const;
export const SCHEMA_REVIEW_FILTERS = ["all", "match", "unconfirmed", "no_match", "unjudged", "not_saved"] as const;

// ── Building blocks ─────────────────────────────────────────────────────────

const text = (description: string): JsonSchema => ({ type: "string", description });
const int = (description: string, range: { minimum?: number; maximum?: number } = {}): JsonSchema => ({ type: "integer", description, ...range });
const num = (description: string): JsonSchema => ({ type: "number", description });
const flag = (description: string): JsonSchema => ({ type: "boolean", description });
const choice = (values: readonly string[], description: string): JsonSchema => ({ type: "string", enum: values, description });
const list = (items: JsonSchema, description: string, range: { minItems?: number; maxItems?: number } = {}): JsonSchema => ({ type: "array", items, description, ...range });
const texts = (description: string, range: { minItems?: number; maxItems?: number } = {}): JsonSchema => list({ type: "string" }, description, range);
const nullable = (schema: JsonSchema): JsonSchema => ({ ...schema, type: [...[schema.type ?? []].flat(), "null"] as JsonType[] });
const tool = (properties: Record<string, JsonSchema>, required: readonly string[] = []): ToolInputSchema => ({ type: "object", properties, ...(required.length ? { required } : {}) });

const NONE = tool({});
const id = (what: string) => text(`${what} (an id from an earlier result)`);
const channelList = (description: string) => list({ type: "string", enum: SCHEMA_CHANNELS }, description);
const outreachChannelList = (description: string) => list({ type: "string", enum: SCHEMA_OUTREACH_CHANNELS }, description);
const tab = (description = "Tab id from browser_tab_open or browser_connection (required)") => int(description, { minimum: 0 });
const element = int("Element number from the latest reading of the page", { minimum: 1 });
const browserWait: JsonSchema = {
  type: "object",
  description: "Wait inside Chrome for a visible CSS selector and/or matching page text, then return one final reading (extension 0.19.0+). Both conditions apply when both are given. No page actions.",
  properties: { selector: text("Visible CSS target; no JavaScript"), text: text("Text the visible target, or page when no selector, must contain"), timeoutMs: int("Local wait, default 20000 ms", { minimum: 0, maximum: 30000 }) },
  additionalProperties: false,
  anyOf: [{ required: ["selector"] }, { required: ["text"] }],
};

/** The older agent's follow-up arguments of a search; research agent v2 drops them (it prepares the plan itself). */
const followUp = (contact = "true only when the owner asked to contact, email or message the leads found: the outreach plan is then prepared automatically when the search finishes") => ({
  contactAfter: flag(contact),
  channels: outreachChannelList("Optional, with contactAfter: only when the owner's own words named how to contact them (browser: through the owner's own signed-in browser); otherwise leave it out and each lead gets its best ready route"),
});
/** The older agent's way to add a search to a request still running in its chat. */
const sameRequest = { sameRequest: flag("Optional true: only when the owner's new message adds to a request whose research is still running in this chat; the search then counts toward that request's target, time and spend cap") };

const PROFILE_TEXT = (description: string) => text(`${description}. An empty string clears the field`);
const placeList = (description: string): JsonSchema => ({ type: ["string", "array"], items: { type: "string" }, description: `${description}. An empty string clears the field` });

export const TOOL_SCHEMAS: Record<string, ToolInputSchema> = {
  // ── Setup and the business ────────────────────────────────────────────────
  check_setup: NONE,
  save_business_info: tool({
    businessName: PROFILE_TEXT("The business's name"),
    website: PROFILE_TEXT("The business's website"),
    offer: PROFILE_TEXT("What the business offers"),
    problemsSolved: PROFILE_TEXT("The problems the offer solves and how"),
    nextStep: PROFILE_TEXT("What an interested lead is offered next: a call, a visit, a quote"),
    prices: PROFILE_TEXT("Prices, packages or rates as the owner gave them"),
    targetCustomers: placeList("Who the business sells to (text, or a list of kinds)"),
    locations: placeList("Where the business works (text, or a list of places)"),
    outreachInstructions: PROFILE_TEXT("How outreach should be written"),
    senderName: PROFILE_TEXT("The sender's name"),
    senderRole: PROFILE_TEXT("The sender's role"),
    bookingDetails: PROFILE_TEXT("How a lead books"),
    language: PROFILE_TEXT("Two-letter language code"),
    notes: PROFILE_TEXT("Anything else the owner said about the business"),
    preferredChannels: channelList("Channels the owner prefers"),
  }),
  search_knowledge: tool({ query: text("What to look up in the owner's saved information and documents") }, ["query"]),

  // ── Lead sources ──────────────────────────────────────────────────────────
  find_leads: tool({
    what: text("Kind of business, e.g. 'dental clinics'"),
    where: text("A city or district; with provider 'apify' also a region or a whole country"),
    maxResults: int("Default 50; the built-in scraper returns about 20 per area, up to 9 areas, at most 200; with provider 'apify', up to the owner's Apify results per run", { minimum: 1 }),
    language: text("Optional two-letter language code"),
    provider: nullable(choice(["apify"], "Optional: 'apify' for Apify's Google Maps Actor; leave it out for the built-in scraper")),
    ...followUp(),
    ...sameRequest,
  }, ["what", "where"]),
  find_instagram_prospects: tool({
    what: text("Kind of customer or business, e.g. 'home bakers'"),
    where: text("Optional: a city, area or country; hashtags made from it are added, and an account whose post or profile names it is marked so"),
    hashtags: texts("Optional: up to 20 hashtags to search, without #: your own choice or the owner's", { maxItems: 20 }),
    maxResults: int("Accounts, default 30; each Apify run is bounded by the owner's results-per-run setting", { minimum: 1 }),
    ...followUp("true only when the owner asked to contact the people found: the plan uses Instagram when connected, or the requested supported contact channels"),
    ...sameRequest,
  }),
  find_social_leads: tool({
    platform: choice(["facebook", "linkedin", "instagram"], "The platform to search"),
    what: text("Keyword or kind of business, e.g. 'real estate agencies'"),
    where: text("Optional: a city, region or country; leave it out to search by keyword alone"),
    maxResults: int("Default 30; each Apify run is bounded by the owner's results-per-run setting", { minimum: 1 }),
    ...followUp("true only when the owner asked to contact the people found"),
    ...sameRequest,
  }, ["platform"]),
  find_customers_on_web: tool({
    customers: text("Who to find, e.g. 'dental clinics'"),
    where: text("Optional city, area or region; leave it out to search anywhere"),
    queries: texts("Optional: up to 6 keyword searches you write, e.g. 'dental clinic Baner Pune', used as they are instead of the built ones", { maxItems: 6 }),
    maxResults: int("1-100 business websites to read, default 40", { minimum: 1, maximum: 100 }),
    ...followUp(),
    ...sameRequest,
  }),
  research_social_sources: tool({
    platforms: list({ type: "string", enum: SCHEMA_SOCIAL_PLATFORMS }, "Optional: the platforms to research; every platform when left out"),
    customers: text("Who to find, e.g. 'real estate agents'; optional when need, keywords or urls say it"),
    need: text("Optional: what they would be asking about or struggling with, in plain words; leave it out to search for the customers themselves"),
    where: text("Optional city or area; leave it out for a topic without a place"),
    subreddits: texts("Optional: up to 6 subreddit names, without r/", { maxItems: 6 }),
    keywords: texts("Optional: up to 6 exact search phrases, each searched as it is", { maxItems: 6 }),
    urls: texts("Optional: up to 50 Instagram, Facebook, X or Reddit profile, page or post links you found, read directly; a link it cannot read is named in the result"),
    since: text("Optional, Reddit's keyword search: past_week, past_month, past_year or all_time; default past_year"),
    maxResults: int("Optional: records across the job; default and most, the organization's records-per-search setting", { minimum: 1 }),
    ...followUp("true only when the owner asked to contact the people found"),
    ...sameRequest,
  }),
  find_linkedin_leads: tool({
    keywords: text("The role, the kind of business and the place, e.g. 'dental clinic owner Pune'"),
    maxResults: int("5-200, default 50", { minimum: 1, maximum: 200 }),
    contactAfter: flag("true only when the owner asked to contact them"),
    ...sameRequest,
  }, ["keywords"]),
  treg_search: tool({ task: text("What you need, in plain words, e.g. 'find work email from full name and company domain'") }, ["task"]),
  treg_call: tool({
    endpointId: text("A catalog id from treg_search, e.g. treg.people.email.find"),
    query: { type: "object", description: "The endpoint's query parameters (text, numbers or lists of them); {} for none" },
    body: nullable({ type: "object", description: "The endpoint's body parameters, for POST endpoints" }),
  }, ["endpointId"]),
  add_instagram_contacts: tool({
    usernames: texts("1-50 usernames, @handles or Instagram profile URLs, as the owner or the page gave them", { minItems: 1, maxItems: 50 }),
    sources: list({
      type: "object",
      properties: { username: text("One of the usernames being saved"), sourceUrl: text("The page it was read on"), quote: text("The exact words there") },
      required: ["username", "sourceUrl"],
    }, "Optional: where a found account was read and the exact words there"),
    listName: text("Optional name for the list"),
    contactAfter: flag("Optional: true when the owner asked to contact these recipients on Instagram"),
  }, ["usernames"]),
  add_contacts: tool({
    contacts: list({
      type: "object",
      description: "Each needs a phone, email, linkedinUrl or profileUrl",
      properties: {
        name: text("The person's or business's name"),
        phone: text("Phone number, with + and the country code when known"),
        email: text("Email address"),
        linkedinUrl: text("LinkedIn profile or company link"),
        profileUrl: text("Their own profile on X, Instagram, Facebook or LinkedIn: a route the owner's browser can message them on"),
        company: text("Company"),
        sourceUrl: text("Optional: the page it was read on"),
        quote: text("Optional: exact words from that page"),
      },
    }, "The contacts, up to 200 a call", { minItems: 1, maxItems: 200 }),
    listName: text("Optional name for the list"),
    ...followUp("true when the owner asked to contact, message or pitch these people: the outreach plan is then prepared right after"),
  }, ["contacts"]),
  use_existing_leads: tool({
    from: choice(SCHEMA_EXISTING_FROM, "Which saved people: all, latest_import or inquiries; default all"),
    search: text("Optional word to match"),
    maxLeads: int("1-500, default 100", { minimum: 1, maximum: 500 }),
    includeHistorical: flag("Optional true: inquiries from imported history too"),
    listName: text("Optional name for the list"),
  }),
  list_inquiries: NONE,
  prepare_inquiry_replies: tool({ autopilot: flag("Optional: propose Automatic replies") }),

  // ── The web ───────────────────────────────────────────────────────────────
  exa_search: tool({
    query: text("Natural-language description of the people, businesses or information needed"),
    numResults: int("Optional 1-100, default 10", { minimum: 1, maximum: 100 }),
    includeDomains: texts("Optional domains to search only"),
    excludeDomains: texts("Optional domains to leave out"),
  }, ["query"]),
  exa_read: tool({ urls: texts("1-10 public page URLs", { minItems: 1, maxItems: 10 }) }, ["urls"]),
  web_search: tool({
    query: text("Keywords"),
    country: text("Optional two-letter country code where results should come from, e.g. IN"),
    page: int("Optional 0-10, for more results", { minimum: 0, maximum: 10 }),
    purpose: text("Optional: why you are searching, one sentence"),
  }, ["query"]),
  read_webpage: tool({ url: text("The page's address") }, ["url"]),

  // ── The server-side browser ───────────────────────────────────────────────
  browser_open: tool({ url: text("The page's address") }, ["url"]),
  browser_read: NONE,
  browser_click: tool({ n: element }, ["n"]),
  browser_fill: tool({ n: element, text: text("What to type, up to 2,000 characters"), submit: flag("Optional: submit the form after typing") }, ["n", "text"]),
  browser_scroll: tool({ direction: choice(["down", "up"], "down or up, default down") }),
  browser_close: NONE,

  // ── The owner's connected browser (tab and screenshot ids are also accepted as tabId / screenshotId) ──
  browser_connection: NONE,
  browser_tab_open: tool({ url: text("The final page's address; WhatsApp chat: https://web.whatsapp.com/send?phone=<international digits>"), tab: tab("Optional: one of this request's tab ids to navigate instead of opening a new tab"), reuse: nullable(flag("Reuse this request's exact open page without reloading, default true; false opens/reloads explicitly")), waitFor: nullable(browserWait) }, ["url"]),
  browser_tab_read: tool({ tab: tab(), waitFor: nullable(browserWait) }),
  browser_tab_click: tool({ tab: tab(), n: element }, ["n"]),
  browser_tab_scroll: tool({ tab: tab(), direction: choice(["down", "up"], "down or up, default down") }),
  browser_tab_search: tool({ tab: tab(), n: element, text: text("The search, up to 200 characters") }, ["n", "text"]),
  browser_tab_close: tool({ tab: tab("Optional tab id; every tab of this request when left out") }),
  browser_task: tool({
    ownerWords: text("The owner's exact words asking for it, copied from their message"),
    goal: text("One line: what will be done"),
    actions: list({ type: "string", enum: SCHEMA_ACTION_KINDS }, "Optional: the kinds you need; default every kind the owner's words allow"),
  }, ["ownerWords", "goal"]),
  browser_tab_act: tool({
    tab: tab(),
    n: element,
    action: choice(SCHEMA_TASK_OPS, "What to do to the element"),
    value: { type: ["string", "number"], description: "fill: the text; select: the option" },
    key: text("press: e.g. Enter, Tab, Escape, Control+a"),
    recipient: text("A step that sends a message: who receives it (international phone number, profile address, @handle on site, or email)"),
    total: text("A step that pays: the order's total exactly as the page shows it, with its currency"),
  }, ["n", "action"]),
  browser_tab_use: tool({
    tab: tab("A tab id (a tab the owner shared, or one from an earlier match)"),
    match: text("Words of the tab's address or title, e.g. 'hubspot'"),
  }),
  browser_tab_show: tool({ tab: tab() }),
  check_browser_routes: tool({ personIds: texts("The leads' person ids, up to 10", { minItems: 1, maxItems: 10 }) }, ["personIds"]),
  browser_tab_screenshot: tool({ tab: tab() }),
  browser_tab_visual: tool({
    tab: tab(),
    screenshot: text("The id of the tab's latest screenshot (required)"),
    action: choice(SCHEMA_VISUAL_OPS, "What to do at the point"),
    x: num("Image pixels from the screenshot's left edge"),
    y: num("Image pixels from the screenshot's top edge"),
    toX: num("drag: where to drop, image pixels"),
    toY: num("drag: where to drop, image pixels"),
    deltaX: num("scroll: sideways, image pixels"),
    deltaY: num("scroll: image pixels, positive is down"),
    text: text("type: the text"),
    key: text("key: e.g. Enter, Tab, Escape, Control+a"),
    recipient: text("A step that sends a message: who receives it (international phone number, profile address, @handle on site, or email)"),
  }, ["action", "x", "y"]),

  // ── The request ───────────────────────────────────────────────────────────
  lead_search_status: tool({ jobId: id("Optional search job; the latest search when left out") }),
  control_research: tool({
    action: choice(["pause", "resume", "cancel"], "pause, resume or cancel"),
    requestId: id("Optional: the request's message id; the latest research in this chat when left out"),
  }, ["action"]),
  set_brief: tool({
    goal: text("Only the owner's requested audience, message purpose and outcome, in one or two sentences"),
    approach: text("Optional: your provisional segments, locations, sources and why they fit this request; not extra owner requirements"),
    leadTarget: nullable(int("The number of leads the owner asked for, or null", { minimum: 1, maximum: 1000 })),
    contact: flag("true when the owner asked to contact, email, message or DM them; false for research only"),
    channels: nullable(outreachChannelList("Channels the owner allowed (browser: their own signed-in browser), or null when they named none")),
    spendCapUsd: nullable(num("Dollars the owner allows on paid sources; 0 when they said free tools only; null when they said nothing")),
    timeLimitMinutes: nullable(int("Minutes the owner allows, or null", { minimum: 5 })),
    done: text("What finished means, in a sentence"),
    newRequest: flag("true when this is a new, different request from the one in progress"),
  }, ["goal"]),
  review_leads: tool({
    filter: choice(SCHEMA_REVIEW_FILTERS, "Optional, default all"),
    limit: int("Optional, 1-80, default 40", { minimum: 1, maximum: 80 }),
    offset: int("Optional: skip this many, for the next page", { minimum: 0 }),
    audienceId: id("Optional: one list only"),
  }),
  set_lead_fit: tool({
    personId: id("The person, from review_leads"),
    fit: choice(["match", "no_match"], "Your verdict"),
    reason: text("A short sentence"),
    quote: text("Optional: the exact words that show it"),
    url: text("The page the quote is from, when it is a page"),
  }, ["personId", "fit", "reason"]),
  finish_request: tool({ summary: text("One sentence: what was done") }, ["summary"]),

  // ── Lists and outreach ────────────────────────────────────────────────────
  list_audiences: NONE,
  describe_audience: tool({ audienceId: id("The list") }, ["audienceId"]),
  prepare_outreach: tool({
    audienceId: id("The lead list"),
    channels: outreachChannelList("Optional: only when the owner's own words named how to contact them (browser: through the owner's own signed-in browser); otherwise leave it out and each lead gets its best ready route"),
    maxLeads: int("Optional, default up to 100", { minimum: 1 }),
    autopilot: flag("Optional: propose Automatic replies"),
    instructions: text("Optional: tone or angle for this run"),
    basedOnRunId: id("Optional: reuse that run's messages"),
    includeSkipped: flag("Optional true: also contact the leads the sorting leaves out, when the owner asks"),
  }, ["audienceId"]),
  list_runs: NONE,
  report: tool({
    period: choice(SCHEMA_PERIODS, "Optional; default last_7_days, all_time for one run"),
    scope: choice(SCHEMA_REPORT_SCOPES, "Optional: whose work is counted"),
    runId: id("Optional: one run"),
  }),
  diagnose_delivery: tool({ runId: id("A specific plan's run; leave out only for an organization-wide account snapshot") }),
  pause_outreach: tool({ runId: id("The run") }, ["runId"]),
  resume_outreach: tool({ runId: id("The run") }, ["runId"]),
  stop_outreach: tool({ runId: id("The run") }, ["runId"]),
  switch_to_review: tool({ runId: id("Optional; every running or paused run when left out") }),
  list_decisions: NONE,
  answer_decision: tool({ decisionId: id("The open decision"), answer: text("The owner's answer, in their words") }, ["decisionId", "answer"]),
};

/** Research agent v2's own contracts, where its tool differs from the older agent's (prepareOutreachV2). */
export const V2_TOOL_SCHEMAS: Record<string, ToolInputSchema> = {
  prepare_outreach: tool({
    leads: choice(["match", "all"], "Optional: match (default) or all"),
    personIds: texts("Optional: person ids from review_leads: exactly these people"),
    audienceId: id("Optional: only this list"),
    maxLeads: int("Optional cap", { minimum: 1 }),
    autopilot: flag("Optional: propose Automatic replies"),
    instructions: text("Optional: tone or angle"),
    basedOnRunId: id("Optional: reuse that run's messages"),
  }),
};

/** A schema without some of its arguments (research agent v2 leaves out the older agent's follow-up ones). */
export function withoutProperties(schema: ToolInputSchema, keys: readonly string[]): ToolInputSchema {
  if (!keys.some((key) => key in schema.properties)) return schema;
  const { required: before, ...rest } = schema;
  const properties = Object.fromEntries(Object.entries(schema.properties).filter(([key]) => !keys.includes(key)));
  const required = (before ?? []).filter((key) => !keys.includes(key));
  return { ...rest, properties, ...(required.length ? { required } : {}) };
}

// ── Reading the model's arguments by the schema ─────────────────────────────

type Coerced = { value: unknown } | { problem: string };

function typesOf(schema: JsonSchema): JsonType[] {
  return schema.type === undefined ? [] : [schema.type].flat() as JsonType[];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function matches(type: JsonType, value: unknown): boolean {
  switch (type) {
    case "string": return typeof value === "string";
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "integer": return typeof value === "number" && Number.isSafeInteger(value);
    case "boolean": return typeof value === "boolean";
    case "array": return Array.isArray(value);
    case "object": return isPlainObject(value);
    case "null": return value === null;
  }
}

const NO = Symbol("no conversion");
const NUMBER_TEXT = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;

/** Lossless readings only: a boolean or number written as text, JSON written as text, a number where text is expected. */
function convert(type: JsonType, value: unknown): unknown {
  const trimmed = typeof value === "string" ? value.trim() : null;
  switch (type) {
    case "boolean":
      return trimmed !== null && /^(?:true|false)$/i.test(trimmed) ? trimmed.toLowerCase() === "true" : NO;
    case "integer":
      return trimmed !== null && /^[+-]?\d+$/.test(trimmed) && Number.isSafeInteger(Number(trimmed)) ? Number(trimmed) : NO;
    case "number":
      return trimmed !== null && NUMBER_TEXT.test(trimmed) && Number.isFinite(Number(trimmed)) ? Number(trimmed) : NO;
    case "string":
      return typeof value === "number" && Number.isFinite(value) ? String(value) : NO;
    case "null":
      return trimmed === "null" ? null : NO;
    default:
      return NO;
  }
}

/** JSON text of an array or object, where the schema takes one. */
function parsedJson(types: JsonType[], value: unknown): unknown {
  if (typeof value !== "string") return NO;
  const trimmed = value.trim();
  const wanted = trimmed.startsWith("[") ? "array" : trimmed.startsWith("{") ? "object" : null;
  if (!wanted || !types.includes(wanted)) return NO;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return matches(wanted, parsed) ? parsed : NO;
  } catch {
    return NO;
  }
}

function expectation(schema: JsonSchema): string {
  if (schema.enum?.length) return `one of ${schema.enum.join(", ")}`;
  const words: Record<JsonType, string> = { string: "text", number: "a number", integer: "a whole number", boolean: "true or false", array: "a list (JSON array)", object: "an object", null: "null" };
  return typesOf(schema).map((type) => words[type]).join(" or ") || "a value";
}

function missing(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === "string" && !value.trim());
}

function coerceValue(schema: JsonSchema, raw: unknown, path: string): Coerced {
  // null is "left out" to every tool; a required one is reported by the caller.
  if (raw === null) return { value: null };
  const types = typesOf(schema);
  // An empty value where text is not taken is "left out", as the tools read it.
  if (typeof raw === "string" && !raw.trim() && types.length && !types.includes("string")) return { value: types.includes("null") ? null : undefined };
  let value: unknown = raw;
  if (types.length) {
    const json = parsedJson(types, value);
    if (json !== NO) value = json;
    else if (!types.some((type) => matches(type, value))) {
      let converted: unknown = NO;
      for (const type of types) {
        converted = convert(type, value);
        if (converted !== NO) break;
      }
      // One value where a list is expected is a list of one.
      if (converted === NO && types.includes("array") && !Array.isArray(value) && value !== undefined) converted = [value];
      if (converted === NO) return { problem: `${path} must be ${expectation(schema)}` };
      value = converted;
    }
  }
  if (schema.enum && typeof value === "string") {
    const given = value;
    const exact = schema.enum.includes(given);
    const folded = exact ? given : schema.enum.find((option) => option.toLowerCase() === given.trim().toLowerCase());
    if (folded === undefined) return { problem: `${path} must be ${expectation(schema)}` };
    value = folded;
  }
  if (Array.isArray(value) && schema.items) {
    const items: unknown[] = [];
    for (const [index, item] of value.entries()) {
      const coerced = coerceValue(schema.items, item, `${path}[${index}]`);
      if ("problem" in coerced) return coerced;
      items.push(coerced.value);
    }
    value = items;
  }
  if (isPlainObject(value) && schema.properties) {
    const read = coerceObject(schema, value, `${path}.`);
    if (read.problems.length) return { problem: read.problems[0]! };
    value = read.args;
  }
  return { value };
}

function coerceObject(schema: JsonSchema, raw: Record<string, unknown>, prefix: string): { args: Record<string, unknown>; problems: string[] } {
  const args = { ...raw };
  const problems: string[] = [];
  for (const [key, property] of Object.entries(schema.properties ?? {})) {
    if (!Object.hasOwn(args, key) || args[key] === undefined) continue;
    const coerced = coerceValue(property, args[key], `${prefix}${key}`);
    if ("problem" in coerced) problems.push(coerced.problem);
    else if (coerced.value === undefined) delete args[key];
    else args[key] = coerced.value;
  }
  for (const key of schema.required ?? []) {
    if (missing(args[key])) problems.push(`${prefix}${key} is required${schema.properties?.[key]?.description ? ` (${schema.properties[key]!.description})` : ""}`);
  }
  return { args, problems };
}

/**
 * The model's arguments read by the tool's schema: booleans and numbers sent
 * as text become booleans and numbers, a list or object sent as JSON text
 * becomes the list or object, one value where a list is expected becomes a
 * list of one, and a fixed-set value matches regardless of case. Whatever
 * still does not fit is a problem for the model to correct; nothing is
 * guessed, and arguments the schema does not name are left as they are.
 */
export function coerceToolArguments(schema: ToolInputSchema | null | undefined, raw: Record<string, unknown>): { args: Record<string, unknown>; problems: string[] } {
  if (!schema) return { args: raw, problems: [] };
  return coerceObject(schema, raw, "");
}
