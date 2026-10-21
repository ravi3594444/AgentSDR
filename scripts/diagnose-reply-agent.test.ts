import { expect, test } from "bun:test";
import { probeReplyProvider, redactReplyDiagnostic, replyProbeRequest } from "./diagnose-reply-agent";
import { DECISION_SCHEMA } from "../src/lib/assistant/replyAgent/agent";

/** DeepSeek Chat's AI/ML catalog tags on 21 Oct 2026. */
const DEEPSEEK_CAPABILITIES = ["file_input", "parallel_tool_calls", "streaming", "structured_output", "tools"];

test("the diagnostic submits the worker's actual schema, model and token budget", () => {
  const request = replyProbeRequest("deepseek-chat", "json_schema");
  expect(request).toMatchObject({ model: "deepseek-chat", max_tokens: 1_500, response_format: { json_schema: { schema: DECISION_SCHEMA } } });
});

test("for DeepSeek it asks for json_schema first, then makes the worker's one function-call fallback on a 400", async () => {
  type ProbeRequest = { model: string; response_format?: unknown; tool_choice?: unknown; tools?: Array<{ function: { parameters: unknown } }> };
  const requests: ProbeRequest[] = [];
  const fetcher = (async (_url, input) => {
    const request = JSON.parse(String(input?.body));
    requests.push(request);
    if (request.response_format) return Response.json({ message: "Validation failed", details: [{ path: "response_format.type" }] }, { status: 400 });
    return Response.json({ choices: [{ message: { tool_calls: [{ type: "function", function: { name: "reply_decision", arguments: "{}" } }] } }] });
  }) as typeof fetch;
  const result = await probeReplyProvider("deepseek/deepseek-chat", "synthetic-key", DEEPSEEK_CAPABILITIES, fetcher);
  expect(requests).toHaveLength(2);
  expect(requests[0]!.response_format).toMatchObject({ type: "json_schema", json_schema: { schema: DECISION_SCHEMA } });
  expect(requests[1]!.response_format).toBeUndefined();
  expect(requests[1]!.model).toBe("deepseek/deepseek-chat");
  expect(requests[1]!.tool_choice).toEqual({ type: "function", function: { name: "reply_decision" } });
  expect(requests[1]!.tools?.[0]?.function.parameters).toEqual(DECISION_SCHEMA);
  expect(result).toMatchObject({ mode: "json_schema", functionCallFallback: true, answeredAs: "tool_call", httpStatus: 200 });
  expect(result.attempts.map((attempt) => [attempt.mode, attempt.httpStatus])).toEqual([["json_schema", 400], ["tool_call", 200]]);
  expect(result.attempts[0]!.validation).toMatchObject({ details: [{ path: "response_format.type" }] });
});

test("never more than two requests, and no fallback for anything but a 400", async () => {
  for (const [status, expected] of [[400, 2], [401, 1], [403, 1], [404, 1], [422, 1], [429, 1], [500, 1]] as const) {
    let calls = 0;
    const formats: string[] = [];
    const fetcher = (async (_url, input) => {
      calls++;
      formats.push(JSON.parse(String(input?.body)).response_format ? "json_schema" : "tool_call");
      return Response.json({ message: `refused ${status}` }, { status });
    }) as typeof fetch;
    const result = await probeReplyProvider("deepseek/deepseek-chat", "synthetic-key", DEEPSEEK_CAPABILITIES, fetcher);
    expect(calls).toBe(expected);
    expect(formats).toEqual(expected === 2 ? ["json_schema", "tool_call"] : ["json_schema"]);
    expect(result.httpStatus).toBe(status);
  }
});

test("a model already asked for a function call is probed with one function call", async () => {
  let calls = 0;
  const fetcher = (async (_url, input) => {
    calls++;
    expect(JSON.parse(String(input?.body)).response_format).toBeUndefined();
    return Response.json({ choices: [] });
  }) as typeof fetch;
  const result = await probeReplyProvider("anthropic/claude-haiku-5.5", "synthetic-key", ["reasoning", "streaming", "tools", "vision"], fetcher);
  expect(calls).toBe(1);
  expect(result).toMatchObject({ mode: "tool_call", functionCallFallback: false, answeredAs: "tool_call" });
});

test("the validation field path is retained, only one AI request is made, and secrets are redacted", async () => {
  let calls = 0;
  const key = "synthetic-diagnostic-secret";
  const fetcher = (async (_url, input) => {
    calls++;
    expect(input?.method).toBe("POST");
    expect(new Headers(input?.headers).get("Authorization")).toBe(`Bearer ${key}`);
    return Response.json({ message: "Validation failed", details: [{ path: "response_format.json_schema", message: "unsupported" }], echo: key }, { status: 400 });
  }) as typeof fetch;
  // Not tagged tools: the 400 stands, as it does in the worker.
  const report = await probeReplyProvider("deepseek-chat", key, ["structured_output"], fetcher);
  expect(calls).toBe(1);
  expect(report).toMatchObject({ httpStatus: 400, validation: { details: [{ path: "response_format.json_schema", message: "unsupported" }] } });
  const text = redactReplyDiagnostic(report, [key]);
  expect(text).not.toContain(key);
  expect(text).toContain("response_format.json_schema");
});
