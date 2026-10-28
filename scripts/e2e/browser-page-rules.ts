/**
 * What the connected browser's page script lets the assistant click and type,
 * checked on real DOM in Chromium (no server, database or network): the
 * same pageScript the extension injects, evaluated the way executeScript
 * evaluates it (its source, with its arguments). Each fixture counts the
 * page's own click and submit handlers, so "refused" means nothing ran.
 *
 *   bun scripts/e2e/browser-page-rules.ts
 */
import { chromium, type Page } from "playwright-core";
import { clickProblem, pageScript, pageScriptConfig, searchProblem, type PageOp, type PageScriptResult, type ResearchElement } from "@/lib/browser/connected/contract";

const executablePath = process.env.BROWSER_EXECUTABLE_PATH ?? "/opt/pw-browsers/chromium-1243/chrome-linux64/chrome";
let checks = 0;
function check(label: string, value: unknown, observed?: unknown) {
  if (!value) throw new Error(`FAIL ${label}${observed === undefined ? "" : ` — ${JSON.stringify(observed)}`}`);
  checks++;
  console.log(`PASS ${label}`);
}

const run = (page: Page, op: PageOp) => page.evaluate(`(${pageScript.toString()})(${JSON.stringify(pageScriptConfig)}, ${JSON.stringify(op)})`) as Promise<PageScriptResult>;
const effects = (page: Page) => page.evaluate("window.effects") as Promise<number>;

/** Loads `body` with every click and submit handler counted, and reads it. */
async function load(page: Page, body: string): Promise<ResearchElement[]> {
  await page.setContent(`<!doctype html><html><body>${body}<script>
    window.effects = 0;
    document.querySelectorAll("[data-effect]").forEach((el) => el.addEventListener("click", () => { window.effects++; }));
    document.querySelectorAll("form").forEach((form) => form.addEventListener("submit", (event) => { event.preventDefault(); window.effects++; }));
  </script></body></html>`);
  const reading = await run(page, { op: "snapshot" });
  if (!reading.ok || !("snapshot" in reading)) throw new Error("no reading");
  return reading.snapshot.elements;
}

async function click(page: Page, elements: ResearchElement[], label: string) {
  const element = elements.find((item) => item.label === label);
  if (!element) throw new Error(`no element “${label}” in ${JSON.stringify(elements.map((item) => item.label))}`);
  return { element, server: clickProblem(element), page: await run(page, { op: "click", n: element.n, label: element.label }), effects: await effects(page) };
}

