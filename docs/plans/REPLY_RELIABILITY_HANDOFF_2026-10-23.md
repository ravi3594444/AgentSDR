# Backend handoff: reply reliability — 23 October 2026

Repository: `ravi3594444/AgentSDR`.

Create `claude/reply-reliability-20261023` from `3fc03b4d2933d7c9e061e95e48d871d3006adadd` on `origin/codex/pilot-deploy-20261021`.

Codex is doing the UI cleanup independently on `codex/ui-cleanup-20261023`. Do not merge that branch, edit UI files, push the deployment branch or deploy. Push your own backend branch for review. Keep each item below in its own tested commit; do not combine the four changes into one patch.

## 1. Claim renewal and ownership

Scope: `src/lib/crm/worker.ts`, `src/lib/crm/queue.ts`, `src/lib/assistant/replyAgent/agent.server.ts` and focused helpers/tests.

- CRM jobs currently become stale after five minutes without a heartbeat; reply-agent claims after three minutes.
- Renew a running claim only while the current worker still owns that exact execution. Use the existing ownership/attempt fields where possible. A timestamp alone is not ownership.
- A worker that loses its claim must stop. It must not renew, complete, overwrite a newer attempt's result or proceed into sending. Preserve the send path's existing idempotency and guards.
- The reply-agent claim needs the same protection as the queue claim. Its current conflict update and finish-by-id must not let an old execution overwrite a replacement.
- Clean up renewal timers on success, failure, abort and claim loss. Do not overlap asynchronous heartbeat calls or keep a cancelled/hung execution alive indefinitely. Coordinate the bounded execution window with item 2.
- Prefer existing columns. Any necessary schema change must be additive, update the schema and migration together, and be packaged by the deploy workflow.

Tests must prove: live slow work is not reclaimed; a dead worker stops renewing and is recoverable; two workers do not own the same execution; an old worker cannot renew or overwrite the replacement; completion/abort clears timers. Include the reply-agent claim and organization isolation.

## 2. One persistent retry/time budget

Scope: reply-job call sites, queue retry handling and an optional budget passed through `src/lib/ai/server/structuredCompletion.ts`.

- Start the budget on the first execution and persist the deadline and consumed attempts across queue retries/restarts. Do not create a fresh allowance every time a job is claimed.
- Every nested model attempt, grounding rewrite, truncated-output retry and schema-format fallback must fit the same budget. Document what counts as a provider request versus an answer. Bound actual transport requests as well as model turns.
- Enforce the remaining deadline on in-flight provider/CLI work with cancellation. Merely checking before a call does not bound its duration.
- Scope new budget behavior to CRM reply work. Preserve existing callers elsewhere: research, outreach writing, lead judging, tools and provider settings must keep their behavior.
- Choose and document named defaults based on both reply paths and tests. The suggested four calls / 120 seconds is a proposal, not proof it fits every stage. Add no user-facing settings in this patch.
- Back off transient provider failures; respect Retry-After within the remaining budget. Do not repeatedly retry permanent credentials/configuration failures. Preserve the existing bounded AI/ML schema-format compatibility fallback.
- Budget exhaustion must leave one visible, recoverable owner state. Keep work already saved and do not send a canned holding message.

Tests must prove: nested retries share the same counter/deadline; a queue retry/restart cannot reset them; a call is aborted at the deadline; exhausted budgets are terminal; permanent errors are not hammered; normal first-attempt success and the existing schema-format fallback still work.

## 3. Bounded reply history

Scope: `src/lib/crm/drafts.ts` and equivalent unbounded reads in the classification/reply-agent paths.

- The draft loader currently fetches the entire thread. The reply agent does likewise, then keeps the last 20 messages.
- Fetch the required first message separately and bound recent history to the existing prompt snapshot's limits. Preserve the trigger message, subject, ordering and existing call-summary context.
- Preserve prompt content and business behavior. Use deterministic ordering for equal timestamps and follow the repository's organization-scope rules for inherited message rows.
- Test empty, short and long threads, the boundary at the message limit, equal timestamps and the original subject. Demonstrate that a long conversation no longer loads all message bodies.

## 4. Failed-generation manual recovery

Scope: backend draft edit/save/send rules and their tests. The existing UI already offers an editor for failed drafts.

- `editableDraft()` in `CrmActionsClient.tsx` accepts a failed draft, while `updateDraft()` in `src/lib/crm/drafts.ts` currently accepts only `awaiting_review`. Fix the backend mismatch.
- After generation fails, a person must be able to write and save a reply, then explicitly approve/send through the existing guarded path. Editing alone must not trigger automatic sending.
- Distinguish generation failure, refused sending and uncertain delivery. Do not enable blind resend after uncertain delivery or bypass revision, stale-context, DNC, wrong-route, takeover or ownership checks.
- Preserve human edits through a refused save/send. Do not invent fallback sales text, introduce a model call or silently regenerate what the owner typed.
- Test failed generation -> human edit -> save -> explicit send, stale revision/context refusal, DNC refusal and uncertain-delivery handling.

## Existing architecture: do not conflate the paths

- Normal assistant-run replies use `runReplyAgent()` through the classification job and usually need one model answer. They do not all traverse classify -> draft -> separate AI check.
- The older draft/autopilot path does have a separate model reply check and can perform one repair. Keep its checks.
- Reply-agent turns already record `ms`, and runs record `totalMs`. This task does not need a new telemetry system.
- Claude's slot acquisition shares the runner deadline. Its structured adapter adds 20 seconds of process-start allowance; include that in any total deadline instead of assuming another independent 30-second wait.

## Validation and review handoff

Read AGENTS.md and CLAUDE.md. Use TypeScript and the existing graphify workflow. Reproduce each defect with a failing test before fixing it. Run typecheck, changed-file lint, focused unit tests and the relevant existing reply-agent / reply-delivery / workspace-replay database suites against disposable local data and fake providers. Run the organization-scope contract check for changed data access. Do not call real providers or send real messages for this task.

Push the backend branch, then return:

1. Commit SHA for each item, with files changed and the exact defect fixed.
2. Test commands/results, clearly distinguishing stand-ins from live verification.
3. Any migration and rollout requirement, remaining limits and known failures.
4. A short explanation of claim fencing, persisted budgeting, history equivalence and failed-draft transitions.

Codex will review the backend diff and tests before merging it with the UI cleanup. The combined branch then needs its own regression/build checks and a controlled live reply test before deployment is called verified. This handoff does not claim the remaining bugs are fixed or authorize a production deploy.
