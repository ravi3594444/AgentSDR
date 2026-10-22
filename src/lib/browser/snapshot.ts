/**
 * What the assistant sees of a page in the remote browser: its address,
 * title, visible text and the interactive elements, numbered so the model
 * can say "click 4" or "fill 2". Pure; driver.ts takes the snapshot inside
 * the page and browser.server.ts decides what may be done with it.
 */

export type PageElement = {
  n: number;
  tag: string;
  type: string | null;
  label: string;
  href: string | null;
};

export type PageSnapshot = { url: string; title: string; text: string; elements: PageElement[] };

export const BROWSER_LIMITS = {
  /** A session's longest life; its minutes are reserved up front. */
  maxSessionMinutes: 10,
  /** Idle seconds after which TinyFish itself ends the session. */
  idleTimeoutSeconds: 300,
  /** Idle minutes after which AgentSDR closes it at the next chance. */
  idleCloseMinutes: 5,
  maxTextChars: 12_000,
  maxElements: 150,
} as const;

/**
 * Runs inside the page (page.evaluate): numbers the visible interactive
 * elements with data-agentsdr-n and returns the snapshot. Kept as a string
 * so no bundler rewrites it; it uses only the page's own DOM.
 */
export const SNAPSHOT_SCRIPT = `(() => {
  const selector = 'a[href], button, input:not([type=hidden]), select, textarea, [role=button], [role=link], [role=tab], [role=checkbox]';
  document.querySelectorAll('[data-agentsdr-n]').forEach((el) => el.removeAttribute('data-agentsdr-n'));
  const out = [];
  let n = 0;
  for (const el of Array.from(document.querySelectorAll(selector))) {
    const box = el.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) continue;
    const style = getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') continue;
    n += 1;
    if (n > ${BROWSER_LIMITS.maxElements}) break;
    el.setAttribute('data-agentsdr-n', String(n));
    const label = (el.getAttribute('aria-label') || el.innerText || el.getAttribute('placeholder') || el.getAttribute('name') || el.getAttribute('title') || el.getAttribute('value') || '').trim().replace(/\\s+/g, ' ').slice(0, 80);
    out.push({ n, tag: el.tagName.toLowerCase(), type: el.getAttribute('type'), label, href: el.getAttribute('href') ? el.href : null });
  }
  return { url: location.href, title: document.title, text: document.body ? document.body.innerText.slice(0, ${BROWSER_LIMITS.maxTextChars}) : '', elements: out };
})()`;

/** One element as the model reads it, e.g. `[4] link "Next page" → https://…`. */
export function elementLine(element: PageElement): string {
  const kind = element.tag === "a" ? "link" : element.tag === "input" ? `input${element.type ? `:${element.type}` : ""}` : element.tag;
  return `[${element.n}] ${kind} "${element.label || "(no label)"}"${element.href ? ` → ${element.href}` : ""}`;
}

/** The snapshot as the model reads it. */
export function formatSnapshot(snapshot: PageSnapshot): string {
  const elements = snapshot.elements.slice(0, BROWSER_LIMITS.maxElements);
  return [
    `Page: ${snapshot.url}${snapshot.title ? ` “${snapshot.title.slice(0, 200)}”` : ""}`,
    `Elements: ${elements.length ? elements.map(elementLine).join(" ") : "none"}`,
    `Text: ${snapshot.text.replace(/\s+/g, " ").trim().slice(0, BROWSER_LIMITS.maxTextChars)}`,
  ].join("\n");
}

/** Why an element may not be filled, or null: credentials are never typed by the assistant. */
export function fillProblem(element: PageElement | undefined): string | null {
  if (!element) return "there is no such element on the page; read the page again for the current numbers";
  if (element.type === "password") return "it is a password field: the assistant never types credentials or logs in";
  if (element.tag !== "input" && element.tag !== "textarea" && element.tag !== "select") return "it is not a text field";
  return null;
}

/** Minutes a session used, rounded up (TinyFish bills by the minute), at least 1. */
export function minutesBetween(start: Date, end: Date): number {
  return Math.max(1, Math.ceil((end.getTime() - start.getTime()) / 60_000));
}