const browser = await chromium.launch({ executablePath, headless: true, args: ["--no-sandbox"] });
try {
  const page = await browser.newPage();

  // Refused: controls that act, whatever language or markup they use.
  for (const [name, html] of [
    ["English Follow", `<button data-effect>Follow</button>`],
    ["Spanish Seguir", `<button data-effect>Seguir</button>`],
    ["an icon-only button", `<button data-effect aria-label="★"></button>`],
    ["a toggle (aria-pressed) labelled More", `<button data-effect aria-pressed="false">More</button>`],
    ["a role=button div labelled Abonnieren", `<div role="button" tabindex="0" data-effect>Abonnieren</div>`],
    ["a # link labelled Gefällt mir", `<a href="#" data-effect>Gefällt mir</a>`],
    ["a Share menu, even as a disclosure", `<button data-effect aria-expanded="false">Share</button>`],
  ] as const) {
    const result = await click(page, await load(page, html), (await load(page, html))[0]!.label);
    check(`${name}: refused by the server and in the page, and nothing ran`, result.element.write && result.server !== null && !result.page.ok && result.effects === 0, result);
  }

  // Allowed: what only shows more, switches view or moves to the next page.
  for (const [name, html, label] of [
    ["a Show more control", `<div role="button" tabindex="0" data-effect>Show more results</div>`, "Show more results"],
    ["Spanish Ver más", `<button data-effect>Ver más</button>`, "Ver más"],
    ["a tab", `<button role="tab" data-effect>Posts</button>`, "Posts"],
    ["a disclosure", `<button aria-expanded="false" data-effect>Filtros</button>`, "Filtros"],
    ["a details summary", `<details><summary data-effect>Opening hours</summary><p>Mon–Fri</p></details>`, "Opening hours"],
    ["a Next page button", `<button data-effect>Next</button>`, "Next"],
    ["a pagination link without an address", `<a rel="next" href="#" data-effect>2</a>`, "2"],
    ["a GET search form's own button", `<form action="/buscar"><input type="search" name="q" aria-label="Productos"><button data-effect>Buscar</button></form>`, "Buscar"],
  ] as const) {
    const result = await click(page, await load(page, html), label);
    check(`${name}: clickable, and clicked`, !result.element.write && result.server === null && result.page.ok && result.effects >= 1, result);
  }

  // A link is followed by its address (the extension checks it), never clicked in the page.
  const link = await click(page, await load(page, `<a href="https://example.org/follow/acme" data-effect>Follow</a>`), "Follow");
  check("a real link is navigated by address, not clicked", link.page.ok && "navigate" in link.page && link.page.navigate === "https://example.org/follow/acme" && link.effects === 0, link);

  // Searches: only a box whose form could not send anything.
  const search = async (html: string, text = "dentists in Pune") => {
    const elements = await load(page, html);
    const box = elements.find((item) => item.kind === "input" && /search|buscar|q/i.test(item.label));
    if (!box) throw new Error("no search box");
    return { box, server: searchProblem(box, text), page: await run(page, { op: "search", n: box.n, label: box.label, text }), effects: await effects(page) };
  };
  const plain = await search(`<form method="get" action="/search"><input type="search" name="q" aria-label="Search"><button>Search</button></form>`);
  check("an ordinary GET search form is searched and submitted", plain.box.search && plain.server === null && plain.page.ok && plain.effects === 1, plain);
  const composer = await search(`<form method="post" action="/send-message"><input type="search" name="q" aria-label="Search"><textarea name="message">A draft the owner left here</textarea><button>Send</button></form>`);
  check("a search box inside a message form is not a search field, and nothing is submitted", !composer.box.search && composer.server !== null && !composer.page.ok && composer.effects === 0, composer);
  const getWithMessage = await search(`<form action="/contact"><input type="search" name="q" aria-label="Search"><textarea name="m"></textarea></form>`);
  check("a GET form that also holds a message box is refused too", !getWithMessage.box.search && !getWithMessage.page.ok && getWithMessage.effects === 0, getWithMessage);
  const login = await search(`<form action="/login"><input name="q" aria-label="Search"><input type="password" aria-label="Password"></form>`);
  check("a form with a password is never searched", !login.box.search && !login.page.ok && login.effects === 0, login);
  const spa = await search(`<div role="search"><input aria-label="Search people" onkeydown="if (event.key === 'Enter') window.effects++"></div>`);
  check("a search box outside any form gets the search and its Enter", spa.box.search && spa.page.ok && spa.effects === 1, spa);
  const sendButton = await click(page, await load(page, `<form method="post" action="/send-message"><input type="search" name="q" aria-label="Search"><textarea name="message"></textarea><button data-effect>Send</button></form>`), "Send");
  check("that form's Send button is refused", sendButton.element.write && !sendButton.page.ok && sendButton.effects === 0, sendButton);

  // A button submits its form unless typed otherwise, whatever its role or label: inside a message form it is refused.
  const messageForm = (button: string, outside = "") => `<form id="composer" method="post" action="/send-message"><textarea name="message">The owner's draft</textarea>${button}</form>${outside}`;
  for (const [name, html, label] of [
    ["a More options disclosure that would submit a message draft", messageForm(`<button aria-expanded="false">More options</button>`), "More options"],
    ["a tab that would submit a message draft", messageForm(`<button role="tab">Posts</button>`), "Posts"],
    ["a Next button that would submit a message draft", messageForm(`<button>Next</button>`), "Next"],
    ["a disclosure tied to the message form by form=", messageForm("", `<button form="composer" aria-expanded="false">More options</button>`), "More options"],
    ["a reset that would clear the draft", messageForm(`<button type="reset">More</button>`), "More"],
    ["a search form's button that posts (formmethod)", `<form action="/buscar"><input type="search" name="q" aria-label="Search"><button formmethod="post">Buscar</button></form>`, "Buscar"],
    ["a search form's button with a message box tied by form=", `<form id="s" action="/buscar"><input type="search" name="q" aria-label="Search"><button>Buscar</button></form><textarea form="s" name="message">Hi</textarea>`, "Buscar"],
  ] as const) {
    const result = await click(page, await load(page, html), label);
    check(`${name}: refused by the server and in the page, and nothing was submitted`, result.element.write && result.server !== null && !result.page.ok && result.effects === 0, result);
  }
  const plainDisclosure = await click(page, await load(page, messageForm(`<button type="button" aria-expanded="false" data-effect>More options</button>`)), "More options");
  check("a type=button disclosure in a message form is clicked and submits nothing", !plainDisclosure.element.write && plainDisclosure.page.ok && plainDisclosure.effects === 1, plainDisclosure);

  console.log(`Page rules in Chromium ${browser.version()}: ${checks} passed. Real DOM, no network.`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser.close();
}
