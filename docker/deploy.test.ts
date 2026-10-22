/**
 * docker/deploy.sh run against stub `docker`, `git` and `curl` executables
 * that append their arguments to a call log and fail on request (FAIL_ON).
 * The log shows which steps ran and in what order: above all, that every
 * failure before the switch stops short of `up -d`, and that a failed check
 * after it puts the previous image back.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dir, "deploy.sh");
const REV = "0123456789abcdef0123456789abcdef01234567";
const BRANCH = "claude/dreamy-fermi-h5woha";
const MIGRATIONS = [
  "add-tinyfish",
  "add-research-sources",
  "add-browser-sessions",
  "add-wrong-number",
  "add-activity",
  "add-assistant-job-reports",
  "add-objectives",
  "add-pilot-fixes",
  "add-brightdata",
  "add-always-on-sending",
  "add-research-agent-v2",
  "add-managed-saas",
];
const DEFAULT_FILES = "-f docker-compose.yml -f docker-compose.build.yml -f docker-compose.discovery.yml";
const ENOUGH_MEMORY = "MemTotal: 8000000 kB\nMemAvailable: 4000000 kB\nSwapTotal: 4194300 kB\nSwapFree: 4194300 kB\n";

// FAIL_ON is a space-separated list of failure names the stubs act on.
const DOCKER_STUB = String.raw`#!/usr/bin/env bash
echo "docker $*" >> "$STUB_LOG"
fails() { [[ " $FAIL_ON " == *" $1 "* ]]; }
if [[ $1 == compose ]]; then
  shift
  while [[ $1 == -f ]]; do shift 2; done
  sub=$1
  shift
  case $sub in
    version) echo "$STUB_COMPOSE_VERSION" ;;
    config) if [[ $* == *--services* ]]; then printf '%s\n' $STUB_SERVICES; fi ;;
    ps) if [[ $* == *--services* ]]; then printf '%s\n' $STUB_RUNNING; else echo cid-app; fi ;;
    exec)
      if [[ $* == *pg_dump* ]]; then
        fails pg_dump && exit 1
        fails empty-dump || printf 'PGDMP fake custom-format dump'
      elif [[ $* == *pg_restore* ]]; then
        cat > /dev/null
        fails pg_restore && exit 1
      fi ;;
    build) fails build && exit 1 ;;
    run)
      for arg in "$@"; do
        if [[ $arg == scripts/*.ts ]] && fails "migration:$(basename "$arg" .ts)"; then exit 1; fi
      done ;;
    up) fails up && exit 1 ;;
    logs) fails worker || echo '[assistant/worker] starting -- poll 3000ms' ;;
  esac
  exit 0
fi
case $1 in
  info) fails docker-info && exit 1 ;;
  inspect) if [[ $* == *State.StartedAt* ]]; then echo 2026-10-19T10:00:00.123456789Z; else echo sha256:running; fi ;;
  image)
    if [[ $* == *image.revision* ]]; then
      if fails running-revision && [[ $* == *sha256:running* ]]; then echo deadbeef; else echo "$STUB_REV"; fi
    fi ;;
esac
exit 0
`;

const GIT_STUB = String.raw`#!/usr/bin/env bash
echo "git $*" >> "$STUB_LOG"
fails() { [[ " $FAIL_ON " == *" $1 "* ]]; }
case "$*" in
  "rev-parse --is-inside-work-tree") echo true ;;
  "rev-parse HEAD" | "rev-parse origin/"*) echo "$STUB_REV" ;;
  "rev-parse -q --verify HEAD:docker/deploy.sh")
    if [[ $STUB_SCRIPT_CHANGES == 1 ]] && grep -q '^git merge' "$STUB_LOG"; then echo 2222; else echo 1111; fi ;;
  "symbolic-ref --short -q HEAD") echo "$STUB_BRANCH" ;;
  "diff --binary HEAD") printf 'diff --git a/.env.example b/.env.example\n' ;;
  "status --porcelain") printf ' M .env.example\n' ;;
  "diff --quiet HEAD") if fails dirty; then exit 1; fi ;;
  "fetch "*) if fails fetch; then exit 1; fi ;;
  "merge --ff-only "*) if fails merge; then echo "fatal: Not possible to fast-forward, aborting." >&2; exit 128; fi ;;
  "rev-list --count "*) echo 0 ;;
  "diff --name-only "*) echo .env.example ;;
esac
exit 0
`;

const CURL_STUB = String.raw`#!/usr/bin/env bash
echo "curl $*" >> "$STUB_LOG"
if [[ " $FAIL_ON " == *" health "* ]]; then printf 000; exit 7; fi
printf 200
`;

type Run = { status: number; output: string; calls: string[]; repo: string };
type Options = {
  env?: Record<string, string | undefined>;
  args?: string[];
  dotenv?: string;
  meminfo?: string;
};

let root = "";
let stubs = "";
let runs = 0;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "agentsdr-deploy-"));
  stubs = join(root, "bin");
  mkdirSync(stubs);
  for (const [name, body] of Object.entries({ docker: DOCKER_STUB, git: GIT_STUB, curl: CURL_STUB })) {
    writeFileSync(join(stubs, name), body);
    chmodSync(join(stubs, name), 0o755);
  }
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

/** Runs deploy.sh in a fresh fake checkout; SKIP_GIT_UPDATE=1 unless overridden. */
function deploy(options: Options = {}): Run {
  const repo = join(root, `repo-${++runs}`);
  mkdirSync(join(repo, "docker"), { recursive: true });
  copyFileSync(SCRIPT, join(repo, "docker", "deploy.sh"));
  for (const file of ["docker-compose.yml", "docker-compose.build.yml", "docker-compose.discovery.yml"]) {
    writeFileSync(join(repo, file), "");
  }
  writeFileSync(join(repo, ".env"), options.dotenv ?? "PORT=3999\n");
  const meminfo = join(repo, "meminfo");
  writeFileSync(meminfo, options.meminfo ?? ENOUGH_MEMORY);
  const log = join(repo, "calls.log");
  writeFileSync(log, "");

  const env: Record<string, string> = {};
  const merged: Record<string, string | undefined> = {
    PATH: `${stubs}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    HOME: root,
    STUB_LOG: log,
    STUB_REV: REV,
    STUB_BRANCH: BRANCH,
    STUB_COMPOSE_VERSION: "2.29.7",
    STUB_SERVICES: "db app gmaps-scraper",
    STUB_RUNNING: "db app gmaps-scraper",
    STUB_SCRIPT_CHANGES: "0",
    FAIL_ON: "",
    MEMINFO_FILE: meminfo,
    SKIP_GIT_UPDATE: "1",
    HEALTH_TIMEOUT_S: "1",
    HEALTH_INTERVAL_S: "0.1",
    WORKER_LOG_TIMEOUT_S: "1",
    ...options.env,
  };
  for (const [key, value] of Object.entries(merged)) if (value !== undefined) env[key] = value;

  const result = Bun.spawnSync(["bash", join(repo, "docker", "deploy.sh"), ...(options.args ?? [])], {
    cwd: repo,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    status: result.exitCode ?? -1,
    output: result.stdout.toString() + result.stderr.toString(),
    calls: readFileSync(log, "utf8").split("\n").filter(Boolean),
    repo,
  };
}

/** A compose call's subcommand and arguments, without its -f flags; null for other calls. */
function composeArgs(call: string): string | null {
  if (!call.startsWith("docker compose ")) return null;
  return call.slice("docker compose ".length).replace(/^(?:-f \S+ )+/, "");
}

function composeCalls(run: Run): string[] {
  return run.calls.map(composeArgs).filter((args): args is string => args !== null);
}

/** Index in the call log of the first compose call starting with `prefix`. */
function composeAt(run: Run, prefix: string): number {
  return run.calls.findIndex((call) => composeArgs(call)?.startsWith(prefix) ?? false);
}

function callAt(run: Run, pattern: RegExp): number {
  return run.calls.findIndex((call) => pattern.test(call));
}

function lastCallAt(run: Run, pattern: RegExp): number {
  return run.calls.findLastIndex((call) => pattern.test(call));
}

function migrationsRun(run: Run): string[] {
  return composeCalls(run)
    .filter((args) => args.startsWith("run "))
    .map((args) => args.match(/scripts\/(\S+)\.ts$/)?.[1] ?? args);
}

function expectNoSwitch(run: Run) {
  expect(run.status).not.toBe(0);
  expect(composeAt(run, "up ")).toBe(-1);
}

describe("docker/deploy.sh", () => {
  test("is executable and parses", () => {
    expect(statSync(SCRIPT).mode & 0o111).toBe(0o111);
    expect(Bun.spawnSync(["bash", "-n", SCRIPT]).exitCode).toBe(0);
  });

  test("happy path: backup, rollback tag, build at the commit, seven migrations in order, switch, checks", () => {
    const run = deploy();
    expect(run.status).toBe(0);

    const dump = composeAt(run, "exec -T db pg_dump -U agentsdr --format=custom agentsdr");
    const verify = composeAt(run, "exec -T db pg_restore --list");
    const tag = callAt(run, /^docker tag sha256:running agentsdr:rollback-\d{8}-\d{6}$/);
    const stopScraper = composeAt(run, "stop gmaps-scraper");
    const build = composeAt(run, `build --build-arg GIT_SHA=${REV} --build-arg NEXT_BUILD_HEAP_MB=4096 app`);
    const firstMigration = composeAt(run, "run --rm --no-deps -T app bun scripts/add-tinyfish.ts");
    const up = composeAt(run, "up -d --no-build");
    const health = callAt(run, /^curl .*http:\/\/127\.0\.0\.1:3999\/sign-in$/);
    const worker = composeAt(run, "logs --no-color --since 2026-10-19T10:00:00.123456789Z app");

    for (const index of [dump, verify, tag, stopScraper, build, firstMigration, up, health, worker]) {
      expect(index).toBeGreaterThanOrEqual(0);
    }
    expect(dump).toBeLessThan(verify);
    expect(verify).toBeLessThan(tag);
    expect(tag).toBeLessThan(stopScraper);
    expect(stopScraper).toBeLessThan(build);
    expect(build).toBeLessThan(firstMigration);
    expect(firstMigration).toBeLessThan(up);
    expect(up).toBeLessThan(health);
    expect(health).toBeLessThan(worker);

    expect(migrationsRun(run)).toEqual(MIGRATIONS);
    expect(composeCalls(run).filter((args) => args.startsWith("run "))).toEqual(
      MIGRATIONS.map((name) => `run --rm --no-deps -T app bun scripts/${name}.ts`),
    );
    // up -d brought the scraper back with the rest; the exit trap has nothing to restart.
    expect(composeAt(run, "start gmaps-scraper")).toBe(-1);

    const backups = readdirSync(join(run.repo, "deploy-backups"));
    const dumpFile = backups.find((name) => /^agentsdr-\d{8}-\d{6}\.dump$/.test(name));
    expect(dumpFile).toBeDefined();
    expect(readFileSync(join(run.repo, "deploy-backups", dumpFile!), "utf8")).toStartWith("PGDMP");
    expect(readFileSync(join(run.repo, "deploy-backups", ".gitignore"), "utf8")).toBe("*\n");
    expect(run.output).toContain(`deployed ${REV}`);
  });

  test.each(["pg_dump", "empty-dump", "pg_restore"])("a failed backup (%s) stops before the build", (failure) => {
    const run = deploy({ env: { FAIL_ON: failure } });
    expectNoSwitch(run);
    expect(composeAt(run, "build ")).toBe(-1);
    expect(composeAt(run, "stop gmaps-scraper")).toBe(-1);
    expect(readdirSync(join(run.repo, "deploy-backups")).filter((name) => name.endsWith(".dump"))).toEqual([]);
  });

  test("the health check follows a PORT that holds a bind address, and an explicit HEALTH_URL wins", () => {
    const cases: [string, Record<string, string>, RegExp][] = [
      ["PORT=127.0.0.1:3000\n", {}, /^curl .*http:\/\/127\.0\.0\.1:3000\/sign-in$/],
      ["PORT=0.0.0.0:3100\n", {}, /^curl .*http:\/\/127\.0\.0\.1:3100\/sign-in$/],
      ["PORT=10.0.0.5:3200\n", {}, /^curl .*http:\/\/10\.0\.0\.5:3200\/sign-in$/],
      ["PORT=[::1]:3300\n", {}, /^curl .*http:\/\/\[::1\]:3300\/sign-in$/],
      ["PORT=3999\n", { PORT: "127.0.0.1:3400" }, /^curl .*http:\/\/127\.0\.0\.1:3400\/sign-in$/],
      ["PORT=127.0.0.1:3000\n", { HEALTH_URL: "http://app.internal:8080/sign-in" }, /^curl .*http:\/\/app\.internal:8080\/sign-in$/],
      ["", {}, /^curl .*http:\/\/127\.0\.0\.1:3000\/sign-in$/],
    ];
    for (const [dotenv, env, url] of cases) {
      const run = deploy({ dotenv, env });
      expect({ dotenv, env, status: run.status }).toEqual({ dotenv, env, status: 0 });
      expect(callAt(run, url)).toBeGreaterThanOrEqual(0);
    }
    const bad = deploy({ dotenv: "PORT=127.0.0.1:http\n" });
    expect(bad.status).not.toBe(0);
    expect(bad.output).toMatch(/PORT '127\.0\.0\.1:http' does not end in a port number; set HEALTH_URL/);
  });

  test("a failed build runs no migration, does not switch, and starts the scraper again", () => {
    const run = deploy({ env: { FAIL_ON: "build" } });
    expectNoSwitch(run);
    expect(migrationsRun(run)).toEqual([]);
    expect(composeAt(run, "build ")).toBeLessThan(composeAt(run, "start gmaps-scraper"));
    expect(run.output).toContain("the image build failed");
  });

  test("a failed migration stops the rest, does not switch, and points agentsdr:local back at the running image", () => {
    const run = deploy({ env: { FAIL_ON: "migration:add-activity" } });
    expectNoSwitch(run);
    expect(migrationsRun(run)).toEqual(MIGRATIONS.slice(0, MIGRATIONS.indexOf("add-activity") + 1));
    expect(run.output).toContain("migration add-activity failed");
    const retag = lastCallAt(run, /^docker tag agentsdr:rollback-\S+ agentsdr:local$/);
    expect(retag).toBeGreaterThan(composeAt(run, "run --rm --no-deps -T app bun scripts/add-activity.ts"));
    expect(composeAt(run, "start gmaps-scraper")).toBeGreaterThan(retag);
  });

  test("too little memory stops before anything else, with the swap file commands", () => {
    const run = deploy({ meminfo: "MemTotal: 8000000 kB\nMemAvailable: 3000000 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n" });
    expectNoSwitch(run);
    expect(composeAt(run, "exec ")).toBe(-1);
    expect(composeAt(run, "build ")).toBe(-1);
    expect(run.output).toContain("sudo fallocate -l 4G /swapfile");
    expect(run.output).toContain("sudo mkswap /swapfile");
    expect(run.output).toContain("/swapfile none swap sw 0 0");
  });

  test("by default every compose call names the build and discovery files", () => {
    const run = deploy();
    expect(run.status).toBe(0);
    const calls = run.calls.filter((call) => call.startsWith("docker compose ") && call !== "docker compose version --short");
    expect(calls.length).toBeGreaterThan(10);
    for (const call of calls) expect(call).toStartWith(`docker compose ${DEFAULT_FILES} `);
  });

  test("a COMPOSE_FILE in .env is used as it is, with no -f flags", () => {
    const run = deploy({
      dotenv: "PORT=3999\nCOMPOSE_FILE=docker-compose.yml:docker-compose.build.yml:docker-compose.discovery.yml\n",
    });
    expect(run.status).toBe(0);
    expect(run.output).toContain("COMPOSE_FILE from .env");
    expect(run.calls.filter((call) => call.startsWith("docker compose -f"))).toEqual([]);
    expect(composeAt(run, "up -d --no-build")).toBeGreaterThanOrEqual(0);
  });

  test("a COMPOSE_FILE without the discovery file needs --yes", () => {
    const dotenv = "COMPOSE_FILE=docker-compose.yml:docker-compose.build.yml\n";
    const refused = deploy({ dotenv });
    expectNoSwitch(refused);
    expect(refused.output).toContain("the Maps scraper will not be configured");
    expect(composeAt(refused, "exec ")).toBe(-1);

    const accepted = deploy({ dotenv, args: ["--yes"] });
    expect(accepted.status).toBe(0);
    expect(composeAt(accepted, "stop gmaps-scraper")).toBe(-1);
  });

  test("a COMPOSE_FILE without the build file is refused", () => {
    const run = deploy({ dotenv: "COMPOSE_FILE=docker-compose.yml:docker-compose.discovery.yml\n", args: ["--yes"] });
    expectNoSwitch(run);
    expect(run.output).toContain("docker-compose.build.yml is not among the compose files");
  });

  test("a failed health check after the switch re-tags the previous image and restarts the app on it", () => {
    const run = deploy({ env: { FAIL_ON: "health" } });
    expect(run.status).not.toBe(0);
    const up = composeAt(run, "up -d --no-build");
    const retag = callAt(run, /^docker tag agentsdr:rollback-\S+ agentsdr:local$/);
    const restart = run.calls.findIndex((call, index) => index > retag && composeArgs(call) === "up -d --no-build app");
    expect(up).toBeGreaterThanOrEqual(0);
    expect(retag).toBeGreaterThan(up);
    expect(restart).toBeGreaterThan(retag);
    expect(run.output).toContain("the migrations stay applied");
  }, 15_000);

  test("a container on another revision after the switch is rolled back", () => {
    const run = deploy({ env: { FAIL_ON: "running-revision" } });
    expect(run.status).not.toBe(0);
    expect(run.output).toContain(`not ${REV}`);
    const retag = callAt(run, /^docker tag agentsdr:rollback-\S+ agentsdr:local$/);
    expect(retag).toBeGreaterThan(composeAt(run, "up -d --no-build"));
    expect(lastCallAt(run, /^docker compose .*up -d --no-build app$/)).toBeGreaterThan(retag);
  });

  test("the git update saves the VM's edits and fast-forwards; it never resets or stashes", () => {
    const run = deploy({ env: { SKIP_GIT_UPDATE: undefined } });
    expect(run.status).toBe(0);
    const fetch = run.calls.indexOf(`git fetch origin +refs/heads/${BRANCH}:refs/remotes/origin/${BRANCH}`);
    const merge = run.calls.indexOf(`git merge --ff-only origin/${BRANCH}`);
    expect(fetch).toBeGreaterThanOrEqual(0);
    expect(merge).toBeGreaterThan(fetch);
    expect(composeAt(run, "exec -T db pg_dump")).toBeGreaterThan(merge);
    expect(run.calls.filter((call) => /^git (reset|stash|checkout)\b/.test(call))).toEqual([]);

    const backups = readdirSync(join(run.repo, "deploy-backups"));
    const patch = backups.find((name) => /^vm-local-\d{8}-\d{6}\.patch$/.test(name));
    const status = backups.find((name) => /^vm-local-\d{8}-\d{6}\.status$/.test(name));
    expect(readFileSync(join(run.repo, "deploy-backups", patch!), "utf8")).toContain("diff --git a/.env.example");
    expect(readFileSync(join(run.repo, "deploy-backups", status!), "utf8")).toContain(" M .env.example");
  });

  test("a refused fast-forward stops before the backup and names the overlapping edit", () => {
    const run = deploy({ env: { SKIP_GIT_UPDATE: undefined, FAIL_ON: "merge" } });
    expectNoSwitch(run);
    expect(composeAt(run, "exec ")).toBe(-1);
    expect(composeAt(run, "build ")).toBe(-1);
    expect(run.output).toContain("git refused to fast-forward");
    expect(run.output).toContain("  .env.example");
  });

  test("on another branch it checks out the deploy branch only when no tracked file is edited", () => {
    const clean = deploy({ env: { SKIP_GIT_UPDATE: undefined, STUB_BRANCH: "main" } });
    expect(clean.status).toBe(0);
    expect(clean.calls.indexOf(`git checkout ${BRANCH}`)).toBeLessThan(clean.calls.indexOf(`git merge --ff-only origin/${BRANCH}`));

    const dirty = deploy({ env: { SKIP_GIT_UPDATE: undefined, STUB_BRANCH: "main", FAIL_ON: "dirty" } });
    expectNoSwitch(dirty);
    expect(dirty.calls.filter((call) => call.startsWith("git checkout") || call.startsWith("git merge"))).toEqual([]);
  });

  test("when the update changes deploy.sh, the new version carries on without updating again", () => {
    const run = deploy({ env: { SKIP_GIT_UPDATE: undefined, STUB_SCRIPT_CHANGES: "1" } });
    expect(run.status).toBe(0);
    expect(run.output).toContain("continuing with the new version");
    expect(run.calls.filter((call) => call.startsWith("git merge"))).toHaveLength(1);
    expect(composeCalls(run).filter((args) => args.startsWith("build "))).toHaveLength(1);
  });

  test("an external database needs EXTERNAL_DB_BACKUP_DONE=1, and is then not dumped", () => {
    const refused = deploy({ env: { STUB_SERVICES: "app gmaps-scraper" } });
    expectNoSwitch(refused);
    expect(refused.output).toContain("EXTERNAL_DB_BACKUP_DONE=1");
    expect(composeAt(refused, "build ")).toBe(-1);

    const accepted = deploy({ env: { STUB_SERVICES: "app gmaps-scraper", EXTERNAL_DB_BACKUP_DONE: "1" } });
    expect(accepted.status).toBe(0);
    expect(composeAt(accepted, "exec ")).toBe(-1);
  });

  test.each([
    ["2.23.9", "refused"],
    ["v2.24.0", "accepted"],
    ["5.6.0", "accepted"],
  ])("docker compose %s is %s", (version, verdict) => {
    const run = deploy({ env: { STUB_COMPOSE_VERSION: version } });
    if (verdict === "accepted") {
      expect(run.status).toBe(0);
    } else {
      expectNoSwitch(run);
      expect(run.output).toContain("older than 2.24");
      expect(composeAt(run, "config")).toBe(-1);
    }
  });
});

// The image runs each default migration from scripts/, so .dockerignore must
// let every one of them into the build context; a missed allow line only
// shows up as a failed deploy on the server (add-pilot-fixes did).
test("every default migration reaches the image: deploy.sh's list is the tested one, each allowed by .dockerignore", () => {
  const defaults = readFileSync(SCRIPT, "utf8").match(/^readonly DEFAULT_MIGRATIONS="([^"]*)"/m)?.[1]?.split(/\s+/).filter(Boolean) ?? [];
  expect(defaults).toEqual(MIGRATIONS);
  const allowed = new Set(readFileSync(join(import.meta.dir, "..", ".dockerignore"), "utf8").split("\n").map((line) => line.trim()));
  expect(defaults.filter((name) => !allowed.has(`!scripts/${name}.ts`))).toEqual([]);
});

test("a CHECK rewritten by several default migrations allows the same values in each, and in db/schema.sql", () => {
  // deploy.sh runs every default migration on every deploy, in order. One that drops a CHECK and adds it back
  // with an older, shorter list fails on any row a later value wrote (a social_research job stopped
  // add-objectives), and the deploy stops there: an earlier migration must carry every later value too.
  const root = join(import.meta.dir, "..");
  const rewrites = new Map<string, { file: string; values: string[] }[]>();
  for (const name of MIGRATIONS) {
    for (const [file] of readFileSync(join(root, "scripts", `${name}.ts`), "utf8").matchAll(/db\/migrations\/[\w.-]+\.sql/g)) {
      const sql = readFileSync(join(root, file), "utf8");
      for (const match of sql.matchAll(/ADD CONSTRAINT (\w+)\s+CHECK \(\s*(?:\w+ IS NULL OR )?\w+ IN \(([^)]*)\)\s*\)/g)) {
        const values = [...match[2]!.matchAll(/'([^']*)'/g)].map((value) => value[1]!).sort();
        const seen = rewrites.get(match[1]!) ?? [];
        if (!seen.some((entry) => entry.file === file)) rewrites.set(match[1]!, [...seen, { file, values }]);
      }
    }
  }
  expect(rewrites.get("assistant_jobs_kind_chk")?.length).toBeGreaterThan(1);
  const schema = readFileSync(join(root, "db/schema.sql"), "utf8");
  for (const [constraint, entries] of rewrites) {
    const fresh = schema.match(new RegExp(`CONSTRAINT ${constraint} CHECK \\(\\((?:\\(\\w+ IS NULL\\) OR \\()?\\(?\\w+ = ANY \\(ARRAY\\[([^\\]]*)\\]`))?.[1];
    const expected = fresh ? [...fresh.matchAll(/'([^']*)'::text/g)].map((value) => value[1]!).sort() : entries.at(-1)!.values;
    for (const entry of entries) expect({ constraint, file: entry.file, values: entry.values }).toEqual({ constraint, file: entry.file, values: expected });
  }
});
