# Night report, 18–19 October 2026

Branch: `claude/dreamy-fermi-h5woha`, built on `claude/new-session-g5hljn`
(`0181203`). Every commit below passed the gates before it was pushed.
Nothing was merged into `main`, nothing was deployed, and no message was sent
to a real person.

The plan is `docs/plans/IMPLEMENTATION_PLAN_2026-10-18.md`. The words used here
are defined in `CONTEXT.md`. Every default taken without asking you, and its
alternative, is in `docs/plans/DECISIONS-2026-10-18.md`.

## What landed

| Slice | Commit | What it does | How it was verified |
| --- | --- | --- | --- |
| S0 Foundation | `58114a7` | Code graph (`graphify-out/`), glossary (`CONTEXT.md`), decision log, `instagram_outreach_queue` added to `OWNED_TABLES` | Baseline gates recorded |
| S1 TinyFish | `de2d8f8` | Per-organization TinyFish key (verified with one search before saving), free-allowance quotas per key (`provider_quota_state`, global) and an org-scoped usage ledger (`provider_usage`, reserve then settle) | `scripts/e2e/tinyfish.ts` 34 checks; live Search, Fetch and Browser through `scripts/e2e/tinyfish-live.ts` |
| S2 Web search and reading | `ce6dba4` | `web_search` tool; `read_webpage` checks the address is public, then reads through TinyFish Fetch, else directly; links on read pages become known links; tighter URL grounding | Unit tests; tinyfish e2e |
| S3 Quotas | `de2d8f8` | A 429 or exhausted allowance makes the job wait with the reason until the reset, instead of failing | tinyfish e2e (429, daily allowance, two organizations on one key) |
| S4 Free sources | `3e857d2` | Hacker News and Stack Exchange readers within their limits; Reddit refused with "API approval not recorded", and a place to record approval (`research_settings`) | `scripts/e2e/research-sources.ts` 37 checks |
| S5 Routing | `ddc1084` | Google Maps through the built-in scraper first; Apify only when asked or as the approved fallback; Instagram searches wait for an Apify slot instead of reporting 0; per-platform coverage in status and completion events | `scripts/e2e/apify.ts` (see the known failures below) |
| S6 Autonomy and reports | `df1edcd` | Autonomous and request-approval starts leave out people already in a running plan and start the rest; all-overlap plans close as "No new leads"; job reports posted exactly once, also after a restart; `report` tool scoped to request, chat, run or organization; TODAY in the organization's time zone | `scripts/e2e/autonomous.ts` 51 checks |
| S7 Recovery | `010b69f` | Root cause of the "{} / message-only" failures: AI/ML API with `tool_choice: "auto"` let the reasoning model run out of tokens. Calls now name the function, refuse a truncated tool call and retry with a larger budget; after 3 attempts the chat shows a plain failure and a Retry button | `scripts/e2e/assistant-recovery.ts` 9 checks; live Haiku 5.5 call: 4 actions on the first attempt |
| S8 Wrong number | `dedba0e` | A wrong-number reply stops outreach to that route at once and blocks it for the organization; Automatic sends one apology, Review drafts it; "stop" in the same message means DNC and nothing is sent | `scripts/e2e/reply-agent.ts` 62 checks |
| S9 Browser | `1c8df1f` | `browser_open/read/click/fill/scroll/close` over TinyFish Browser (CDP), off until you allow minutes a day; one session per organization; minutes reserved and settled; closed at the end of every turn | `scripts/e2e/browser.ts` 19 checks; live session read by the real driver |
| S10 Activity | `78c9cd7` | `/activity`: every search and plan, and every reply, across all chats, with the real state and reason; cancel a search; new-replies badge | `scripts/e2e/activity.ts` 23 checks; screenshots, desktop and phone |
| S12 Plan evidence | `da68f91`, `8bf2721` | Plan cards say who authorized sending (Start, request approval, Autonomous, or not started), each sender's time zone, gate and next allowed send, and per-lead delivery evidence (accepted, delivered as WhatsApp reported, read receipt; never "seen") | `scripts/e2e/delivery-evidence.ts` 18 checks |

S11 (the CRM half of the workspace rework) is reported in its own section below.

## Gates on the final commit

<!-- filled in at the end -->

## Before you deploy this branch

Run the migrations in this order, in the running container
(`docker exec <container> bun scripts/<name>.ts`) or against the database.
Each one is safe to re-run. The new code reads these tables and columns, so
run them all before the new image takes traffic.

1. `add-tinyfish.ts`: `tinyfish_settings`, `provider_usage`, `provider_quota_state`
2. `add-research-sources.ts`: `research_settings`
3. `add-browser-sessions.ts`: `browser_sessions`
4. `add-wrong-number.ts`: `crm_wrong_routes` and the "Wrong Number" subcategory. Classification and every send path now query it.
5. `add-activity.ts`: `activity_seen`
6. `add-assistant-job-reports.ts`: `assistant_jobs.report_key`, `reported_at`. The worker writes these columns.

The image now ships all six (`Dockerfile`, `.dockerignore`).

## Your morning list

1. **Rotate both keys** shared in the chat (TinyFish and AI/ML API). They were
   kept in a scratch file outside the repository and never committed, but they
   were in the conversation.
2. Settings → Organization → TinyFish: paste the new key (one free search
   verifies it). Browser minutes stay at 0 unless you want the browser tools.
3. Run the two buyer examples with a spend cap, for example "find real estate
   agents in Pune who might buy AI automation", and read the coverage line:
   it names each source and provider, and what was not searched and why.
4. Send one test inbound reply to a plan in Review mode and check Action
   required, Activity → Replies and the plan card agree.
5. Decide decision 16 below (Instagram-only eligibility).

## Known gaps and failures

- `scripts/e2e/web-discovery.ts` (2 failures) and `scripts/e2e/apify.ts`
  (5 failures) fail identically on the baseline `640b2d6`. They expect
  Instagram-only accounts to be excluded or uncontactable, while the branch
  makes them reachable by DM. Which rule is intended is your call (decision 16).
- The AI/ML API test key reached its all-time limit for premium models
  (Claude Sonnet, Qwen); Claude Haiku 5.5 still answered and the fix was
  verified on it only.
- The manual Start button still enrols everyone, overlaps included (as
  before tonight); only Autonomous and request-approval starts leave
  overlaps out.
- LinkedIn senders are not in a plan's Sending status yet; the card says so.
- Reddit has no reader by design; recording an approval enables nothing yet.
- If the process stops between an Autonomous start and its chat event, that
  event is lost; the launch job's own "Outreach started" report still
  appears.
