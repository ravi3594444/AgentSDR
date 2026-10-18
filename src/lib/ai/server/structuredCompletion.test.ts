import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { completeStructured, isStrictJsonSchema, type StructuredCompletionRuntime } from "./structuredCompletion";
import { actionsProblem, agentReplySchema, nextAgentBatch, outreachRequested, parseAgentReply, type AgentReply } from "@/lib/assistant/agent";
import { parseWriterReply, writerReplyInstructions, WRITER_REPLY_SCHEMAS } from "@/lib/assistant/writerReply";

type Reply = { toolArgs?: string; content?: string; throws?: Error; error?: unknown; finish?: string };

/** A runtime whose client answers each call from the scripted list, in order. */
function scripted(replies: Reply[], schemaName = "submit", providerKey: "openrouter" | "aimlapi" = "openrouter") {
  const requests: unknown[] = [];
  const runtime: StructuredCompletionRuntime = async () => ({
    providerKey,
    selection: { provider: "minimax", modelId: "minimax/minimax-m3" },
    routing: { provider: { only: ["minimax"] } },
    structuredOutput: "tool_call",
    supportsPlugins: true,
    client: { chat: { completions: { create: async (request: never) => {
      requests.push(request);
      const reply = replies.shift();
      if (!reply) throw new Error("scripted client ran out of replies");
      if (reply.throws) throw reply.throws;
      if (reply.error !== undefined) return { error: reply.error };
      return {
        choices: [{ finish_reason: reply.finish ?? "tool_calls", message: {
          content: reply.content ?? null,
          tool_calls: reply.toolArgs === undefined
            ? []
            : [{ type: "function", function: { name: schemaName, arguments: reply.toolArgs } }],
        } }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      };
    } } } },
  });
  return { runtime, requests };
}

const input = {
  timeoutMs: 1_000,
  systemPrompt: "Classify.",
  userPrompt: "Hello",
  maxOutputTokens: 100,
  jsonSchema: { type: "object", required: ["category"], properties: { category: { type: "string" } } },
  schemaName: "submit",
};
const noSleep = async () => {};

describe("completeStructured", () => {
  test("asks for the answer as a tool call, never as a response_format", async () => {
    const { runtime, requests } = scripted([{ toolArgs: '{"category":"a"}' }]);
    const result = await completeStructured(input, { runtime, sleep: noSleep });
    const request = requests[0] as Record<string, unknown>;
    assert.equal(request.response_format, undefined);
    assert.equal(request.tool_choice, "auto");
    assert.equal((request.tools as Array<{ function: { name: string } }>)[0].function.name, "submit");
    assert.equal(result.text, '{"category":"a"}');
    assert.equal(result.attempts, 1);
    assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 5 });
  });

  test("retries when the model answers in prose instead of calling the tool", async () => {
    const { runtime } = scripted([{ content: "Sure! It is category a." }, { toolArgs: '{"category":"a"}' }]);
    const result = await completeStructured(input, { runtime, sleep: noSleep });
    assert.equal(result.attempts, 2);
  });

  test("retries arguments that are not a JSON object", async () => {
    const { runtime } = scripted([{ toolArgs: "category: a" }, { toolArgs: "[1]" }, { toolArgs: '{"category":"a"}' }]);
    const result = await completeStructured(input, { runtime, sleep: noSleep });
    assert.equal(result.attempts, 3);
  });

  test("retries a call the caller's accept rejects, and reports the last rejection", async () => {
    const { runtime } = scripted([{ toolArgs: '{"category":"z"}' }, { toolArgs: '{"category":"a"}' }]);
    const accept = (text: string) => {
      if (JSON.parse(text).category !== "a") throw new Error("category z is not in the taxonomy");
    };
    const first = scripted([{ toolArgs: '{"category":"z"}' }, { toolArgs: '{"category":"a"}' }]);
    const result = await completeStructured({ ...input, accept }, { runtime: first.runtime, sleep: noSleep });
    assert.equal(result.attempts, 2);
    // The retry is told why the first answer was rejected, and shown it.
    const userMessage = (request: unknown) => ((request as { messages: Array<{ role: string; content: string }> }).messages.find((m) => m.role === "user")!.content);
    assert.equal(userMessage(first.requests[0]), "Hello");
    assert.match(userMessage(first.requests[1]), /^Hello\n\nYour previous answer was rejected: category z is not in the taxonomy/);
    assert.match(userMessage(first.requests[1]), /\{"category":"z"\}/);
    void runtime;

    const exhausted = scripted([{ toolArgs: '{"category":"z"}' }, { toolArgs: '{"category":"z"}' }]);
    await assert.rejects(
      completeStructured({ ...input, accept, maxAttempts: 2 }, { runtime: exhausted.runtime, sleep: noSleep }),
      { message: "submit failed after 2 attempts: category z is not in the taxonomy" },
    );
  });

  test("retries a transient transport failure but not a routing failure", async () => {
    const transient = scripted([{ throws: Object.assign(new Error("overloaded"), { status: 503 }) }, { toolArgs: '{"category":"a"}' }]);
    assert.equal((await completeStructured(input, { runtime: transient.runtime, sleep: noSleep })).attempts, 2);

    const routing = scripted([{ throws: Object.assign(new Error("404 No endpoints found"), { status: 404 }) }, { toolArgs: '{"category":"a"}' }]);
    await assert.rejects(
      completeStructured(input, { runtime: routing.runtime, sleep: noSleep }),
      { message: "404 No endpoints found" },
    );
    assert.equal(routing.requests.length, 1);
  });

  test("surfaces an in-body provider error instead of crashing on missing choices", async () => {
    const { runtime, requests } = scripted([{ error: { code: 404, message: "Provider returned error" } }]);
    await assert.rejects(
      completeStructured(input, { runtime, sleep: noSleep }),
      { message: "OpenRouter returned no submit call: 404 Provider returned error" },
    );
    assert.equal(requests.length, 1);
  });
});

