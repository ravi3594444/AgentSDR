import { describe, expect, test } from "bun:test";
import { browserReadiness, browserTiming, defaultPageWait, reusablePage, waitForProblem, waitForReady } from "./readiness";

describe("page conditions stay read-only and bounded", () => {
  test("a delayed composer is handled locally and returns one readiness outcome", async () => {
    let at = 0;
    let probes = 0;
    const outcome = await waitForReady({ selector: "footer [contenteditable=true]", timeoutMs: 2_000 }, {
      expiresAt: 10_000, now: () => at, sleep: async (ms) => { at += ms; }, stopped: async () => null,
      probe: async () => ({ ready: ++probes >= 4 }),
    });
    expect(outcome).toEqual({ state: "ready", waitedMs: 750, checks: 4 });
  });

  test("an absent condition times out truthfully, never claims success", async () => {
    let at = 0;
    const outcome = await waitForReady({ text: "Contact saved", timeoutMs: 500 }, {
      expiresAt: 10_000, now: () => at, sleep: async (ms) => { at += ms; }, stopped: async () => null, probe: async () => ({ ready: false }),
    });
    expect(outcome.state).toBe("timeout");
    expect(outcome.waitedMs).toBe(500);
    expect(outcome.reason).toContain("nothing was submitted or sent");
  });

  test("Stop or disconnect interrupts the wait before another probe", async () => {
    let at = 0;
    let probes = 0;
    const outcome = await waitForReady({ selector: "#composer" }, {
      expiresAt: 10_000, now: () => at, sleep: async (ms) => { at += ms; }, stopped: async () => at >= 250 ? "owner pressed Stop" : null,
      probe: async () => { probes++; return { ready: false }; },
    });
    expect(outcome.state).toBe("cancelled");
    expect(probes).toBe(1);
  });

  test("Stop wins when the page becomes ready during the same probe", async () => {
    let stop = false;
    const outcome = await waitForReady({ selector: "#composer" }, {
      expiresAt: Date.now() + 10_000, stopped: async () => stop ? "disconnected" : null,
      probe: async () => { stop = true; return { ready: true }; },
    });
    expect(outcome.state).toBe("cancelled");
  });

  test("command expiry interrupts a longer page wait", async () => {
    let at = 0;
    const outcome = await waitForReady({ selector: "#composer", timeoutMs: 5_000 }, {
      expiresAt: 300, now: () => at, sleep: async (ms) => { at += ms; }, stopped: async () => null, probe: async () => ({ ready: false }),
    });
    expect(outcome.state).toBe("cancelled");
    expect(outcome.waitedMs).toBe(300);
  });

  test("sign-in and challenge pages end the wait, while invalid selectors propagate as errors", async () => {
    expect((await waitForReady({ text: "Ready" }, { expiresAt: Date.now() + 1_000, stopped: async () => null, probe: async () => ({ ready: false, blocked: true }) })).state).toBe("blocked");
    await expect(waitForReady({ selector: "[" }, { expiresAt: Date.now() + 1_000, stopped: async () => null, probe: async () => { throw new Error("invalid CSS selector"); } })).rejects.toThrow("invalid CSS");
  });

  test("conditions do not accept executable code or an unbounded timeout", () => {
    expect(waitForProblem({ selector: "footer", text: "Ready", timeoutMs: 0 })).toBeNull();
    for (const bad of [null, {}, { selector: "" }, { text: 1 }, { selector: "footer", timeoutMs: 30_001 }, { selector: "footer", code: "submit()" }]) expect(waitForProblem(bad)).not.toBeNull();
  });
});

describe("exact-page reuse preserves ownership, destination and drafts", () => {
  const tab = (patch: Record<string, unknown> = {}) => ({ tabId: 1, requestId: "mine", url: "https://web.whatsapp.com/send?phone=12025550101", lastUsedAt: 10, ...patch });
  test("reuse has no navigation and picks only this request's exact live URL", () => {
    expect(reusablePage([tab()], "mine", tab().url)?.tabId).toBe(1);
    expect(reusablePage([tab({ requestId: "other" })], "mine", tab().url)).toBeUndefined();
    expect(reusablePage([tab({ home: { windowId: 3 } })], "mine", tab().url)).toBeUndefined();
    expect(reusablePage([tab()], "mine", "https://web.whatsapp.com/send?phone=12025550102")).toBeUndefined();
    expect(reusablePage([tab({ url: `${tab().url}#other-chat` })], "mine", tab().url)).toBeUndefined();
    expect(reusablePage([tab(), tab({ tabId: 2, lastUsedAt: 20 })], "mine", tab().url)?.tabId).toBe(2);
  });
  test("only a WhatsApp chat entry, not the home page or a look-alike, gets a composer wait", () => {
    expect(defaultPageWait(tab().url)?.selector).toContain("#main footer");
    for (const url of ["https://web.whatsapp.com/", "https://web.whatsapp.com.attacker.net/send?phone=12025550101", "http://web.whatsapp.com/send?phone=12025550101", "https://web.whatsapp.com/send?phone=bad"]) expect(defaultPageWait(url)).toBeUndefined();
  });
});

test("untrusted diagnostics are finite, bounded and cannot add action fields", () => {
  expect(browserTiming({ browserMs: 12.8, queueMs: -1, roundTripMs: Infinity, readyWaitMs: "5", reusedTab: true, send: true })).toEqual({ browserMs: 13, reusedTab: true });
  expect(browserReadiness({ state: "sent", waitedMs: 0, checks: 1 })).toBeUndefined();
  expect(browserReadiness({ state: "timeout", waitedMs: 1, checks: 2 })).toEqual({ state: "timeout", waitedMs: 1, checks: 2 });
});
