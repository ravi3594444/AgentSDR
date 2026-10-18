import "server-only";

import { SNAPSHOT_SCRIPT, type PageSnapshot } from "./snapshot";

/**
 * The few things the assistant does in a remote browser, behind an
 * interface so tests use a fake. The real driver connects to TinyFish
 * Browser's CDP URL with playwright-core (no local browser): the browser
 * runs on TinyFish, never on this server.
 */
export type BrowserPage = {
  goto(url: string): Promise<void>;
  snapshot(): Promise<PageSnapshot>;
  click(n: number): Promise<void>;
  fill(n: number, text: string, submit: boolean): Promise<void>;
  scroll(direction: "down" | "up"): Promise<void>;
  url(): string;
  /** Drops the connection; the session itself is ended through TinyFish's API. */
  disconnect(): Promise<void>;
};

export type BrowserConnector = (cdpUrl: string) => Promise<BrowserPage>;

const ACTION_TIMEOUT_MS = 15_000;

async function playwrightConnect(cdpUrl: string): Promise<BrowserPage> {
  const { chromium } = await import("playwright-core");
  const browser = await chromium.connectOverCDP(cdpUrl, { timeout: 30_000 });
  const context = browser.contexts()[0] ?? (await browser.newContext());
  const page = context.pages()[0] ?? (await context.newPage());
  const settle = () => page.waitForLoadState("domcontentloaded", { timeout: ACTION_TIMEOUT_MS }).catch(() => undefined);
  const element = (n: number) => page.locator(`[data-agentsdr-n="${n}"]`).first();
  return {
    goto: async (url) => {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    },
    snapshot: async () => (await page.evaluate(SNAPSHOT_SCRIPT)) as PageSnapshot,
    click: async (n) => {
      await element(n).click({ timeout: ACTION_TIMEOUT_MS });
      await settle();
    },
    fill: async (n, text, submit) => {
      await element(n).fill(text, { timeout: ACTION_TIMEOUT_MS });
      if (submit) {
        await element(n).press("Enter", { timeout: ACTION_TIMEOUT_MS });
        await settle();
      }
    },
    scroll: async (direction) => {
      await page.mouse.wheel(0, direction === "down" ? 900 : -900);
      await page.waitForTimeout(400);
    },
    url: () => page.url(),
    disconnect: async () => {
      // Closing a CDP-connected browser drops our connection; TinyFish ends the session on DELETE.
      await browser.close().catch(() => undefined);
    },
  };
}

let connector: BrowserConnector = playwrightConnect;

/** Test hook: a fake browser instead of playwright-core and TinyFish. */
export function setBrowserConnector(next: BrowserConnector | null): void {
  connector = next ?? playwrightConnect;
}

export function connectBrowser(cdpUrl: string): Promise<BrowserPage> {
  return connector(cdpUrl);
}
