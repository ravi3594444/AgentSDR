import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { defaultFeatureState, type FeatureState } from "@/lib/features/catalog";
import { coerceToolArguments, SCHEMA_CHANNELS, SCHEMA_EXISTING_FROM, SCHEMA_PERIODS, SCHEMA_REPORT_SCOPES, SCHEMA_ACTION_KINDS, SCHEMA_SOCIAL_PLATFORMS, SCHEMA_TASK_OPS, SCHEMA_VISUAL_OPS, TOOL_SCHEMAS, withoutProperties, type ToolInputSchema } from "./toolSchemas";

// The first import of tools.server loads most of the app.
setDefaultTimeout(60_000);

const ALL_ON = (v2: boolean): FeatureState => ({ ...Object.fromEntries(Object.keys(defaultFeatureState()).map((key) => [key, true])), research_agent_v2: v2 } as FeatureState);

describe("every assistant tool has a typed contract", () => {
  test("a tool without a schema fails here (add it to toolSchemas.ts or give the tool a schema)", async () => {
    const { TOOL_NAMES, toolSchema } = await import("./tools.server");
    const missing = TOOL_NAMES.filter((name) => !toolSchema(name, false) || !toolSchema(name, true));
    expect(missing).toEqual([]);
    expect(Object.keys(TOOL_SCHEMAS).filter((name) => !TOOL_NAMES.includes(name))).toEqual([]);
  });

  test("each schema names exactly arguments its tool's text describes, typed, and v2 leaves out the older follow-ups", async () => {
    const { toolDescriptionsFor } = await import("./tools.server");
    for (const v2 of [false, true]) {
      for (const tool of toolDescriptionsFor(ALL_ON(v2))) {
        const schema = tool.inputSchema!;
        expect(schema.type).toBe("object");
        for (const [key, property] of Object.entries(schema.properties)) {
          expect({ tool: tool.name, key, described: new RegExp(`\\b${key}\\b`).test(tool.arguments) }).toEqual({ tool: tool.name, key, described: true });
          expect({ tool: tool.name, key, typed: property.type !== undefined || property.enum !== undefined }).toEqual({ tool: tool.name, key, typed: true });
        }
        for (const key of schema.required ?? []) expect(Object.keys(schema.properties)).toContain(key);
        if (v2) for (const key of ["contactAfter", "sameRequest"]) expect({ tool: tool.name, key, offered: key in schema.properties }).toEqual({ tool: tool.name, key, offered: false });
      }
    }
  });

  test("the fixed sets match the code that checks them", async () => {
    const [{ ACTION_KINDS, TASK_OPS, VISUAL_OPS }, { PERIOD_KINDS, RESULTS_SCOPE_KINDS }, { EXISTING_LEADS_FROM }, { BRIGHTDATA_PLATFORMS }, { PROFILE_CHANNELS }] = await Promise.all([
      import("@/lib/browser/connected/contract"), import("./results"), import("./existingLeads"), import("@/lib/brightdata/catalog"), import("./profile"),
    ]);
    expect([...SCHEMA_TASK_OPS]).toEqual([...TASK_OPS]);
    expect([...SCHEMA_VISUAL_OPS]).toEqual([...VISUAL_OPS]);
    expect([...SCHEMA_ACTION_KINDS]).toEqual([...ACTION_KINDS]);
    expect([...SCHEMA_PERIODS]).toEqual([...PERIOD_KINDS]);
    expect([...SCHEMA_REPORT_SCOPES].sort()).toEqual([...RESULTS_SCOPE_KINDS].sort());
    expect([...SCHEMA_EXISTING_FROM]).toEqual([...EXISTING_LEADS_FROM]);
    expect([...SCHEMA_SOCIAL_PLATFORMS].sort()).toEqual([...BRIGHTDATA_PLATFORMS].sort());
    expect([...SCHEMA_CHANNELS]).toEqual([...PROFILE_CHANNELS]);
  });
});

