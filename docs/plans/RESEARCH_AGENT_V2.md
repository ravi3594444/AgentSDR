# Research agent v2: the model plans, the code guards (21 Oct 2026)

Branch `claude/research-agent-fixes`, from `f25af92` (the pilot merge). Not
merged, not deployed. Off by default: an owner or admin turns on
**Research agent v2 (beta)** on the Providers & features page. With it off,
the assistant behaves exactly as before.

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

**The driver** (`objective.ts`, `objectiveDriver.server.ts`). A limit (the
target, the spend cap, the time limit) wakes the model once, with a note
naming the limit, to prepare the plan from what matched and finish; then
the request stops. Searches are refused at a limit. A request whose last
chat word is the assistant's question waits for the answer instead of
ending as "sources exhausted". The continuation note no longer presses for
more searches.

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
