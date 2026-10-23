# Prospect reply conversation quality — 23 October 2026

## Scope

Only the prospect reply agent's instructions and decision-field descriptions changed. Research, model/provider settings, credentials, customer accounts, delivery rules and database access are unchanged. The WhatsApp identity handoff fix is already in `27a5192`.

## Findings and change

The old prompt required a new discovery question for every bare greeting while also saying not to ask after an ignored question. That encouraged a fresh sales opener instead of continuing the chat. It did not clearly separate a possible fit, an answer to discovery and the lead agreeing to a call. The model sometimes notified the owner that a person wanted a call when only the assistant had offered one.

The revised instructions ask the agent to use the previous answer, interpret ordinary spelling mistakes in context, avoid repeated introductions and acknowledgements, answer the specific question or problem, and ask one focused question only when useful. Owner notes default to null and need a real owner action. Interest and a ready-for-call notification must come from the lead's expressed intent. These distinctions are also described beside the structured fields. No phrase replacement, canned reply, extra model call per production reply or keyword classifier was added.

## Real-model evidence

The send-free evaluator runs the production prompt builder, `runReplyGeneration`, `runtimeFor` and `completeStructured`, with the current AI/ML model catalog and a temporary test key. It uses conversation fixtures in memory. There is no database connection, settings write or messaging adapter. Network requests are restricted to AI/ML. The temporary key was removed and is absent from all changed source files.

| Run | Evidence |
| --- | --- |
| DeepSeek Chat baseline, six transcript cases | Four cases had the recorded quality problems: premature interest, two false ready-for-call notes, or another sales question after an ignored question. Pricing handoff and opt-out worked. The baseline did not reproduce the exact repeated-thank-you wording in every sample. |
| Same six cases, first revised prompt | Four had no recorded observation, up from two. The ignored greeting was answered briefly, and the false ready-for-call notes stopped. Two pain-only replies were still labelled interested. |
| Further focused DeepSeek checks | The outbound-calls answer and clinic-process case were other with no owner note. A pain-only existing-CRM case still came back interested, including after strengthening the field descriptions. This is an unresolved model-quality limitation. |
| Haiku 5.5, final prompt and schema | Four checks passed: the owner's typo, existing-CRM follow-ups, missing pricing, and a continuation using the model's own previous reply. Discovery stayed other with no owner note. Pricing was interested with a question for the owner. The continuation used the spreadsheet/follow-up detail and skipped the previous acknowledgement. |

The evaluation used **30 model answers**, including answers rejected and retried by the existing harness, over **52 completion HTTP requests** (many were schema refusals before the existing function-call fallback). AI/ML reported **51,719 input tokens and 6,671 output tokens**. Dollar cost was not measured. The evaluator capped answers at 30; no further paid calls were made. Its raw-request ceiling was extended from 48 to 54 for the final cross-check, keeping the same 30-answer limit.

These are small, manually read transcript checks, not a guarantee for all leads or models. The evaluator's observations are test-only heuristics; they do not filter customers' replies. In particular, a synonym for follow-up was initially flagged by the evaluator and the observation was corrected before comparing both sets of transcripts.

## Verification

- Existing unit suite: 2,215 pass, 0 fail.
- Four new evaluator checks pass, covering false interest/owner handoff, repeated filler without banning normal acknowledgements, follow-up synonyms, pricing and opt-out observations.
- Typecheck and lint pass.
- The graph was regenerated locally. Its JSON remains too large for the GitHub connector's 16 MiB input limit, so the remote graph/report pair is retained together at the preceding revision.
- No new production build or VM deployment was run for this instruction-only change. Actual customer-channel delivery was intentionally not exercised.

## Reproduce without changing any workspace

Use a temporary key file outside the repository, readable only by its owner:

```bash
bun --conditions=react-server scripts/eval/reply-agent.ts \
  --key-file /path/to/private-test-key \
  --model anthropic/claude-haiku-5.5 \
  --phase check --output /tmp/reply-evaluation.json \
  --budget-file /tmp/reply-evaluation-budget.json
```

The budget file is shared across phases so restarting the process does not silently reset the cap. An optional `--catalog-file` reuses a freshly downloaded public AI/ML catalog. `--only` accepts comma-separated scenario IDs; `--dialogue-only` exercises a conversation in which subsequent turns use generated previous replies. Read the transcript as well as the observations. Remove the temporary credential when finished.
