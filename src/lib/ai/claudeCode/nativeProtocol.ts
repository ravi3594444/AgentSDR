/** Native Claude turns call MCP themselves; only the final owner-facing answer is JSON. */
export const NATIVE_ANSWER_SCHEMA = {
  type: "object",
  properties: { message: { type: "string" }, suggestions: { type: "array", items: { type: "string" }, maxItems: 3 } },
  required: ["message", "suggestions"],
  additionalProperties: false,
};

export function parseNativeAnswer(text: string): { message: string; suggestions: string[] } {
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Claude did not return a final answer.");
  const answer = value as Record<string, unknown>;
  if (typeof answer.message !== "string" || !Array.isArray(answer.suggestions)
    || answer.suggestions.length > 3 || answer.suggestions.some((item) => typeof item !== "string")
    || Object.keys(answer).some((key) => key !== "message" && key !== "suggestions")) {
    throw new Error("Claude did not return a valid final answer. Saved tool results are kept.");
  }
  return { message: answer.message, suggestions: answer.suggestions as string[] };
}

export type NativeSessionArgs = { sessionId: string; resume: boolean; maxTurns: number; mcpConfigFile: string };

/** Additional flags for the native loop. --tools "" still removes built-ins, not MCP tools. */
export function nativeFlags(input: NativeSessionArgs): string[] {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(input.sessionId) || !Number.isInteger(input.maxTurns) || input.maxTurns < 1 || input.maxTurns > 40) {
    throw new Error("Invalid native Claude session options");
  }
  return [
    "--mcp-config", input.mcpConfigFile,
    "--allowedTools", "mcp__agentsdr__*",
    "--permission-mode", "dontAsk",
    "--restricted",
    "--no-chrome",
    // The pinned 2.1.306 CLI supports this; resumed turns must use today's request and rules.
    "--system-prompt-snapshot", "off",
    input.resume ? "--resume" : "--session-id", input.sessionId,
    "--max-turns", String(input.maxTurns),
  ];
}

/** A credential source must be verified before allowing an MCP effect, not only at final output. */
export function nativeInitProblem(frame: Record<string, unknown>): string | null {
  if (frame.type !== "system" || frame.subtype !== "init") return "Claude has not initialized this turn.";
  if (frame.apiKeySource !== "none") return "Claude did not confirm this account's own login. No app tool was authorized.";
  const tools = frame.tools;
  if (!Array.isArray(tools) || !tools.includes("mcp__agentsdr__set_brief")) return "Claude did not load the app's MCP tools. Update the CLI and retry.";
  const unexpected = tools.filter((name) => typeof name !== "string" || (!name.startsWith("mcp__agentsdr__") && name !== "StructuredOutput" && name !== "ToolSearch" && name !== "EndConversation"));
  return unexpected.length ? "Claude loaded unexpected tools. No app tool was authorized." : null;
}
