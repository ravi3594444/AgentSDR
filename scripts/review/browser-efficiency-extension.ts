/** Actual extension controller, stand-in Chrome/DOM/bridge. No browser or account is used. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { BrowserResearchAction, BrowserResearchCommand, BrowserResearchResult } from "@/lib/browser/connected/contract";

const repo = resolve(import.meta.dir, "../..");
const local: Record<string, unknown> = {};
const session: Record<string, unknown> = {};
const event = { addListener() {} };
const storage = (data: Record<string, unknown>) => ({ async get(key: string) { return { [key]: data[key] }; }, async set(patch: Record<string, unknown>) { Object.assign(data, patch); }, async remove(key: string) { delete data[key]; } });
type Tab = { id: number; url: string; title: string; status: string; windowId: number; index: number; groupId: number };
const tabs = new Map<number, Tab>();
const requestId = randomUUID();
const url = "https://web.whatsapp.com/send?phone=12025550101";
const conn = { apiBase: "https://app.fixture.net", token: "fixture-token", connectionId: randomUUID(), organizationName: "Fixture", userEmail: "owner@fixture.net", sites: ["web"], lastSeq: 0, paused: false };
let creates = 0, navigations = 0, probes = 0, reads = 0;
let mode = "ready";
let draft = "Existing draft";
let answered: BrowserResearchResult | null = null;
const chromeStandIn = {
  storage: { local: storage(local), session: storage(session) },
  runtime: { id: "fixture", onMessage: event, onStartup: event, onInstalled: event, getManifest: () => ({ version: "0.19.0" }), getPlatformInfo: async () => ({}), getURL: (path: string) => `chrome-extension://fixture/${path}` },
  tabs: {
    onRemoved: event, onUpdated: event,
    async get(id: number) { const tab = tabs.get(id); if (!tab) throw new Error("tab closed"); return { ...tab }; },
    async create(input: { url: string }) { creates++; const tab = { id: 100 + creates, url: input.url, title: "WhatsApp", status: "complete", windowId: 1, index: 0, groupId: -1 }; tabs.set(tab.id, tab); return tab; },
    async update(id: number, patch: Partial<Tab>) { if (patch.url) navigations++; Object.assign(tabs.get(id)!, patch); return tabs.get(id); },
    async group() { return 1; }, async remove(id: number) { tabs.delete(id); },
  },
  windows: { getLastFocused: async () => ({ id: 1 }) }, tabGroups: { get: async () => ({ id: 1 }), update: async () => ({}) },
  permissions: { contains: async () => true },
  scripting: { async executeScript(input: { args: unknown[] }) {
    const op = input.args[1] as { op: string };
    if (op.op === "ready") {
      probes++;
      if (mode === "stop") local.researchConnection = { ...local.researchConnection as object, paused: true };
      if (mode === "replace") local.researchConnection = { ...conn, token: "new-workspace", lastSeq: 0 };
      return [{ result: { ok: true, ready: mode === "ready" || mode === "delayed" && probes >= 3 } }];
    }
    if (op.op !== "snapshot") throw new Error(`Wait performed a page action: ${op.op}`);
    reads++;
    return [{ result: { ok: true, snapshot: { url, title: "WhatsApp", text: "Fixture chat", elements: [{ n: 1, kind: "input", label: "Message", href: null, write: false, search: false, field: { type: "editor", value: draft } }], scroll: { y: 0, height: 800, viewport: 800 }, attention: null, readAt: new Date().toISOString() } } }];
  } },
  action: { getBadgeText: async () => "", setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {}, setTitle: async () => {} },
  alarms: { onAlarm: event, create: async () => {}, clear: async () => {} }, debugger: { onDetach: event },
};
Object.assign(globalThis, { chrome: chromeStandIn });
const transpiler = new Bun.Transpiler({ loader: "ts", target: "bun" });
const screenSource = readFileSync(`${repo}/extensions/whatsapp-recorder/src/screen.ts`, "utf8").replace('"../../../src/lib/browser/connected/contract"', `"${repo}/src/lib/browser/connected/contract.ts"`);
const screenModule = `data:text/javascript;base64,${Buffer.from(transpiler.transformSync(screenSource)).toString("base64")}`;
const source = readFileSync(`${repo}/extensions/whatsapp-recorder/src/research.ts`, "utf8")
  .replace('"../../../src/lib/browser/connected/contract"', `"${repo}/src/lib/browser/connected/contract.ts"`)
  .replace('"../../../src/lib/browser/connected/readiness"', `"${repo}/src/lib/browser/connected/readiness.ts"`)
  .replace('"./screen"', `"${screenModule}"`);
const runtime = await import(`data:text/javascript;base64,${Buffer.from(transpiler.transformSync(`${source}\nexport { runCommand };`)).toString("base64")}`) as { runCommand(connection: typeof conn, command: BrowserResearchCommand): Promise<boolean> };
await Bun.sleep(0);
const realFetch = globalThis.fetch;
globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => { answered = JSON.parse(String(init?.body)).result; return Response.json({ ok: true }); }) as typeof fetch;
let checks = 0;
const check = (label: string, ok: unknown) => { if (!ok) throw new Error(label); checks++; console.log(`PASS ${label}`); };
function reset(owner = requestId) {
  creates = navigations = probes = reads = 0; answered = null; mode = "ready"; draft = "Existing draft";
  local.researchConnection = { ...conn }; local.researchDeviceId = randomUUID();
  session.researchTabs = { 1: { requestId: owner, createdAt: Date.now(), lastUsedAt: Date.now(), attention: null } };
  session.researchGroups = {};
  session.researchSharedTabs = [];
  tabs.clear(); tabs.set(1, { id: 1, url, title: "WhatsApp", status: "complete", windowId: 1, index: 0, groupId: -1 });
}
const command = (action: BrowserResearchAction): BrowserResearchCommand => ({ id: randomUUID(), seq: 1, requestId, issuedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 5_000).toISOString(), action });
const answer = () => answered as BrowserResearchResult | null;
try {
  reset(); mode = "delayed";
  const open = command({ kind: "open", url, tabId: null });
  await runtime.runCommand(conn, open);
  check("an exact same-request chat is reused without creating or navigating a tab", creates === 0 && navigations === 0 && answer()?.timing?.reusedTab === true);
  check("three local readiness probes become one final page observation", probes === 3 && reads === 1 && answer()?.readiness?.state === "ready");
  check("the existing draft is preserved and no input/click script ran", answer()?.ok && draft === "Existing draft");
  check("execution and readiness durations are returned", typeof answer()?.timing?.browserMs === "number" && typeof answer()?.timing?.readyWaitMs === "number");
  const before = probes + reads;
  await runtime.runCommand(conn, open);
  check("replaying the same command does not run page operations again", probes + reads === before);

  reset(randomUUID()); await runtime.runCommand(conn, command({ kind: "open", url, tabId: null }));
  check("another request's tab is not reused or navigated", creates === 1 && navigations === 0);
  reset(); await runtime.runCommand(conn, command({ kind: "open", url, tabId: null, reuse: false }));
  check("an explicit fresh tab remains available", creates === 1);
  reset(); await runtime.runCommand(conn, command({ kind: "open", url: url.replace("0101", "0102"), tabId: null }));
  check("a different recipient URL is not treated as the same chat", creates === 1);
  reset(); mode = "never"; await runtime.runCommand(conn, command({ kind: "read", tabId: 1, waitFor: { selector: "#absent", timeoutMs: 10 } }));
  check("a missing condition returns timeout plus one current observation, not success for readiness", answer()?.readiness?.state === "timeout" && reads === 1);
  reset(randomUUID());
  const sharedConnection = { ...conn, sites: [] };
  local.researchConnection = sharedConnection;
  session.researchSharedTabs = [{ tabId: 1, url, title: "Shared chat" }];
  await runtime.runCommand(sharedConnection, command({ kind: "read", tabId: 1, waitFor: { selector: "#composer" } }));
  check("a toolbar-shared tab keeps its existing read-only access when waiting", answer()?.ok && answer()?.readiness?.state === "ready" && probes === 1 && reads === 1);
  reset(randomUUID()); local.researchConnection = sharedConnection;
  await runtime.runCommand(sharedConnection, command({ kind: "read", tabId: 1, waitFor: { selector: "#composer" } }));
  check("a tab that is neither owned nor shared is not probed", answer()?.ok === false && probes === 0 && reads === 0);
  reset(); mode = "stop"; await runtime.runCommand(conn, command({ kind: "read", tabId: 1, waitFor: { selector: "#composer" } }));
  check("Stop during the wait prevents the final read and all following page actions", answer()?.ok === false && answer()?.readiness?.state === "cancelled" && reads === 0);
  reset(); mode = "replace"; await runtime.runCommand(conn, command({ kind: "read", tabId: 1, waitFor: { selector: "#composer" } }));
  check("a connection replacement cancels the old wait and preserves the new sequence", answer()?.ok === false && (local.researchConnection as typeof conn).lastSeq === 0 && reads === 0);
  reset(); const expired = command({ kind: "read", tabId: 1, waitFor: { selector: "#composer" } }); expired.expiresAt = new Date(Date.now() - 1).toISOString();
  await runtime.runCommand(conn, expired);
  check("an expired command runs no page operations", probes === 0 && reads === 0);
  console.log(`Browser efficiency extension checks: ${checks} passed (actual controller; stand-in Chrome/DOM/bridge).`);
} finally { globalThis.fetch = realFetch; delete local.researchConnection; }
