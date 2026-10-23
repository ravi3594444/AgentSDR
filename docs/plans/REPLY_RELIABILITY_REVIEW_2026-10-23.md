# Reply reliability review — 23 October 2026

Reviewed remote `claude/reply-reliability-20261023` at
`98d58433def3bad2eb4ee4488f83e28f97279fc1`, based on `3fc03b4`.

**Decision: hold the backend/UI merge.** Four findings below need correction.
This review changes only a regression probe and this document. No application
code, UI, deployment branch, running VM or provider settings were changed.
All models and sends used stand-ins; no real message was sent.

## RR1 — Budget persistence fails open (high)

`src/lib/crm/ai/budget.server.ts`: `persist()` catches every exception,
including `CrmJobClaimLostError`, and `beforeTransportRequest()` still returns
true. An execution may authorize a request without recording it, or after
another worker took its claim.

Reproduction: create a real claimed classification job and initialize its
budget. Replace its owner/attempt in the database. The old budget authorizes
one more request despite its write being refused. The replacement then reads
the persisted state and authorizes ten more: **11 authorized against a cap of
10**. The test counts authorizations; it does not make paid calls.

Required correction: persist successfully under ownership before allowing a
transport request. Propagate claim loss instead of treating it as a warning;
transient persistence failure must not authorize an unrecorded request. Keep
the persisted deadline/counter across retries and restarts.

## RR2 — Reply-agent fencing does not fence effects (high)

`src/lib/assistant/replyAgent/agent.server.ts`: fencing the heartbeat, turns
and final status prevents old audit writes but does not stop drafting or
sending. `claimLost` changes only on the next heartbeat. The fenced turns
update can match zero rows; its result is ignored.

Reproduction: increment the claimed reply run's attempt while the stand-in
model is working, then return a valid answer before the heartbeat runs. The
displaced execution **creates one draft and makes one fake send**. The newer
attempt's run row remains protected, so fencing metadata alone is insufficient.
This proves an obsolete execution can act; it does not assert that the
existing send idempotency always permits two deliveries.

Required correction: check current claim ownership at effect boundaries,
including the transaction that creates the draft/reserves the send. Stop on
a zero-row ownership check; propagate cancellation to active model work.
Do not rely only on a periodically updated boolean. Preserve all existing
send idempotency, revision, DNC, takeover and context checks.

## RR3 — Losing the CRM job does not stop its handler (high)

`src/lib/crm/worker.ts`: a lost claim clears the renewal interval but does not
cancel the handler. Completion/failure are fenced only after it has acted.
The reply agent's own claim can remain valid after its parent CRM job changes
owners. Legacy classification, draft and automatic-send paths also need the
same execution boundary.

Reproduction: process a genuinely claimed classification job through
`handleClassificationJob`. Change that job's owner/attempt inside the fake
model, then return a valid reply. The displaced handler **makes one fake
send** after losing its CRM claim.

Required correction: bind handler work to the exact CRM execution and stop
effects after claim loss, independently of the reply-agent claim. Serialize
renewals so slow database writes cannot overlap. Bound renewal lifetime,
cancel active work on loss/deadline, and clean up timers on all exits. A
replacement must not be overwritten or marked failed by the old handler.

## RR4 — Permanent provider failures still retry at the queue layer (medium)

`src/lib/crm/worker.ts`: only `PermanentCrmJobError` and the budget-exhaustion
name are terminal. An HTTP 401 propagated by the completion is treated as a
normal retryable job error. The persistent budget does not fix that.

Reproduction: the real queue worker drains the same job three times with a
stand-in completion that rejects with status 401. It invokes the completion
**three times**, then fails on attempt three. The probe advances `runAfter`
between drains to skip sleeping; it does not reset payload, budget or attempts.

Required correction: keep permanent provider/configuration failures terminal
through both layers, including errors with a nested cause. Preserve the
existing single AI/ML schema-format compatibility fallback. Back off transient
failures within the remaining budget and respect Retry-After; do not apply new
CRM behavior to unrelated research/writer callers.

## Reproduction and validation

`scripts/e2e/reply-reliability-review.ts` contains the targeted regression
probes. Run it with Bun's `--conditions=react-server` against a fresh local
database using `db/schema.sql` and `db/seed.sql`. It refuses non-local data and
forbids external fetches.

On the reviewed application code: **5 checks pass, 6 fail**. Failures correspond
to RR1 (2), RR2 (2), RR3 (1), RR4 (1).

The five passing checks prove that a failed generation can be manually edited
without sending, creates no auto-send job, rejects a stale revision, can be
explicitly sent through the normal guarded path, and refuses editing an
uncertain delivery. These are behavior checks, not just status predicates.

Other checks performed on the reviewed branch:

| Check | Result |
| --- | --- |
| Unit suite, `TZ=UTC bun test --conditions=react-server` | 2,237 pass, 0 fail |
| Typecheck (Node heap 4 GB) | pass |
| Changed-file lint | pass |
| `scripts/e2e/reply-delivery.ts` | 21 checks pass |
| `scripts/e2e/workspace-replay.ts` | 107 checks pass |
| Organization-scope contract against fresh schema | pass |

Database checks here use disposable PGlite (PostgreSQL-compatible WASM) with
one connection. They verify SQL transitions and the deterministic takeovers
above; they do not establish real multi-connection PostgreSQL lock behavior.
The full email-heavy `reply-agent.ts` suite could not finish in that setup:
its email suppression check requests a global-pool query while holding a
transaction. It was stopped and is **not counted as passing**. That limitation
is not classified as a regression introduced by this branch. Native Postgres
reply-agent/locking checks remain required.

The first typecheck invocation hit Node's default 2 GB heap; the same code
passes with `NODE_OPTIONS=--max-old-space-size=4096`.

No production build, combined-branch gates or live-provider checks are claimed:
the merge is intentionally held on the four reproduced findings.

## Agent follow-up

On the existing backend branch, take the regression probe from this review
and fix RR1–RR4 in focused commits. Do not touch UI, prompts, provider defaults,
research behavior or sending limits. Do not deploy or call real providers.
Run these probes to green without weakening their assertions, plus the
original lease/deadline/restart/cancellation tests required by
`REPLY_RELIABILITY_HANDOFF_2026-10-23.md`. Return the updated remote SHA and
test results for another review. The UI branch remains independently
deployable at `4e8e69c`.
