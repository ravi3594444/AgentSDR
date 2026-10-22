import { describe, expect, test } from "bun:test";
import { actionsProblem, agentReplySchema, cleanSuggestions, searchArgsKey, searchRequestFor, displayThreadTitle, groundingCorpus, isSmallTalk, MAX_ACTIONS_PER_REPLY, MAX_ACTIONS_PER_STEP, nextAgentBatch, outreachIntent, outreachRequested, outreachRequestProblem, parseAgentReply, pendingOutreachRequest, researchOnlyStated, sameMessage, standingOutreachRequestIndex, outreachRevoked, threadTitleFrom, transcriptText, unbackedClaim, ungroundedContacts, urlGiven, type AgentReply, type TranscriptMessage } from "./agent";

const TOOLS = ["find_leads", "save_business_info", "prepare_outreach"];

describe("parseAgentReply", () => {
  test("parses actions whose arguments are a JSON string", () => {
    const reply = parseAgentReply(JSON.stringify({
      message: "Searching now.",
      actions: [{ tool: "find_leads", arguments: "{\"what\":\"dentists\",\"where\":\"Pune\"}" }],
    }), TOOLS);
    expect(reply).toEqual({ message: "Searching now.", actions: [{ tool: "find_leads", args: { what: "dentists", where: "Pune" } }], suggestions: [] });
  });

  test("empty arguments mean no arguments", () => {
    expect(parseAgentReply(JSON.stringify({ message: "", actions: [{ tool: "prepare_outreach", arguments: "" }] }), TOOLS).actions[0]!.args).toEqual({});
    expect(parseAgentReply(JSON.stringify({ message: "", actions: [{ tool: "prepare_outreach", arguments: "  " }] }), TOOLS).actions[0]!.args).toEqual({});
  });

  test("rejects unknown tools, bad JSON, arrays and too many actions with a fixable reason", () => {
    expect(() => parseAgentReply("not json", TOOLS)).toThrow("JSON object only");
    expect(() => parseAgentReply(JSON.stringify({ message: "x", actions: [{ tool: "send_everything", arguments: "{}" }] }), TOOLS)).toThrow("does not exist");
    expect(() => parseAgentReply(JSON.stringify({ message: "x", actions: [{ tool: "find_leads", arguments: "{oops" }] }), TOOLS)).toThrow("JSON object written as a string");
    expect(() => parseAgentReply(JSON.stringify({ message: "x", actions: [{ tool: "find_leads", arguments: "[1]" }] }), TOOLS)).toThrow("must be a JSON object");
    const many = Array.from({ length: MAX_ACTIONS_PER_REPLY + 1 }, () => ({ tool: "find_leads", arguments: "{}" }));
    expect(() => parseAgentReply(JSON.stringify({ message: "x", actions: many }), TOOLS)).toThrow("at most");
    expect(() => parseAgentReply(JSON.stringify({ message: "  ", actions: [] }), TOOLS)).toThrow("Say something");
  });

  test("after tool results an empty reply ends the turn", () => {
    expect(parseAgentReply(JSON.stringify({ message: "", actions: [] }), TOOLS, { allowEmpty: true })).toEqual({ message: "", actions: [], suggestions: [] });
  });

  test("the schema lists exactly the tools and requires every property (strict mode)", () => {
    const schema = agentReplySchema(TOOLS);
    expect(schema.required).toEqual(["message", "actions", "suggestions"]);
    expect(schema.properties.actions.items.properties.tool.enum).toEqual(TOOLS);
    expect(schema.properties.actions.items.required).toEqual(["tool", "arguments"]);
    expect(schema.properties.actions.maxItems).toBe(MAX_ACTIONS_PER_STEP);
  });

  test("normalizes recognizable tool-call formats without dropping calls", () => {
    const action = { tool: "find_leads", arguments: '{"what":"dentists","where":"Pune"}' };
    const native = { type: "function", function: { name: action.tool, arguments: action.arguments } };
    for (const body of [
      { actions: action },
      { actions: JSON.stringify([action]) },
      { actions: JSON.stringify(action) },
      { tool_calls: [native] },
      { actions: native },
      { tool: "find_leads", args: { what: "dentists", where: "Pune" } },
      { name: "find_leads", arguments: action.arguments },
      { assistant_reply: { actions: [action] } },
    ]) {
      expect(parseAgentReply(JSON.stringify(body), TOOLS)).toEqual({
        message: "", actions: [{ tool: "find_leads", args: { what: "dentists", where: "Pune" } }], suggestions: [],
      });
    }
  });

  test("missing or unsupported actions require repair instead of silently doing nothing", () => {
    for (const body of [{ message: "Searching now" }, { message: "Searching now", actions: null }, { actions: "find_leads" }, { actions: { arbitrary: [] } }]) {
      expect(() => parseAgentReply(JSON.stringify(body), TOOLS, { allowEmpty: true })).toThrow('"actions":[{"tool":"TOOL_NAME"');
    }
    for (const body of [null, [], "text", 7]) {
      expect(() => parseAgentReply(JSON.stringify(body), TOOLS)).toThrow("JSON object only");
    }
  });

  test("normalized calls still reject unknown tools and invalid arguments", () => {
    expect(() => parseAgentReply(JSON.stringify({ tool_calls: [{ function: { name: "send_everything", arguments: "{}" } }] }), TOOLS)).toThrow("does not exist");
    for (const args of ["[1]", "null", "{oops", [1], false, 7]) {
      expect(() => parseAgentReply(JSON.stringify({ actions: { name: "find_leads", args } }), TOOLS)).toThrow("JSON object");
    }
  });
});

