/** Pure DOM fixtures, no Chrome or network. Supply Happy DOM from a separate tools install. */
import { pageScript, pageScriptConfig, clickProblem, searchProblem } from "@/lib/browser/connected/contract";

type FixtureWindow = Window & typeof globalThis & { happyDOM: { close(): Promise<void> } };
const domModule = process.env.BROWSER_REVIEW_DOM_MODULE ?? "happy-dom";
const { Window: Fixture } = await import(domModule) as { Window: new (options: { url: string }) => FixtureWindow };
const win = new Fixture({ url: "https://fixture.company.test/" });
Object.assign(globalThis, { window: win, location: win.location, document: win.document, HTMLInputElement: win.HTMLInputElement, Event: win.Event, KeyboardEvent: win.KeyboardEvent, NodeFilter: win.NodeFilter, getComputedStyle: win.getComputedStyle.bind(win) });
Object.defineProperty(win.HTMLElement.prototype, "getBoundingClientRect", { value() { return { top: 0, bottom: 40, width: 120, height: 40, left: 0, right: 120 }; } });
const results: { check: string; passed: boolean; observed?: unknown }[] = [];
function check(name: string, passed: boolean, observed?: unknown) { const result = { check: name, passed, observed }; results.push(result); console.log(JSON.stringify(result)); }
try {
  for (const label of ["Follow", "Seguir"]) {
    let follows = 0;
    win.document.body.innerHTML = `<button type="button" id="follow">${label}</button>`;
    win.document.getElementById("follow")!.addEventListener("click", () => { follows++; });
    const initial = await pageScript(pageScriptConfig, { op: "snapshot" });
    if (!initial.ok || !("snapshot" in initial)) throw new Error("No snapshot");
    const element = initial.snapshot.elements.find((entry) => entry.label === label)!;
    const serverRefusal = clickProblem(element);
    const clicked = await pageScript(pageScriptConfig, { op: "click", n: element.n, label: element.label });
    check(`${label}: follow action must not cause a write`, serverRefusal !== null && !clicked.ok && follows === 0, { serverRefusal, clicked, sideEffects: follows });
  }
  for (const composer of [false, true]) {
    let submissions = 0;
    win.document.body.innerHTML = composer
      ? '<form method="post" action="/send-message"><input type="search" name="q" aria-label="Search"><textarea name="message">A draft the owner left here</textarea><button type="submit">Send</button></form>'
      : '<form method="get" action="/search"><input type="search" name="q" aria-label="Search"><button type="submit">Search</button></form>';
    win.document.querySelector("form")!.addEventListener("submit", (event) => { event.preventDefault(); submissions++; });
    const state = await pageScript(pageScriptConfig, { op: "snapshot" });
    if (!state.ok || !("snapshot" in state)) throw new Error("No search snapshot");
    // A box inside a sending form is no longer classed as a search field at all; the assertion below still decides.
    const input = (state.snapshot.elements.find((entry) => entry.search) ?? state.snapshot.elements.find((entry) => entry.kind === "input"))!;
    const refused = searchProblem(input, "business owners");
    const searched = await pageScript(pageScriptConfig, { op: "search", n: input.n, label: input.label, text: "business owners" });
    check(composer ? "a search cannot submit a message-composer form" : "control: an ordinary search form still works", composer ? submissions === 0 : refused === null && searched.ok && submissions === 1, { refused, searched, sideEffects: submissions });
  }
} finally { await win.happyDOM.close(); }
console.log(`DOM probe: ${results.filter((row) => row.passed).length} passed, ${results.filter((row) => !row.passed).length} failed. No real browser or messages.`);
process.exitCode = results.every((row) => row.passed) ? 0 : 1;
