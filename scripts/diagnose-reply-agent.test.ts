import { expect, test } from "bun:test";
import { probeReplyProvider, redactReplyDiagnostic, replyProbeRequest } from "./diagnose-reply-agent";
import { DECISION_SCHEMA } from "../src/lib/assistant/replyAgent/agent";

test("the diagnostic submits the worker's actual schema, model and token budget", () => {
  const request = replyProbeRequest("deepseek-chat", "json_schema");
  expect(request).toMatchObject({ model: "deepseek-chat", max_tokens: 1_500, response_format: { json_schema: { schema: DECISION_SCHEMA } } });
});

test("the diagnostic uses function calling for DeepSeek's live catalog capabilities", async () => {
  let calls = 0;
  const fetcher = (async (_url, input) => {
    calls++;
    const request = JSON.parse(String(input?.body));
    expect(request.response_format).toBeUndefined();
    expect(request.tool_choice).toEqual({ type: "function", function: { name: "reply_decision" } });
    expect(request.tools[0].function.parameters).toEqual(DECISION_SCHEMA);
    return Response.json({ choices: [{ message: { tool_calls: [{ type: "function", function: { name: "reply_decision", arguments: "{}" } }] } }] });
  }) as typeof fetch;
  const result = await probeReplyProvider("deepseek/deepseek-chat", "synthetic-key", ["structured_output", "tools"], fetcher);
  expect(result.httpStatus).toBe(200);
  expect(calls).toBe(1);
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
  const report = await probeReplyProvider("deepseek-chat", key, ["structured_output"], fetcher);
  expect(calls).toBe(1);
  expect(report).toMatchObject({ httpStatus: 400, validation: { details: [{ path: "response_format.json_schema", message: "unsupported" }] } });
  const text = redactReplyDiagnostic(report, [key]);
  expect(text).not.toContain(key);
  expect(text).toContain("response_format.json_schema");
});