describe("nextAgentBatch", () => {
  const plan = (count: number): AgentReply => parseAgentReply(JSON.stringify({
    message: "Searches queued.", suggestions: ["Show results"],
    actions: Array.from({ length: count }, (_, index) => ({ tool: "find_leads", arguments: JSON.stringify({ what: "dentists", where: `City ${index}` }) })),
  }), TOOLS);

  test("five actions no longer hit the old four-action rejection", () => {
    const result = nextAgentBatch(plan(5));
    expect(result.batch.actions).toHaveLength(5);
    expect(result.pending).toBeNull();
  });

  test("larger plans keep every action in order and show the message only after the last batch", () => {
    for (const count of [9, 17, MAX_ACTIONS_PER_REPLY]) {
      const reply = plan(count);
      let pending: AgentReply | null = reply;
      const executed = [];
      let batches = 0;
      while (pending) {
        const result = nextAgentBatch(pending);
        expect(result.batch.actions.length).toBeLessThanOrEqual(MAX_ACTIONS_PER_STEP);
        expect(result.replanAfterRead).toBe(false);
        expect(result.batch.message).toBe(result.pending ? "" : reply.message);
        expect(result.batch.suggestions).toEqual(result.pending ? [] : reply.suggestions);
        executed.push(...result.batch.actions);
        pending = result.pending;
        batches += 1;
      }
      expect(executed).toEqual(reply.actions);
      expect(batches).toBe(Math.ceil(count / MAX_ACTIONS_PER_STEP));
    }
  });

  test("a webpage read waits for its real results before saving details or searching", () => {
    const reply: AgentReply = { message: "Website read and leads found.", suggestions: ["Show results"], actions: [
      { tool: "read_webpage", args: { url: "https://agency.example" } },
      { tool: "save_business_info", args: { offer: "Guessed from the unread website" } },
      { tool: "find_leads", args: { what: "dentists", where: "Pune" } },
    ] };
    const result = nextAgentBatch(reply);
    expect(result.batch.actions).toEqual(reply.actions.slice(0, 1));
    expect(result.batch.message).toBe("");
    expect(result.batch.suggestions).toEqual([]);
    expect(result.pending).toBeNull();
    expect(result.replanAfterRead).toBe(true);
  });

  test("a read in a later batch still stops speculative following actions", () => {
    const reply = plan(10);
    reply.actions[8] = { tool: "read_webpage", args: { url: "https://agency.example" } };
    const first = nextAgentBatch(reply);
    expect(first.batch.actions).toHaveLength(8);
    expect(first.pending).not.toBeNull();
    const second = nextAgentBatch(first.pending!);
    expect(second.batch.actions).toEqual([reply.actions[8]!]);
    expect(second.pending).toBeNull();
    expect(second.replanAfterRead).toBe(true);
  });

  test("all actions are syntactically validated before any batch is accepted", () => {
    const actions = Array.from({ length: 10 }, () => ({ tool: "find_leads", arguments: "{}" }));
    actions[9]!.tool = "unknown_tool";
    expect(() => parseAgentReply(JSON.stringify({ actions }), TOOLS)).toThrow('actions[9].tool');
    actions[9] = { tool: "find_leads", arguments: "[1]" };
    expect(() => parseAgentReply(JSON.stringify({ actions }), TOOLS)).toThrow('actions[9].arguments');
  });

  test("queued batches are checked again against current business information", () => {
    const reply = plan(8);
    reply.actions.push({ tool: "save_business_info", args: { senderName: "Amit Sharma" } });
    const queued = nextAgentBatch(reply).pending!;
    const batch = nextAgentBatch(queued).batch;
    expect(actionsProblem(batch.actions, { profile: { businessName: "Bright Path" }, ownerCorpus: "We are Bright Path", outreachRequested: true })).toContain("not what the owner wrote");
  });
});

describe("unbackedClaim", () => {
  test("a message that says something was done needs a tool that succeeded this turn", () => {
    expect(unbackedClaim("I've saved your business details.", [], false)).toContain("no tool has succeeded");
    expect(unbackedClaim("I have found 40 dentists.", [], false)).toContain("no tool has succeeded");
    expect(unbackedClaim("I've saved your business details.", ["save_business_info"], false)).toBeNull();
  });

  test("an earlier search backs \"I found …\", never \"I've sent / saved / prepared …\"", () => {
    expect(unbackedClaim("I found 30 dentists in Austin; 12 match.", [], false, true)).toBeNull();
    expect(unbackedClaim("I've sent emails to all 24 dentists.", [], false, true)).toContain("no tool has succeeded");
    expect(unbackedClaim("I've saved that you offer free delivery.", [], false, true)).toContain("no tool has succeeded");
    expect(unbackedClaim("I found 30 dentists and I've prepared the plan.", [], false, true)).toContain("no tool has succeeded");
    expect(unbackedClaim("I found 30 dentists.", [], false, false)).toContain("no tool has succeeded");
  });

  test("future intentions and questions pass", () => {
    expect(unbackedClaim("I will search for dentists in Pune once you confirm.", [], false)).toBeNull();
    expect(unbackedClaim("Which city should I search?", [], false)).toBeNull();
  });

  test("saying outreach is live needs a started run on record", () => {
    expect(unbackedClaim("Your campaign is now live.", ["prepare_outreach"], false)).toContain("Start button");
    expect(unbackedClaim("Your campaign is now live.", ["prepare_outreach"], true)).toBeNull();
  });
});

describe("transcriptText", () => {
  const base: Omit<TranscriptMessage, "role" | "content"> = { tool: null, toolInput: null, toolResult: null, status: null, attachments: [] };

  test("shows owner, assistant, tool and event lines in order", () => {
    const text = transcriptText([
      { ...base, role: "user", content: "Find dentists", attachments: [{ name: "brochure.pdf" }] },
      { ...base, role: "tool", content: "", tool: "find_leads", toolInput: { what: "dentists" }, toolResult: { summary: "Search started." }, status: "ok" },
      { ...base, role: "event", content: "The search finished: 12 leads." },
      { ...base, role: "assistant", content: "Done searching." },
    ]);
    expect(text.split("\n")).toEqual([
      "OWNER: Find dentists [attached: brochure.pdf]",
      "TOOL find_leads({\"what\":\"dentists\"}) → ok: Search started.",
      "EVENT: The search finished: 12 leads.",
      "ASSISTANT: Done searching.",
    ]);
  });

  test("drops the oldest lines past the limit", () => {
    const messages = Array.from({ length: 50 }, (_, index) => ({ ...base, role: "user" as const, content: `message ${index} ${"x".repeat(50)}` }));
    const text = transcriptText(messages, 600);
    expect(text.startsWith("(earlier conversation omitted)")).toBe(true);
    expect(text).toContain("message 49");
    expect(text).not.toContain("message 0 ");
  });
});

