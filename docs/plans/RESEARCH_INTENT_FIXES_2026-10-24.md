# Research intent fixes — 24 October 2026

Branch: `codex/research-intent-fixes-20261024`, based on the chat fixes at
`b31f83b`. No changes to sending, authentication, DNC or reply grounding.

## Resulting behavior

The owner supplies the goal; the model selects connected sources by their
relevance and actual matching/contactable yield. No paid/free choice or
saved request allowance is required. An explicit budget in the owner's
request still applies. Provider limits and Included-service allowances,
Pause, Stop, sending limits and the existing time limit still apply.

An ordinary request has `spendCapUsd: null`. Zero means the owner explicitly
asked for free sources only; a positive amount is an explicit request cap.
The brief reads that cap from the owner's words, so a model-supplied zero
cannot turn an unrelated ordinary request into free-only research. Old
`objectiveSpendUsd` settings are retained for compatibility but ignored for
new requests and hidden from the research form. Usage continues to be recorded.

The current request controls the audience. Saved customers and previous
campaigns are context, not mandatory niches or locations for a broad new
request. A real continuation can still inherit the earlier request's scope.
The prompt tells the model to ask only when missing owner information or
source access blocks progress, rather than asking users to choose providers.

## Concrete qualification defect

The assistant's summary previously preceded the owner's original messages,
and the sorter kept only 600 characters. A narrow interpretation could
therefore crowd out the owner's broad request or latest clarification.

The owner's words now come first; the initial request and newest answers
are bounded separately. The model's summary is labelled search strategy,
not extra requirements, and the sorter receives up to 4,000 characters.
Plan preparation uses the same owner-grounded request as qualification.
Instructions distinguish questions to ask after contacting someone from
evidence that must already exist before contact. No claim of success,
revenue or buying intent may be invented to improve the counts.

Progress without a budget shows recorded spending without a fictitious
`$0` cap. A continuation and the request details omit `of 25` when the
owner named no target; this does not change the existing target semantics.

## Upgrade

`add-optional-research-budget` drops NOT NULL on
`assistant_objectives.spend_cap_usd`; the fresh schema matches it. Existing
requests and their numeric caps are not rewritten. The migration is in the
Dockerfile, .dockerignore and the default deploy sequence. A repeated run
preserves existing caps. Start a new request to test the new behavior;
previously stored no-match verdicts are not silently changed.

## Verification

- Seven budget checks failed before the change and pass after it. Two more
  request-context checks reproduced summary precedence and truncation.
- Application/scripts unit tests under TZ=UTC: 2,245 pass, zero failures.
- Deploy tests, including migration packaging: 25 pass, zero failures.
- Disposable PGlite with one connection and fake providers: research-budget
  16, objective 98, research-agent-v2 44, assistant 73, chat-unicode 7
  and discovery-errors 7 checks pass (245 checks total across the runs).
- The budget suite applies the real migration twice over an older NOT NULL
  column and verifies preservation, uncapped reservations, explicit caps,
  credits, individual tools, Pause/Resume/Stop, deadlines and isolation.
- Organization-scope contract passes.
- Typecheck and changed-file lint pass.
- Production Next.js webpack build passes. Its font download used an
  offline build-only fixture outside the repository; the VM must fetch
  its real fonts. No Docker image was built here.

## Limits of this verification

No live provider or recipient was contacted, and no VM was changed.
The real model's research strategy and relevance decisions need a live
recheck: stand-ins prove the instructions and data delivered to it, not
semantic accuracy. Full Bright Data and full-flow suites did not complete
the social-research leg on this one-connection fixture; they are not counted
as passes. Native multi-connection PostgreSQL locking is not verified.

The reported `EAI_AGAIN gmaps-scraper` is a separate VM DNS/service failure;
this patch does not repair its container. The deploy script pauses that
scraper during image compilation, which is one possible cause while a
deploy is running. The three safety findings in the break-test report are
separate pending work.

The later “have done?” follow-up returned HTTP 500 after research had
already stopped. The uploaded SQL log shows a lead-review save containing
an invalid half-emoji (a lone surrogate). PostgreSQL rejects the same input
with 22P02 in the regression check. Inserts cleaned their strings and JSON,
but updates did not. Updates now use the same sanitizer, and review text
uses Unicode-safe clipping. Seven checks cover rejection of the original
input, a successful completed update, valid emoji, nested keys/values,
status-only updates and organization isolation.

If the builtin Maps scraper fails and the approved Apify fallback cannot
run, an available website search now takes over with the same request,
customer type and location. A retried handoff reuses the saved child job.
The seven discovery-errors checks verify these paths and honest failures
when no fallback is available. Actual Docker DNS remains a VM check.

Search cards now say Search finished, Search failed or Source not searched
rather than implying the whole request has stopped or finished. Provider
labels use the backend actually attempted. An orphaned tool row is no
longer shown as live work: the current turn and busy state decide whether
it says Working, Step interrupted or Status unavailable. No old tool is
automatically replayed, and a tool step never proves a DM was sent.

The model is instructed to send discovered social URLs through an
available collector after a login-blocked direct read, rather than
repeating the blocked page read. Its real source choices remain a live
check. Earlier no-match reasons in the supplied log also confirm that some
leads were judged against old niches; this does not establish that every
contactable lead should match, and no verdict was automatically reversed.

Double-check on 25 October: an inherited local timezone reproduced two
unrelated date-test failures on both this branch and its unchanged base.
The full suite passes under the test environment's TZ=UTC; product code
was not changed for those tests. The GitHub snapshot had also dropped the
deploy script's executable bit. That is corrected and all 25 deployment
tests pass; the final source publisher preserves file modes.

The AST graph was rebuilt locally. Its ~18 MB graph.json exceeds the
connector's snapshot limit; the generated graph pair remains local and can
be rebuilt from this branch with `graphify update .`.
