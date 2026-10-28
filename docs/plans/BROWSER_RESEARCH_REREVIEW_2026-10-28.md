# Connected-browser research: re-review, 28 October 2026

**Verdict: hold merge/deployment for one remaining BR3 form-submission case.** The original six reproductions pass after the fixes. BR1, BR2, BR4 and BR5 are resolved in those probes; BR6 works on the local Exa combination. BR3 fixes the original Follow/Seguir and search-form cases, but its new navigation/disclosure allowlist can still submit an existing message form.

Reviewed: `claude/happy-carson-0tz5hz` at **`ceac4ca30e40acaca70b418b40c7545e9561b96c`**. All 24 changed file blobs match GitHub, and the complete checked-out source tree matches remote tree `102ebe2de977fef2514b5191ec77ec7841a1233a`. No application fix, release-branch merge, VM change, real social browsing or outreach was performed in this re-review.

## One remaining fix: a readable control may still be a submit button

**High; continuation of BR3.** In `src/lib/browser/connected/contract.ts`, `pageScript`'s `isWrite` allows a tab, an `aria-expanded` disclosure, or a read/next/more label before considering whether clicking it submits a form. Native HTML button behavior still applies: a `<button>` associated with a form defaults to a submit button unless explicitly made `type="button"`.

Reproduced against the actual page script using Happy DOM, with the server's `clickProblem` check too:

```html
<form method="post" action="/send-message">
  <textarea name="message">The owner's existing draft</textarea>
  <button aria-expanded="false">More options</button>
</form>
```

Both checks allow the button; its click fires the form's submit handler. The same happens with `<button role="tab">Posts</button>`, and with a submit button outside the form associated through `form="composer"`. The ordinary `type="button"` disclosure is the passing control: it expands without submitting.

**No real message or network request occurred.** The fixture counts and prevents each submit. This is a specific interaction between the allowlist and HTML form behavior, not a claim about how every real social site marks up its controls.

Fix direction: check the control's effective submit behavior and actual form owner before allowing its ARIA role or label. Respect default button types and `form=` association. Refuse a submission into a non-search/sending form, while preserving explicitly non-submit disclosures/tabs and ordinary search/navigation. Do not add site bans, per-click approvals, new caps or a general browser-writing feature to solve this.

New reproduction: **`scripts/review/browser-form-submission.ts` — 1 passing control, 3 failing cases** on the reviewed commit. It intentionally exits nonzero until the fix. Keep its assertions.

```sh
BROWSER_REVIEW_DOM_MODULE=/path/to/happy-dom/lib/index.js \
  bun scripts/review/browser-form-submission.ts
```

Happy DOM is a separate review-tool installation, not an added application dependency.

## What independently passes

| Check | Result |
| --- | --- |
| Browser branch unit suite | 2,331 pass, 0 fail |
| Original review database probe | 8/8; Exa correctly skipped on this branch |
| Original DOM probe | 4/4 |
| Delayed old poll and same-connection control | both pass |
| Browser database suite | 69/69 |
| Native harness database suite | 27/27 |
| Organization-scope contract | pass |
| Migration | remove the two browser tables, apply SQL twice; both results match fresh-install columns, constraints and indexes |
| Typecheck | pass with a 4 GB Node heap |
| Extension packaging | pass, 17 files |

The migration replay and database suites use disposable **PGlite**, not native PostgreSQL concurrency verification. The first typecheck hit Node's default 2 GB heap limit; the rerun with 4 GB passed. This was a local checker memory limit, not an application failure.

The one-line original DOM-probe change is valid: a search box inside a message form is no longer classed as a search field, so the probe finds the input to test refusal directly. Its no-submit assertion remains unchanged.

The native startup-order change also passes its new tests: early calls wait for verified init, and an invalid init never authorizes a tool. The author's diagnosis corrects my earlier description of that failure as a test flake; the stdout/MCP ordering race was a real product defect.

## Local combination with Exa

Exa source: `72c31a0e25a56de2fa3f3a7b538903f2a882af37` plus its published executable-mode correction `4a82788dffbbf24db15e04e224592462e044ccbf` (`docker/deploy.sh` remains `100755`). The trial combination is local and unpublished.

Five conflicts, resolved by retaining both additions: `.dockerignore`, `Dockerfile`, `docker/deploy.sh`, `docker/deploy.test.ts`, and the long-result/page-state sets in `src/lib/assistant/agent.ts`. No research or sending behavior was rewritten to resolve them.

Combined results: **2,340 unit tests pass; typecheck and lint pass; review probe 9/9; Exa 30/30; browser 69/69; native harness 27/27.** Models, providers and the browser are stand-ins. BR6's genuine multi-page Exa evidence is accepted. The new form-submission failure is in the unchanged shared page script and still needs its fix.

## Handoff and remaining acceptance

Fix the single form boundary above on the browser branch, then rerun the new probe, existing DOM/page-rules checks, deployment packaging test, browser/native/Exa suites and the combined build. Keep the six fixes and init-order fix intact. This re-review adds only the report and regression probe; it does not implement the fix.

The code graph is regenerated locally for the added probe; the review publication omits that generated large graph. A full production build, actual Chromium/page-rules run, visible signed-in social page, real Chrome permission prompt, customer's personal Claude login and VM/proxy check were **not independently repeated here**. The author's reported real-extension/production checks remain their evidence, not mine. Live acceptance stays pending.
