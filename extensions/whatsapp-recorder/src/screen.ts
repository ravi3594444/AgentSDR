/**
 * Screen control for owner-requested tasks (research.ts runs the commands):
 * a research tab is shown in the AgentSDR task window, its visible part
 * captured, and pointer and keyboard input sent to it, through Chrome's
 * debugger (the DevTools protocol) attached to that one tab only.
 *
 * Why the debugger, measured 28 Oct 2026 in Chromium 153 launched plainly
 * (docs/plans/INTERACTIVE_BROWSER_REPORT_2026-10-28.md has the runs):
 *
 * - A background tab in the owner's window is hidden: Chrome stops drawing
 *   it (one animation frame a second), tabs.captureVisibleTab captures the
 *   owner's ACTIVE tab instead (a different page), and a debugger capture
 *   took 6.5 s or timed out at 8 s. So a tab is first moved into its own
 *   unfocused window, where it is the active tab and drawn: captures there
 *   took about 60 ms. The owner's own window and tabs are left alone.
 * - The debugger's capture names the exact tab, so it can never picture
 *   the owner's other tabs, and its input events are the browser's own
 *   (trusted): canvas drags and real keys work where synthetic page events
 *   are ignored. Its input reached the hidden tab too.
 * - Chrome shows "… started debugging this browser" while it is attached;
 *   the owner's Cancel there is their Stop (research.ts pauses). It is
 *   attached only for a visual step, and detached when the tab goes idle.
 *
 * Coordinates: a screenshot covers the viewport, captured at `scale` image
 * pixels per CSS pixel (at most SCREENSHOT_MAX_SIDE a side). The protocol's
 * clip is in CSS pixels and its image is clip × scale × the screen's device
 * scale factor (page zoom excluded), so the clip scale is scale / that
 * factor; input events take CSS pixels of the viewport, at any zoom (both
 * measured at zoom 125% and device scale 2).
 */

import { SCREENSHOT_MAX_SIDE, type BrowserScreenshot, type VisualOp } from "../../../src/lib/browser/connected/contract";

const TASK_WINDOW_KEY = "researchTaskWindow";
const PROTOCOL = "1.3";
const COMMAND_TIMEOUT_MS = 25_000;
/** A tab the debugger has not been used on for this long is let go. */
export const SCREEN_IDLE_MS = 60_000;

const attached = new Map<number, number>();

export type ScreenMetrics = { width: number; height: number; scrollX: number; scrollY: number; zoom: number };

function send<T>(tabId: number, method: string, params: Record<string, unknown> = {}): Promise<T> {
  return Promise.race([
    chrome.debugger.sendCommand({ tabId }, method, params) as Promise<T>,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`the browser did not answer ${method} in time`)), COMMAND_TIMEOUT_MS)),
  ]);
}

/** Attaches to the tab (once); true when this call attached it. */
async function attach(tabId: number): Promise<boolean> {
  if (attached.has(tabId)) {
    attached.set(tabId, Date.now());
    return false;
  }
  try {
    await chrome.debugger.attach({ tabId }, PROTOCOL);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/already attached/i.test(message)) throw new Error(`Chrome did not allow screen control of that tab: ${message}`);
    // Ours from before a worker restart is fine; DevTools or another extension is not.
    const target = (await chrome.debugger.getTargets()).find((item) => item.tabId === tabId);
    if (!target?.attached || target.extensionId !== chrome.runtime.id) throw new Error("another debugger (DevTools, or another extension) is attached to that tab; the owner has to close it first");
  }
  attached.set(tabId, Date.now());
  return true;
}

export async function release(tabId: number): Promise<void> {
  attached.delete(tabId);
  await chrome.debugger.detach({ tabId }).catch(() => undefined);
}

/** Lets go of tabs idle for SCREEN_IDLE_MS (Chrome's "debugging" bar goes with them). */
export async function releaseIdle(now = Date.now()): Promise<void> {
  for (const [tabId, usedAt] of attached) if (now - usedAt > SCREEN_IDLE_MS) await release(tabId);
}

