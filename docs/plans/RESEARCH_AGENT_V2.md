# Research agent v2: the model plans, the code guards (21 Oct 2026)

Branch `claude/research-agent-fixes`, from `f25af92` (the pilot merge).
Since 22 Oct (branch `claude/research-v2-live-fixes`) it is the assistant's
only harness: built in, no switch (see "Live fixes and one harness" at the
end).

## Why

The research-agent audit (the eval below, v1 column) found the v1 harness
deciding too much in code: the automatic plan after a search
(`contactAfter`), counts and channels inferred from word lists, a
transcript that lost the owner's request after four page reads, and a
continuation note that pressed for more searches. The model made the
mistakes code had set up for it: false matches went into plans, a city
given in a clarification was lost, channels were widened.

The owner's direction: make the model the mastermind with general tools,
and keep only the guard rails that are needed.

## What changed

**The brief** (`brief.ts`). Before its first search, the model writes down
the request with `set_brief`: goal, number of leads, contact or not, the
only channels allowed, spend cap, time limit, and what "done" means, from
every owner message about it (an answer to its question included). It is
stored in the objective's controls and pinned at the top of every step.
The model may tighten any limit; a limit above the organization's default
(Sending rules `objectiveLeadTarget` / `objectiveHours` /
`objectiveSpendUsd`) stands only when that number appears in the owner's
words (`numbersIn`, `amountsIn`, `durationsIn`). Searches are refused
until there is a brief.

**What the model reads** (`agentV2.ts`, `agentV2.server.ts`). A short
system prompt: a six-step method (understand, brief, search, check, plan,
finish), what the server enforces, and the sources. No scenario rules; two
general ones the eval asked for: the owner's place holds (a neighbouring
city, a suburb or the wider area is another place, searched only when the
owner allows it; the judge's "another place" says the same), and never ask
what the brief already settles (a question stops the request until the
owner answers).
Every step pins the request (every owner message since it began) and its
brief, then the server's PROGRESS (funnel, searches so far, spend, time,
plans), then the conversation, trimmed oldest page text first (60k
characters, the newest three page reads whole), owner lines last.

**Tools.** `review_leads` shows each lead with its verdict, reason, facts
and source. `set_lead_fit` corrects a verdict, only with a quote found in a
page the model read or in the lead's own saved facts (HTML entities and
spacing do not hide a quote; a name, title or @handle is a hint, never
proof of a place). `prepare_outreach` with `forRequest` builds one
"Matching leads" plan of the request's matching leads, up to its target,
on the brief's channels only. `finish_request` ends the request (stop
reason `finished`). Search tools lose `contactAfter` in v2: the model
prepares the plan after reviewing.

**The driver** (`objective.ts`, `objectiveDriver.server.ts`). A request
that would end on its own (a limit reached: the target, the spend cap, the
time limit; or no source left: a continuation that started nothing, or two
that found nothing) first gets one **last turn**, with a note naming why, to
prepare the plan from what matched and finish. No search starts in it.
When it ends the request stops at a limit that still holds, or as "sources
exhausted"; a last turn begun at the target that ends below it (the model
corrected verdicts) goes on as an ordinary continuation instead. It waits
while it runs, holds while the owner has paused, and a failed model answer
is tried again (at most three times). Only a question from a turn that
started no search makes the request wait for the owner ("Which city?");
a side question asked while a search runs does not. The continuation note
no longer presses for more searches.

**The judge reads the owner's words.** Leads are judged against the brief's
goal with the owner's own messages for the request beside it (up to the
next request in the chat, compared in SQL), so a place given in an answer
counts even when the brief was written before it.

**Claims.** A message sent in the same step as a search it only starts may
not report that search's results (`startedNotFinishedClaim`).

**Autonomous mode** still starts plans on its own within its daily caps,
and in v2 only for a request in which the owner asked for outreach.

**Model calls** (`structuredCompletion.ts`, `runtime.ts`; all features,
not only v2). Two failures the eval found with DeepSeek Chat on AI/ML API:

- When AI/ML's catalog could not be read in 5 seconds, a model's `tools`
  tag was unknown, so a refused json_schema request was not retried as a
  function call, and the owner's first message stopped with "400
  Validation failed". An unknown tag now allows that one retry: a second
  refusal costs one request.
- Asked to call `assistant_reply`, DeepSeek called the assistant's action
  names (`set_brief`, `search_knowledge`) as functions, three attempts
  alike. The retry is now told what it called and that the named function
  is the only one.

## The guard rails kept (code, not prompt)

- Spend caps, reserved under the provider's lock and the request's spend
  guard; limits above the default only when the owner wrote them.
