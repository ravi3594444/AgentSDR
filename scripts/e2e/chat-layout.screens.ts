export {};
/**
 * Screenshots of the assistant chat for the layout review
 * (docs/plans/chat-layout-2026-10-28/): the seeded long request
 * (chat-layout.seed.ts) at desktop 1440×900 and mobile 390×844, in the light
 * default and the dark theme, as the owner first sees it (scrolled to the
 * newest message) and as one tall page of the whole conversation.
 *
 *   bun run scripts/e2e/chat-layout.screens.ts <fixture.json> <out dir> <prefix>
 *
 * Needs BASE_URL (a local server on the disposable database) and
 * CHROMIUM_PATH. Only reads: it signs in and opens the page.
 */
const [fixturePath, outDir, prefix] = process.argv.slice(2);
if (!fixturePath || !outDir || !prefix) throw new Error("Usage: chat-layout.screens.ts <fixture.json> <out dir> <prefix>");
const base = process.env.BASE_URL ?? "http://localhost:3100";
if (!/^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(base)) throw new Error("BASE_URL must be a local server");
const { readFileSync, mkdirSync } = await import("node:fs");
const { chromium } = await import("playwright-core");
const fixture = JSON.parse(readFileSync(fixturePath, "utf8")) as { email: string; password: string; threadId: string };
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, args: ["--no-sandbox"] });
const sizes = [{ name: "desktop", width: 1440, height: 900, mobile: false }, { name: "mobile", width: 390, height: 844, mobile: true }];
const themes = (process.env.THEMES ?? "light,dark").split(",");
for (const theme of themes) {
  for (const size of sizes) {
    const context = await browser.newContext({ viewport: { width: size.width, height: size.height }, deviceScaleFactor: 1, isMobile: size.mobile, hasTouch: size.mobile });
    await context.addInitScript((value) => { try { window.localStorage.setItem("agentsdr-theme", value); } catch { /* storage blocked */ } }, theme);
    const signIn = await context.request.post(`${base}/api/auth/sign-in/email`, { headers: { origin: base }, data: { email: fixture.email, password: fixture.password } });
    if (!signIn.ok()) throw new Error(`Sign-in failed: HTTP ${signIn.status()}`);
    const page = await context.newPage();
    page.on("console", (message) => { if (message.type() === "error") console.log(`${size.name} ${theme} console error: ${message.text().slice(0, 400)}`); });
    page.on("pageerror", (error) => console.log(`${size.name} ${theme} page error: ${error.message.slice(0, 400)}`));
    await page.goto(`${base}/assistant?thread=${fixture.threadId}`, { waitUntil: "networkidle", timeout: 180_000 });
    await page.waitForSelector('[aria-label="Assistant conversation"]', { timeout: 60_000 });
    await page.waitForTimeout(2_500);
    const file = (view: string) => `${outDir}/${prefix}-${size.name}-${theme}-${view}.png`;
    await page.screenshot({ path: file("viewport") });
    // The request panel: closed at first, opened and closed from the keyboard, the message box not moving.
    const toggle = page.getByTestId("request-panel-toggle");
    if (await toggle.count()) {
      const composer = page.getByLabel("Message the assistant");
      const before = await composer.boundingBox();
      const panelAtFirst = await page.getByTestId("request-panel").count();
      await toggle.focus();
      await page.keyboard.press("Enter");
      await page.getByTestId("request-panel").waitFor({ timeout: 30_000 });
      await page.waitForTimeout(1_500);
      const expanded = await toggle.getAttribute("aria-expanded");
      await page.screenshot({ path: file("panel") });
      const during = await composer.boundingBox();
      await page.keyboard.press("Escape");
      await page.waitForTimeout(300);
      const closed = (await page.getByTestId("request-panel").count()) === 0;
      const focusBack = await page.evaluate(() => document.activeElement?.getAttribute("data-testid"));
      const after = await composer.boundingBox();
      console.log(`${size.name} ${theme} panel: open at first=${panelAtFirst > 0}, aria-expanded after Enter=${expanded}, closed by Escape=${closed}, focus back on toggle=${focusBack === "request-panel-toggle"}, message box y ${before?.y} → ${during?.y} → ${after?.y}`);
    }
    // The whole conversation as one tall page: the chat's own scroller grown to its content.
    const height = await page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>('[aria-label="Assistant conversation"]');
      return scroller ? scroller.scrollHeight : 0;
    });
    await page.setViewportSize({ width: size.width, height: Math.min(12_000, size.height + Math.max(0, height - size.height / 2)) });
    await page.waitForTimeout(800);
    await page.evaluate(() => document.querySelector<HTMLElement>('[aria-label="Assistant conversation"]')?.scrollTo({ top: 0 }));
    await page.waitForTimeout(400);
    await page.screenshot({ path: file("full") });
    // Scroll boxes inside the conversation, with every disclosure opened: there should be none.
    const nested = await page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>('[aria-label="Assistant conversation"]');
      if (!scroller) return -1;
      scroller.querySelectorAll("details").forEach((element) => { element.open = true; });
      return [...scroller.querySelectorAll<HTMLElement>("*")].filter((element) => {
        const style = getComputedStyle(element);
        return /(auto|scroll)/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 1;
      }).length;
    });
    console.log(`${size.name} ${theme}: scroll boxes inside the conversation with all details open = ${nested}`);
    await context.close();
    console.log(`${prefix} ${size.name} ${theme}: captured`);
  }
}
await browser.close();
process.exit(0);
