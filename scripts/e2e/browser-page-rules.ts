/**
 * What the connected browser's page script lets the assistant click and type,
 * checked on real DOM in Chromium (no server, database or network): the
 * same pageScript the extension injects, evaluated the way executeScript
 * evaluates it (its source, with its arguments). Each fixture counts the
 * page's own click and submit handlers, so "refused" means nothing ran.
 * Then a task's changes (op "act": fill, select, check, press, click) and
 * the probe a screen step runs first, with what a grant still never does.
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

  // --- Tasks (the owner asked; the extension checked the grant): changes, and what stays refused ---
  const act = async (label: string, action: Extract<PageOp, { op: "act" }>["action"], extra: { value?: string; key?: { key: string; modifiers: string[] }; social?: boolean } = {}) => {
    const elements = await page.evaluate(`(${pageScript.toString()})(${JSON.stringify(pageScriptConfig)}, {"op":"snapshot"})`) as PageScriptResult;
    const element = ("snapshot" in elements ? elements.snapshot.elements : []).find((item) => item.label === label);
    if (!element) throw new Error(`no element “${label}”`);
    return { element, page: await run(page, { op: "act", n: element.n, label, action, value: extra.value ?? null, key: extra.key ?? null, social: extra.social ?? false }), effects: await effects(page) };
  };
  const value = (selector: string) => page.evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el.value ?? el.innerText; })()`) as Promise<string>;

  await load(page, `<form method="post" action="/contacts"><label for="e">Correo electrónico</label><input id="e" name="email" oninput="window.effects++">
    <textarea aria-label="Notes"></textarea><div contenteditable="true" aria-label="Description" oninput="window.effects++"></div>
    <select aria-label="Lifecycle"><option>Lead</option><option value="cust">Customer</option></select>
    <input type="checkbox" aria-label="Subscribed"><div role="checkbox" aria-checked="false" aria-label="VIP" onclick="this.setAttribute('aria-checked', this.getAttribute('aria-checked') === 'true' ? 'false' : 'true')"></div>
    <input type="password" aria-label="Password"><input autocomplete="cc-number" aria-label="Card"><button>Save contact</button></form>`);
  const reading = await page.evaluate(`(${pageScript.toString()})(${JSON.stringify(pageScriptConfig)}, {"op":"snapshot"})`) as PageScriptResult;
  const fields = "snapshot" in reading ? reading.snapshot.elements : [];
  check("a reading names a field by its label (Spanish here), with its type and value; a password's and a card's values are never read",
    fields.some((item) => item.label === "Correo electrónico" && item.field?.type === "text") && fields.some((item) => item.label === "Password" && item.field?.sensitive && item.field.value === "")
      && fields.some((item) => item.label === "Card" && item.field?.sensitive) && fields.some((item) => item.label === "Description" && item.field?.type === "editor")
      && fields.some((item) => item.label === "Lifecycle" && item.field?.options?.join() === "Lead,Customer"), fields);
  const filled = await act("Correo electrónico", "fill", { value: "priya@acme.in" });
  check("fill sets a text field the way a framework sees it (its input event ran)", filled.page.ok && await value("#e") === "priya@acme.in" && filled.effects >= 1, filled);
  const notes = await act("Notes", "fill", { value: "Line one\nLine two" });
  check("fill puts line breaks in a textarea", notes.page.ok && await value("textarea") === "Line one\nLine two", notes);
  const editor = await act("Description", "fill", { value: "Owner-approved text" });
  check("fill types into a contenteditable editor through its own input handling", editor.page.ok && (await value("[contenteditable]")).trim() === "Owner-approved text", editor);
  const chosen = await act("Lifecycle", "select", { value: "customer" });
  check("select chooses an option by its text", chosen.page.ok && await value("select") === "cust", chosen);
  const missing = await act("Lifecycle", "select", { value: "Partner" });
  check("select of an option that is not there says which ones are", !missing.page.ok && "error" in missing.page && missing.page.error.includes("Lead | Customer"), missing);
  const box = await act("Subscribed", "check");
  const aria = await act("VIP", "check");
  const again = await act("VIP", "check");
  check("check ticks a checkbox and an ARIA checkbox, and checking a checked one changes nothing", box.page.ok && aria.page.ok && again.page.ok
    && await page.evaluate("document.querySelector('[type=checkbox]').checked && document.querySelector('[role=checkbox]').getAttribute('aria-checked') === 'true'"), [box, aria, again]);
  const password = await act("Password", "fill", { value: "hunter2" });
  const card = await act("Card", "fill", { value: "4242424242424242" });
  check("a password or card field is never typed into", !password.page.ok && !card.page.ok && await page.evaluate("document.querySelector('[type=password]').value === '' && document.querySelector('[autocomplete=cc-number]').value === ''"), [password, card]);
  const save = await act("Save contact", "click");
  check("with the owner's request, a form's Save button is clicked and the form submits", save.page.ok && save.effects >= 1, save);

  for (const [name, html, label, social] of [
    ["Send, in a mail composer", `<div><textarea>Hi Priya</textarea><button data-effect>Send</button></div>`, "Send", false],
    ["Spanish Enviar", `<button data-effect>Enviar</button>`, "Enviar", false],
    ["Reply all", `<button data-effect>Reply all</button>`, "Reply all", false],
    ["Buy now", `<button data-effect>Buy now</button>`, "Buy now", false],
    ["Post on a social site", `<button data-effect>Post</button>`, "Post", true],
    ["Seguir on a social site", `<button data-effect>Seguir</button>`, "Seguir", true],
    ["an unlabelled icon button beside a written message on a social site", `<form><div contenteditable="true">Hello there</div><button data-effect aria-label="✈"></button></form>`, "✈", true],
  ] as const) {
    await load(page, html);
    const result = await act(label, "click", { social });
    check(`a task still never clicks ${name}`, !result.page.ok && result.effects === 0, result);
  }
  await load(page, `<button data-effect>Post</button>`);
  const blogPost = await act("Post", "click");
  check("Post on the owner's own (non-social) site is the task's to click", blogPost.page.ok && blogPost.effects === 1, blogPost);
  await load(page, `<form><div contenteditable="true">Hello there</div><button type="button" data-effect aria-label="✈"></button></form>`);
  const webIcon = await act("✈", "click");
  check("the same icon button on another site is clicked (only social sites refuse by structure)", webIcon.page.ok && webIcon.effects === 1, webIcon);

  const enter = { key: "Enter", modifiers: [] as string[] };
  await load(page, `<form action="/search"><input aria-label="Find a contact" onkeydown="window.effects++"></form>`);
  const enterSearch = await act("Find a contact", "press", { key: enter });
  check("Enter in a form's text field fires the page's key handler and submits the form", enterSearch.page.ok && enterSearch.effects === 2, enterSearch);
  await load(page, `<textarea aria-label="Message" onkeydown="window.effects++">Hi</textarea>`);
  const enterTextarea = await act("Message", "press", { key: enter });
  check("Enter is never pressed in a message box (chats send on Enter)", !enterTextarea.page.ok && enterTextarea.effects === 0, enterTextarea);
  await load(page, `<form method="post"><input aria-label="Subject"><button>Send</button></form>`);
  const enterSend = await act("Subject", "press", { key: enter });
  check("Enter is refused where it would submit through a Send button", !enterSend.page.ok && enterSend.effects === 0, enterSend);
  await load(page, `<input aria-label="Tags" onkeydown="if (event.key === 'ArrowDown' && event.shiftKey) window.effects++">`);
  const arrow = await act("Tags", "press", { key: { key: "ArrowDown", modifiers: ["Shift"] } });
  check("other keys reach the page's handlers with their modifiers", arrow.page.ok && arrow.effects === 1, arrow);

  // --- The probe a screen step runs first, at a CSS point or on the keyboard focus ---
  const probe = (target: "point" | "focus", x: number, y: number, extra: { readOnly?: boolean; social?: boolean; key?: { key: string; modifiers: string[] } } = {}) =>
    run(page, { op: "probe", x, y, target, key: extra.key ?? null, social: extra.social ?? false, readOnly: extra.readOnly ?? false });
  await load(page, `<div style="margin:0;padding:0"><canvas width="300" height="100" style="display:block;position:absolute;left:0;top:0;width:300px;height:100px"></canvas>
    <button style="position:absolute;left:0;top:120px;width:120px;height:40px">Send</button>
    <a href="https://example.org/next" style="position:absolute;left:0;top:180px;display:block;width:120px;height:30px">Next page</a>
    <input type="password" aria-label="Password" style="position:absolute;left:0;top:240px">
    <textarea aria-label="Message" style="position:absolute;left:200px;top:240px">Hi</textarea>
    <iframe src="data:text/html,<button>Inside</button>" style="position:absolute;left:0;top:300px;width:200px;height:80px;border:0"></iframe></div>`);
  check("a task's point on a canvas is allowed; without a task it is not clicked", (await probe("point", 50, 50)).ok && !(await probe("point", 50, 50, { readOnly: true })).ok);
  check("a point on Send is refused even in a task", !(await probe("point", 40, 140)).ok);
  check("without a task a point on a link is allowed (a research click)", (await probe("point", 40, 190, { readOnly: true })).ok);
  check("a point inside another site's embedded frame is refused", !(await probe("point", 40, 320)).ok);
  await page.focus("input[type=password]");
  check("typing where the focus is a password field is refused", !(await probe("focus", 0, 0)).ok);
  await page.focus("textarea");
  check("Enter where the focus is a message box is refused; typing there (a draft) is not", !(await probe("focus", 0, 0, { key: enter })).ok && (await probe("focus", 0, 0)).ok);

  console.log(`Page rules in Chromium ${browser.version()}: ${checks} passed. Real DOM, no network.`);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser.close();
}
