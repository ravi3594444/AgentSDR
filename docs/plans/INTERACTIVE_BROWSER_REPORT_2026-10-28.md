# Interactive connected browser — report, 28 October 2026

Branch `claude/interactive-browser-20261028`, from `codex/interactive-browser-handoff-20261028` (`ee39a2a`, application baseline `1fa5659`). Not merged, not deployed. The research version under test is unchanged in what it may do; this adds owner-requested **tasks** beside it.

## What the owner gets

Connect Chrome once (the same Connect browser flow), then ask in the chat for a browser task: "add these contacts to my HubSpot", "fill in the registration form at …", "draw a line between the two dots on my board". The agent opens the page in the owner's signed-in Chrome, reads its fields, fills, chooses, ticks, clicks and saves, looks at a screenshot when the elements do not help (canvases, maps, charts), works by screen points there, and checks the result. Native Claude (a personally connected Claude login) runs its own loop over MCP; API models use the same tools through the JSON harness.

## How it is authorized (no settings, no per-click approvals)

- **`browser_task`** starts a task only from the owner's own words in this request (`src/lib/browser/connected/tasks.ts`):
  - copied **word for word** from the owner's messages: a page's text or the model's paraphrase grants nothing (prompt-injection fixture refused);
  - asking for a **change** (`CHANGE_REQUEST_PATTERN`, whole words in English, Spanish, Portuguese, French, German, Italian, Hindi). Research words never do, so a research request stays read-only;
  - **naming each site**: by its address, its domain, or its name as a word ("HubSpot" for app.hubspot.com; a few product names such as Gmail). A look-alike such as `hubspot.evil-login.com` is not covered.
  
  When a check fails, the model is told to ask the owner one question. The owner's answer is an owner message, and the next `browser_task` finds it.
