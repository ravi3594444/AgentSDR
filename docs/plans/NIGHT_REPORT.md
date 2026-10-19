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

### S11 Workspace: the CRM half (`7b63f66`)

- **Conversation summary.** Every CRM record, and every Action required
  row, now carries a summary built only from recorded message evidence:
  - the latest inbound and outbound message;
  - who answered: "Answered by you" or "Answered by assistant", else a
    neutral label;
  - "Waiting for their reply" where that is true;
  - the account and channel, and the effective reply mode;
  - any pending draft or decision;
  - restrictions (DNC, wrong route) and the actual next action.
- **New views.** Action required gains Needs you and All replies views, each
  with a count. `/crm/actions` keeps working.
- **Manual replies settle.** A manual reply, from the app or echoed from
  WhatsApp Web, settles the pending reply and stales its drafts. It keeps
  unrelated open decisions and newer messages, and never changes takeover.
- **Badge.** The Action required badge counts exactly what the list shows.
- **Instagram.** It is in the channel filter and in account attention.
- **Unnamed contacts.** They show their business and contact route.
- **Verification.**
  - `scripts/e2e/workspace-replay.ts` (87 checks) replays the pricing enquiry,
    the assistant's answer, the owner's reply from WhatsApp Web and a newer
    message.
  - It also covers a pending classification, an unrelated quote decision,
    wrong number and DNC, duplicate and delayed webhooks, an unavailable
    provider, and isolation.

## Review of the whole night's work

Every slice was then reviewed by area: providers, assistant, outreach starts
and evidence, CRM send paths, and tenancy and Activity. S11 got its own
review. Each finding was handed to a second agent whose job was to refute it.

Results: 35 findings confirmed, 3 refuted. The confirmed ones were 1
blocker, 6 major and 28 minor.

### Round one of fixes (`0634a6d`)

The findings were split into six clusters with no files in common:
providers, assistant, plan evidence, wrong numbers, CRM workspace and
Activity. Each cluster was fixed test-first in its own worktree and its own
fresh database, then handed to a verifier.

The blocker and every major finding were fixed:
- **WhatsApp privacy id.** A WhatsApp `@lid` id was recorded as the wrong
  route, so phone-based checks missed it.
- **Apify Maps.** It could run, and be paid for, a second time after it
  already searched.
- **Stale waits.** A search that had started was still shown as "waiting
  for a slot".
- **Grounding.** `web_search` echoed the model's own query into what counts
  as grounded, so a guessed email or phone could pass.
- **Activity Cancel.** It was offered on a plan's start job, where it did
  not stop the launch.
- **Campaign steps.** They were labelled "Answered by you".
- **Stuck classification.** An owner's reply that arrived during
  classification left the lead stuck in "classifying".

Results after merging all six clusters:
- `tsc`, eslint and `db:check` pass, and so do 1554 unit tests.
- All 13 e2e suites pass:

  | Suite | Checks |
  | --- | --- |
  | activity | 34 |
  | workspace-replay | 102 |
  | reply-agent | 82 |
  | delivery-evidence | 23 |
  | autonomous | 62 |
  | assistant-intake | 44 |
  | assistant | 73 |
  | assistant-recovery | 9 |
  | tinyfish | 40 |
  | browser | 20 |
  | research-sources | 41 |
  | apify | 63, plus its 5 known failures |
  | web-discovery | 83, plus its 2 known failures |

The verifiers then found one regression: a sending window ending at
midnight showed 00:00 as the next send. They also found several partial
fixes:
- A person's manual "Wrong Number" confirmation ignored "stop" wording, so
  it recorded no DNC.
- A privacy-id chat recorded the person's current phone, not the number
  that wrote.
- Campaign-step labels did not survive removing a lead from the campaign.

They also found one older gap: Stop pressed during a plan's launch did not
stop the campaigns being created. These went into a second round, below.

### Round two of fixes

The first attempt stopped on the account's session limit before any change
was committed. The safety items were then done by hand, test-first, and
merged in `a0364c1`:

- **"Stop" wins whoever confirms a wrong number.** A person confirming
  "Wrong Number" on "This isn't Priya's number anymore, please stop texting
  me" now sets Do Not Contact and drafts no apology. `closeWrongNumber`
  reads the message's own opt-out wording for every caller.
- **The number that wrote is the one blocked.** A WhatsApp chat addressed
  by a privacy id (`@lid`) is recorded by its own chat's number. Before, it
  used the Person's current phone, which an operator may have corrected; or,
  with no number known anywhere, the privacy id itself. Both WhatsApp send
  paths check a chat's privacy id as well as its number.
- **Stop during a plan's launch.** The launch step now records whatever
  campaigns it already created on the run and stops them, so nothing it set
  up sends. Before, they stayed active and out of Stop's reach.
- **No midnight promise (the regression).** A sending window that ends at
  00:00 reports its real start as the next send. A plan's
  `diagnose_delivery` names only its own senders.

Checks after the merge:

| Check | Result |
| --- | --- |
| Unit tests | 1559 pass |
| reply-agent | 87 |
| workspace-replay | 102 |
| autonomous | 63, including a trigger-driven Stop during launch |
| delivery-evidence | 27 |
| assistant | 73 |
| assistant-intake | 44 |

## Tenancy isolation

`scripts/e2e/tenancy-isolation.ts` was run against a dev server on a fresh
local copy (`agentsdr_iso`: `db:setup`, the demo organization as A, and the
fixture rows for every table added tonight, from
`scripts/e2e/seed-new-feature-fixtures.ts`). Result: **no isolation
failures**.
- Fingerprints: 1144, from 72 tables of A.
- The positive control found A's own data in 38 of 69 plain GET routes.
- Checked as B: 119 reads, 109 writes and 69 pages.

It lists three items to review. Each answers 200 to B for one of A's ids,
but no A identifier appears in the response. All three are routes tonight's
work did not touch:
- `GET /api/linkedin/campaigns/[id]/chart-data`
- `GET /api/linkedin/campaigns/[id]/merge-fields`
- `GET /api/outreach/inbox/leads/[id]/crm-context`

A 404 would be more correct for each.

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
7. `add-objectives.ts`: `assistant_objectives`, the `objective` job kind, `treg_calls.request_id`. Search tools create objectives and Treg calls write the column.

The image now ships all seven (`Dockerfile`, `.dockerignore`).

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
5. Decide decision 16 in the decisions log (whether Instagram-only accounts are eligible).

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