describe("outreachRequested", () => {
  test("the reported prompts work with or without a website URL", () => {
    const plain = "hey find leads for our agency find and reach otu them in every ay possible insta email linked ai whastapp find leads to sell our ai aautomations any locatiosn i ned leads that si s liek active";
    const withUrl = "hey find leads for our agency first visit our site 22nd-x-ai-studio.vercel.app find and reach otu them in every ay possible insta email linked ai whastapp find leads to sell our ai aautomations";
    for (const prompt of [plain, withUrl]) {
      expect(outreachRequested(prompt)).toBe(true);
      expect(actionsProblem([{ tool: "find_leads", args: { what: "dental clinics", where: "Pune", contactAfter: true } }], {
        profile: { businessName: "Our Agency", offer: "AI automations", locations: "Pune" },
        ownerCorpus: prompt, outreachRequested: outreachRequested(prompt),
      })).toBeNull();
    }
    expect(urlGiven("https://22nd-x-ai-studio.vercel.app", withUrl)).toBe(true);
    expect(actionsProblem([{ tool: "read_webpage", args: { url: "https://22nd-x-ai-studio.vercel.app" } }], {
      profile: {}, ownerCorpus: withUrl, outreachRequested: true,
    })).toBeNull();
  });

  test("the owner's latest message asking to contact people counts, typos and Hinglish included", () => {
    expect(outreachRequested("do outreach")).toBe(true);
    expect(outreachRequested("Find dental clinics in Pune and email them.")).toBe(true);
    expect(outreachRequested("liek via campagion ai agent should able ot pitch the coutemr")).toBe(true);
    expect(outreachRequested("whatsapp pe bhejo")).toBe(true);
  });

  test("a yes counts only as an answer to the assistant offering outreach", () => {
    const offer = "I found 24 dental clinics. Shall I prepare outreach to them?";
    expect(outreachRequested("yes", offer)).toBe(true);
    expect(outreachRequested("haan karo", offer)).toBe(true);
    expect(outreachRequested("ok go ahead", offer)).toBe(true);
    expect(outreachRequested("yes", "Is your business in Pune?")).toBe(false);
    expect(outreachRequested("yes")).toBe(false);
  });

  test("information, questions and refusals do not ask for outreach", () => {
    expect(outreachRequested("We run Bright Path. We sell maintenance plans.")).toBe(false);
    expect(outreachRequested("What can you do?")).toBe(false);
    expect(outreachRequested("don't contact them yet")).toBe(false);
    expect(outreachRequested("do not email anyone")).toBe(false);
    expect(outreachRequestProblem("our prices are fair")).toContain("has not asked");
  });

  test("a request stays open across a clarifying question until a search or plan acts on it", () => {
    const m = (role: "user" | "assistant" | "tool", content: string, tool: string | null = null, toolInput: Record<string, unknown> | null = null) => ({ role, content, tool, toolInput, status: role === "tool" ? "ok" : null });
    const asked = [m("user", "find real estate agents in USA and do outreach on whatsapp"), m("assistant", "Which cities should I search?"), m("user", "Austin and Dallas")];
    expect(pendingOutreachRequest(asked)).toBe("find real estate agents in USA and do outreach on whatsapp");
    expect(pendingOutreachRequest([...asked, m("tool", "Search started", "find_leads", { contactAfter: true }), m("user", "thanks")])).toBeNull();
    expect(pendingOutreachRequest([m("user", "We sell cleaning services"), m("assistant", "Got it. Who are your customers?"), m("user", "offices in Austin")])).toBeNull();
    expect(pendingOutreachRequest([m("user", "do outreach"), m("user", "a"), m("user", "b"), m("user", "c")])).toBeNull();
  });

  test("outreachIntent tolerates typos but not unrelated words", () => {
    expect(outreachIntent("contcat them")).toBe(true);
    expect(outreachIntent("whatsap them")).toBe(true);
    expect(outreachIntent("our prices are fair")).toBe(false);
  });

  // Pilot finding L01: words a typo away from an outreach word, budget
  // wording and a research-only statement must never authorize outreach.
  const PILOT_PROMPT = "Research only. Find 3 dental clinics in Pune, India. Use free sources only with a $0 source budget, and finish within 5 minutes. Save a lead list. Do not contact anyone. No outreach. No messages. No campaigns.";

  test("budget wording is not a request to send", () => {
    expect(outreachRequested("Research only. Spend $0. Do not contact anyone.")).toBe(false);
    expect(outreachRequested("Find 20 gyms in Mumbai. Spend cap $2, free sources first.")).toBe(false);
    expect(outreachRequested("How much have we spent so far?")).toBe(false);
    expect(outreachRequested("Find dentists in Pune, spend up to $1 and email them.")).toBe(true);
  });

  test("a real word within a typo of an outreach word is not one", () => {
    const nearMisses = [
      "spend", "spent", "sent", "contract", "content", "context", "connect", "massage", "passage", "fellow", "hollow", "fallow",
      "beach", "teach", "peach", "roach", "ranch", "react", "bleach", "breach", "preach", "each",
      "patch", "witch", "ditch", "hitch", "stitch", "pinch", "itch", "pitcher",
      "mall", "main", "maid", "nail", "rail", "sail", "tail", "jail", "hail", "male", "mild", "mile",
      "seed", "sand", "bend", "lend", "tend", "mend", "fend", "vend", "linked", "followers",
    ];
    for (const word of nearMisses) {
      expect(outreachIntent(`Find clinics near the ${word}`)).toBe(false);
      expect(outreachIntent(`${word} them`)).toBe(false);
    }
    expect(outreachRequested("Rank each clinic by rating, the main ones first, with their contracts and website content.")).toBe(false);
    expect(outreachRequested("How many were sent yesterday?")).toBe(false);
    expect(outreachRequested("List the ones on the beach road with a patch of parking; show spending by source.")).toBe(false);
  });

  test("genuine misspellings and inflections still ask for outreach", () => {
    expect(outreachIntent("campagion them")).toBe(true);
    expect(outreachIntent("contcat the clinics")).toBe(true);
    expect(outreachIntent("emial them the offer")).toBe(true);
    expect(outreachIntent("whatsap them")).toBe(true);
    expect(outreachIntent("start contacting them")).toBe(true);
    expect(outreachIntent("I messaged two already, do the rest")).toBe(true);
    expect(outreachIntent("send the emails today")).toBe(true);
    expect(outreachIntent("reach out to them")).toBe(true);
    expect(outreachIntent("pitch them on whatsapp")).toBe(true);
  });

  test("contact details asked for as data are not outreach: a verb directed at me or us, or a channel named as a thing", () => {
    expect(outreachRequested("Find dentists in Pune and send me their emails")).toBe(false);
    expect(outreachRequested("email me the list")).toBe(false);
    expect(outreachRequested("Find 50 real estate agents in Austin and send us their email and whatsapp numbers")).toBe(false);
    expect(outreachRequested("collect their contact details and linkedin profiles")).toBe(false);
    expect(outreachRequested("Find clinics with an email address and a whatsapp number")).toBe(false);
    expect(outreachRequested("message me when done")).toBe(false);
    expect(outreachRequested("send the list to me")).toBe(false);
    expect(outreachRequested("Find dentists in Pune and email them")).toBe(true);
    expect(outreachRequested("Find dentists in Pune and send them our offer")).toBe(true);
    expect(outreachRequested("write them an email about our plan")).toBe(true);
    expect(outreachRequested("whatsapp the clinics that have no website")).toBe(true);
    expect(outreachRequested("email every clinic on the list")).toBe(true);
  });

  test("an explicit research-only statement prevents outreach, whatever else the message says", () => {
    expect(researchOnlyStated("Research only.")).toBe(true);
    expect(researchOnlyStated("research-only please")).toBe(true);
    expect(researchOnlyStated("only research for now")).toBe(true);
    expect(researchOnlyStated("just research, no outreach")).toBe(true);
    expect(researchOnlyStated("Do not contact anyone.")).toBe(true);
    expect(researchOnlyStated("don't contact anybody")).toBe(true);
    expect(researchOnlyStated("dont contact them")).toBe(true);
    expect(researchOnlyStated("never contact people")).toBe(true);
    expect(researchOnlyStated("find them without contacting anyone")).toBe(true);
    expect(researchOnlyStated("Find 20 clinics. No messages.")).toBe(true);
    expect(researchOnlyStated("Find 20 clinics, no campaigns")).toBe(true);
    expect(researchOnlyStated(PILOT_PROMPT)).toBe(true);
    expect(researchOnlyStated("Find dentists in Pune and email them")).toBe(false);
    expect(researchOnlyStated("We do market research for clinics; email them our offer")).toBe(false);
    expect(researchOnlyStated("send no more than 20 messages a day")).toBe(false);
    expect(outreachRequested("Find clinics and email me the list. Research only, do not contact anyone.")).toBe(false);
    expect(outreachRequested("Find 30 dentists in Pune and whatsapp them. Research only.")).toBe(false);
    expect(outreachRequested(PILOT_PROMPT)).toBe(false);
    expect(outreachRequested("Switch the target niche to orthodontists. Research only, no outreach.")).toBe(false);
    expect(outreachRequested("Change the niche to pilates studios in Pune and email them")).toBe(true);
    // A yes to an offer does not override the owner's own research-only words.
    expect(outreachRequested("yes, research only", "Shall I email them?")).toBe(false);
    expect(outreachRevoked("From now on research only.")).toBe(true);
  });

  test("a negation of one channel still requests outreach on the other", () => {
    expect(researchOnlyStated("don't email them, WhatsApp them")).toBe(false);
    expect(outreachRequested("don't email them, WhatsApp them")).toBe(true);
    expect(researchOnlyStated("Do not contact them by email; WhatsApp them instead.")).toBe(false);
    expect(outreachRequested("Do not contact them by email; WhatsApp them instead.")).toBe(true);
    expect(outreachRequested("no emails, whatsapp only")).toBe(true);
  });

  test("genuine requests stay requests: typos, Hinglish and a yes to an offer", () => {
    expect(outreachRequested("find 20 dentists in pune and contcat them on whatsap")).toBe(true);
    expect(outreachRequested("Pune ke dentists ko whatsapp pe message bhejo")).toBe(true);
    expect(outreachRequested("inko sampark karo")).toBe(true);
    expect(outreachRequested("do outreach to 50 gyms in Mumbai, spend up to $2")).toBe(true);
    expect(outreachRequested("yes", "Shall I email the 12 clinics I found?")).toBe(true);
    expect(outreachRequested("haan karo", "Shall I message them on WhatsApp?")).toBe(true);
    expect(outreachRequested("run an email campaign for the ones with no website")).toBe(true);
    expect(outreachRequested("follow up with the ones who did not reply")).toBe(true);
  });

  // Pilot finding L01, second round: outreachRequested is an authorization
  // gate. The owner's research-only words are a veto with wide recall, and
  // nothing else may silence a genuine request.
  const chat = (...turns: [string, string][]) => turns.map(([role, content]) => ({ role: role as "user" | "assistant", content, tool: null, toolInput: null, status: null }));

  test("a research-only message cancels an earlier request that nothing has acted on", () => {
    expect(pendingOutreachRequest(chat(["user", "find dentists in Pune and email them"], ["assistant", "Which area of Pune?"], ["user", "Kothrud. Actually research only, do not contact anyone."]))).toBeNull();
    expect(pendingOutreachRequest(chat(["user", "find dentists in Pune and email them"], ["assistant", "Got it. Starting."], ["user", "wait, research only. no outreach."]))).toBeNull();
    expect(pendingOutreachRequest(chat(["user", "find dentists in Pune and email them"], ["assistant", "Which area?"], ["user", "Kothrud"], ["assistant", "Any budget?"], ["user", "kisi ko contact mat karo"]))).toBeNull();
    // A plain answer to a clarifying question keeps the request.
    expect(pendingOutreachRequest(chat(["user", "find dentists in Pune and email them"], ["assistant", "Which area of Pune?"], ["user", "Kothrud"]))).toBe("find dentists in Pune and email them");
  });

  test("a negation over a list of channels is a veto, whatever the commas", () => {
    for (const text of [
      "Do not email, whatsapp or call anyone.", "No emails, messages or calls to anyone.", "Do not contact anyone via email or whatsapp.",
      "Do not contact anyone by email, whatsapp or linkedin.", "Do not contact anyone through email.", "Don't send any messages.",
      "Do not send them any messages.", "Don't message or email anyone", "No need to contact or email them",
    ]) {
      expect(outreachRequested(text)).toBe(false);
      expect(outreachRevoked(text)).toBe(true);
    }
    expect(researchOnlyStated("Do not email, whatsapp or call anyone.")).toBe(true);
    expect(researchOnlyStated("No emails, messages or calls to anyone.")).toBe(true);
    expect(outreachRequested("Do not email, whatsapp or call anyone. Find clinics with an email address.")).toBe(false);
    // One channel negated, another asked for: still a request.
    expect(outreachRequested("no emails, whatsapp only")).toBe(true);
    expect(outreachRequested("don't email them, WhatsApp them")).toBe(true);
  });

  test("common real words inside the typo radius are not outreach words; short outreach words take no typos", () => {
    for (const text of [
      "Find clinics like the following: Smile Dental, Pune. Spend $0.", "Use the following list of areas: Baner, Kothrud. Budget zero.",
      "I followed your advice and found 3 more. Spend $0.", "She follows the same plan.", "Find clinics with constant foot traffic. Spend $0.",
      "Find clinics that use gmail. Spend $0.", "whatsup, find 3 clinics", "How many are contactable?", "Is the site reachable?",
      "Find dentists in the Champaign area", "Connect my LinkedIn account", "connect the whatsapp number", "Follow these steps and find 3 clinics",
      "Find camping sites near Pune", "Find startups with a spark of growth", "Read my pitch deck and find investors", "What does this error message mean?",
      "Find clinics within reach of Baner",
    ]) expect(outreachRequested(text)).toBe(false);
    // "send", "mail" (four letters or fewer) match only as written.
    expect(outreachIntent("sned them the offer")).toBe(false);
    expect(outreachIntent("send them the offer")).toBe(true);
    // Typos of the longer words still count, and so does following up.
    for (const text of ["campagion them", "contcat the clinics", "emial them", "whatsap them", "mesage them", "pitchh them", "Keep following up with them", "follow-up with the clinics", "connect with them", "connect with the CTOs"]) {
      expect(outreachIntent(text)).toBe(true);
    }
  });

  test("Hinglish refusals: the negation after the word counts", () => {
    for (const text of [
      "kisi ko contact mat karo", "koi message mat bhejo", "unhe email mat karo", "whatsapp mat karo", "abhi message mat karna",
      "sirf research karo, kisi ko sampark mat karo", "kisi ko bhi contact nahi karna hai", "sirf list banao, kisi ko contact mat karo",
    ]) expect(outreachRequested(text)).toBe(false);
    expect(researchOnlyStated("sirf research karo")).toBe(true);
    expect(researchOnlyStated("kisi ko contact mat karo")).toBe(true);
    // One channel refused, another asked for; "na" after a verb is a softener, not a refusal.
    expect(outreachRequested("email mat karo, whatsapp karo")).toBe(true);
    expect(outreachRequested("unhe whatsapp pe message bhejo na")).toBe(true);
  });

  test("a curly apostrophe is an apostrophe", () => {
    expect(researchOnlyStated("Don\u2019t contact anyone")).toBe(true);
    expect(outreachRequested("Don\u2019t contact anyone; I\u2019ll do the outreach myself later.")).toBe(false);
    expect(outreachRequested("Don\u2019t contact anyone. Find clinics like the following: Smile Dental.")).toBe(false);
    expect(outreachRequested("Don\u2018t message anybody")).toBe(false);
  });

  test("the owner keeping the contact for themselves, or zero outreach, is research only", () => {
    for (const text of ["Find 20 gyms. I'll contact them myself.", "We'll reach out ourselves.", "I'll do the outreach myself later.", "I will message them on my own.", "find 20 gyms. Zero outreach.", "find 20 gyms. Outreach: none."]) {
      expect(researchOnlyStated(text)).toBe(true);
      expect(outreachRequested(text)).toBe(false);
    }
  });

  test("an outreach verb done for the owner is still outreach", () => {
    for (const text of [
      "do the outreach for me", "can you do outreach for me?", "contact the clinics for me", "contact them for me", "pitch them for us",
      "reach out to them for us", "run the campaign for us", "message the gym owners for me", "handle the outreach for us", "whatsapp them for me",
      "Email them for me", "whatsapp the clinics for me please", "Find dentists in Pune and pitch them for me",
    ]) expect(outreachRequested(text)).toBe(true);
    // Aimed at the owner it is data.
    expect(outreachRequested("send me their emails")).toBe(false);
    expect(outreachRequested("send the list to me")).toBe(false);
  });

  test("a channel word after an article is an action unless a detail noun follows it", () => {
    for (const text of [
      "run the email sequence", "kick off the email sequence for the dentists", "start the whatsapp sequence", "launch the email blast",
      "go ahead with email", "proceed with whatsapp", "go with whatsapp", "do the emails now", "start the emails",
      "write an email to each clinic", "write an email to the clinics", "draft an email for each clinic", "compose an email to every dentist",
      "Compose an email to every dentist on the list", "Start the email sequence for the clinics",
    ]) expect(outreachRequested(text)).toBe(true);
    expect(outreachRequested("ok go ahead with email", "Shall I email or WhatsApp them?")).toBe(true);
    for (const text of [
      "Find clinics with an email address", "the email addresses of the owners", "their whatsapp numbers", "an email id for each clinic", "collect the contact details",
      "Find clinics with email and phone", "Export the contacts to CSV", "verify the emails", "mujhe list bhejo", "mujhe unke emails bhejo",
    ]) expect(outreachRequested(text)).toBe(false);
    // A negation stays with what it negates: "no website" does not negate the pitch after it.
    expect(outreachRequested("Find salons in Pune with no website and pitch them a website")).toBe(true);
  });

  test("words that only look like a research-only statement do not cancel a request", () => {
    expect(outreachRequested("We are a research-only consultancy. Email the clinics.")).toBe(true);
    expect(outreachRequested("No outreach yet? Start the campaign now.")).toBe(true);
    expect(outreachRequested("Find dentists in Pune, whatsapp them, do not contact anyone twice")).toBe(true);
    expect(outreachRequested("No outreach on email, whatsapp them instead")).toBe(true);
    expect(researchOnlyStated("No outreach yet? Start the campaign now.")).toBe(false);
  });

  test("short confirmations answer an offer", () => {
    for (const text of ["Do it", "go for it", "sure, go ahead with it", "yes do it", "please do"]) expect(outreachRequested(text, "Shall I contact them?")).toBe(true);
    expect(outreachRequested("go for it", "Is your business in Pune?")).toBe(false);
  });

  test("a yes to the assistant offering the owner data is not a yes to outreach", () => {
    expect(outreachRequested("yes", "I found 12 clinics. Shall I send you their contact details?")).toBe(false);
    expect(outreachRequested("yes", "Shall I email you the list?")).toBe(false);
    expect(outreachRequested("yes", "Shall I contact them for you?")).toBe(true);
  });

  test("research only in other words: a wish, a hold, a pause, a condition that means not now", () => {
    for (const text of [
      "Find dentists. Don't reach out.", "No contact with leads please", "Find dentists. I don't want any outreach.", "I don't want you to contact anyone",
      "I do not want you to email them", "Hold off on contacting anyone", "Outreach is not needed. Find 10 gyms.", "This is just for research",
      "Find dentists and email them. Do not contact anyone until I approve.", "Do not contact anyone at all", "Do not contact them under any circumstances",
      "Find 10 gyms. I'll handle the outreach.", "Pause the campaign", "Find gyms, skip the emails",
      "You can't contact anyone yet", "We won't email them", "You shouldn't message them", "You cannot pitch them",
    ]) expect(outreachRequested(text)).toBe(false);
  });

  test("a negation stays with what it negates, so a request beside it still counts", () => {
    for (const text of [
      "Find clinics that have no outreach team and email them", "Do not contact anyone before 9am; email the clinics tomorrow", "Don't wait, just email them",
      "Do not contact anyone in Baner, email the rest", "Skip the clinics without websites and email the rest", "I want you to contact them",
      "We'll handle the outreach through AgentSDR, start with email", "Email them, but don't WhatsApp them", "Don't WhatsApp them, email them instead",
    ]) expect(outreachRequested(text)).toBe(true);
  });

  test("sameMessage spots a repeated message, not a different one", () => {
    expect(sameMessage("Search started for real estate agents in the USA. I'll let you know.", "Search started for real estate agents in the USA, I'll let you know.")).toBe(true);
    expect(sameMessage("Search started for real estate agents.", "I found 12 agents; 9 can be contacted.")).toBe(false);
  });
});

