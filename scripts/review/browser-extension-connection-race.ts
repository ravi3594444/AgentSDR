import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
const repo = resolve(import.meta.dir, "../..");
const key = "researchConnection";
const local: Record<string, unknown> = {};
const session: Record<string, unknown> = {};
const event = { addListener() {} };
const storage = (data: Record<string, unknown>) => ({
  async get(keys: string) { return { [keys]: data[keys] }; },
  async set(patch: Record<string, unknown>) { Object.assign(data, patch); },
  async remove(keys: string) { delete data[keys]; },
});
Object.assign(globalThis, { chrome: {
  storage: { local: storage(local), session: storage(session) },
  runtime: { id: "fixture", onMessage: event, onStartup: event, onInstalled: event, getManifest() { return { version: "0.16.0" }; }, async getPlatformInfo() { return {}; }, getURL(path: string) { return `chrome-extension://fixture/${path}`; } },
  tabs: { onRemoved: event, onUpdated: event },
  action: { async getBadgeText() { return ""; }, async setBadgeText() {}, async setBadgeBackgroundColor() {}, async setTitle() {} },
  alarms: { onAlarm: event, async create() {}, async clear() {} },
  debugger: { onDetach: event },
} });
const transpiler = new Bun.Transpiler({ loader: "ts", target: "bun" });
// research.ts imports its screen-control module (0.17.0); it is loaded the same way, its contract import made absolute.
const screenSource = readFileSync(`${repo}/extensions/whatsapp-recorder/src/screen.ts`, "utf8")
  .replace('"../../../src/lib/browser/connected/contract"', `"${repo}/src/lib/browser/connected/contract.ts"`);
const screenModule = `data:text/javascript;base64,${Buffer.from(transpiler.transformSync(screenSource)).toString("base64")}`;
const source = readFileSync(`${repo}/extensions/whatsapp-recorder/src/research.ts`, "utf8")
  .replace('"../../../src/lib/browser/connected/contract"', `"${repo}/src/lib/browser/connected/contract.ts"`)
  .replace('"./screen"', `"${screenModule}"`);
const moduleText = transpiler.transformSync(`${source}\nexport { pollLoop };\n`);
const extensionRuntime = await import(`data:text/javascript;base64,${Buffer.from(moduleText).toString("base64")}`) as { pollLoop(): Promise<void> };
await new Promise((done) => setTimeout(done, 0));
const old = { apiBase: "https://app.fixture.test", token: "old-workspace-token", connectionId: randomUUID(), organizationName: "A", userEmail: "a@fixture.test", sites: ["web"], lastSeq: 4, paused: false };
const replacement = !process.argv.includes("--same-connection");
const next = replacement ? { ...old, token: "new-workspace-token", connectionId: randomUUID(), organizationName: "B", lastSeq: 0 } : { ...old };
local[key] = old;
local.researchDeviceId = randomUUID();
let release: ((response: Response) => void) | null = null;
let started: (() => void) | null = null;
const pending = new Promise<void>((done) => { started = done; });
let postedWith: string | null = null;
let firstPoll = true;
let observedNextSeq: unknown = null;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  const token = (init?.headers as Record<string, string>)?.Authorization;
  if (firstPoll && url.endsWith("/poll") && token === `Bearer ${old.token}`) {
    firstPoll = false;
    started!();
    return new Promise<Response>((done) => { release = done; });
  }
  if (url.includes("/commands/")) { postedWith = token; return Response.json({ ok: true }); }
  if (url.endsWith("/poll") && token === `Bearer ${next.token}`) {
    observedNextSeq = (local[key] as { lastSeq: number }).lastSeq;
    delete local[key];
    return Response.json({ commands: [], serverTime: new Date().toISOString() });
  }
  throw new Error(`Unexpected fixture request ${url}`);
}) as typeof fetch;
try {
  const loop = extensionRuntime.pollLoop();
  await pending;
  local[key] = next; // The owner reconnects/switches workspace while the earlier long poll is pending.
  const resume = release as unknown as (response: Response) => void;
  resume(Response.json({ serverTime: new Date().toISOString(), commands: [{ id: randomUUID(), seq: 9, requestId: randomUUID(), issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60_000).toISOString(), action: { kind: "tabs" } }] }));
  await loop;
  const result = { check: replacement ? "old connection's poll cannot consume the replacement's sequence or token" : "control: the current connection handles its own command", passed: replacement ? observedNextSeq === 0 && postedWith !== `Bearer ${next.token}` : observedNextSeq === 9 && postedWith === `Bearer ${old.token}`, observedNextSeq, connectionReplaced: replacement, oldCommandPostedUsingNewToken: replacement && postedWith === `Bearer ${next.token}` };
  console.log(JSON.stringify(result));
  if (!result.passed) process.exitCode = 1;
} finally { globalThis.fetch = realFetch; }
