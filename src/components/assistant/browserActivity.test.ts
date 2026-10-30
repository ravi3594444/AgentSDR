import { expect, test } from "bun:test";
import { browserActivity, browserTimingDetails, isConnectedBrowserTool } from "./browserActivity";

const step = (tool: string, data: Record<string, unknown> = {}) => ({ tool, status: "ok", toolResult: { data } });
test("a send task is browser activity with its goal and site, never a claim of delivery", () => {
  expect(browserActivity([step("browser_task", { grant: { goal: 'Send "hi" to the confirmed number' } }), step("browser_tab_open", { url: "https://web.whatsapp.com/send?phone=12025550101" }), step("browser_tab_visual")]))
    .toEqual({ label: "Chrome · WhatsApp", goal: 'Send "hi" to the confirmed number', waiting: false });
});
test("mixed research and browser steps keep provider searches distinct", () => {
  expect(browserActivity([step("web_search"), step("browser_open"), step("browser_tab_read", { url: "https://acme.net" })])?.label).toBe("Chrome · acme.net");
  expect(browserActivity([step("web_search"), step("browser_open")])).toBeNull();
  expect(isConnectedBrowserTool("browser_tab_act")).toBe(true);
  expect(isConnectedBrowserTool("find_customers_on_web")).toBe(false);
});
test("a readiness timeout is visible as waiting and disappears after a later successful observation", () => {
  const wait = step("browser_tab_read", { readiness: { state: "timeout" } });
  expect(browserActivity([wait])?.waiting).toBe(true);
  expect(browserActivity([wait, step("browser_tab_read", { readiness: { state: "ready" } })])?.waiting).toBe(false);
});
test("timing details show measured phases, label overlap and omit invalid values", () => {
  const text = browserTimingDetails({ browserMs: 2_000, readyWaitMs: 1_000, queueMs: 0, roundTripMs: 2_500, authorizationMs: NaN });
  expect(text).toContain("Browser: 2.0 s");
  expect(text).toContain("Readiness wait (within browser time): 1.0 s");
  expect(text).toContain("Queue: 0 ms");
  expect(text).not.toContain("Task authorization");
  expect(browserTimingDetails({ browserMs: "5", queueMs: -1 })).toBeNull();
});
