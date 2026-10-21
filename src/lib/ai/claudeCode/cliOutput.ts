/**
 * What the `claude` CLI prints, read without side effects: its sign-in link
 * and the code a person pastes back (adapted from OpenMausBot, see below),
 * `claude auth status --json`, and the stream-json frames of one `-p`
 * generation. The server half (spawning, accounts) is in cli.server.ts.
 *
 * claudeSignInLink, claudeLoginPrompt and claudeLoginCode are adapted from
 * OpenMausBot server/drivers/claude-login-auth.ts at commit
 * bdcfc44044bc1f59fb49b0315aae85fb3c502e93, Copyright 2026 Milind Soni and
 * OpenMausBot contributors, licensed under the Apache License 2.0
 * (docs/third-party/openmausbot/LICENSE). The limit reading follows the same
 * project's server/drivers/claude-limits.ts. Changes: AgentSDR's types and
 * wording; the frame reader is new.
 *
 * Frame shapes were read from Claude Code 2.1.306 (`-p --output-format
 * stream-json --verbose --json-schema`, 21 Oct 2026): `system/init` names the
 * model and the tools (only StructuredOutput with `--tools ""`),
 * `rate_limit_event` carries `rate_limit_info`, and `result` carries
 * `structured_output`, `usage` and `is_error`.
 */

import { stripVTControlCharacters } from "node:util";
import type { ClaudeCodeLimit, ClaudeCodeLoginMethod, ClaudeCodeModel, ClaudeCodeWindow } from "./contract";

/** Where Anthropic's sign-in lives. Anything else in the CLI's output is not a link we show. */
const SIGN_IN_HOSTS = ["claude.com", "claude.ai", "console.anthropic.com", "platform.claude.com", "anthropic.com"];

export function claudeSignInLink(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    const trusted = SIGN_IN_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
    return url.protocol === "https:" && trusted && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

/** The first Anthropic sign-in link on a finished line of the CLI's output. */
export function claudeLoginPrompt(output: string): { authorizationUrl: string } | null {
  const lines = stripVTControlCharacters(output).split(/\r?\n/).slice(0, -1);
  for (const line of lines) {
    const match = /(https:\/\/\S+)/.exec(line.trim());
    const link = match ? claudeSignInLink(match[1].replace(/[),.;]+$/, "")) : null;
    if (link) return { authorizationUrl: link };
  }
  return null;
}

