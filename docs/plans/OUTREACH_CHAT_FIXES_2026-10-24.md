# Outreach chat fixes — 24 October 2026

Branch: `codex/outreach-chat-fixes-20261024`, based on release `8eedc1a`.
No new migration; no provider, sender, daily-limit or approval settings changed.

## Reproduced problems and changes

- Instagram recipients saved by `add_instagram_contacts` had no request id,
  and were not marked as owner-selected matches. The request planner could
  therefore see the WhatsApp recipient and miss the supplied Instagram handle.
  The list now belongs to its request. Only exact handles present in the
  owner's message get an owner-selected match; other handles still need review.
- Each `prepare_outreach` call built a new derived list and another proposal.
  Identical request/recipient/route preparations now reuse the selection list
  and run before another writer call. A final lookup under a transaction-level
  advisory lock prevents two identical preparations publishing two runs.
  Review/Automatic is a choice on the same card, not another campaign.
  Explicitly different writing instructions or a based-on rewrite can still
  produce a different proposal.
- A new chat could prepare outreach for people already in an active conversation.
  Preparation now reports their existing running/starting/paused plans without
  another proposal or writer call. Mixed lists prepare only the uncovered
  people, with the covered people left out with a reason. Start's existing
  overlap check remains the final authority; this does not resume paused runs.
- Routine chat steps now share one expandable Activity log per turn. Exact
  brief echoes are omitted and repeated successful messages for the same run
  show one current plan card. Actual errors, decisions and different plans stay
  visible; stored message history is retained.
- The observed owner note predicted an exact pricing question that “may follow”
  even though the lead's services question was answered. The reply prompt now
  distinguishes actual unanswered questions from possible future questions.
  English future-question predictions in a question note are sent back through
  the existing bounded repair loop. The note is not silently removed: it may
  also contain a genuine owner action. Real unanswered price questions still
  reach the owner; grounding and the shared retry/time budget stay enforced.

## Verification

Seven new database assertions fail on the unchanged `8eedc1a` release and
pass with these fixes: repeated proposal/list creation, active-run reuse,
cross-chat active/paused coverage, and the two-channel Instagram omission.

Disposable PGlite, one connection, fake providers only:

- Research agent v2: 44 checks pass (including pre-fix proposal compatibility).
- Reply agent: 110 checks pass.
- Autonomous: 70 checks pass.
- Assistant: 73 checks pass.
- Original reliability review: 11 checks pass.
- Additional reliability boundaries: 6 checks pass.
- Organization-scope contract: pass; suites include second-organization checks.

The legacy Assistant suite initially failed two assertions on both this branch
and the unchanged release. Its fixture filled to a hard-coded 40 replies while
the application's configured limit is 200. The fixture now uses
`AUTOPILOT_LIMITS.perDay`, retaining the assertion that five concurrent jobs
with only two slots left send exactly two messages. Its report assertion uses
the same configured allowance. The product limit was not changed.

Final unit suite: 2,259 pass, zero failures. Typecheck, changed-file lint,
diff checks and the production build pass. Two existing malformed-HTML
performance assertions exceeded their 500 ms threshold while a build was
running; the final full unit run, without a concurrent build, passed unchanged.

## Deployment and remaining checks

No real messages were sent by these local checks, and the VM was not changed.
Existing proposed plans are not cancelled and old owner decisions are not
silently resolved. An owner answer was submitted for the browser test's old
WhatsApp decision separately; these changes prevent the reproduced new failures.

After deployment, use a new chat with one supplied Instagram handle and one
supplied WhatsApp number. Check both appear in the request and plan. Retry
preparation and confirm the same plan remains. Reply from each test account and
verify one response per inbound message. Check one Review-mode reply too.

Native multi-connection PostgreSQL contention, live providers and a Docker
image build remain unverified here. The local Next build uses build-only font
fixtures because Google Fonts downloads are blocked; fixtures are outside the
repository and never shipped. The VM must fetch the actual fonts.

The AST graph was regenerated locally. Its ~18 MB graph.json exceeds the
connector's 16 MiB snapshot limit, so the generated graph pair is not included in the source snapshot;
it can be regenerated from the published source with `graphify update .`.