describe("completeStructured output budget", () => {
  test("doubles max_tokens after a length finish and reports the budget when exhausted", async () => {
    const requests: Array<Record<string, unknown>> = [];
    let calls = 0;
    const runtime: StructuredCompletionRuntime = async () => ({
      providerKey: "openrouter",
      selection: { provider: "minimax", modelId: "minimax/minimax-m3" },
      routing: {},
      structuredOutput: "tool_call",
      supportsPlugins: true,
      client: { chat: { completions: { create: async (request: never) => {
        requests.push(request as Record<string, unknown>);
        calls += 1;
        if (calls < 3) return { choices: [{ finish_reason: "length", message: { content: "", tool_calls: [] } }] };
        return { choices: [{ finish_reason: "tool_calls", message: { tool_calls: [{ type: "function", function: { name: "submit", arguments: '{"category":"a"}' } }] } }] };
      } } } },
    });
    const result = await completeStructured({ ...input, maxOutputTokens: 800 }, { runtime, sleep: noSleep });
    assert.equal(result.attempts, 3);
    assert.deepEqual(requests.map((request) => request.max_tokens), [800, 1600, 3200]);

    calls = 0;
    await assert.rejects(
      completeStructured({ ...input, maxOutputTokens: 800, maxAttempts: 2 }, { runtime, sleep: noSleep }),
      { message: "submit failed after 2 attempts: The model ran out of output tokens (1600) before calling submit" },
    );
  });
});

/** An AI/ML API runtime: JSON-schema answers in the message content, no routing, no plugins. */
function jsonSchemaRuntime(replies: Array<{ content?: string; finish?: string; refusal?: string }>) {
  const requests: Array<Record<string, unknown>> = [];
  const runtime: StructuredCompletionRuntime = async () => ({
    providerKey: "aimlapi",
    selection: { provider: "aimlapi", modelId: "openai/gpt-4o-mini" },
    routing: {},
    structuredOutput: "json_schema",
    supportsPlugins: false,
    client: { chat: { completions: { create: async (request: never) => {
      requests.push(request as Record<string, unknown>);
      const reply = replies.shift();
      if (!reply) throw new Error("scripted client ran out of replies");
      return {
        choices: [{ finish_reason: reply.finish ?? "stop", message: { content: reply.content ?? null, refusal: reply.refusal ?? null } }],
        usage: { prompt_tokens: 7, completion_tokens: 3 },
      };
    } } } },
  });
  return { runtime, requests };
}