- **The grant** (sites as registrable domains, 12 h expiry, the owner's words, the goal) is the chat's own `browser_task` tool record, written only by the server. It serves its own request only.
- **The grant travels with every change** (`BrowserTaskGrantRef` on `act` / `visual` commands). The extension refuses a page outside its sites even when the server is bypassed (live check). Only the browser's own person's messages count, and another workspace sees neither the grant nor the browser.

**What a grant never allows** (`contract.ts`; refused on the server and again in the page):
- **Contacting people.** Reply, reply all, forward, message, invite, DM and repost are refused in several languages. "Send" words are refused beside a written message, or on any social site; elsewhere "Enviar"/"Senden" is usually a form's submit button, which a requested form task must be able to press. On social sites, post, comment, share, connect, follow, subscribe and join are refused too, and so is any control beside a written message. Contacting people stays in `prepare_outreach` and its approval, so there is no second, untracked sender.
- **Enter in a message box**, since chats send on Enter. Line breaks go into the text instead.
- **Payments** (buy, pay, checkout, place order, donate, …).
- **Passwords, card numbers and one-time codes** are never read or typed; sign-ins and CAPTCHAs stay with the owner.

## DOM interaction (`browser_tab_act`)

Readings now list each field's type and state:

```
[3] input "Lifecycle stage" {select, = "Lead", options: Lead | Customer}
[4] input "Card" {text, password/card/code: never typed}
```

`fill` covers inputs, textareas and contenteditable editors (through `execCommand("insertText")`, so editors see their own input events). There are also `select`, `check`/`uncheck` (native and ARIA), `press` (synthetic key events with modifiers; Enter in a form submits it after the checks) and `click` on any non-refused control. Every action re-checks the element's label against the reading, and the page is read again afterwards.

## Screenshots and screen points (`browser_tab_screenshot`, `browser_tab_visual`)

### Scripting vs `chrome.debugger`

Measured 28 Oct 2026 in Chromium 153. Chrome was launched plainly, without Playwright's anti-throttling switches, under Xvfb and in `--headless=new`.

| Situation | Result |
| --- | --- |
| Background tab in the owner's window | `document.visibilityState` hidden, 1 animation frame/s |
| `tabs.captureVisibleTab` for that window | captured the owner's **active** tab, a different page |
| Debugger `Page.captureScreenshot` of that hidden tab | 6.5 s, or timed out at 8 s |
| Debugger input to the hidden tab | delivered, `isTrusted: true` |
| Synthetic page events (scripting) | delivered, `isTrusted: false`; no real typing |
| The tab in its own unfocused window | visible; `captureVisibleTab` and debugger capture ≈ 60 ms |

- **Decision.** A visual step moves the task tab into an unfocused **AgentSDR task window**, where it is the active tab and is drawn. The owner's window and active tab are untouched (live check). The debugger then captures that exact tab, so it can never picture another one, and sends the browser's own input (trusted pointer and keys, canvas drags).
- **Permission.** `debugger` cannot be an optional permission (Chrome's permission docs list it as not optional), so 0.17.0 declares it.
- **The debugging bar.** Chrome shows "… started debugging this browser" while the debugger is attached. It is attached only for visual steps and released after 60 s idle or when the tabs close. The owner's Cancel on that bar is treated as their Stop: research pauses.
- **Settling.** That bar appears a moment after attaching and shortens the page, so a screenshot waits for the viewport to hold still. Found live: without this, every first screenshot was stale at once.
- **Scope.** DOM work stays in background tabs, as research does.

### Coordinates

- **Image to page.** A screenshot is the viewport, captured at `scale` image pixels per CSS pixel, at most 1280 px a side. A point (x, y) of the image is the CSS viewport point (x / scale, y / scale).
- **Capture.** The debugger's clip is in CSS pixels, and its image is clip × scale × the screen's device scale factor (page zoom excluded), so the extension asks for scale / (devicePixelRatio / zoom).
- **Input.** Input events take CSS viewport pixels at any zoom. Both were measured at zoom 125% and device scale 2: clicks landed within 1 CSS px.
- **Frames.** Points inside a same-origin frame are probed inside it. Another site's frame is refused: the model is told to open that frame's page itself.

### Stale targets

- **On the server.** A step must name the tab's latest screenshot (any step on the tab other than a read replaces it) and lie inside it.
- **In the extension.** It refuses when the tab's URL changed, or its viewport size, scroll or zoom moved by a pixel. Live checks covered a page that scrolled itself and one that navigated itself after the screenshot.
- **After every step.** Each visual step returns a new screenshot; the old one is no longer a target.
- **Without a task.** A visual click lands only where a research click could (link, tab, expand, "more"). `move` and `scroll` only look. Click, drag, type and key otherwise need the grant.

## The image reaches the model

- **Native Claude (MCP).** A tool result carries `{type: "image"}` blocks beside its text. With the installed CLI (2.1.312) the model read a code that existed only in an image's pixels, both with and without `structuredContent`. The adapter keeps `structuredContent` (its text) and adds the image blocks.
- **API models.** The next `completeStructured` call carries the screenshot as an image part (OpenAI `image_url` data URL; the Anthropic adapter converts it to an image block instead of dropping it), with a note naming it, and only once. `structuredVision()` decides from the provider's own catalog: OpenRouter's `input_modalities`, AI/ML API's `vision` tag; every Claude model on the Anthropic API takes images.
- **Models that cannot take images.** A text-only model, or Claude Code's structured (CLI) runtime here, gets an honest refusal ("the selected AI model … does not take images; work from the page's elements"). Nothing is captured, and nothing switches to another or paid model. The CLI structured runtime throws on an image rather than drop it.
- **Not stored.** Screenshots are not stored: the command row's image is blanked after the model gets it, and the chat keeps text only. What only an image shows cannot ground a saved contact.

## Lost answers, Stop, restarts

- **No repeats.** A command is delivered once and never repeated: the extension records its sequence number before running it.
- **Lost answers.** A change the browser took but never answered is reported as "may or may not have happened: read the tab first". A cancelled step that never reached the browser is reported as not run. Live check: a save whose answer came too late was submitted exactly once.
- **Unchanged.** Stop (toolbar), Disconnect, replacement of the connection, the service worker's restart and the native turn's cancellation all behave as before (research checks rerun).

## Verification (labels matter)

| Check | Kind | Result |
| --- | --- | --- |
| Unit suite | `npm test` | **2,345 pass**, 0 fail |
| Typecheck, lint of changed files | | pass |
| `scripts/e2e/browser-page-rules.ts` | the page script on real DOM in Chromium | **60 pass** (30 research + 30 task: fill/select/check/press, contacting/paying/password refusals, Spanish labels, "Enviar inscripción", probes) |
| `scripts/e2e/browser-tasks.ts` | real database and bridge routes, stand-in extension and model | **25 pass** (who may start a task, injection, research-only, unnamed site, refusals, grant per request, other workspace, old extension, screenshot image not stored, stale/outside points, lost answer, JSON harness carries the image, text-only model refused) |
| `scripts/e2e/browser-research.ts` | research suite, unchanged behaviour | **69 pass** |
| `scripts/e2e/browser-tasks.live.ts` | **real extension 0.17.0 in a visible Chromium (Xvfb), real production server**, fixture sites, scripted models | **31 pass** |
| Same, `LIVE_REAL_CLAUDE=1` | **real Claude Code CLI (this machine's login)**, fixture sites | **34 pass**: Claude read a code drawn only in canvas pixels ("PFCN"; not in any tool text), entered and saved a CRM contact, and drew from dot to dot by sight (it chose (120, 340)→(560, 340); the line landed on both dots) |
| `scripts/e2e/browser-research.live.ts` | real extension 0.17.0, headless, research | **45 pass** |
| Review probes (`scripts/review/*`) | | regressions 8/8, race pass (both modes), DOM 4/4, form submission 4/4 |
| Organization-scope contract; tenancy isolation walk (the live-tasks workspace as A) | | pass; no isolation failures (133 reads, 2 writes, 66 pages) |
| Production build (`bun run build`, includes extension packaging) | | pass |
| Local trial merge with Exa (`4a82788`), not pushed | | 5 conflicts, both sides kept (`.dockerignore`, `Dockerfile`, `docker/deploy.sh`, `docker/deploy.test.ts`, the tool sets in `agent.ts`); typecheck pass, **2,354 unit**, Exa 30, tasks 25, research 69 |

The real-Claude run was this container's CLI login, not a customer's personal Claude login. The sites are fixtures served under their names; nobody was signed in to anything, and no real prospect, site or account was touched.

## Changes worth knowing

- **Extension 0.17.0 adds the `debugger` permission.** Unpacked installs (how the extension is distributed) take it without a prompt. A packed or Web Store install would be disabled until the owner accepts the new permission. `BROWSER_TASK_MIN_VERSION` makes tasks tell the owner to update.
- **Readings show field state** for every reading, research included (additive; what research may click or type is unchanged).
- **No migration.** Grants live in the chat's tool records; screenshots are not stored.

## Not verified, and what blocks it

- **A real desktop.** Under Xvfb there is no window manager, so the task window is never covered. On Windows and macOS Chrome may stop drawing an occluded or minimized window. Capture then falls back to the debugger's slow path (6.5 s measured for a hidden tab) or times out, and the step says so. Not measured there.
- **The owner's own signed-in Chrome.** No real social site, CRM or customer Chrome profile was used. Chrome's real permission prompt for the new permission on a packed install, and the owner pressing Cancel on the debugging bar, were not exercised: automation cannot click Chrome's own bar.
- **A customer's personal Claude login, the deployed proxy and the VM.** Not exercised.
- **Headless.** No tested task needed it. The commands (`open`, `read`, `act`, `screenshot`, `visual`) do not depend on the transport, so a future headless transport would answer the same commands from its own established profile. No cookie export was added.
- **Found, not fixed (outside this task).** The native harness gives MCP tools a generic input schema, so Claude sometimes sends arrays and booleans as strings. The browser tools now accept a JSON-encoded site list. `set_brief`'s booleans were refused as strings in the real run, the existing behaviour.
- **Screenshots in Claude's session history.** Native Claude's session files on the server keep the conversation, including screenshot images of the owner's pages, under the account's own Claude config directory.
