/**
 * Claude Code as an AI engine: the owner's own Claude account, signed in
 * through Anthropic's unmodified `claude` CLI running on this server
 * (docs/plans/CLAUDE_CODE_LOGIN.md). The shapes the settings route, its page
 * and the server share; this file stays free of runtime imports.
 */

export const CLAUDE_CODE_ENGINE_KEY = "claude-code";
export const CLAUDE_CODE_ENGINE_NAME = "Claude Code";

/**
 * The CLI's own sign-in choices (`claude auth login --claudeai | --console |
 * --sso`). All of them stay offered: Anthropic's hosting conditions forbid
 * removing or restricting an authentication method built into the binary.
 */
export const CLAUDE_CODE_LOGIN_METHODS = [
  { key: "claudeai", label: "Claude subscription", detail: "Your Pro, Max, Team or Enterprise plan. The CLI's default." },
  { key: "console", label: "Anthropic Console", detail: "Your own Console account; Anthropic bills its API use to you." },
  { key: "sso", label: "Single sign-on", detail: "Your organization's SSO for Claude." },
] as const;
export type ClaudeCodeLoginMethod = typeof CLAUDE_CODE_LOGIN_METHODS[number]["key"];

export function isClaudeCodeLoginMethod(value: unknown): value is ClaudeCodeLoginMethod {
  return CLAUDE_CODE_LOGIN_METHODS.some((method) => method.key === value);
}

/**
 * Model aliases the CLI resolves for the signed-in account. "default" passes
 * no `--model`, so the account's own default answers. Which of them an
 * account may use is only known by asking (the Check button), never assumed.
 */
export const CLAUDE_CODE_MODELS = [
  { key: "default", label: "Account default" },
  { key: "sonnet", label: "Sonnet" },
  { key: "opus", label: "Opus" },
  { key: "haiku", label: "Haiku" },
] as const;
export type ClaudeCodeModel = typeof CLAUDE_CODE_MODELS[number]["key"];

export function isClaudeCodeModel(value: unknown): value is ClaudeCodeModel {
  return CLAUDE_CODE_MODELS.some((model) => model.key === value);
}

/** The CLI's per-generation effort flag; default omits the flag. */
export const CLAUDE_CODE_EFFORTS = [
  { key: "default", label: "Model default" },
  { key: "low", label: "Low" },
  { key: "medium", label: "Medium" },
  { key: "high", label: "High" },
  { key: "xhigh", label: "Extra high" },
  { key: "max", label: "Max" },
] as const;
export type ClaudeCodeEffort = typeof CLAUDE_CODE_EFFORTS[number]["key"];

export function isClaudeCodeEffort(value: unknown): value is ClaudeCodeEffort {
  return CLAUDE_CODE_EFFORTS.some((effort) => effort.key === value);
}

/** One sign-in in progress, as the page polls it. The code the owner pastes is never part of it. */
export type ClaudeCodeSignIn = {
  phase: "waiting" | "succeeded" | "failed" | "cancelled" | "expired";
  flowId: string;
  /** Anthropic's own sign-in page, as the CLI printed it; null until it has. */
  authorizationUrl: string | null;
  expiresAt: string | null;
  message?: string;
};

/** What a model check found: the model id the CLI ran, or why it could not. */
export type ClaudeCodeModelCheck =
  | { ok: true; modelId: string; checkedAt: string; effort?: ClaudeCodeEffort }
  | { ok: false; error: string; checkedAt: string; effort?: ClaudeCodeEffort };

/** Checks saved before effort selection tested the model's default effort. */
export function claudeCodeCheckMatches(check: ClaudeCodeModelCheck | undefined, effort: ClaudeCodeEffort): boolean {
  return check?.ok === true && (check.effort ?? "default") === effort;
}

/** Display a version only after a check reported that model ID. */
export function claudeCodeModelLabel(model: ClaudeCodeModel, modelId?: string): string {
  const label = CLAUDE_CODE_MODELS.find((entry) => entry.key === model)?.label ?? model;
  const version = modelId?.match(/^claude-(sonnet|opus|haiku)-(\d+)-(\d+)(?:-\d{8})?$/i);
  if (!version || (model !== "default" && version[1].toLowerCase() !== model)) return label;
  const family = version[1][0].toUpperCase() + version[1].slice(1).toLowerCase();
  const resolved = `${family} ${version[2]}.${version[3]}`;
  return model === "default" ? `${label} (${resolved})` : resolved;
}

/** One usage window exactly as the CLI's `rate_limit_event` reported it. */
export type ClaudeCodeWindow = { window: string; utilization: number | null; resetsAt: string | null };

/** A usage window that refused this account. `modelSpecific`: a weekly window of one model family, so only that model is held. */
export type ClaudeCodeLimit = { window: string | null; resetsAt: string | null; message: string; modelSpecific: boolean; model?: ClaudeCodeModel };

export type ClaudeCodeStatus = {
  /** Whether this person may use the engine: the owner of the platform operator's organization (owner-only pilot). */
  allowed: boolean;
  reason?: string;
  /** The CLI on this server, or null when it is not installed. */
  cli: { version: string } | null;
  cliError?: string;
  /**
   * This person's own login in this organization. `signedIn` null: the CLI
   * could not say. `expired`: a generation was refused as signed out or
   * expired since the last sign-in, whatever `auth status` says.
   */
  account: { signedIn: boolean | null; method: string | null; expired: boolean };
  signIn: ClaudeCodeSignIn | null;
  engine: {
    /** The organization's AI steps run on this engine. */
    selected: boolean;
    /** Whose login the organization's AI steps use. Any owner here may stop it or switch it to their own. */
    ownerUserId: string | null;
    ownedByYou: boolean;
    model: ClaudeCodeModel;
    effort: ClaudeCodeEffort;
    checks: Partial<Record<ClaudeCodeModel, ClaudeCodeModelCheck>>;
    /** Why this organization cannot use Claude Code now (for example other members), or null. */
    blocked: string | null;
  };
  /** Generations running or waiting on this login right now. */
  running: number;
  /** Usage limits the CLI reported that have not reset yet (a model's own, or the whole account's). */
  limits: ClaudeCodeLimit[];
  /** The last usage the CLI reported for this login, if any. Never estimated. */
  windows: ClaudeCodeWindow[];
  windowsReportedAt: string | null;
};