/** The owner's Cancel on Chrome's bar (or the tab closing): forget the attachment; `onCancelled` hears a Cancel. */
export function watchDetach(onCancelled: (tabId: number) => void): void {
  chrome.debugger.onDetach.addListener((source, reason) => {
    if (source.tabId === undefined) return;
    attached.delete(source.tabId);
    if (reason === "canceled_by_user") onCancelled(source.tabId);
  });
}

/**
 * Shows the tab as the active tab of the AgentSDR task window (created
 * unfocused the first time), so Chrome draws it. Returns the window.
 */
export async function showInTaskWindow(tabId: number): Promise<number> {
  const stored = (await chrome.storage.session.get(TASK_WINDOW_KEY))[TASK_WINDOW_KEY] as number | undefined;
  const tab = await chrome.tabs.get(tabId);
  const existing = stored === undefined ? null : await chrome.windows.get(stored).catch(() => null);
  if (existing?.id !== undefined && tab.windowId === existing.id) {
    if (!tab.active) await chrome.tabs.update(tabId, { active: true });
    return existing.id;
  }
  if (existing?.id !== undefined) {
    await chrome.tabs.move(tabId, { windowId: existing.id, index: -1 });
    await chrome.tabs.update(tabId, { active: true });
    return existing.id;
  }
  const created = await chrome.windows.create({ tabId, focused: false, state: "normal", width: 1200, height: 860 });
  if (created?.id === undefined) throw new Error("Chrome did not open the 22nd x ai task window");
  await chrome.storage.session.set({ [TASK_WINDOW_KEY]: created.id });
  return created.id;
}

type LayoutMetrics = { cssVisualViewport: { pageX: number; pageY: number; clientWidth: number; clientHeight: number; zoom?: number } };

/** The viewport as the debugger sees it now, in CSS pixels. */
export async function metrics(tabId: number): Promise<ScreenMetrics> {
  await attach(tabId);
  const layout = await send<LayoutMetrics>(tabId, "Page.getLayoutMetrics");
  const view = layout.cssVisualViewport;
  const zoom = view.zoom ?? await chrome.tabs.getZoom(tabId);
  return { width: view.clientWidth, height: view.clientHeight, scrollX: view.pageX, scrollY: view.pageY, zoom };
}

/** Same place within a pixel: anything else (a scroll, a resize, a zoom) makes a screenshot's points mean something else. */
export function sameView(a: ScreenMetrics, b: ScreenMetrics): boolean {
  return Math.abs(a.width - b.width) < 1 && Math.abs(a.height - b.height) < 1 && Math.abs(a.scrollX - b.scrollX) < 1
    && Math.abs(a.scrollY - b.scrollY) < 1 && Math.abs(a.zoom - b.zoom) < 0.001;
}

/** A JPEG's size from its start-of-frame marker. */
function jpegSize(base64: string): { width: number; height: number } | null {
  const bytes = Uint8Array.from(atob(base64.slice(0, 200_000)), (char) => char.charCodeAt(0));
  for (let i = 2; i + 9 < bytes.length;) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1]!;
    const length = (bytes[i + 2]! << 8) | bytes[i + 3]!;
    if (marker >= 0xc0 && marker <= 0xc3) return { height: (bytes[i + 5]! << 8) | bytes[i + 6]!, width: (bytes[i + 7]! << 8) | bytes[i + 8]! };
    i += 2 + length;
  }
  return null;
}

/**
 * The viewport once it holds still: attaching makes Chrome show its
 * "started debugging" bar a moment later, which shortens the page, so a
 * screenshot taken before that would be stale at once.
 */
async function settledMetrics(tabId: number): Promise<ScreenMetrics> {
  if (await attach(tabId)) await new Promise((done) => setTimeout(done, 600));
  let previous = await metrics(tabId);
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await new Promise((done) => setTimeout(done, 150));
    const current = await metrics(tabId);
    if (sameView(current, previous)) return current;
    previous = current;
  }
  return previous;
}