describe("greetings and suggestions", () => {
  test("a greeting or thanks is small talk; anything with a request is not", () => {
    for (const text of ["hey\\", "Hi!", "heyyy", "hello there", "good morning", "thanks!", "thank you", "how are you?", "kaise ho", "👋", "hii bhai"]) {
      expect(isSmallTalk(text)).toBe(true);
    }
    for (const text of ["hi, find dental clinics in Pune", "yes", "ok go ahead", "what can you do", "We sell dental chairs", "contact them"]) {
      expect(isSmallTalk(text)).toBe(false);
    }
  });

  test("conversation titles skip greetings and stray characters", () => {
    expect(threadTitleFrom("hey\\")).toBeNull();
    expect(threadTitleFrom("  Find dental clinics in Pune and contact them. ")).toBe("Find dental clinics in Pune and contact them");
    expect(threadTitleFrom("We service dental chairs and autoclaves within the same week for clinics across Pune and PCMC")).toBe("We service dental chairs and autoclaves within the same…");
    expect(displayThreadTitle("hey\\")).toBe("New conversation");
    expect(displayThreadTitle("Conversation")).toBe("New conversation");
    expect(displayThreadTitle("Use my list")).toBe("Use my list");
  });

  test("suggestions are short, distinct and at most three", () => {
    expect(cleanSuggestions(["Find dental clinics in Pune", "“Upload my list”", "find dental clinics in pune", "", 4, "x".repeat(80), "Show results", "One more"]))
      .toEqual(["Find dental clinics in Pune", "Upload my list", "Show results"]);
    expect(cleanSuggestions("nope")).toEqual([]);
  });
});