describe("completeStructured with AI/ML API (JSON schema)", () => {
  const strictInput = {
    ...input,
    jsonSchema: { type: "object", additionalProperties: false, required: ["category"], properties: { category: { type: "string" } } },
  };

  test("asks for strict JSON schema output, with no tools, routing or plugins", async () => {
    const { runtime, requests } = jsonSchemaRuntime([{ content: '{"category":"a"}' }]);
    const result = await completeStructured(strictInput, { runtime, sleep: noSleep });
    const request = requests[0];
    assert.deepEqual(request.response_format, {
      type: "json_schema",
      json_schema: { name: "submit", strict: true, schema: strictInput.jsonSchema },
    });
    assert.equal(request.tools, undefined);
    assert.equal(request.tool_choice, undefined);
    assert.equal(request.provider, undefined);
    assert.equal(request.model, "openai/gpt-4o-mini");
    assert.equal(result.text, '{"category":"a"}');
    assert.equal(result.provider, "aimlapi");
    assert.deepEqual(result.usage, { inputTokens: 7, outputTokens: 3 });
  });

  test("sends a schema that is not strict-compatible as non-strict", async () => {
    const { runtime, requests } = jsonSchemaRuntime([{ content: '{"category":"a"}' }]);
    await completeStructured(input, { runtime, sleep: noSleep });
    assert.equal((requests[0].response_format as { json_schema: { strict: boolean } }).json_schema.strict, false);
  });

  test("unwraps a fenced answer and retries prose, refusals and rejected answers", async () => {
    const { runtime } = jsonSchemaRuntime([
      { content: "Sure, it is a." },
      { content: "", refusal: "I cannot help with that" },
      { content: '{"category":"wrong"}' },
      { content: '```json\n{"category":"a"}\n```' },
    ]);
    const result = await completeStructured({
      ...strictInput,
      maxAttempts: 4,
      accept: (text) => { if (JSON.parse(text).category !== "a") throw new Error("category must be a"); },
    }, { runtime, sleep: noSleep });
    assert.equal(result.attempts, 4);
    assert.equal(result.text, '{"category":"a"}');
  });

  test("doubles the token budget when a JSON answer is cut off", async () => {
    const { runtime, requests } = jsonSchemaRuntime([{ content: '{"categ', finish: "length" }, { content: '{"category":"a"}' }]);
    const result = await completeStructured({ ...strictInput, maxOutputTokens: 300 }, { runtime, sleep: noSleep });
    assert.equal(result.attempts, 2);
    assert.deepEqual(requests.map((request) => request.max_completion_tokens), [300, 600]);
  });

  test("refuses web-search plugins instead of answering from memory", async () => {
    const { runtime, requests } = jsonSchemaRuntime([{ content: '{"category":"a"}' }]);
    await assert.rejects(
      completeStructured({ ...strictInput, plugins: [{ id: "web" }] }, { runtime, sleep: noSleep }),
      /Web search runs through OpenRouter/,
    );
    assert.equal(requests.length, 0);
  });
});

describe("assistant completion recovery", () => {
  const tools = ["find_leads", "read_webpage"];
  const plainPrompt = "hey find leads for our agency find and reach otu them in every ay possible insta email linked ai whastapp find leads to sell our ai aautomations any locatiosn i ned leads that si s liek active";
  const websitePrompt = "hey find leads for our agency first visit our site 22nd-x-ai-studio.vercel.app find and reach otu them in every ay possible insta email linked ai whastapp find leads to sell our ai aautomations";

  for (const mode of ["tool_call", "json_schema"] as const) {
    for (const prompt of [plainPrompt, websitePrompt]) {
      const websiteFirst = prompt === websitePrompt;
      test(`${mode}: accepts a larger plan ${websiteFirst ? "with a webpage read" : "without a URL"} on the first attempt`, async () => {
        const actions = Array.from({ length: 9 }, (_, index) => ({ tool: "find_leads", arguments: JSON.stringify({ what: "dental clinics", where: `City ${index}`, contactAfter: true }) }));
        if (websiteFirst) actions.unshift({ tool: "read_webpage", arguments: JSON.stringify({ url: "https://22nd-x-ai-studio.vercel.app" }) });
        const text = JSON.stringify({ message: "Searches queued.", actions, suggestions: [] });
        const { runtime, requests } = mode === "tool_call"
          ? scripted([{ toolArgs: text }], "assistant_reply")
          : jsonSchemaRuntime([{ content: text }]);
        let accepted: AgentReply | undefined;
        const result = await completeStructured({
          ...input, schemaName: "assistant_reply", jsonSchema: agentReplySchema(tools), userPrompt: prompt,
          accept: (text) => {
            accepted = parseAgentReply(text, tools);
            const staged = nextAgentBatch(accepted);
            const problem = actionsProblem(staged.batch.actions, { smallTalk: false, profile: {}, ownerCorpus: prompt, outreachRequested: outreachRequested(prompt) });
            if (problem) throw new Error(problem);
          },
        }, { runtime, sleep: noSleep });
        assert.equal(result.attempts, 1);
        assert.equal(requests.length, 1);
        assert.ok(accepted);
        const staged = nextAgentBatch(accepted);
        assert.equal(staged.batch.message, "");
        if (websiteFirst) {
          assert.equal(staged.batch.actions.length, 1);
          assert.equal(staged.replanAfterRead, true);
          assert.equal(staged.pending, null);
        } else {
          assert.equal(staged.batch.actions.length, 8);
          assert.equal(staged.pending?.actions.length, 1);
          assert.deepEqual([...staged.batch.actions, ...staged.pending!.actions], accepted.actions);
        }
      });
    }
  }

  test("a missing actions field gets a concrete repair instruction and retains the owner's plain prompt", async () => {
    const valid = { message: "Searching now.", actions: [{ tool: "find_leads", arguments: '{"what":"dentists","where":"Pune"}' }], suggestions: [] };
    const { runtime, requests } = scripted([{ toolArgs: '{"message":"Searching now."}' }, { toolArgs: JSON.stringify(valid) }], "assistant_reply");
    const result = await completeStructured({
      ...input, schemaName: "assistant_reply", jsonSchema: agentReplySchema(tools), userPrompt: plainPrompt,
      accept: (text) => { parseAgentReply(text, tools); },
    }, { runtime, sleep: noSleep });
    assert.equal(result.attempts, 2);
    const retry = requests[1] as { messages: Array<{ role: string; content: string }> };
    const repair = retry.messages.find((message) => message.role === "user")!.content;
    assert.ok(repair.startsWith(plainPrompt));
    assert.ok(repair.includes('"actions":[{"tool":"TOOL_NAME","arguments":"{}"}]'));
    assert.ok(repair.includes("do not omit actions"));
  });
});

