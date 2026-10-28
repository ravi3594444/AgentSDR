/**
 * BR3 follow-up: a navigation/disclosure label must not make a message
 * form's submit button safe to click. Pure DOM fixtures, no real browser,
 * network or messages. Set BROWSER_REVIEW_DOM_MODULE to a separate Happy DOM
 * installation's happy-dom/lib/index.js; no app dependency is added.
 */
import { clickProblem, pageScript, pageScriptConfig } from "@/lib/browser/connected/contract";

type FixtureWindow = Window & typeof globalThis & { happyDOM: { close(): Promise<void> } };
const domModule = process.env.BROWSER_REVIEW_DOM_MODULE ?? "happy-dom";
const { Window: Fixture } = await import(domModule) as { Window: new (options: { url: string }) => FixtureWindow };
const win = new Fixture({ url: "https://fixture.company.test/" });
Object.assign(globalThis, { window: win, location: win.location, document: win.document, HTMLInputElement: win.HTMLInputElement, Event: win.Event, KeyboardEvent: win.KeyboardEvent, NodeFilter: win.NodeFilter, getComputedStyle: win.getComputedStyle.bind(win) });
Object.defineProperty(win.HTMLElement.prototype, "getBoundingClientRect", { value() { return { top: 0, bottom: 40, width: 120, height: 40, left: 0, right: 120 }; } });

const form = (button: string) => `<form id="composer" method="post" action="/send-message"><textarea name="message">The owner's existing draft</textarea>${button}</form>`;
const cases = [
  { name: "control: an explicit non-submit disclosure still works", html: form('<button type="button" aria-expanded="false">More options</button>'), allowed: true },
  { name: "a disclosure cannot submit an existing message draft", html: form('<button aria-expanded="false">More options</button>'), allowed: false },
  { name: "a tab cannot submit an existing message draft", html: form('<button role="tab">Posts</button>'), allowed: false },
  { name: "a button associated through form= cannot submit the message draft", html: form("") + '<button form="composer" type="submit" aria-expanded="false">More options</button>', allowed: false },
] as const;
let passed = 0;
try {
  for (const fixture of cases) {
    let clicks = 0;
    let submissions = 0;
    win.document.body.innerHTML = fixture.html;
    win.document.querySelector("button")!.addEventListener("click", () => { clicks++; });
    win.document.querySelector("form")!.addEventListener("submit", event => { event.preventDefault(); submissions++; });
    const state = await pageScript(pageScriptConfig, { op: "snapshot" });
    if (!state.ok || !("snapshot" in state)) throw new Error("No fixture reading");
    const element = state.snapshot.elements.find(item => item.kind === "button")!;
    const serverRefusal = clickProblem(element);
    const clicked = await pageScript(pageScriptConfig, { op: "click", n: element.n, label: element.label });
    const ok = fixture.allowed
      ? serverRefusal === null && clicked.ok && clicks === 1 && submissions === 0
      : serverRefusal !== null && !clicked.ok && submissions === 0;
    if (ok) passed++;
    console.log(JSON.stringify({ check: fixture.name, passed: ok, serverRefusal, clicked, clicks, submissions }));
  }
} finally { await win.happyDOM.close(); }
console.log(`BR3 form probe: ${passed} passed, ${cases.length - passed} failed. No real browser or messages.`);
process.exitCode = passed === cases.length ? 0 : 1;
