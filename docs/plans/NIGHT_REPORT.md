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

## Day two, 19 October: finishing the plan

You decided decision 16 (Instagram-only prospects are eligible) and asked for
the rest of the plan to be finished, with no further provider integrations.
Two parts went to sub-agents in their own worktrees and databases; the rest
was done directly. Each was gated before it was merged.

| Work | Commits | What changed | Verified by |
| --- | --- | --- | --- |
| Decision 16 | `391785a` | An Instagram-only account is a lead when its profile was read and, for a place, names it; otherwise it is kept for research with the reason. A commenter stays for research until its own profile is checked | The 7 earlier failures pass, with new positive cases (`apify` 70, `web-discovery` 85) |
| Final review fixes | `a3af223`, `0c67135` | A privacy-id chat keeps its number; a live wrong-number claim is retried later instead of failing; Stop takes the campaigns from its own write; a launch records each campaign before activating it and a retried launch reuses it; a page that only echoes the model's query grounds nothing | `reply-agent` 103, `autonomous` 68, unit tests (each failed before the fix) |
| LinkedIn sending status | `c720cdb` | Plan cards show each LinkedIn account with the engine's own checks: hours, the daily invitation limit, the next allowed send | `delivery-evidence` 30 |
| Activity states and counts | `e15415b`, `ee4b2e6` | Outside sending hours (with the next allowed send in the viewer's time), partly done, each plan's leads, contacted and replied, each request's research and how it ended | `activity` 41 |
| Per-request controls (item 1, sub-agent) | `5e5316f`, merged `29e60af` | `assistant_objectives`: a lead target, time limit and spend cap per request; continuation across jobs without an owner message; spend reserved and settled through the existing ledgers; the stop reason stored; partial results kept; one final report | `objective` 56 |
| Shared metrics (item 2, sub-agent) | `1637d4a`, merged `ab07da2` | One set of definitions, dates and time zone for Overview and Analytics; current counts labelled apart from period totals; per-source found, qualified and contactable people | `metrics-parity` 36 |
| Full flow with fake providers (item 4) | `ba14585` | One request from the prompt to the final report, including continuation, Start, request approval, a launch taken over after its worker died, and repeated callbacks | `full-flow` 18 |
| Desktop and phone checks (item 5) | `907dee2` | Plan cards, Leads & replies, Action required, a record and Activity at 1366 and 390 px. Fixed: a record's status line shrank to one word per line on a phone; the stage filter ran its counts together on a phone; "these 1 leads"; an ISO timestamp in Activity | Screenshots before and after |

The full-flow test also found that a business found with only a phone was
named by its number in plans and in the facts given to the writer; it is now
named by its business name (`ba14585`).

### Final review of day two (`502f71d`, `171c3b6`, `8cb9d26`)

The one final check, as a bounded workflow:
- Three reviewers covered objectives and spend; metrics and reporting; and the
  directly written fixes.
- A skeptic tried to refute each serious finding, two per reviewer.
- The rest were judged here by reading the code.

Results: 12 findings. 11 were real and are fixed, each with a test that
failed first. 1 was refuted: the funnel's "% of previous" follows from
period counts and is labelled.

| Finding | Severity | Fix |
| --- | --- | --- |
| Pausing during a continuation turn ended the request as "sources exhausted" on resume | major | The pause time is recorded; that turn is not judged |
| A spend-guard wait (pause, cap held) skipped Instagram profile reads, so every account was kept for research | major | A "profiles" stage keeps the posts and retries, bounded |
| A retried launch reused its already-active LinkedIn campaign, failed the run and left it sending, beyond Stop | major | An active recorded campaign counts as launched |
| A deferred wrong-number job was recorded as a failed classification and set the record to error | major | Deferral is not a failure |
| In Autonomous mode a new request was filed under, and refused by, a stopped earlier one | major | The turn decides the search's request once (`searchRequestFor`) |
| An Apify start whose answer was lost was recorded as refused at $0 | minor | It stays "starting", counted, never retried; swept as spent |
| A deferral on a job's last attempt left it queued forever | minor | Deferral gives back the attempt |
| A guessed phone with separators in a URL path was grounded by the page's echo | minor | Path segments with 7+ digits count as model-written |
| The grounding strip removed a domain an earlier search had returned, and with it the page's real email | minor | Only what no earlier source gave is removed |
| Activity and plan-card counts dropped to 0 for a stopped plan's messaged leads, and missed opt-outs | minor | Counts from evidence a stop leaves in place |
| A Stop between recording and activating a campaign could be undone; a crash then left it active | minor | Each activation re-checks the run; a retried job stops a stopped run's campaigns |

The isolation check itself had two flaws, found when it was run again today:
- It read a static .xlsx template's XML namespace (`schemas.microsoft.com`) as
  a demo company's domain. A domain now counts only as that host.
- It passed when the dev server died part way through. A request that gets no
  answer now fails the run.

It is now run against a production build instead of a dev server. On demand,
the dev server compiled every route and grew past the memory limit.

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

All on the final tree, on a fresh local database:
- `tsc --noEmit`: pass. eslint on every TypeScript file the branch changed
  since `299fd14`: pass.
- Unit tests: 1686 pass, 0 fail.
- `db:check`: all checks pass, on a fresh install and on the upgrade path.
- Upgrade path: the base branch's `db/schema.sql`, then the 7 migrations
  below in order, then all 7 again. Every run succeeded, and the result is
  the same schema as a fresh install (pg_dump differs only in its random
  `\restrict` token).
- e2e, 16 suites, 859 checks, 0 failures:

  | Suite | Checks | Suite | Checks |
  | --- | --- | --- | --- |
  | metrics-parity | 36 | assistant | 73 |
  | full-flow | 18 | assistant-recovery | 9 |
  | activity | 42 | objective | 67 |
  | workspace-replay | 107 | tinyfish | 41 |
  | reply-agent | 105 | research-sources | 42 |
  | delivery-evidence | 30 | browser | 20 |
  | autonomous | 70 | apify | 70 |
  | assistant-intake | 44 | web-discovery | 85 |

Not run here: the live scripts (`tinyfish-live`, `aiml-live`), which need
keys and spend; they passed on 18 October on the test keys.

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

The image now ships all seven (`Dockerfile`, `.dockerignore`). All are
additive (new tables and columns), so the running old version is unaffected
while they run.

### Deployment commands (build from source with Docker Compose)

Adjust paths and the compose files to your VM; these follow
`docs/self-hosting/docker-compose.mdx`.

```sh
cd /path/to/AgentSDR
git fetch origin claude/dreamy-fermi-h5woha
git checkout claude/dreamy-fermi-h5woha
git reset --hard origin/claude/dreamy-fermi-h5woha     # the final commit; check `git log -1`

# 1. Back up the database first.
docker compose exec db pg_dump -U agentsdr agentsdr > agentsdr-$(date +%F)-before-upgrade.sql

# 2. Build the new image (the old container keeps serving).
docker compose -f docker-compose.yml -f docker-compose.build.yml build app

# 3. Migrations, in order, with the new image, before it takes traffic.
for m in add-tinyfish add-research-sources add-browser-sessions add-wrong-number \
         add-activity add-assistant-job-reports add-objectives; do
  docker compose -f docker-compose.yml -f docker-compose.build.yml run --rm app bun scripts/$m.ts || break
done

# 4. Switch to the new image.
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d app
```

Without Compose: run each migration in a one-off container of the new image
with the production `DATABASE_URL`
(`docker run --rm -e DATABASE_URL=… <image> bun scripts/<name>.ts`), or,
after the switch, `docker exec <container> bun scripts/<name>.ts`.

### Running-image checks

1. The image is the new one:
   `docker compose exec app ls scripts/add-objectives.ts` lists the file, and
   `docker compose exec app sh -c 'grep -rlF "Outside sending hours" .next | head -1'` and
   `docker compose exec app sh -c 'grep -rlF "Same period in Analytics" .next | head -1'`
   each print a file (Activity's and Overview's new wording, compiled in).
2. The migrations ran:
   `docker compose exec db psql -U agentsdr agentsdr -Atc "select to_regclass('tinyfish_settings'), to_regclass('research_settings'), to_regclass('browser_sessions'), to_regclass('crm_wrong_routes'), to_regclass('activity_seen'), to_regclass('assistant_objectives')"`
   prints six names, none empty, and
   `… -Atc "select count(*) from information_schema.columns where (table_name, column_name) in (('assistant_jobs','report_key'), ('assistant_jobs','reported_at'), ('treg_calls','request_id'))"`
   prints `3`.
3. The app: the container is healthy and its log shows the workers starting
   (`[assistant/worker] starting`) with no schema error. `/activity`,
   `/assistant/results` and `/analytics` load. Overview and Analytics give the
   same Today and Last 7 days figures. Analytics names your organization's
   time zone.
4. In a new chat, "find 5 dental clinics in Pune" (free sources): the first
   search's result says "until it has 5 qualified leads"; Activity lists a
   "Lead request"; the chat ends with one "Research finished" or
   "Research stopped" report with the stop reason.

## Your morning list

Deployment and live acceptance are **pending** until you run them.
1. **Rotate both keys** shared in the chat (TinyFish and AI/ML API). They were
   kept in a scratch file outside the repository and never committed, but they
   were in the conversation.
2. Deploy as above, then work through the running-image checks.
3. Settings → Organization → TinyFish: paste the new key (one free search
   verifies it). Browser minutes stay at 0 unless you want the browser tools.
4. Live research pilot on both buyer examples with a spend cap in the
   request, for example "find 20 real estate agents in Pune who might buy AI
   automation, spend up to $3". Check the final report's sources, leads,
   spend and stop reason against Activity and the lead lists.
5. An Instagram-only prospect reaching an approved Instagram plan through the
   connected Unipile account, with one recipient you approve.
6. Send one test inbound reply to a plan in Review mode and check Action
   required, Activity → Replies and the plan card agree.

## Known gaps and failures

- No live run of today's work: everything above is verified with fake
  providers on a local database. Live acceptance is your list above.
- The AI/ML API test key reached its all-time limit for premium models
  (Claude Sonnet, Qwen); Claude Haiku 5.5 still answered and the
  structured-call fix was verified on it only.
- The manual Start button still enrolls everyone, overlaps included; only
  Autonomous and request-approval starts leave overlaps out.
- Web-search coverage of a request is counted until your next request in the
  same chat (decision 50).
- Requests served only by `web_search`/`read_webpage` start no objective; a
  follow-up such as "use Instagram too" counts as a new request. Changing a
  running request's limits needs a new request. Pause and cancel are a chat
  tool and an API route, not buttons yet.
- Tavily, AI web-research cost before it is reported, and model tokens are
  outside a request's dollar cap (decision 41).
- Loading Overview settles decisions you already answered in the chat (a
  database write; it never starts, approves or sends anything).
- Analytics has no run, request or chat filter. Delivery and read receipts
  are recorded for WhatsApp only.
- Reddit has no reader by design; recording an approval enables nothing yet.
- If the process stops between an Autonomous start and its chat event, that
  event is lost; the launch job's own "Outreach started" report still
  appears.
- Three routes answer 200 to another organization for one of your ids
  without returning your data (listed under Tenancy isolation); a 404 would be
  more correct.
- On a desktop record page both "Leads & replies" and "Pipeline" are
  highlighted in the sidebar (both point at `/crm/pipeline`); this predates
  the branch.