describe("outreach response recovery through the provider transport", () => {
  const sorted = { leads: [{ index: 25, group: "Real estate agencies", approach: "standard", reason: "The business publishes a Chicago office." }] };

  for (const mode of ["tool_call", "json_schema"] as const) {
    test(`${mode}: repairs the missing-leads response from the planning failure`, async () => {
      const invalid = '{"message":"I sorted your leads."}';
      const valid = JSON.stringify({ lead_sorting: sorted });
      const { runtime, requests } = mode === "tool_call"
        ? scripted([{ toolArgs: invalid }, { toolArgs: valid }], "lead_sorting")
        : jsonSchemaRuntime([{ content: invalid }, { content: valid }]);
      let accepted: ReturnType<typeof parseWriterReply<"lead_sorting">> | undefined;
      const result = await completeStructured({
        ...input, schemaName: "lead_sorting", jsonSchema: WRITER_REPLY_SCHEMAS.lead_sorting,
        userPrompt: `${writerReplyInstructions("lead_sorting")}\nSort lead 25 from its public facts.`,
        accept: (text) => { accepted = parseWriterReply(text, "lead_sorting"); },
      }, { runtime, sleep: noSleep });
      assert.equal(result.attempts, 2);
      assert.deepEqual(accepted, sorted);
      const retry = requests[1] as { messages: Array<{ role: string; content: string }> };
      const repair = retry.messages.find((message) => message.role === "user")!.content;
      assert.ok(repair.includes("lead_sorting.leads is required"));
      assert.ok(repair.includes('"leads" as an array'));
      assert.ok(!repair.includes("undefined is not an object"));
    });
  }

  test("sorting, sequences, reviews, opening lines and personal messages all pass through their real schemas", async () => {
    const stages = {
      lead_sorting: sorted,
      outreach_sequences: { channels: [{ channel: "linkedin", messages: [{ subject: "", body: "How do you handle new inquiries?", waitDays: 0 }] }] },
      first_message_review: { messages: [{ channel: "linkedin", wouldReply: 4, reasons: [] }] },
      opening_lines: { lines: [{ index: 25, line: "I saw your Chicago office listed." }] },
      personal_messages: { messages: [{ index: 25, subject: "", body: "How does your Chicago office handle inquiries?" }] },
    };
    for (const name of Object.keys(stages) as (keyof typeof stages)[]) {
      const key = WRITER_REPLY_SCHEMAS[name].required[0]!;
      const rows = Object.values(stages[name])[0];
      const { runtime } = scripted([{ toolArgs: JSON.stringify({ [key]: rows[0] }) }], name);
      let accepted: unknown;
      const result = await completeStructured({
        ...input, schemaName: name, jsonSchema: WRITER_REPLY_SCHEMAS[name],
        accept: (text) => { accepted = parseWriterReply(text, name); },
      }, { runtime, sleep: noSleep });
      assert.equal(result.attempts, 1);
      assert.deepEqual(accepted, stages[name]);
    }
  });

  test("persistent malformed sorting is refused with a field-level reason instead of fake successful output", async () => {
    const { runtime } = scripted([{ toolArgs: '{}' }, { toolArgs: '{"leads":null}' }], "lead_sorting");
    await assert.rejects(completeStructured({
      ...input, schemaName: "lead_sorting", jsonSchema: WRITER_REPLY_SCHEMAS.lead_sorting, maxAttempts: 2,
      accept: (text) => { parseWriterReply(text, "lead_sorting"); },
    }, { runtime, sleep: noSleep }), /lead_sorting failed after 2 attempts: lead_sorting.leads must be an array/);
  });
});