describe("actionsProblem", () => {
  const profile = { businessName: "Bright Path Dental Supplies" };
  const ownerCorpus = "We are Bright Path Dental Supplies in Pune. We service dental chairs and autoclaves within the week. Sign as Ravi.";

  test("a greeting does not stop tools: \"test\" or \"hey\" is the model's to read", () => {
    expect(actionsProblem([{ tool: "check_setup", args: {} }], { profile, ownerCorpus: "hey", outreachRequested: false })).toBeNull();
  });

  test("a search that contacts people, or a plan, needs the owner to have asked", () => {
    const contactSearch = [{ tool: "find_leads", args: { what: "dental clinics", where: "Pune", contactAfter: true } }];
    expect(actionsProblem(contactSearch, { profile, ownerCorpus, outreachRequested: false })).toContain("has not asked");
    expect(actionsProblem(contactSearch, { profile, ownerCorpus, outreachRequested: true })).toBeNull();
    expect(actionsProblem([{ tool: "find_leads", args: { what: "dental clinics", where: "Pune" } }], { profile, ownerCorpus, outreachRequested: false })).toBeNull();
    expect(actionsProblem([{ tool: "prepare_outreach", args: { audienceId: "x" } }], { profile, ownerCorpus, outreachRequested: false })).toContain("has not asked");
  });

  test("a save that changes nothing is not refused (the tool answers that nothing was new)", () => {
    expect(actionsProblem([{ tool: "save_business_info", args: {} }], { profile, ownerCorpus, outreachRequested: false })).toBeNull();
    expect(actionsProblem([{ tool: "save_business_info", args: { businessName: "Bright Path Dental Supplies" } }], { profile, ownerCorpus, outreachRequested: false })).toBeNull();
  });

  test("the owner's information is saved, paraphrased or not; invented values are refused", () => {
    expect(actionsProblem([{ tool: "save_business_info", args: { offer: "Same-week servicing of dental chairs and autoclaves", locations: "Pune", senderName: "Ravi" } }], { profile, ownerCorpus, outreachRequested: false })).toBeNull();
    expect(actionsProblem([{ tool: "save_business_info", args: { senderName: "Amit Sharma", website: "brightpath.in" } }], { profile, ownerCorpus, outreachRequested: false })).toContain("senderName, website are not what the owner wrote");
    expect(actionsProblem([{ tool: "save_business_info", args: { offer: "Monthly plan at ₹2,499 with 20% discount" } }], { profile, ownerCorpus, outreachRequested: false })).toContain("offer is not what the owner wrote");
    expect(actionsProblem([{ tool: "save_business_info", args: { notes: "" , language: "en" } }], { profile: { ...profile, notes: "old" }, ownerCorpus, outreachRequested: false })).toBeNull();
  });
});