/** The tab's visible part, at most SCREENSHOT_MAX_SIDE a side. */
export async function capture(tabId: number): Promise<Omit<BrowserScreenshot, "id" | "url" | "title" | "takenAt">> {
  const view = await settledMetrics(tabId);
  const [frame] = await chrome.scripting.executeScript({ target: { tabId }, func: () => devicePixelRatio });
  const devicePixels = typeof frame?.result === "number" && frame.result > 0 ? frame.result : 1;
  const screenFactor = devicePixels / (view.zoom || 1);
  const scale = Math.min(1, SCREENSHOT_MAX_SIDE / view.width, SCREENSHOT_MAX_SIDE / view.height);
  const shot = await send<{ data: string }>(tabId, "Page.captureScreenshot", {
    format: "jpeg",
    quality: 75,
    clip: { x: view.scrollX, y: view.scrollY, width: view.width, height: view.height, scale: scale / screenFactor },
    captureBeyondViewport: false,
  });
  const size = jpegSize(shot.data) ?? { width: Math.round(view.width * scale), height: Math.round(view.height * scale) };
  return { mediaType: "image/jpeg", data: shot.data, width: size.width, height: size.height, scale: size.width / view.width, viewport: view };
}

const MODIFIER_BITS: Record<string, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
const KEY_CODES: Record<string, number> = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Home: 36, End: 35, PageUp: 33, PageDown: 34, Space: 32 };

async function mouse(tabId: number, type: string, x: number, y: number, extra: Record<string, unknown> = {}): Promise<void> {
  await send(tabId, "Input.dispatchMouseEvent", { type, x, y, ...extra });
}

/** One pointer or keyboard step at CSS point (x, y) of the viewport; the browser's own input, not page events. */
export async function input(tabId: number, step: {
  op: VisualOp;
  x: number;
  y: number;
  toX: number | null;
  toY: number | null;
  deltaX: number | null;
  deltaY: number | null;
  text: string | null;
  key: { key: string; modifiers: string[] } | null;
}): Promise<void> {
  await attach(tabId);
  const { x, y } = step;
  switch (step.op) {
    case "move":
      await mouse(tabId, "mouseMoved", x, y);
      return;
    case "click":
    case "double_click": {
      await mouse(tabId, "mouseMoved", x, y);
      for (let count = 1; count <= (step.op === "double_click" ? 2 : 1); count += 1) {
        await mouse(tabId, "mousePressed", x, y, { button: "left", buttons: 1, clickCount: count });
        await mouse(tabId, "mouseReleased", x, y, { button: "left", buttons: 0, clickCount: count });
      }
      return;
    }
    case "drag": {
      const toX = step.toX ?? x;
      const toY = step.toY ?? y;
      await mouse(tabId, "mouseMoved", x, y);
      await mouse(tabId, "mousePressed", x, y, { button: "left", buttons: 1, clickCount: 1 });
      // In steps, as a hand moves: pages that draw or drop on movement see the path.
      for (let i = 1; i <= 12; i += 1) await mouse(tabId, "mouseMoved", x + ((toX - x) * i) / 12, y + ((toY - y) * i) / 12, { button: "left", buttons: 1 });
      await mouse(tabId, "mouseReleased", toX, toY, { button: "left", buttons: 0, clickCount: 1 });
      return;
    }
    case "scroll":
      await mouse(tabId, "mouseWheel", x, y, { deltaX: step.deltaX ?? 0, deltaY: step.deltaY ?? 0 });
      return;
    case "type":
      if (step.text) await send(tabId, "Input.insertText", { text: step.text });
      return;
    case "key": {
      if (!step.key) return;
      const modifiers = step.key.modifiers.reduce((bits, name) => bits | (MODIFIER_BITS[name] ?? 0), 0);
      const name = step.key.key;
      const printable = [...name].length === 1 ? name : name === "Space" ? " " : "";
      const text = name === "Enter" ? "\r" : printable && !(modifiers & (MODIFIER_BITS.Control! | MODIFIER_BITS.Meta! | MODIFIER_BITS.Alt!)) ? printable : "";
      const code = KEY_CODES[name] ?? printable.toUpperCase().charCodeAt(0);
      const base = { modifiers, key: printable && name !== "Space" ? printable : name === "Space" ? " " : name, code: printable && /^[a-z]$/i.test(printable) ? `Key${printable.toUpperCase()}` : name, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code };
      await send(tabId, "Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", ...base, ...(text ? { text, unmodifiedText: text } : {}) });
      await send(tabId, "Input.dispatchKeyEvent", { type: "keyUp", ...base });
      return;
    }
  }
}
