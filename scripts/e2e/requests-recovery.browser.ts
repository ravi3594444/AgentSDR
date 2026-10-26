/** Real local production server, auth, API and disposable DB. Injected read failures only; never providers or sends. */
import { spawn } from "node:child_process";
import { readFileSync, openSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
if (!/^postgres(?:ql)?:\/\/[^/]+@(localhost|127\.0\.0\.1):55479\/agentsdr_review$/.test(process.env.DATABASE_URL ?? "")) throw new Error("Requires disposable local database on 55479");
const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const base = "http://127.0.0.1:3101";
const fixturePath = `/tmp/agentsdr-ui-audit-${process.pid}.json`;
const env = { ...process.env, BETTER_AUTH_URL: base, NEXT_PUBLIC_APP_URL: base, BETTER_AUTH_SECRET: "local-ui-browser-fixture-only-8f3b49fd", UI_AUDIT_FIXTURE: fixturePath, INTERNAL_SCHEDULER: "false", NEXT_TELEMETRY_DISABLED: "1" };
const seed = spawn(process.env.BUN_EXECUTABLE ?? "bun", ["--conditions=react-server", "scripts/e2e/ui-audit.seed.ts"], { cwd: root, env, stdio: "inherit" });
if (await new Promise(resolve => seed.on("exit", resolve)) !== 0) throw new Error("Seed failed");
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as { email: string; password: string; organizationId: string; threadId: string; requestId: string };
const log = openSync(process.env.UI_AUDIT_SERVER_LOG ?? "/tmp/agentsdr-ui-audit-server.log", "w");
const server = spawn("node", ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", "3101"], { cwd: root, env, stdio: ["ignore", log, log], detached: true });
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
const check = (name: string, value: boolean) => { if (!value) throw new Error(`FAIL ${name}`); console.log(`PASS ${name}`); };
try {
  for (let attempt = 0; ; attempt++) {
    try { if ((await fetch(`${base}/sign-in`, { signal: AbortSignal.timeout(30_000) })).ok) break; } catch {}
    if (attempt >= 5) throw new Error("Local production server did not become ready");
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE_PATH, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu", "--no-zygote"] });
  const context = await browser.newContext();
  const login = await context.request.post(`${base}/api/auth/sign-in/email`, { headers: { origin: base }, data: { email: fixture.email, password: fixture.password } });
  check(`real sign-in succeeds (HTTP ${login.status()})`, login.ok());
  const active = await context.request.post(`${base}/api/auth/organization/set-active`, { headers: { origin: base }, data: { organizationId: fixture.organizationId } });
  check("real workspace selection succeeds", active.ok());
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.goto(`${base}/assistant/requests`, { waitUntil: "domcontentloaded", timeout: 120_000 });
  await page.getByTestId("request-row").first().waitFor({ timeout: 60_000 });
  check("browser renders the request from the real API and database", await page.getByText("Research dentists without sending", { exact: true }).count() > 0);
  const row = page.getByTestId("request-row").first();
  await row.locator("button[aria-expanded]").first().click();
  await page.getByText("Matching", { exact: true }).waitFor();
  check("saved request details open", true);
  const summaryResponse = await context.request.get(`${base}/api/assistant/requests/${encodeURIComponent(`r:${fixture.requestId}`)}`);
  const savedSummary = await summaryResponse.json();
  await page.route("**/api/assistant/requests/*", route => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...savedSummary, blocker: "Updated saved status" }) }));
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await page.getByText("Updated saved status", { exact: true }).waitFor();
  check("an expanded request refreshes as background work advances", true);
  await page.unroute("**/api/assistant/requests/*");
  await page.route("**/api/assistant/requests?*", route => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Fixture temporary failure" }) }));
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.getByText("Fixture temporary failure", { exact: true }).waitFor();
  check("an API failure preserves loaded rows and offers retry", await row.count() > 0 && await page.getByRole("button", { name: "Try again", exact: true }).count() > 0);
  await page.unroute("**/api/assistant/requests?*");
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await page.getByText("Fixture temporary failure", { exact: true }).waitFor({ state: "hidden" });
  check("retry recovers through the real API", await row.count() > 0);
  await page.route("**/api/assistant/requests?*", route => route.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  await page.getByText("The saved request list could not be read. Try again.").waitFor();
  check("malformed success is an error, not an empty list", await row.count() > 0);
  await page.unroute("**/api/assistant/requests?*");
  await page.route("**/api/assistant/requests?*", async () => { await new Promise(resolve => setTimeout(resolve, 30_000)); });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.getByText(/Loading took too long/).waitFor({ timeout: 30_000 });
  check("a stalled first read ends with an actionable error rather than endless skeletons", await page.getByRole("button", { name: "Try again", exact: true }).count() > 0 && await page.getByRole("status", { name: "Loading", exact: true }).count() === 0);
  await page.unroute("**/api/assistant/requests?*");
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await page.getByTestId("request-row").first().waitFor();
  check("timeout recovery shows real saved work", await page.getByText("Research dentists without sending", { exact: true }).count() > 0);
  const listResponse = await context.request.get(`${base}/api/assistant/requests`);
  const savedList = await listResponse.json();
  let releaseOld: (() => void) | undefined;
  const oldResponse = new Promise<void>(resolve => { releaseOld = resolve; });
  let markOldFinished: (() => void) | undefined;
  const oldFinished = new Promise<void>(resolve => { markOldFinished = resolve; });
  let oldStarted: (() => void) | undefined;
  const started = new Promise<void>(resolve => { oldStarted = resolve; });
  await page.route("**/api/assistant/requests?*", async route => {
    const query = new URL(route.request().url()).searchParams;
    if (query.get("state") === "open") {
      oldStarted?.(); await oldResponse;
      try { await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...savedList, requests: savedList.requests.map((item: Record<string, unknown>) => ({ ...item, title: "Stale filter result" })) }) }); } catch {} finally { markOldFinished?.(); }
    } else await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...savedList, requests: savedList.requests.map((item: Record<string, unknown>) => ({ ...item, title: "Current filter result" })) }) });
  });
  await page.getByRole("button", { name: "In progress", exact: true }).click(); await started;
  await page.getByRole("button", { name: "Finished", exact: true }).click();
  await page.getByText("Current filter result", { exact: true }).waitFor(); releaseOld?.(); await oldFinished;
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  check("a delayed old filter cannot replace the current view", await page.getByText("Stale filter result", { exact: true }).count() === 0);
  await page.unroute("**/api/assistant/requests?*");
  await page.getByRole("group", { name: "State", exact: true }).getByRole("button", { name: "All", exact: true }).click();
  await page.getByText("Research dentists without sending", { exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  check("Requests fits a phone viewport", await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
  check("no browser runtime errors", pageErrors.length === 0);
  console.log("Requests recovery browser checks passed");
} catch (cause) {
  const failedPage = browser?.contexts()[0]?.pages()[0];
  if (failedPage) console.error("Browser failure state:", (await failedPage.locator("body").innerText()).slice(-6500));
  throw cause;
} finally {
  await browser?.close();
  if (server.pid) try { process.kill(-server.pid, "SIGTERM"); } catch {}
  try { unlinkSync(fixturePath); } catch {}
}
