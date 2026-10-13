import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { completeStructured, isStrictJsonSchema, type StructuredCompletionRuntime } from "./structuredCompletion";

type Reply = { toolArgs?: string; content?: string; throws?: Error; error?: unknown };

/** A runtime whose client answers each call from the scripted list, in order. */
function scripted(replies: Reply[]) {
  const requests: unknown[] = [];
  const runtime: StructuredCompletionRuntime = async () => ({
    providerKey: "openrouter",
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
        choices: [{ message: {
          content: reply.content ?? null,
          tool_calls: reply.toolArgs === undefined
            ? []
            : [{ type: "function", function: { name: "submit", arguments: reply.toolArgs } }],
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
    const result = await completeStructured({ ...input, accept }, { runtime, sleep: noSleep });
    assert.equal(result.attempts, 2);

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
