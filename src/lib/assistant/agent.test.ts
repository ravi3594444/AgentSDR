import { describe, expect, test } from "bun:test";
import { agentReplySchema, MAX_ACTIONS_PER_STEP, outreachIntent, ownerRequestProblem, parseAgentReply, transcriptText, unbackedClaim, type TranscriptMessage } from "./agent";

const TOOLS = ["find_leads", "save_business_info", "prepare_outreach"];

describe("parseAgentReply", () => {
  test("parses actions whose arguments are a JSON string", () => {
    const reply = parseAgentReply(JSON.stringify({
      message: "Searching now.",
      actions: [{ tool: "find_leads", arguments: "{\"what\":\"dentists\",\"where\":\"Pune\"}" }],
    }), TOOLS);
    expect(reply).toEqual({ message: "Searching now.", actions: [{ tool: "find_leads", args: { what: "dentists", where: "Pune" } }] });
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
    expect(parseAgentReply(JSON.stringify({ message: "", actions: [] }), TOOLS, { allowEmpty: true })).toEqual({ message: "", actions: [] });
  });

  test("the schema lists exactly the tools and requires every property (strict mode)", () => {
    const schema = agentReplySchema(TOOLS);
    expect(schema.required).toEqual(["message", "actions"]);
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

describe("ownerRequestProblem", () => {
  const owner = "We run Bright Path. Find dental clinics in Pune and email them. liek via campagion ai agent should able ot pitch the coutemr";

  test("a quote of the owner's request for outreach passes, typos included", () => {
    expect(ownerRequestProblem("email them", owner)).toBeNull();
    expect(ownerRequestProblem("via campagion ai agent should able ot pitch", owner)).toBeNull();
  });

  test("no quote, a quote the owner did not write, or words that do not ask for outreach are refused", () => {
    expect(ownerRequestProblem(undefined, owner)).toContain("required");
    expect(ownerRequestProblem("please contact everyone", owner)).toContain("exact words");
    expect(ownerRequestProblem("We run Bright Path", owner)).toContain("do not ask for outreach");
  });

  test("outreachIntent tolerates typos but not unrelated words", () => {
    expect(outreachIntent("contcat them")).toBe(true);
    expect(outreachIntent("whatsap them")).toBe(true);
    expect(outreachIntent("our prices are fair")).toBe(false);
  });
});
