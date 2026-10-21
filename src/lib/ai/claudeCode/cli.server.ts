import "server-only";

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseAuthStatus, type AuthStatus } from "./cliOutput";

/**
 * Running the installed, unmodified `claude` CLI for one account.
 *
 * Each (organization, person) pair has its own directory under
 * CLAUDE_CODE_DATA_DIR: `config/` is the CLI's CLAUDE_CONFIG_DIR (where it
 * keeps its own login, `.credentials.json`), `home/` its HOME (where a
 * keyless Console sign-in keeps its Anthropic profile, which a config
 * directory alone does not separate). The CLI manages both; this app never
 * reads the credentials in them.
 *
 * The CLI gets an allowlisted environment, not this server's: no database
 * URL, encryption key or provider keys reach it, and no inherited Anthropic
 * credential (ANTHROPIC_API_KEY would silently turn a subscription login into
 * API billing; CLAUDE_CODE_OAUTH_TOKEN would be someone else's login).
 */

export type CliCommand = { command: string; args: string[] };
/** The whole environment a CLI process gets (never this server's own). */
export type CliEnvironment = Record<string, string>;

/** `CLAUDE_CODE_CLI` names the binary (default: `claude` on PATH). Tests point it at a fake. */
let cliOverride: CliCommand | null = null;
export function setClaudeCliForTests(cli: CliCommand | null): void {
  cliOverride = cli;
}
export function configuredCli(): CliCommand {
  return cliOverride ?? { command: process.env.CLAUDE_CODE_CLI?.trim() || "claude", args: [] };
}