/** What Anthropic's page shows after sign-in: a code, sometimes with `#state`. */
export function claudeLoginCode(value: string): string | null {
  const code = value.trim();
  return /^[A-Za-z0-9_\-#.:]{8,1024}$/.test(code) ? code : null;
}

export function loginArgs(method: ClaudeCodeLoginMethod): string[] {
  return ["auth", "login", `--${method}`];
}

export type AuthStatus = { state: "in" | "out" | "unknown"; method: string | null; configDirectory: string | null };

/** `claude auth status --json`: exit 0 with loggedIn true, exit 1 with loggedIn false; anything else is unknown. */
export function parseAuthStatus(stdout: string, exitCode: number | null): AuthStatus {
  try {
    const status: unknown = JSON.parse(stdout);
    const record = status && typeof status === "object" ? status as Record<string, unknown> : {};
    const method = typeof record.authMethod === "string" ? record.authMethod : null;
    const configDirectory = typeof record.configDirectory === "string" ? record.configDirectory : null;
    const state = exitCode === 0 && record.loggedIn === true ? "in" : exitCode === 1 && record.loggedIn === false ? "out" : "unknown";
    return { state, method, configDirectory };
  } catch {
    return { state: "unknown", method: null, configDirectory: null };
  }
}

/**
 * One isolated generation: no built-in tools (the only tool the model gets is
 * the CLI's StructuredOutput), no MCP servers, no settings files, no slash
 * commands, nothing kept on disk. `--bare` is not used: it never reads the
 * OAuth login this engine exists for.
 */
export function generationArgs(input: { model: ClaudeCodeModel; systemPrompt: string; jsonSchema: Record<string, unknown> }): string[] {
  return [
    "-p",
    "--output-format", "stream-json",
    "--verbose",
    "--tools", "",
    "--no-session-persistence",
    "--strict-mcp-config",
    "--setting-sources", "",
    "--disable-slash-commands",
    ...(input.model === "default" ? [] : ["--model", input.model]),
    "--system-prompt", input.systemPrompt,
    "--json-schema", JSON.stringify(input.jsonSchema),
  ];
}

const USAGE_LIMIT = /\busage limit\b|\bhit your (?:(?!rate\b)[\w'’-]+ ){0,3}(?:limit|budget)\b|\b(?:weekly|daily|monthly|subscription|usage|session|5-hour) limit reached\b|\bout of (?:usage(?: credits)?|extra usage|credits)\b/i;
const SIGNED_OUT = /\bnot logged in\b|\blogin expired\b|please run \/login|\binvalid api key\b|\boauth token (?:has )?expired\b|\bauthentication_(?:error|failed)\b/i;
const MODEL_UNAVAILABLE = /\bmodel not found\b|\bunknown model\b|\bunsupported model\b|\bdoes not support this model\b|\bnot available (?:on|for|with) your (?:plan|account|subscription)\b|\bmodel[^.]{0,60}\bis not available\b/i;

export type ClaudeFailure =
  /** The login is gone or expired: sign in again in Settings. Never retried. */
  | { kind: "signed_out"; message: string }
  /** A usage window refused this account until `limit.resetsAt`. Never retried. */
  | { kind: "limit"; limit: ClaudeCodeLimit }
  /** The account cannot use this model. Never retried. */
  | { kind: "model_unavailable"; message: string }
  /** Overloaded, a server fault or a dropped process: worth another attempt. */
  | { kind: "transient"; message: string }
  /** Anything else the CLI refused; not retried. */
  | { kind: "error"; message: string };

export type GenerationOutcome = {
  /** The answer as JSON text (structured_output) or, failing that, whatever text the CLI ended with. */
  text: string | null;
  modelId: string | null;
  usage: { inputTokens?: number; outputTokens?: number };
  windows: ClaudeCodeWindow[];
  failure: ClaudeFailure | null;
  /** Whether a `result` frame arrived at all; a process that died before it is a failure. */
  finished: boolean;
};

type Frame = Record<string, unknown>;

function asRecord(value: unknown): Frame | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Frame : null;
}

function epochIso(value: unknown): string | null {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? new Date(value * 1000).toISOString() : null;
}

/** The windows a `rate_limit_info` reports, as reported (utilization 0..1). */
export function windowsFrom(info: unknown): ClaudeCodeWindow[] {
  const record = asRecord(info);
  const windows = asRecord(record?.unifiedWindows);
  if (!windows) {
    return record && typeof record.rateLimitType === "string"
      ? [{ window: record.rateLimitType, utilization: null, resetsAt: epochIso(record.resetsAt) }]
      : [];
  }
  return Object.entries(windows).flatMap(([window, value]) => {
    const entry = asRecord(value);
    if (!entry) return [];
    const utilization = typeof entry.utilization === "number" && Number.isFinite(entry.utilization) ? entry.utilization : null;
    return [{ window, utilization, resetsAt: epochIso(entry.resetsAt) }];
  });
}

const WINDOW_NAMES: Record<string, string> = {
  five_hour: "5-hour limit",
  seven_day: "weekly limit",
  seven_day_opus: "weekly Opus limit",
  seven_day_sonnet: "weekly Sonnet limit",
};

export function windowName(window: string | null | undefined): string {
  return window && Object.hasOwn(WINDOW_NAMES, window) ? WINDOW_NAMES[window] : "usage limit";
}

/**
 * The window refusing this account, from a `rate_limit_info` whose status is
 * "rejected" while no extra usage is paying for the call; null otherwise.
 */
export function limitRefusal(info: unknown, timeZone = "UTC"): ClaudeCodeLimit | null {
  const record = asRecord(info);
  if (!record || record.status !== "rejected" || record.isUsingOverage === true) return null;
  const window = typeof record.rateLimitType === "string" ? record.rateLimitType : null;
  const resetsAt = epochIso(record.resetsAt);
  return { window, resetsAt, message: limitMessage(window, resetsAt, timeZone) };
}

export function limitMessage(window: string | null, resetsAt: string | null, timeZone = "UTC", said?: string): string {
  const name = windowName(window);
  if (resetsAt) {
    let when: string;
    try {
      when = `${new Date(resetsAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone })} (${timeZone})`;
    } catch {
      when = `${resetsAt.slice(0, 16).replace("T", " ")} UTC`;
    }
    return `Your Claude account reached its ${name}, which resets ${when}. AI steps on Claude Code wait until then; nothing is sent to another provider.`;
  }
  const words = said?.trim().replace(/[.\s]+$/, "");
  return `Your Claude account reached its ${name}${words ? ` (Claude Code says: "${words.slice(0, 200)}")` : ""}. AI steps on Claude Code wait until it resets; nothing is sent to another provider.`;
}

function frameText(frame: Frame): string {
  const message = asRecord(frame.message);
  const content = Array.isArray(message?.content) ? message.content : [];
  return content.map((part) => {
    const record = asRecord(part);
    return record?.type === "text" && typeof record.text === "string" ? record.text : "";
  }).join("").trim();
}

function resultError(frame: Frame): string {
  const errors = Array.isArray(frame.errors) ? frame.errors.filter((error): error is string => typeof error === "string" && error.trim() !== "") : [];
  if (errors.length) return errors.join("; ");
  if (typeof frame.result === "string" && frame.result.trim()) return frame.result.trim();
  return `Claude Code ended with an error (${String(frame.subtype ?? frame.terminal_reason ?? "unknown")})`;
}

/** What one failure says, in order of what outranks what: a limit, a sign-out, a model, a transient fault. */
function classify(text: string, kind: unknown, status: unknown, limit: ClaudeCodeLimit | null, timeZone: string): ClaudeFailure {
  if (limit) return { kind: "limit", limit };
  if (USAGE_LIMIT.test(text) || kind === "usage_limit_reached") {
    return { kind: "limit", limit: { window: null, resetsAt: null, message: limitMessage(null, null, timeZone, text) } };
  }
  if (SIGNED_OUT.test(text) || kind === "authentication_failed" || status === 401) {
    return { kind: "signed_out", message: "Claude Code is signed out on this server (its login is missing or expired). Sign in again in Settings → AI provider." };
  }
  if (MODEL_UNAVAILABLE.test(text) || kind === "model_not_found" || status === 404) {
    return { kind: "model_unavailable", message: `This Claude account cannot use the chosen model (Claude Code says: "${text.slice(0, 200)}"). Choose another model in Settings → AI provider.` };
  }
  if (kind === "overloaded" || kind === "server_error" || kind === "rate_limit" || (typeof status === "number" && (status === 429 || status >= 500))) {
    return { kind: "transient", message: `Claude Code could not answer right now: ${text.slice(0, 300)}` };
  }
  return { kind: "error", message: `Claude Code refused the request: ${text.slice(0, 300)}` };
}

/** Reads one generation's stream-json lines (stdout split on newlines; blank and non-JSON lines are skipped). */
export function readGeneration(lines: readonly string[], timeZone = "UTC"): GenerationOutcome {
  const outcome: GenerationOutcome = { text: null, modelId: null, usage: {}, windows: [], failure: null, finished: false };
  let limit: ClaudeCodeLimit | null = null;
  let apiError: { text: string; kind: unknown } | null = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let frame: Frame;
    try {
      const parsed = asRecord(JSON.parse(trimmed));
      if (!parsed) continue;
      frame = parsed;
    } catch {
      continue;
    }
    if (frame.type === "system" && frame.subtype === "init" && typeof frame.model === "string") {
      outcome.modelId = frame.model;
    } else if (frame.type === "rate_limit_event") {
      const windows = windowsFrom(frame.rate_limit_info);
      if (windows.length) outcome.windows = windows;
      limit = limitRefusal(frame.rate_limit_info, timeZone) ?? limit;
    } else if (frame.type === "assistant" && (frame.is_api_error_message === true || typeof frame.error === "string")) {
      apiError = { text: frameText(frame), kind: frame.error };
      const params = asRecord(frame.api_error_params);
      limit = limitRefusal(params?.rate_limit_info, timeZone) ?? limit;
    } else if (frame.type === "result") {
      outcome.finished = true;
      const usage = asRecord(frame.usage);
      if (usage) {
        outcome.usage = {
          ...(typeof usage.input_tokens === "number" ? { inputTokens: usage.input_tokens } : {}),
          ...(typeof usage.output_tokens === "number" ? { outputTokens: usage.output_tokens } : {}),
        };
      }
      if (frame.is_error === true) {
        const text = apiError?.text || resultError(frame);
        outcome.failure = classify(text, frame.api_error ?? apiError?.kind, frame.api_error_status, limit, timeZone);
        continue;
      }
      const structured = asRecord(frame.structured_output);
      outcome.text = structured ? JSON.stringify(structured) : typeof frame.result === "string" ? frame.result : null;
    }
  }
  if (!outcome.failure && apiError && outcome.text === null) {
    outcome.failure = classify(apiError.text, apiError.kind, null, limit, timeZone);
  }
  if (!outcome.failure && limit && outcome.text === null) outcome.failure = { kind: "limit", limit };
  return outcome;
}