- Do Not Contact, suppression, wrong-number records.
- Sending limits and readiness; a channel only when its sender is
  connected.
- Nothing is sent before Start (or Autonomous mode's caps); no tool starts
  outreach.
- No double sends (the claims and ledgers as before).
- Tenancy: every query in the organization's scope; another
  organization's lead cannot be marked.
- Claims checked against the record.

## How it is judged

`scripts/eval/research-agent/`: nine cases run end to end on a local
`agentsdr_eval…` database: the real chat turn, tools, worker stages,
judge, driver and report, with every outside provider faked (Maps, Apify,
TinyFish, Unipile, websites) and a real model through AI/ML API. `score.ts`
grades what landed in the database: no false match (in the judged list
or a plan), recall, a plan when the case allows one, only matches and
only the asked channels in it, within the target, no plan for research
only, no paid source for a free-only request, bounded searches, the
request ending. `scripts/e2e/research-agent-v2.ts` checks the guard rails
through `runTool`, without a model.

| Case | What it tests |
| --- | --- |
| c1 | 10 Miami hair salons on Instagram, DM them (wrong city, product brand, nail salon among the results) |
| c2 | CTOs at fintech startups, email them (no city; banks and ATMs on Maps) |
| c3 | 8 Austin wedding photographers, email (weak first results) |
| c4 | research only: test Maps and web search, 5 each, no outreach |
| c5, c5b | 5 Denver yoga studios, free sources only (two wordings) |
| c6 | 10 hair salons on Instagram, DM them; the city comes in the answer |
| c7 | "5 businesses in New York, email them"; the profile says which kind |
| c8 | Instagram asked for, no Instagram sender connected |

## Results

DeepSeek Chat (`deepseek/deepseek-chat`) through AI/ML API for both. v1 is
the base commit `f25af92`; v2 is three full rounds on this branch (r20 and
r21 at `a65fd0a`, r22 at `8a3df41`). A run is clean when it passes every
graded check.

| Case | v1 clean runs | v2 clean runs | v2 failures |
| --- | --- | --- | --- |
| c1 | 0/2 (a hair-product brand in the plan, twice) | 2/3 | recall 3 of 4 (r20) |
| c2 | 0/1 (no plan) | 3/3 | |
| c3 | 0/1 (19 planned, target 8) | 2/3 | a Round Rock studio in an Austin plan (r21; the place rule came after) |
| c4 | 0/1 (report said "fell short" for a test) | 3/3 | |
| c5 | 1/1 | 3/3 | |
| c5b | 1/1 | 3/3 | |
| c6 | 0/1 (Fort Lauderdale salon matched; older fixture) | 1/3 | no plan: the eval's model budget (r21, harness changed after); a needless question left it waiting (r22, see below) |
| c7 | 0/1 (10 planned, target 5) | 3/3 | |
| c8 | 0/2 (no search at all) | 3/3 | |
| **All** | **2/12 runs, 56/68 checks** | **23/27 runs, 161/166 checks** | |

Across the 27 v2 runs: one run put a non-matching lead in a plan (c3 r21),
no plan used a channel the owner did not allow, none went past its lead
target, no free-only request touched a paid source, and no research-only
request got a plan.

Read with care:

- The v1 numbers are from the base commit, before the model-call fixes
  above, which help v1 too; v1 was not re-measured with them (the key ran
  out). Most v1 failures were not model-call failures but decisions code
  made for the model (automatic plans past the target, a brand or a wrong
  city kept in the plan).
- v1's c6 ran with an earlier fixture whose profile named Florida.
- Earlier v2 rounds (r1–r17) were used to find and fix problems and are
  not counted.
- The last prompt line ("never ask what the brief already settles", added
  after r22's c6 waited on "should I search another source?") is
  **unmeasured**: the AI/ML key ran out of quota for every model (403
  `ALL_TIME_LIMIT_EXCEEDED`, DeepSeek from about 22:06 UTC on 21 Oct)
  before it could be run.

### After the limit was raised (22 Oct)

| Round | Code | Clean runs | What failed |
| --- | --- | --- | --- |
| r30 | `ec1dace` | 7/9 | c6: idle turn ended the request with no plan (fixed: the last turn); c8: recall 2 of 4 |
| r31 | last turn added | 7/9 | c6: brief written before "Miami." so a Los Angeles salon was judged and planned (fixed: the judge reads the owner's words); c3: a side question held the request (fixed) |
| r32–r34 | same | c6 3/3 | |
| r35 | `268ff98` | 7/9 | c2: a non-CTO judged a match (not in the plan); c1: recall 3 of 4 |

The judge-window fix and the review's fixes (`c9e82ed`) are proved by the
unit and e2e suites (the driver scenario runs the real driver), not yet by
an eval round: the next one (r36) was refused by the key's quota after one
call per case.

## Not done, and why

- **Claude Sonnet 5.5 comparison.** The AI/ML key answered 403
  `ALL_TIME_LIMIT_EXCEEDED` for Sonnet (also after the owner raised the
  usage, 21 Oct 21:14 UTC) while DeepSeek still worked, and then for
  DeepSeek too (about 22:06 UTC). GLM 5.3 was refused the same way; Claude
  Haiku 5.5 answered a probe and the first one or two calls of two runs,
  then was refused too (about 22:20 UTC), so those runs are not counted.
  The pattern fits a dollar cap on the key that cheaper requests passed
  for longer. The v1 Sonnet runs from before are invalid for the same
  reason. The numbers above are DeepSeek only; whether a stronger model
  needs less of the harness is untested.
- **The guard rails suite and the e2e suites** ran without a model:
  `research-agent-v2` (17 checks), and with v2 off `assistant`,
  `assistant-intake`, `assistant-recovery`, `assistantAutomation`,
  `objective`, `full-flow`, `autonomous`, `request-workspace`,
  `research-sources`, `web-discovery`, `tinyfish`, `apify`, `brightdata`,
  `activity`, `worker-recovery`, `business-profile`, `instagram`, `treg`,
  `browser`, and the tenancy contract, all passing on a database built
  with `db:setup`. The webpack production build passes (4096 MB heap, as
  `deploy.sh`), and tenancy isolation against `bun server.js` reports no
  failures.
- **No live run.** Every provider is faked; nothing was sent.

## Deploying

1. `bun run scripts/add-research-agent-v2.ts` (widens two CHECKs; safe to
   re-run; `docker/deploy.sh` runs it).
2. Deploy. Nothing changes until an owner turns the feature on.

This branch also fixes a deploy blocker in the deployed line: once
Bright Data has run one `social_research` job, re-running `add-objectives`
(every deploy re-runs every default migration) failed on its older
job-kind list and `deploy.sh` stopped before the switch. The same fix is
on `claude/outreach-polish-20261021`. `docker/deploy.test.ts` now fails
when two default migrations rewrite one CHECK with different values.

## Live fixes and one harness (22 Oct)

Branch `claude/research-v2-live-fixes`, from the deployed `5c1d03f`. Found
in two live runs on the deployed app (the owner's model: Claude Opus 5.5
through the Claude Code engine). Every failure traced was the harness's,
not the model's.

| Live symptom | Cause | Fix |
| --- | --- | --- |
| "Outreach them all" after a research-only request: `set_brief` 19 times, every plan refused "research only", no plan | `set_brief` wrote to the chat's active request (none: the research had finished, so it made a new empty one) while `prepare_outreach` and `review_leads` read the turn's request (the finished research-only one) | One request per turn: every v2 tool reads the turn's request, which follows `set_brief`; a follow-up to an ended request continues it and inherits its leads and verdicts (`controls.continues`) |
| "any niche, anywhere": it copied the profile's customers and places | The prompt said "find businesses usually means their target customers"; search tools filled who and where from the profile | An open niche or place is the model's research; v2 search tools no longer fill them from the profile |
| "Tell me if you want a higher limit"; Reddit/X searched for business leads | Nothing told the model the money is the server's, or that a named source is allowed, not required | Prompt: choose sources by where the leads are; do not discuss the budget |
| A second "still running… nothing found yet" message each turn | After starting searches the loop asked the model again; PROGRESS hid a running search's count | A step that only starts searches (and writes the brief) ends the turn; running searches show their count so far |
| "Working… 0 businesses found" on Apify; "0 of ?" while judging; "Current counts are on the plan card" with no plan | The card looked up the job's own stage name; the judging total was taken per batch; one fixed pointer | Card falls back to the progress stage; the total is taken once; the pointer names This request first |

Then, at the owner's direction ("the model sees the tools, uses them and
does what was asked"), the rules that second-guessed the model went:
searches waiting for a brief, the research-only refusal, plans from judged
matches only (`leads: "all"` and `personIds` now), the 25/100 plan cap (an
owner's number still sizes the plan), the owner's-own-number rule for the
lead target and time (it stays for money), and the quote required to mark
a match (a quote given must still be found). Kept: Start (or Autonomous
caps, with the owner's words asking for contact), Do Not Contact,
suppression, sending limits, connected senders, the spend cap and its
reservations, no double sends, tenancy, claims checked against the record.

Finally the switch went: `research_agent_v2` is built in
(`BUILT_IN_FEATURES`), on for every organization; a saved "off" is
ignored and the settings page no longer lists it.

Verified with stand-ins (no live provider, no model): the v2 e2e suite
replays the live "outreach them all" case (a new request continuing the
ended one, a plan of its 3 matching leads, the brief written once),
`leads: "all"` and `personIds` plans, the brief-free search, and one model
call for a step that only starts searches. The prompt changes (open niche
and place, money, sources) are **unmeasured with a real model**.

## Tools loosened (22 Oct)

Branch `claude/loosen-tools`, from `8e6e042`. The owner's ask: loosen
Apify, and let the model use TinyFish, Bright Data and every other tool as
it judges; spending stays the owner's choice through their own budgets. An
audit of 158 tool texts, arguments and limits was triaged item by item;
what only steered the model went, what protects money, people, sends,
tenancy, the truth or a real provider limit stayed.

| Area | Loosened | Kept |
| --- | --- | --- |
| Apify | A place is optional for `find_social_leads` (Facebook gets `locations: []` and `searchType: "pages"`, LinkedIn no `locations`) and `find_instagram_prospects` (up to 20 hashtags, the model's own); `find_leads` with provider `apify` takes a region or a country, bounded by the owner's results per run, and the choice is the model's; 4 open runs per organization (was 2); Apify refusing a run for its plan's memory or concurrency is a wait for a slot, not "exhausted"; runs may take 30 minutes (cost stays capped by `maxTotalChargeUsd`); an unreadable `/users/me/limits` no longer refuses (the owner's budget and per-run cap still bound the run); a refusal names its real reason | Per-Actor approval; private Instagram accounts excluded; the 500 results-per-run CHECK; the owner's monthly budget and per-run cap; the request's spend guard |
| Web tools | The SOURCES lines and tool texts say what a tool does: the web tools, the browser and `add_contacts` find and save leads (200 a call); `web_search` pages 0–10, Tavily's 20 results, a TinyFish wait of up to a minute sat out and a longer one sent to Tavily when a key is saved and the request may pay; pages show 12,000 characters, 100 links (social profiles included), 200 contacts; TinyFish Fetch keeps 30,000 characters and 150 links; one browser per chat (minutes checked under the organization's lock), 12,000-character snapshots of 150 elements, 2,000 characters typed; `find_customers_on_web` without a place, with up to 6 of the model's own `queries`, up to 100 sites, directories 10 pages of 50 links and contacts; 4 open website searches, 50 a day on OpenRouter | The exact-arguments repeat check; grounding of every saved contact; the Hacker News and Stack Exchange contact stripping and no matching of usernames; login-walled hosts and Reddit never opened by `read_webpage` or the browser; a free-only request never pays Tavily; the browser's daily minutes; the 240-minute CHECK on them |
| Harness | 24 steps a turn (100 Autonomous), 12 actions a step, 4,000 output tokens a step; 6 page reads kept whole, 6,000 characters of other results, 160,000 characters of conversation; contacts grounded in the last 200 messages; `describe_audience` offered | The owner's place; the turn ending after starting searches with a message; "never keep searching past what the owner asked for" |
| Bright Data | Platforms optional (every one by default); `customers` optional with a need, keywords or links; 6 keywords and subreddits, 4 queries per platform; `maxResults` defaults to the records per search; `urls` (up to 50) read directly, unreadable ones reported; Reddit's `since`; 4 open research jobs; slot waits not counted toward the timeout (45 minutes); 25 author profiles per platform, read in order with no phrase list; customers-only searches read profiles and pages first and hold nothing back for authors; 40 website reads, 600 findings; an Instagram business profile not naming the place saved place-unconfirmed (as Apify's); Facebook `/p/<Name>-<id>/` pages; `lead_search_status` reads social jobs; facts before the price in the description | The Reddit switch; the monthly credits and the records-per-search setting (its 300 CHECK); reservations, the spend guard and the ledger; the trigger retry rules; never messaging on Reddit, X or Facebook |

Not done: raising the browser minutes an owner may allow past 240 a day
(`tinyfish_settings_browser_chk` holds it; it needs a migration, as do
Apify's 500 and Bright Data's 300). The Facebook `/p/` form is accepted
from its URL shape only; one live collection should confirm Bright Data
reads it, since a failed input is billed.

Verified with stand-ins (no live provider, no model): the apify,
brightdata, web-discovery, tinyfish, browser, research-agent-v2,
research-sources, assistant, objective and full-flow suites, with new checks
for a place-free Facebook search, the model's own hashtags, a memory-full
Apify account waiting, links read through Bright Data with no search,
`lead_search_status` on a social job, one browser per chat within the day's
minutes, and `web_search` waiting out or falling back from a TinyFish wait.
The prompt and description changes are **unmeasured with a real model**.
