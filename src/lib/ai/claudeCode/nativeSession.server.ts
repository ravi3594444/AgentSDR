import "server-only";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { accountPaths, type ClaudeAccount } from "./cli.server";
import type { ClaudeCodeModel } from "./contract";

/** Explicit IDs only: never resume the machine's most recent Claude conversation. */
export function nativeSession(account: ClaudeAccount, input: { threadId: string; requestId: string; model: ClaudeCodeModel }) {
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuid.test(input.threadId) || !uuid.test(input.requestId)) throw new Error("Invalid native Claude request identity");
  const cwd = join(accountPaths(account).work, "sessions", input.threadId.toLowerCase(), input.requestId.toLowerCase());
  mkdirSync(cwd, { recursive: true, mode: 0o700 });
  const file = join(cwd, "session.json");
  let sessionId = randomUUID();
  let resume = false;
  try {
    const previous: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!previous || typeof previous !== "object" || Array.isArray(previous)) throw new Error("Invalid session manifest");
    const record = previous as Record<string, unknown>;
    if (typeof record.sessionId !== "string" || !uuid.test(record.sessionId) || typeof record.model !== "string") throw new Error("Invalid session manifest");
    if (record.model === input.model) {
      sessionId = record.sessionId as typeof sessionId;
      resume = true;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Could not read this request's Claude session. No new session was started.");
  }
  return {
    cwd, sessionId, resume,
    // A failed first turn starts a fresh session from the saved app transcript; no blind CLI replay.
    save: () => {
      const temporary = join(cwd, `${randomUUID()}.tmp`);
      writeFileSync(temporary, JSON.stringify({ sessionId, model: input.model }), { mode: 0o600, flag: "wx" });
      renameSync(temporary, file);
    },
  };
}
