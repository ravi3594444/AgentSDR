import { describe, expect, test } from "bun:test";
import { actionsProblem, agentReplySchema, cleanSuggestions, displayThreadTitle, isSmallTalk, MAX_ACTIONS_PER_REPLY, MAX_ACTIONS_PER_STEP, nextAgentBatch, outreachIntent, outreachRequested, outreachRequestProblem, parseAgentReply, pendingOutreachRequest, sameMessage, standingOutreachRequestIndex, outreachRevoked, threadTitleFrom, transcriptText, unbackedClaim, ungroundedContacts, urlGiven, type AgentReply, type TranscriptMessage } from "./agent";

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
    reply.actions.push({ tool: "save_business_info", args: { businessName: "Bright Path" } });
    const queued = nextAgentBatch(reply).pending!;
    const batch = nextAgentBatch(queued).batch;
    expect(actionsProblem(batch.actions, { smallTalk: false, profile: { businessName: "Bright Path" }, ownerCorpus: "We are Bright Path", outreachRequested: true })).toContain("change nothing");
  });
});

describe("unbackedClaim", () => {
  test("a message that says something was done needs a tool that succeeded this turn", () => {
    expect(unbackedClaim("I've saved your business details.", [], false)).toContain("no tool has succeeded");
    expect(unbackedClaim("I have found 40 dentists.", [], false)).toContain("no tool has succeeded");
    expect(unbackedClaim("I've saved your business details.", ["save_business_info"], false)).toBeNull();
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
        smallTalk: isSmallTalk(prompt), profile: { businessName: "Our Agency", offer: "AI automations", locations: "Pune" },
        ownerCorpus: prompt, outreachRequested: outreachRequested(prompt),
      })).toBeNull();
    }
    expect(urlGiven("https://22nd-x-ai-studio.vercel.app", withUrl)).toBe(true);
    expect(actionsProblem([{ tool: "read_webpage", args: { url: "https://22nd-x-ai-studio.vercel.app" } }], {
      smallTalk: false, profile: {}, ownerCorpus: withUrl, outreachRequested: true,
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

  test("no tools on a greeting", () => {
    expect(actionsProblem([{ tool: "check_setup", args: {} }], { smallTalk: true, profile, ownerCorpus: "hey", outreachRequested: false })).toContain("greeted");
    expect(actionsProblem([], { smallTalk: true, profile, ownerCorpus: "hey", outreachRequested: false })).toBeNull();
  });

  test("a search that contacts people, or a plan, needs the owner to have asked", () => {
    const contactSearch = [{ tool: "find_leads", args: { what: "dental clinics", where: "Pune", contactAfter: true } }];
    expect(actionsProblem(contactSearch, { smallTalk: false, profile, ownerCorpus, outreachRequested: false })).toContain("has not asked");
    expect(actionsProblem(contactSearch, { smallTalk: false, profile, ownerCorpus, outreachRequested: true })).toBeNull();
    expect(actionsProblem([{ tool: "find_leads", args: { what: "dental clinics", where: "Pune" } }], { smallTalk: false, profile, ownerCorpus, outreachRequested: false })).toBeNull();
    expect(actionsProblem([{ tool: "prepare_outreach", args: { audienceId: "x" } }], { smallTalk: false, profile, ownerCorpus, outreachRequested: false })).toContain("has not asked");
  });

  test("a save that changes nothing is refused", () => {
    expect(actionsProblem([{ tool: "save_business_info", args: {} }], { smallTalk: false, profile, ownerCorpus, outreachRequested: false })).toContain("change nothing");
    expect(actionsProblem([{ tool: "save_business_info", args: { businessName: "Bright Path Dental Supplies" } }], { smallTalk: false, profile, ownerCorpus, outreachRequested: false })).toContain("change nothing");
  });

  test("the owner's information is saved, paraphrased or not; invented values are refused", () => {
    expect(actionsProblem([{ tool: "save_business_info", args: { offer: "Same-week servicing of dental chairs and autoclaves", locations: "Pune", senderName: "Ravi" } }], { smallTalk: false, profile, ownerCorpus, outreachRequested: false })).toBeNull();
    expect(actionsProblem([{ tool: "save_business_info", args: { senderName: "Amit Sharma", website: "brightpath.in" } }], { smallTalk: false, profile, ownerCorpus, outreachRequested: false })).toContain("senderName, website are not what the owner wrote");
    expect(actionsProblem([{ tool: "save_business_info", args: { offer: "Monthly plan at ₹2,499 with 20% discount" } }], { smallTalk: false, profile, ownerCorpus, outreachRequested: false })).toContain("offer is not what the owner wrote");
    expect(actionsProblem([{ tool: "save_business_info", args: { notes: "" , language: "en" } }], { smallTalk: false, profile: { ...profile, notes: "old" }, ownerCorpus, outreachRequested: false })).toBeNull();
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

  test("actionsProblem refuses invented contacts and links nobody gave", () => {
    const input = { smallTalk: false, profile: {}, ownerCorpus: owner, outreachRequested: true };
    expect(actionsProblem([{ tool: "add_contacts", args: { contacts: [{ phone: "8084794983" }] } }], input)).toBeNull();
    expect(actionsProblem([{ tool: "add_contacts", args: { contacts: [{ phone: "9999999999" }] } }], input)).toContain("not in what the owner wrote");
    expect(actionsProblem([{ tool: "read_webpage", args: { url: "https://www.sparklehome.example/team" } }], input)).toBeNull();
    expect(actionsProblem([{ tool: "read_webpage", args: { url: "https://example.org" } }], input)).toContain("only links the owner gave");
    expect(actionsProblem([{ tool: "read_webpage", args: { url: "https://example.org" } }], input)).toContain("web_search");
  });

  test("a supplied Instagram handle needs no URL, city or other contact identity", () => {
    const prompt = "hey cna u contact dev__ravi_35 via instagrma and try to sell our services";
    const action = { tool: "add_instagram_contacts", args: { usernames: ["dev__ravi_35"], contactAfter: true } };
    const input = { smallTalk: false, profile: {}, ownerCorpus: prompt, outreachRequested: outreachRequested(prompt) };
    expect(input.outreachRequested).toBe(true);
    expect(actionsProblem([action], input)).toBeNull();
    expect(actionsProblem([{ ...action, args: { ...action.args, usernames: ["dev_ravi_35"] } }], input)).toContain("do not invent or shorten");
    expect(actionsProblem([{ ...action, args: { ...action.args, usernames: ["ravi"] } }], input)).toContain("not an exact Instagram recipient");
  });

  test("saving an Instagram handle is distinct from requesting outreach", () => {
    const input = { smallTalk: false, profile: {}, ownerCorpus: "Save @dev__ravi_35", outreachRequested: false };
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