describe("contacts and links from the chat", () => {
  const owner = "can u do outreach to a people on whatsapp num is 8084794983 tery to sell him. also mail priya@sparkle.example and see https://www.sparklehome.example/team";

  test("a contact the owner typed is accepted, with or without the country code; an invented one is not", () => {
    expect(ungroundedContacts([{ phone: "8084794983" }, { phone: "+91 80847 94983", name: "Lead" }, { email: "Priya@Sparkle.example" }], owner)).toEqual([]);
    expect(ungroundedContacts([{ phone: "+1 415 555 0100" }, { email: "ceo@sparkle.example" }, { linkedinUrl: "https://linkedin.com/in/someone" }], owner))
      .toEqual(["+1 415 555 0100", "ceo@sparkle.example", "https://linkedin.com/in/someone"]);
  });

  test("only links the owner gave are opened", () => {
    expect(urlGiven("https://sparklehome.example/team", owner)).toBe(true);
    expect(urlGiven("sparklehome.example", owner)).toBe(true);
    expect(urlGiven("https://competitor.example", owner)).toBe(false);
    expect(urlGiven("", owner)).toBe(false);
  });

  test("a browser step ends the batch, like a page read; browser_open may open any public page", () => {
    const reply = { message: "Working.", suggestions: [], actions: [
      { tool: "browser_open", args: { url: "https://dir.example/agents" } },
      { tool: "browser_click", args: { n: 3 } },
    ] };
    const { batch, replanAfterRead } = nextAgentBatch(reply);
    expect(batch.actions.map((action) => action.tool)).toEqual(["browser_open"]);
    expect(replanAfterRead).toBe(true);
    expect(actionsProblem([{ tool: "browser_open", args: { url: "https://dir.example/agents" } }], { profile: {}, ownerCorpus: "TOOL web_search: https://dir.example/agents", outreachRequested: false })).toBeNull();
    expect(actionsProblem([{ tool: "browser_open", args: { url: "https://elsewhere.example/" } }], { profile: {}, ownerCorpus: "TOOL web_search: https://dir.example/agents", outreachRequested: false })).toBeNull();
  });

  test("a link is given only for the same site or its subdomain, never a look-alike or a parent", () => {
    const corpus = "TOOL web_search: 1. Acme Realty — https://www.acme-realty.example/agents — Pune agents\nwrite to sales@shop.widgets.example";
    expect(urlGiven("https://acme-realty.example/contact", corpus)).toBe(true);
    expect(urlGiven("https://blog.acme-realty.example/", corpus)).toBe(true);
    expect(urlGiven("https://shop.widgets.example/", corpus)).toBe(true);
    expect(urlGiven("https://widgets.example/", corpus)).toBe(false);
    expect(urlGiven("https://notacme-realty.example/", corpus)).toBe(false);
    expect(urlGiven("https://realty.example/", corpus)).toBe(false);
    expect(urlGiven("https://acme-realty.example.evil.test/", corpus)).toBe(false);
  });

  test("actionsProblem refuses invented contacts; which public page to read is the model's", () => {
    const input = { profile: {}, ownerCorpus: owner, outreachRequested: true };
    expect(actionsProblem([{ tool: "add_contacts", args: { contacts: [{ phone: "8084794983" }] } }], input)).toBeNull();
    expect(actionsProblem([{ tool: "add_contacts", args: { contacts: [{ phone: "9999999999" }] } }], input)).toContain("not in what the owner wrote");
    expect(actionsProblem([{ tool: "read_webpage", args: { url: "https://www.sparklehome.example/team" } }], input)).toBeNull();
    // A directory the model knows of, not given in the chat (the tool itself still refuses private addresses).
    expect(actionsProblem([{ tool: "read_webpage", args: { url: "https://example.org" } }], input)).toBeNull();
  });

  test("a supplied Instagram handle needs no URL, city or other contact identity", () => {
    const prompt = "hey cna u contact dev__ravi_35 via instagrma and try to sell our services";
    const action = { tool: "add_instagram_contacts", args: { usernames: ["dev__ravi_35"], contactAfter: true } };
    const input = { profile: {}, ownerCorpus: prompt, outreachRequested: outreachRequested(prompt) };
    expect(input.outreachRequested).toBe(true);
    expect(actionsProblem([action], input)).toBeNull();
    expect(actionsProblem([{ ...action, args: { ...action.args, usernames: ["dev_ravi_35"] } }], input)).toContain("do not invent or shorten");
    expect(actionsProblem([{ ...action, args: { ...action.args, usernames: ["ravi"] } }], input)).toContain("not an exact Instagram recipient");
  });

  test("saving an Instagram handle is distinct from requesting outreach", () => {
    const input = { profile: {}, ownerCorpus: "Save @dev__ravi_35", outreachRequested: false };
    const action = { tool: "add_instagram_contacts", args: { usernames: ["@dev__ravi_35"], contactAfter: false } };
    expect(actionsProblem([action], input)).toBeNull();
    expect(actionsProblem([{ ...action, args: { ...action.args, contactAfter: true } }], input)).toContain("has not asked");
  });

  test("DM requests and revocations use the same outreach authorization as message requests", () => {
    expect(outreachRequested("DM @dev__ravi_35 on Instagram")).toBe(true);
    expect(outreachRequested("Please send DMs to these Instagram accounts")).toBe(true);
    expect(outreachRequested("Don't DM @dev__ravi_35 yet")).toBe(false);
    expect(outreachRevoked("Don't DM @dev__ravi_35 yet")).toBe(true);
  });
});

