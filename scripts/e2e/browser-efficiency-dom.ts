/** Real Chromium DOM, fixture pages only. No accounts, server or outgoing messages. */
import { chromium, type Page } from "playwright-core";
import { pageScript, pageScriptConfig, type PageOp, type PageScriptResult } from "@/lib/browser/connected/contract";
import { waitForReady } from "@/lib/browser/connected/readiness";

const browser = await chromium.launch({ executablePath: process.env.BROWSER_EXECUTABLE_PATH ?? "/opt/pw-browsers/chromium-1243/chrome-linux64/chrome", headless: true, args: ["--no-sandbox"] });
let checks = 0;
function check(label: string, ok: unknown) { if (!ok) throw new Error(label); checks++; console.log(`PASS ${label}`); }
const run = (page: Page, op: PageOp) => page.evaluate(`(${pageScript.toString()})(${JSON.stringify(pageScriptConfig)},${JSON.stringify(op)})`) as Promise<PageScriptResult>;
const reading = async (page: Page) => { const result = await run(page, { op: "snapshot" }); if (!result.ok || !("snapshot" in result)) throw new Error("No page reading"); return result.snapshot; };

try {
  const page = await browser.newPage();
  await page.setContent(`<body><nav>${Array.from({ length: 180 }, (_, i) => `<a href="https://fixture.net/${i}">Navigation ${i}</a>`).join(" ")}</nav>
    <main id="main"><footer><div contenteditable="true" role="textbox" aria-label="Type a message" style="min-height:30px">Existing draft</div>
    <button type="button" id="send" onclick="window.effects++"> <span data-icon="send"></span> </button></footer></main>
    <label>Password<input type="password" value="fixture-password-never-read"></label><script>window.effects=0</script></body>`);
  const before = await reading(page);
  const composer = before.elements.find((item) => item.label === "Type a message");
  const send = before.elements.find((item) => item.label === "send");
  check("a composer after 180 navigation links remains in the observation", composer?.field?.value === "Existing draft");
  check("an icon-only Send has a usable label and remains in the observation", send?.write === true);
  check("the element limit remains in force", before.elements.length <= pageScriptConfig.maxElements);
  check("sensitive values stay out of field observations", !JSON.stringify(before).includes("fixture-password-never-read"));
  const refused = await run(page, { op: "click", n: send!.n, label: send!.label });
  check("better icon labels do not let research send a message", !refused.ok && await page.evaluate("window.effects") === 0);
  const noMessage = await run(page, { op: "act", n: send!.n, label: send!.label, action: "click", value: null, key: null, social: false, kinds: ["interact"] });
  check("an ordinary form grant still cannot click Send beside a draft", !noMessage.ok && await page.evaluate("window.effects") === 0);
  check("reading and probing preserve the owner's existing draft", (await reading(page)).elements.find((item) => item.label === "Type a message")?.field?.value === "Existing draft");

  await page.setContent(`<body><h1>Chat loading</h1><main id="main"></main><script>
    window.effects=0;
    setTimeout(()=>{document.querySelector('#main').innerHTML='<footer><div role="textbox" contenteditable="true" aria-label="Message" style="min-height:30px"></div><button type="button" onclick="window.effects++">Send</button></footer>'},600);
  </script></body>`);
  let probes = 0;
  const ready = await waitForReady({ selector: "#main footer [contenteditable=true]", timeoutMs: 3_000 }, {
    expiresAt: Date.now() + 5_000, stopped: async () => null,
    probe: async () => { probes++; const result = await run(page, { op: "ready", selector: "#main footer [contenteditable=true]", text: null }); if (!result.ok || !("ready" in result)) throw new Error("No readiness probe"); return result; },
  });
  check("a delayed SPA composer becomes ready through local probes", ready.state === "ready" && probes > 1);
  const after = await reading(page);
  check("the single final observation contains the usable composer", after.elements.some((item) => item.field?.type === "editor"));
  check("waiting never types, submits or sends", await page.evaluate("window.effects") === 0 && after.elements.find((item) => item.field?.type === "editor")?.field?.value === "");
  const invalid = await run(page, { op: "ready", selector: "[", text: null });
  check("invalid selectors fail without page side effects", !invalid.ok && await page.evaluate("window.effects") === 0);
  await page.setContent('<body><p>Order saved</p><section id="target">Still loading</section><div id="hidden" style="display:none">Ready</div></body>');
  const scoped = await run(page, { op: "ready", selector: "#target", text: "Order saved" });
  const hidden = await run(page, { op: "ready", selector: "#hidden", text: "Ready" });
  check("selector and text apply to the same visible target", scoped.ok && "ready" in scoped && !scoped.ready);
  check("hidden targets do not satisfy readiness", hidden.ok && "ready" in hidden && !hidden.ready);
  const text = await run(page, { op: "ready", selector: null, text: "Order saved" });
  check("visible page text can satisfy a read-only wait", text.ok && "ready" in text && text.ready);

  await page.route("https://fixture.net/**", (route) => route.fulfill({ contentType: "text/html", body: '<h1>Sign in</h1><input type="password">' }));
  await page.goto("https://fixture.net/login");
  const login = await run(page, { op: "ready", selector: "#composer", text: null });
  check("a login ends a wait instead of generating loading polls", login.ok && "ready" in login && login.blocked);
  await page.setContent('<body><form id="challenge-form">Human check</form></body>');
  const challenge = await run(page, { op: "ready", selector: "#composer", text: null });
  check("a challenge ends a wait for owner attention", challenge.ok && "ready" in challenge && challenge.blocked);
  console.log(`Browser efficiency DOM checks: ${checks} passed. Real Chromium; fixture pages only.`);
} finally { await browser.close(); }