describe("arguments are read by the schema, in one place", () => {
  const brief = TOOL_SCHEMAS.set_brief!;

  test("booleans and numbers sent as text become booleans and numbers", () => {
    const { args, problems } = coerceToolArguments(brief, { goal: "Find clinics", contact: "True", newRequest: "false", leadTarget: "25", spendCapUsd: "0.5", timeLimitMinutes: " 60 " });
    expect(problems).toEqual([]);
    expect(args).toEqual({ goal: "Find clinics", contact: true, newRequest: false, leadTarget: 25, spendCapUsd: 0.5, timeLimitMinutes: 60 });
  });

  test("a list or object sent as JSON text is that list or object; one value where a list is expected is a list of one", () => {
    expect(coerceToolArguments(brief, { goal: "g", channels: "[\"email\",\"WhatsApp\"]" }).args.channels).toEqual(["email", "whatsapp"]);
    expect(coerceToolArguments(brief, { goal: "g", channels: "email" }).args.channels).toEqual(["email"]);
    expect(coerceToolArguments(TOOL_SCHEMAS.browser_task!, { ownerWords: "add them", goal: "add", actions: "[\"Interact\",\"open_tabs\"]" }).args.actions).toEqual(["interact", "open_tabs"]);
    const contacts = coerceToolArguments(TOOL_SCHEMAS.add_contacts!, { contacts: "{\"name\":\"Asha\",\"phone\":919876543210}" });
    expect(contacts).toEqual({ args: { contacts: [{ name: "Asha", phone: "919876543210" }] }, problems: [] });
    expect(coerceToolArguments(TOOL_SCHEMAS.treg_call!, { endpointId: "treg.x", query: "{\"username\":\"a\"}" }).args.query).toEqual({ username: "a" });
  });

  test("null and empty values: null stays (the tools read it as left out), empty is left out where text is not taken", () => {
    expect(coerceToolArguments(brief, { goal: "g", leadTarget: "null", channels: null, spendCapUsd: "" }).args).toEqual({ goal: "g", leadTarget: null, channels: null, spendCapUsd: null });
    expect(coerceToolArguments(TOOL_SCHEMAS.find_leads!, { what: "salons", where: "Pune", maxResults: "" }).args).toEqual({ what: "salons", where: "Pune" });
  });

  test("whatever still does not fit is refused, never guessed", () => {
    expect(coerceToolArguments(brief, { goal: "g", newRequest: "maybe" }).problems).toEqual(["newRequest must be true or false"]);
    expect(coerceToolArguments(brief, { goal: "g", leadTarget: 12.5 }).problems).toEqual(["leadTarget must be a whole number or null"]);
    expect(coerceToolArguments(brief, { goal: "g", channels: ["email", "fax"] }).problems).toEqual(["channels[1] must be one of email, whatsapp, linkedin, instagram, browser"]);
    expect(coerceToolArguments(TOOL_SCHEMAS.report!, { period: "last_week" }).problems[0]).toContain("period must be one of today");
    expect(coerceToolArguments(TOOL_SCHEMAS.treg_call!, { endpointId: "treg.x", query: "domain=acme.example" }).problems).toEqual(["query must be an object"]);
    expect(coerceToolArguments(TOOL_SCHEMAS.add_contacts!, { contacts: ["+91 98765 43210"] }).problems).toEqual(["contacts[0] must be an object"]);
    expect(coerceToolArguments(brief, { contact: true }).problems[0]).toStartWith("goal is required");
    expect(coerceToolArguments(TOOL_SCHEMAS.set_lead_fit!, { personId: "x", fit: "match", reason: "  " }).problems[0]).toStartWith("reason is required");
  });

  test("a fixed set matches regardless of case; text is never parsed as JSON; unnamed arguments are left alone", () => {
    expect(coerceToolArguments(TOOL_SCHEMAS.browser_tab_act!, { tabId: "3", n: "2", action: "Fill", value: 42 }).args).toEqual({ tabId: "3", n: 2, action: "fill", value: 42 });
    expect(coerceToolArguments(TOOL_SCHEMAS.set_lead_fit!, { personId: "p", fit: "match", reason: "[1] says so", quote: "{not json" }).args.reason).toBe("[1] says so");
    expect(coerceToolArguments(TOOL_SCHEMAS.save_business_info!, { locations: "[\"Pune\",\"PCMC\"]", notes: "[draft]" }).args).toEqual({ locations: ["Pune", "PCMC"], notes: "[draft]" });
    expect(coerceToolArguments(null, { anything: "1" })).toEqual({ args: { anything: "1" }, problems: [] });
  });

  test("withoutProperties drops arguments and their required entries", () => {
    const schema: ToolInputSchema = { type: "object", properties: { a: { type: "string" }, b: { type: "boolean" } }, required: ["a", "b"] };
    expect(withoutProperties(schema, ["b"])).toEqual({ type: "object", properties: { a: { type: "string" } }, required: ["a"] });
    expect(withoutProperties(schema, ["c"])).toBe(schema);
  });
});

describe("runTool refuses a mistyped argument as the model's to correct, before the tool runs", () => {
  test("refused, hidden from the owner, with what to fix", async () => {
    const { runTool } = await import("./tools.server");
    const context = { threadId: "00000000-0000-4000-8000-000000000000", userId: null, ownerText: "find clinics", v2: true };
    const page = await runTool("web_search", { query: "dental clinics Pune", page: "eleven" }, context);
    expect(page).toEqual({ ok: false, refused: true, summary: "Not run: page must be a whole number." });
    const act = await runTool("browser_tab_act", { tab: 1, n: 2, action: "submit" }, context);
    expect(act.refused).toBe(true);
    expect(act.summary).toContain("action must be one of click, fill, select, check, uncheck, press");
  });
});