describe("groundingCorpus: what the owner wrote and what sources returned", () => {
  const owner = (content: string) => ({ role: "user" as const, content, tool: null, status: null, toolResult: null });
  const searched = (query: string, results: { url: string; title: string | null; snippet: string | null }[], status = "ok") => {
    const summary = results.length
      ? `TinyFish Search for “${query}”: ${results.length} results (candidates; read a page before relying on it).\n${results.map((hit, index) => `${index + 1}. ${hit.title ?? "(no title)"} — ${hit.url}${hit.snippet ? ` — ${hit.snippet}` : ""}`).join("\n")}`
      : `TinyFish Search for “${query}” returned nothing. Try different keywords or another source.`;
    return { role: "tool" as const, tool: "web_search", status, content: summary, toolResult: { summary, data: { query, page: 0, provider: "tinyfish", results } } };
  };
  const ask = "find the email of Acme Dental, Pune and contact them";
  const input = (corpus: string) => ({ profile: {}, ownerCorpus: corpus, outreachRequested: true });
  const addGuess = { tool: "add_contacts", args: { contacts: [{ email: "info@acmedental.in", name: "Acme Dental" }], contactAfter: true } };
  const readGuess = { tool: "read_webpage", args: { url: "https://acmedental.in/contact" } };

  test("a web search's own query grounds nothing: a guessed email or site stays refused after a search for it", () => {
    for (const query of ["info@acmedental.in", "acmedental.in"]) {
      const corpus = groundingCorpus([owner(ask), searched(query, [])]);
      expect(actionsProblem([addGuess], input(corpus))).toContain("not in what the owner wrote");
      expect(urlGiven(readGuess.args.url, corpus)).toBe(false);
    }
    // A search that returned other businesses does not ground the query either.
    const other = groundingCorpus([owner(ask), searched("acmedental.in contact email", [{ url: "https://www.justdial.example/pune/dentists", title: "Dentists in Pune", snippet: "Top 20 dentists" }])]);
    expect(actionsProblem([addGuess], input(other))).toContain("not in what the owner wrote");
    expect(urlGiven(readGuess.args.url, other)).toBe(false);
    expect(actionsProblem([{ tool: "read_webpage", args: { url: "https://justdial.example/pune/dentists" } }], input(other))).toBeNull();
  });

  test("what a search returned grounds its links and contacts", () => {
    const corpus = groundingCorpus([owner(ask), searched("Acme Dental Pune", [{ url: "https://www.acmedental.in/", title: "Acme Dental, Pune", snippet: "Write to info@acmedental.in" }])]);
    expect(actionsProblem([addGuess], input(corpus))).toBeNull();
    expect(actionsProblem([readGuess], input(corpus))).toBeNull();
  });

  test("owner messages, documents and successful page reads count; failed reads and other tools do not", () => {
    const read = (status: string, content: string) => ({ role: "tool" as const, tool: "read_webpage", status, content, toolResult: { summary: content } });
    const corpus = groundingCorpus([
      owner("We sell to clinics in Pune"),
      read("ok", "Page https://clinic.example: call +91 98220 11111"),
      read("error", "Could not open https://guess.example: not found"),
      { role: "tool" as const, tool: "find_leads", status: "ok", content: "Search for “guess.example” started", toolResult: { summary: "Search for “guess.example” started" } },
      { role: "assistant" as const, tool: null, status: null, content: "I will email ceo@guess.example", toolResult: null },
    ], "Price list: ₹2,499 a month");
    expect(corpus).toContain("We sell to clinics in Pune");
    expect(corpus).toContain("+91 98220 11111");
    expect(corpus).toContain("₹2,499");
    expect(corpus).not.toContain("guess.example");
  });

  // Written as tools.server.ts pageResult and browserResult write them: the page's own address is the one the model asked for.
  const pageRead = (url: string, page: { title: string; contacts?: string[]; links?: string[]; text: string }) => {
    const summary = `Read ${url} “${page.title}” via TinyFish (${page.text.length} characters). Contacts on the page: ${page.contacts?.join(", ") || "none"}. Links on the page: ${page.links?.join(" ") || "none"}. Text: ${page.text}`;
    const contacts = (page.contacts ?? []).map((contact) => ({ kind: contact.split(" ")[0], value: contact.split(" ").slice(1).join(" ") }));
    return { role: "tool" as const, tool: "read_webpage", status: "ok", content: summary, toolResult: { summary, data: { url, title: page.title, contacts, links: page.links ?? [] } } };
  };
  const browserPage = (url: string, page: { title: string; elements: string[]; text: string }) => {
    const summary = `Opened a browser.\nPage: ${url} “${page.title}”\nElements: ${page.elements.join(" ") || "none"}\nText: ${page.text}`;
    return { role: "tool" as const, tool: "browser_open", status: "ok", content: summary, toolResult: { summary, data: { url, title: page.title, elements: page.elements.length } } };
  };
  const listedOn = "find the email of Acme Dental, Pune and contact them. They are listed on knowndir.example";
  const addPhoneGuess = { tool: "add_contacts", args: { contacts: [{ phone: "+91 98220 11111", name: "Acme Dental" }], contactAfter: true } };

  test("a page's own address grounds nothing the model put in its query string or fragment", () => {
    const guessed = "https://www.knowndir.example/search?q=info@acmedental.in&phone=+919822011111";
    const read = groundingCorpus([owner(listedOn), pageRead(guessed, {
      title: "Search",
      // A "#main" link resolves to the whole address the page was opened at.
      links: [`${guessed}#main`, "https://www.knowndir.example/about"],
      text: "No listings match your search.",
    })]);
    const opened = groundingCorpus([owner(listedOn), browserPage(`https://knowndir.example/find?email=info@acmedental.in&tel=919822011111#acmedental.in`, {
      title: "Find a business",
      elements: [`[1] link "Skip to content" → https://knowndir.example/find?email=info@acmedental.in&tel=919822011111#main`, `[2] input:search "Search"`],
      text: "Nothing matched.",
    })]);
    // A query ending in punctuation, listed last before the summary's own full stop.
    const punctuated = `https://www.knowndir.example/search?q=info@acmedental.in&tel=+919822011111.)`;
    const trailing = groundingCorpus([owner(listedOn), pageRead(punctuated, { title: "Search", links: [punctuated], text: "No listings." })]);
    for (const corpus of [read, opened, trailing]) {
      expect(actionsProblem([addGuess], input(corpus))).toContain("not in what the owner wrote");
      expect(actionsProblem([addPhoneGuess], input(corpus))).toContain("not in what the owner wrote");
      expect(urlGiven(readGuess.args.url, corpus)).toBe(false);
      expect(corpus).not.toContain("acmedental");
      expect(corpus).not.toContain("9822011111");
      // The page itself, and the site it is on, are still what was read.
      expect(actionsProblem([{ tool: "read_webpage", args: { url: "https://knowndir.example/listings" } }], input(corpus))).toBeNull();
    }
    expect(read).toContain("https://www.knowndir.example/search");
    expect(read).toContain("https://www.knowndir.example/about");
    expect(opened).toContain("Page: https://knowndir.example/find “Find a business”");
  });

  test("a page that only echoes what the model searched for grounds none of it, including after a redirect", () => {
    const echoed = groundingCorpus([owner(listedOn), pageRead("https://www.knowndir.example/search?q=info@acmedental.in&tel=%2B919822011111", {
      title: "Results for info@acmedental.in",
      text: "No listings match info@acmedental.in or +919822011111. Try acmedental.in instead.",
    })]);
    // The model asked for one address and was redirected to another that repeats what it wrote.
    const redirected = { ...pageRead("https://knowndir.example/landing", { title: "You searched acmedental.in", text: "Nothing for info@acmedental.in, 919822011111." }), toolInput: { url: "https://knowndir.example/go?to=acmedental.in&mail=info%40acmedental.in&p=919822011111" } };
    const pathEcho = groundingCorpus([owner(listedOn), pageRead("https://knowndir.example/lookup/info@acmedental.in/919822011111", { title: "Lookup", text: "info@acmedental.in: no record. 919822011111: no record." })]);
    for (const corpus of [echoed, groundingCorpus([owner(listedOn), redirected]), pathEcho]) {
      expect(actionsProblem([addGuess], input(corpus))).toContain("not in what the owner wrote");
      expect(actionsProblem([addPhoneGuess], input(corpus))).toContain("not in what the owner wrote");
      expect(urlGiven(readGuess.args.url, corpus)).toBe(false);
      expect(actionsProblem([{ tool: "read_webpage", args: { url: "https://knowndir.example/listings" } }], input(corpus))).toBeNull();
    }
  });

  test("a guessed phone written with separators in the address's path is taken out of the page that echoes it", () => {
    const corpus = groundingCorpus([owner(listedOn), pageRead("https://knowndir.example/phone/98220-11111", { title: "Lookup", text: "No results for 98220-11111." })]);
    expect(actionsProblem([addPhoneGuess], input(corpus))).toContain("not in what the owner wrote");
  });

  test("what an earlier source gave is not a guess: searching a directory for a domain a search returned keeps the page's contacts", () => {
    const corpus = groundingCorpus([
      owner(ask),
      searched("Acme Dental Pune", [{ url: "https://www.acmedental.in/", title: "Acme Dental, Pune", snippet: "Dental clinic in Pune" }]),
      pageRead("https://knowndir.example/search?q=acmedental.in", { title: "Acme Dental", text: "Acme Dental, Pune — info@acmedental.in — +91 98220 11111" }),
    ]);
    expect(actionsProblem([addGuess], input(corpus))).toBeNull();
    // A domain only the model wrote is still taken out.
    const guessed = groundingCorpus([owner(ask), pageRead("https://knowndir.example/search?q=acmedental.in", { title: "Search", text: "No results for acmedental.in" })]);
    expect(urlGiven(readGuess.args.url, guessed)).toBe(false);
  });

  test("a query naming the page's own site, or plain words, takes nothing from what the page returned", () => {
    const corpus = groundingCorpus([owner(ask), pageRead("https://knowndir.example/search?site=knowndir.example&q=acme+dental", {
      title: "knowndir.example: Acme Dental",
      text: "Acme Dental, Pune — info@acmedental.in — +91 98220 11111 — https://www.acmedental.in/",
    })]);
    expect(actionsProblem([addGuess], input(corpus))).toBeNull();
    expect(actionsProblem([addPhoneGuess], input(corpus))).toBeNull();
    expect(actionsProblem([readGuess], input(corpus))).toBeNull();
    expect(actionsProblem([{ tool: "read_webpage", args: { url: "https://knowndir.example/listings" } }], input(corpus))).toBeNull();
  });

  test("what a page returned still grounds: its text, title, contacts and links, whatever its address", () => {
    const corpus = groundingCorpus([owner(listedOn), pageRead("https://www.knowndir.example/search?q=acme+dental+pune", {
      title: "Acme Dental, Pune",
      contacts: ["email info@acmedental.in"],
      links: ["https://www.acmedental.in/", "https://www.knowndir.example/search?q=acme+dental+pune&page=2"],
      text: "Acme Dental, Koregaon Park, Pune. Call +91 98220 11111.",
    })]);
    expect(actionsProblem([addGuess], input(corpus))).toBeNull();
    expect(actionsProblem([addPhoneGuess], input(corpus))).toBeNull();
    expect(actionsProblem([readGuess], input(corpus))).toBeNull();
    // A link the page lists is the page's, query string included.
    expect(corpus).toContain("https://www.knowndir.example/search?q=acme+dental+pune&page=2");
    const browsed = groundingCorpus([owner(listedOn), browserPage("https://knowndir.example/find?q=dentists", {
      title: "Dentists",
      elements: [`[1] link "Acme Dental" → https://www.acmedental.in/contact`],
      text: "Acme Dental — info@acmedental.in — +91 98220 11111",
    })]);
    expect(actionsProblem([addGuess], input(browsed))).toBeNull();
    expect(actionsProblem([addPhoneGuess], input(browsed))).toBeNull();
    expect(actionsProblem([readGuess], input(browsed))).toBeNull();
  });
});