describe("a function call cut off at the token limit (Claude Haiku 5.5 on AI/ML API, 18 Oct 2026)", () => {
  // The answers the owner saw, replayed: {} and message-only calls, each ending with finish "length".
  const schema = agentReplySchema(["find_leads", "report"]);
  const assistant = { ...input, schemaName: "assistant_reply", jsonSchema: schema, maxOutputTokens: 1_500, accept: (text: string) => void parseAgentReply(text, ["find_leads", "report"], { allowEmpty: true }) };

  test("AI/ML API names the function to call instead of leaving it to the model", async () => {
    const { runtime, requests } = scripted([{ toolArgs: '{"message":"","actions":[],"suggestions":[]}' }], "assistant_reply", "aimlapi");
    await completeStructured(assistant, { runtime, sleep: noSleep });
    assert.deepEqual((requests[0] as { tool_choice: unknown }).tool_choice, { type: "function", function: { name: "assistant_reply" } });
  });

  test("OpenRouter keeps tool_choice auto", async () => {
    const { runtime, requests } = scripted([{ toolArgs: '{"message":"","actions":[],"suggestions":[]}' }], "assistant_reply");
    await completeStructured(assistant, { runtime, sleep: noSleep });
    assert.equal((requests[0] as { tool_choice: unknown }).tool_choice, "auto");
  });

  test("{} and message-only calls cut off by the limit are retried with twice the budget, never accepted", async () => {
    const good = '{"message":"Searching Mumbai.","actions":[{"tool":"find_leads","arguments":"{\\"what\\":\\"real estate agents\\",\\"where\\":\\"Mumbai\\"}"}],"suggestions":[]}';
    const { runtime, requests } = scripted([
      { toolArgs: "{}", finish: "length" },
      { toolArgs: '{"message":"I\'m starting searches for real estate agents in Mumbai"}', finish: "length" },
      { toolArgs: good },
    ], "assistant_reply", "aimlapi");
    const result = await completeStructured(assistant, { runtime, sleep: noSleep });
    assert.equal(result.attempts, 3);
    assert.equal(JSON.parse(result.text).actions.length, 1);
    const budgets = (requests as Record<string, unknown>[]).map((request) => request.max_tokens ?? request.max_completion_tokens);
    assert.deepEqual(budgets, [1_500, 3_000, 6_000]);
  });

  test("a complete-looking call without actions is still refused with a repair instruction", async () => {
    const { runtime } = scripted([{ toolArgs: '{"message":"Searching now."}' }, { toolArgs: '{"message":"Searching now."}' }, { toolArgs: "{}" }], "assistant_reply", "aimlapi");
    await assert.rejects(completeStructured(assistant, { runtime, sleep: noSleep }), /actions must be an array/);
  });
});

describe("isStrictJsonSchema", () => {
  test("accepts the app's own schema shapes, nested ones included", () => {
    assert.equal(isStrictJsonSchema({
      type: "object",
      additionalProperties: false,
      required: ["a", "b"],
      properties: {
        a: { anyOf: [{ type: "string", enum: ["x"] }, { type: "null" }] },
        b: { type: "array", items: { type: "object", additionalProperties: false, required: ["c"], properties: { c: { type: "number" } } } },
      },
    }), true);
  });

  test("rejects optional properties or open objects at any depth", () => {
    assert.equal(isStrictJsonSchema({ type: "object", required: ["a"], properties: { a: { type: "string" } } }), false);
    assert.equal(isStrictJsonSchema({ type: "object", additionalProperties: false, required: [], properties: { a: { type: "string" } } }), false);
    assert.equal(isStrictJsonSchema({
      type: "object",
      additionalProperties: false,
      required: ["a"],
      properties: { a: { type: "object", properties: { b: { type: "string" } }, required: ["b"] } },
    }), false);
  });
});