let dataDirOverride: string | null = null;
export function setClaudeDataDirForTests(dir: string | null): void {
  dataDirOverride = dir;
}
export function claudeDataDir(): string {
  return resolve(dataDirOverride ?? (process.env.CLAUDE_CODE_DATA_DIR?.trim() || join(process.cwd(), ".data", "claude-code")));
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type ClaudeAccount = { organizationId: string; userId: string };

export function accountKey(account: ClaudeAccount): string {
  return `${account.organizationId}:${account.userId}`;
}

export type AccountPaths = { root: string; home: string; config: string; work: string };

/** This account's directories, created 0700 on first use. Ids must be UUIDs, so no path can escape the data directory. */
export function accountPaths(account: ClaudeAccount, create = true): AccountPaths {
  if (!UUID.test(account.organizationId) || !UUID.test(account.userId)) throw new Error("Invalid Claude Code account");
  const root = join(claudeDataDir(), "accounts", account.organizationId.toLowerCase(), account.userId.toLowerCase());
  const paths = { root, home: join(root, "home"), config: join(root, "config"), work: join(root, "work") };
  if (create) for (const dir of [paths.root, paths.home, paths.config, paths.work]) mkdirSync(dir, { recursive: true, mode: 0o700 });
  return paths;
}

const PASSED_THROUGH = [
  "PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ",
  "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "no_proxy",
  "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR",
];

/** The CLI's whole environment for this account. */
export function accountEnvironment(paths: AccountPaths, extra: CliEnvironment = {}): CliEnvironment {
  const env: CliEnvironment = {};
  for (const key of PASSED_THROUGH) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  return {
    ...env,
    HOME: paths.home,
    XDG_CONFIG_HOME: join(paths.home, ".config"),
    CLAUDE_CONFIG_DIR: paths.config,
    NO_COLOR: "1",
    // The binary stays exactly as installed; it is updated with the image, not by itself.
    DISABLE_AUTOUPDATER: "1",
    ...extra,
  };
}

/**
 * Whether this account's own directories hold a login: the CLI's
 * `.credentials.json`, or an Anthropic profile in its HOME. A CLI that says
 * "logged in" without either is using a credential from somewhere else on
 * the machine, which must never answer for this account. Only existence is
 * checked; nothing is read.
 */
export function hasOwnLogin(paths: AccountPaths): boolean {
  if (existsSync(join(paths.config, ".credentials.json"))) return true;
  const profiles = join(paths.home, ".config", "anthropic", "configs");
  try {
    return readdirSync(profiles).length > 0;
  } catch {
    return false;
  }
}

export function spawnCli(args: string[], options: { env: CliEnvironment; cwd: string }): ChildProcess {
  const cli = configuredCli();
  // Its own process group, so a timeout or cancel stops everything it started.
  return spawn(cli.command, [...cli.args, ...args], { env: options.env as NodeJS.ProcessEnv, cwd: options.cwd, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32" });
}

/** Stops a CLI process and its group: TERM, then KILL after `graceMs`. Resolves once it has exited (or could not be). */
export async function stopCli(child: ChildProcess | null, graceMs = 1_500): Promise<boolean> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return true;
  const exited = new Promise<void>((resolveExit) => child.once("close", () => resolveExit()));
  const signal = (name: NodeJS.Signals) => {
    try {
      if (process.platform !== "win32" && child.pid) process.kill(-child.pid, name);
      else child.kill(name);
    } catch {
      try { child.kill(name); } catch { /* already gone */ }
    }
  };
  signal("SIGTERM");
  const graceful = await Promise.race([exited.then(() => true), new Promise<boolean>((done) => setTimeout(() => done(false), graceMs).unref())]);
  if (graceful) return true;
  signal("SIGKILL");
  return Promise.race([exited.then(() => true), new Promise<boolean>((done) => setTimeout(() => done(false), graceMs).unref())]);
}

const MAX_OUTPUT = 32_768;

/** Runs a short CLI command to completion with no stdin: stdout (bounded), exit code; null when it could not start. */
export function runCliCommand(args: string[], options: { env: CliEnvironment; cwd: string; timeoutMs: number }): Promise<{ stdout: string; code: number | null } | null> {
  return new Promise((resolveRun) => {
    let child: ChildProcess;
    try {
      child = spawnCli(args, options);
    } catch {
      resolveRun(null);
      return;
    }
    let stdout = "";
    child.stdin?.end();
    child.stdout?.on("data", (chunk: Buffer) => { if (stdout.length < MAX_OUTPUT) stdout += chunk.toString("utf8"); });
    child.stderr?.on("data", () => {});
    const timer = setTimeout(() => { void stopCli(child, 500); }, options.timeoutMs);
    timer.unref();
    child.once("error", () => { clearTimeout(timer); resolveRun(null); });
    child.once("close", (code) => { clearTimeout(timer); resolveRun({ stdout, code }); });
  });
}

/** The CLI's version (`claude --version`), or null when it is not installed or will not run. */
export async function cliVersion(): Promise<string | null> {
  const scratch = mkdtempSync(join(claudeDataDirReady(), "version-"));
  try {
    const result = await runCliCommand(["--version"], { env: { PATH: process.env.PATH ?? "", NO_COLOR: "1", DISABLE_AUTOUPDATER: "1", HOME: scratch }, cwd: scratch, timeoutMs: 10_000 });
    const version = result?.code === 0 ? /\d+\.\d+\.\d+/.exec(result.stdout)?.[0] : null;
    return version ?? null;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function claudeDataDirReady(): string {
  const dir = claudeDataDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export type AccountAuth = AuthStatus & { own: boolean };

/**
 * `claude auth status --json` for this account. "in" only when the CLI says
 * so for this account's config directory and the login is stored in this
 * account's own directories (hasOwnLogin); otherwise the CLI is reporting a
 * credential that is not this account's, which counts as signed out.
 */
export async function accountAuthStatus(account: ClaudeAccount): Promise<AccountAuth> {
  const paths = accountPaths(account);
  const result = await runCliCommand(["auth", "status", "--json"], { env: accountEnvironment(paths), cwd: paths.home, timeoutMs: 10_000 });
  if (!result) return { state: "unknown", method: null, configDirectory: null, own: false };
  const status = parseAuthStatus(result.stdout, result.code);
  const sameDirectory = !status.configDirectory || resolve(status.configDirectory) === resolve(paths.config);
  const own = status.state === "in" && sameDirectory && hasOwnLogin(paths);
  return { ...status, state: status.state === "in" && !own ? "out" : status.state, own };
}

/** A fresh empty working directory for one generation, so no project files or settings are near it. */
export function scratchDirectory(paths: AccountPaths): { cwd: string; remove: () => void } {
  const cwd = mkdtempSync(join(paths.work, "run-"));
  return { cwd, remove: () => { try { rmSync(cwd, { recursive: true, force: true }); } catch { /* best effort */ } } };
}
