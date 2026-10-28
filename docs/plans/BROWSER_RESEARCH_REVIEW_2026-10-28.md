# Connected-browser research: independent review, 28 October 2026

**Verdict: hold merge/deployment for the fixes below.** The main wiring works in the existing tests, but additional probes reproduce failures in reconnect handling, action restrictions, provenance and native cancellation. These are fixture results, not claims about a real social account.

Reviewed browser commit: `c472532036eb4b96cac3d530e7f13ae0d6b501b8` on `claude/happy-carson-0tz5hz`, two commits over handoff `8233c46`. Review/probes do not modify the application implementation. No merge to the release branch, VM changes, real provider calls, social browsing or outreach.

## What checks out

- The native text-result fix is retained. The earlier prototype put page text only in MCP `content`; adding it to `structuredContent.result` addresses what the real CLI was missing. That earlier test gap was mine. I did not independently repeat the author's real signed-in CLI test here.
- Original browser branch: **2,329 unit tests pass**, typecheck passes, extension packaging passes (17 files).
- Original database suites: **browser research 65/65, native harness 27/27, organization-scope check passes**. My database is disposable PGlite behind the PostgreSQL wire adapter, **not native PostgreSQL concurrency verification**. The author reports separate PostgreSQL 16 checks.
- Exa trial merge: one content conflict in `src/lib/assistant/agent.ts`, resolved by keeping both Exa names and `...CONNECTED_PAGE_TOOLS` in the long-result and page-state sets. Exa 30/30, browser 65/65 and native harness 27/27 pass on the local combined tree with stand-ins.
- The trial merge caught a file-mode mistake in my Exa connector snapshot: `docker/deploy.sh` had become non-executable. Corrected on the Exa branch at **`4a82788dffbbf24db15e04e224592462e044ccbf`**; no content change or deploy. The local combined tree has that corrected mode.
- Combined final run: **2,338 unit tests pass, 0 fail; typecheck passes**. Review probe scripts also typecheck and lint clean. No full production build or real browser UI verification was repeated in this review.
- One earlier run, while typecheck/graph jobs were also active, failed the existing 500 ms hostile-page timing assertion and one fake-CLI turn. Both suites then passed in isolation (66 tests), and the complete sequential rerun above passed without changing an application assertion.
- The code graph was regenerated locally after the review probes were added. This review branch publishes only the report and reproduction scripts; the generated 18 MB graph was not included in the connector publication.

## Required fixes

### BR1 — upgrade path does not install the new tables

**High; deployment blocker.** The new `scripts/create-browser-research-tables.ts` is absent from `.dockerignore`'s script exceptions and the Dockerfile's runner copies. It is also absent from `docker/deploy.sh`'s `DEFAULT_MIGRATIONS`.

Normal Compose deployment therefore neither packages nor runs the migration. A fresh schema containing these tables does not prove an existing VM can upgrade. The report's migration command is not usable inside the shipped image as written.

Fix: package the TS script and SQL, add the migration to the existing before-switch deploy sequence, extend the deployment packaging test, and replay the upgrade twice. Keep it additive. No new deployment mechanism is needed.

### BR2 — a delayed old poll consumes the replacement connection

**High; reconnect/workspace-switch reliability.** In `extensions/whatsapp-recorder/src/research.ts`, `pollLoop` receives an answer using a captured connection, then calls `runCommand(command)`. `runCommand` reloads whatever connection is current. The response is not bound to the connection that fetched it.

Reproduction with the actual extension module and a mocked Chrome/HTTP boundary:

1. A's poll is in flight; the owner reconnects or switches to B.
2. B starts with sequence 0.
3. A's delayed response carries sequence 9.
4. The extension advances **B** to sequence 9 and posts A's result using **B's token**. B's valid lower sequence numbers will then be skipped as already handled.

The server still rejects a result for the wrong connection; this probe does **not** demonstrate a cross-workspace database read. The reproduced failure is connection/sequence contamination and lost work.

Fix: capture and fence the expected connection identity/token for poll responses, sequence/storage updates, execution, result posts and delayed cleanup. Discard a stale response before it changes the replacement's state. Preserve reconnect and Stop; do not add confirmations or a retry quota.

### BR3 — the advertised read-only actions can submit a write

**High; the read-only promise is not enforced by the current page rules.** `pageScript` / `isWrite` in `src/lib/browser/connected/contract.ts` uses English labels and `search` submits the input's form without checking that form's other fields or purpose.

Pure DOM fixtures exercising the actual page script (no real browser/network):