describe("Autonomous mode: the owner's standing request", () => {
  const owner = (content: string) => ({ role: "user" as const, content, tool: null, toolInput: null, status: null });
  const tool = (name: string, toolInput: Record<string, unknown>) => ({ role: "tool" as const, content: "", tool: name, toolInput, status: "ok" as const });
  test("stands after a plan acted on it, so the next searches still contact what they find", () => {
    const history = [owner("Find dentists in Pune and contact them"), tool("find_leads", { contactAfter: true })];
    expect(pendingOutreachRequest(history)).toBeNull();
    expect(standingOutreachRequestIndex(history)).toBe(0);
  });
  test("ends when the owner later says to stop contacting people", () => {
    expect(outreachRevoked("Stop contacting people, just find leads")).toBe(true);
    expect(outreachRevoked("Find more dentists and contact them")).toBe(false);
    const history = [owner("Find dentists in Pune and contact them"), tool("find_leads", { contactAfter: true }), owner("Stop contacting people for now, just find leads")];
    expect(standingOutreachRequestIndex(history)).toBeNull();
  });
});

describe("searchRequestFor: which owner request a search serves", () => {
  const base = { continuationRequestId: null, latestOwnerId: "m2", outreachRequestId: "m1", outreachPending: true, outreachResearchStopped: false };
  test("a pending outreach request keeps the searches the owner's follow-ups start, so its plans and research stay one request", () => {
    expect(searchRequestFor(base)).toBe("m1");
    expect(searchRequestFor({ ...base, latestOwnerId: "m1" })).toBe("m1");
  });
  test("a request that only stands (Autonomous mode, already acted on) does not swallow a new one: the new message is its own request", () => {
    expect(searchRequestFor({ ...base, outreachPending: false })).toBe("m2");
  });
  test("once the outreach request's research has stopped, a new message starts new research rather than being refused", () => {
    expect(searchRequestFor({ ...base, outreachResearchStopped: true })).toBe("m2");
  });
  test("a continuation serves its own request; with no outreach request the latest message is the request", () => {
    expect(searchRequestFor({ ...base, continuationRequestId: "m0" })).toBe("m0");
    expect(searchRequestFor({ ...base, outreachRequestId: null })).toBe("m2");
    expect(searchRequestFor({ ...base, outreachRequestId: null, latestOwnerId: null })).toBeNull();
  });
});

describe("the same search, asked again (pilot F08)", () => {
  test("arguments that differ only in case, spacing, order or empty values are one search", () => {
    expect(searchArgsKey("find_leads", { what: "Real estate  agencies", where: "Pune", maxResults: 50 }))
      .toBe(searchArgsKey("find_leads", { maxResults: 50, where: " pune ", what: "real estate agencies", language: "" }));
  });

  test("other words, another place, another tool or another limit are another search", () => {
    const base = searchArgsKey("find_leads", { what: "real estate agencies", where: "Pune" });
    expect(searchArgsKey("find_leads", { what: "real estate agents", where: "Pune" })).not.toBe(base);
    expect(searchArgsKey("find_leads", { what: "real estate agencies", where: "Mumbai" })).not.toBe(base);
    expect(searchArgsKey("find_customers_on_web", { what: "real estate agencies", where: "Pune" })).not.toBe(base);
    expect(searchArgsKey("find_leads", { what: "real estate agencies", where: "Pune", maxResults: 100 })).not.toBe(base);
  });
});
