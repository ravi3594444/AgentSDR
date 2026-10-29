import "server-only";

import { completeStructured } from "@/lib/ai/server/structuredCompletion";
import { recordUsage } from "@/lib/assistant/usage.server";
import { AUTHORITY_PROMPT, AUTHORITY_SCHEMA, parseAuthority, type Authority } from "./tasks";

/**
 * What the owner's own messages in a request authorize in their browser
 * (tasks.ts has the kinds). One structured call that is shown nothing but
 * those messages (with the owner's few before the request, marked as
 * context): no page, no tool result and none of the assistant's words
 * reach it, so nothing a website says can widen what it grants. It runs on
 * the organization's selected AI like every other step; when that cannot
 * answer, nothing is granted (the caller says why).
 */
export async function judgeAuthority(said: { earlier: readonly string[]; current: readonly string[] }): Promise<Authority> {
  const numbered = (texts: readonly string[]) => texts.map((text, index) => `${index + 1}. ${text}`).join("\n\n");
  const completion = await completeStructured({
    timeoutMs: 60_000,
    maxOutputTokens: 800,
    schemaName: "browser_authority",
    schemaDescription: "What the owner's own messages authorize the assistant to do in their browser.",
    jsonSchema: AUTHORITY_SCHEMA as unknown as Record<string, unknown>,
    systemPrompt: AUTHORITY_PROMPT,
    userPrompt: [
      ...(said.earlier.length ? [`THE OWNER'S EARLIER MESSAGES (context only: they grant something only where this request's messages refer back to them):\n\n${numbered(said.earlier)}`] : []),
      `THE OWNER'S MESSAGES IN THIS REQUEST (oldest first):\n\n${numbered(said.current)}`,
    ].join("\n\n---\n\n"),
    accept: (text) => {
      parseAuthority(text);
    },
  });
  await recordUsage("assistant", completion);
  return parseAuthority(completion.text);
}