- English **Follow** is blocked (positive control).
- Spanish **Seguir** passes both the server's computed-element check and the page's click check; its click handler runs.
- A normal GET search form works (positive control).
- A form with a search input, an existing message textarea, `method="post"`, `action="/send-message"`, and a **Send** button gets submitted by `browser_tab_search`. Blocking a click on Send does not prevent `input.form.requestSubmit()`.

No real follow or message occurred. The fixtures count the click/submit handlers and prevent real submission.

Fix the action classification and search/form boundary with tests of actual DOM classification, not only manually supplied `write: true` booleans. Preserve ordinary navigation, search and show-more controls. Do not solve this with per-page/per-click permission prompts or a blanket social-site ban. Keep all outreach in the app's existing sending path.

### BR4 — page evidence can be assigned to the wrong contact or invented from a URL

**High; lead quality and provenance.** `pageEvidence.server.ts` verifies that a URL was read and a quote appears somewhere in the serialized result. It does not bind the contact identity to that page's content, and the quote search includes URL/metadata.

Reproduced through the actual grounding check, importer and database:

- Read Alice/Alpha's page containing `alice@alpha.example.org` and Bob/Beta's page containing `bob@beta.example.org`.
- Save Alice's email with Beta's `sourceUrl` and a real quote about Bob.
- Accepted and persisted: Alice's contact evidence says it came from **Beta's** page, even though the address never appeared there.
- A token appearing only in `?fact=entirely-invented-token` is accepted as a quote from that page, although the page body contains no such token.

Positive controls: a real body quote succeeds; an unread page and an invented body quote not present in metadata are refused.

Fix: validate the identity and quote against the selected page's actual returned content (and a genuine profile URL where appropriate), not the whole chat or JSON metadata. Reuse the existing normalization/grounding functions. Keep owner-provided contacts working; ask the model for the correct source or omit false page provenance. Apply the same boundary to Instagram sources.

### BR5 — native turn cancellation is dropped before the browser queue

**High; work continues after cancellation.** `connectedStep` and the listing path in `browser_connection` call `runBrowserAction` without the native scope's abort signal. The queue accepts a signal, but these callers do not supply it.

Probe: start a browser read within `inNativeTool`, abort that scope, then poll the device. The command is still pending and gets delivered after the abort. Positive control: the same queue expires the command correctly when its caller passes a signal directly.

Fix: propagate native cancellation to ordinary queued browser actions (including tab listing), expire undelivered work, and prevent stale execution/result effects. Reuse `nativeToolSignal` when combining with Exa. End-of-turn tab cleanup must still run safely rather than opening new research work. Cover cancellation between queueing and delivery.

### BR6 — integration with Exa needs its page shape supported

**Combined branch only; not a defect in the standalone browser branch.** `PAGE_TOOLS` omits `exa_read`, and `pageEvidence` expects one `data.url`. Exa reads return `data.pages[]`. On the trial merge a genuine Exa page/body quote is rejected as "was not read in this chat".

Fix in the shared page-evidence adapter, preserving each Exa page's URL, text and read time and BR4's identity/quote checks. No second page download or new provider is needed. Retain both Exa and connected-browser entries when resolving `agent.ts`.

## Reproduction scripts

- `scripts/review/browser-research-regressions.ts`: real app/database paths. Original branch: **4 positive controls pass, 4 required behaviors fail**, Exa case skipped because Exa is absent. Combined tree: **4 pass, 5 fail**, including Exa evidence. Intentional nonzero exit until fixed.
- `scripts/review/browser-extension-connection-race.ts`: actual extension module with mocked Chrome/HTTP. Replacement case fails; `--same-connection` is the passing control. No database or actual Chrome required.
- `scripts/review/browser-page-read-only.ts`: actual page script in Happy DOM. **2 controls pass, 2 restrictions fail**. Happy DOM is a separate test-tool install, not a new app dependency; set `BROWSER_REVIEW_DOM_MODULE` to that installation's `happy-dom/lib/index.js`.

Run database probes only on a disposable local `agentsdr_native` database with the current schema and seed. No live credentials are used. Keep the assertions; fix the behaviors instead of weakening the probes.

## Handoff / acceptance

Fix BR1–BR5 on the browser work branch in focused commits, then BR6 on integration with Exa. Keep the existing native result-text fix, workspace/device authentication, DNC, grounding, source choice, explicit owner budgets and approved sending path. No new research feature, default caps, or new settings pages are requested.

Then run the probes, existing browser/native/Exa database suites, typecheck, lint, packaging/deploy checks, and one production build on the combined commit. The remaining real visible Chrome/social page, actual permission prompt, customer's personal Claude login and VM/proxy checks stay pending until executed. Existing broad tests passing does not turn the reproduced failures into a pass.
