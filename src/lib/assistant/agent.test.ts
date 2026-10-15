import { describe, expect, test } from "bun:test";
import { actionsProblem, agentReplySchema, cleanSuggestions, displayThreadTitle, isSmallTalk, MAX_ACTIONS_PER_STEP, outreachIntent, outreachRequested, outreachRequestProblem, parseAgentReply, pendingOutreachRequest, sameMessage, threadTitleFrom, transcriptText, unbackedClaim, type TranscriptMessage } from "./agent";

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
  });

  test("rejects unknown tools, bad JSON, arrays and too many actions with a fixable reason", () => {
    expect(() => parseAgentReply("not json", TOOLS)).toThrow("JSON object only");
    expect(() => parseAgentReply(JSON.stringify({ message: "x", actions: [{ tool: "send_everything", arguments: "{}" }] }), TOOLS)).toThrow("does not exist");
    expect(() => parseAgentReply(JSON.stringify({ message: "x", actions: [{ tool: "find_leads", arguments: "{oops" }] }), TOOLS)).toThrow("JSON object written as a string");
    expect(() => parseAgentReply(JSON.stringify({ message: "x", actions: [{ tool: "find_leads", arguments: "[1]" }] }), TOOLS)).toThrow("must be a JSON object");
    const many = Array.from({ length: MAX_ACTIONS_PER_STEP + 1 }, () => ({ tool: "find_leads", arguments: "{}" }));
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
