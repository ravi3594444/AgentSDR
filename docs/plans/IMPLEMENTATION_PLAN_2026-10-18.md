# AgentSDR implementation plan: reliable lead discovery and outreach

Updated: 18 October 2026, Asia/Kolkata. Implementation status added
19 October 2026 (next section).

This handoff starts from the repository plan on `claude/new-session-g5hljn`
at `640b2d6` and incorporates the owner's live Instagram test and the review
of `pipeline-sketch.md`. The updates below include a local frontend pass and
the remaining implementation plan. The new research/browser/Activity work is
not implemented yet.

Status (18 October, before implementation; see the status section below for 19 October): next-session research work remains planned. The owner has now tested
Instagram sending and automatic replies on the VM. The frontend workspace pass
is committed locally as `5fb1a51`; it has not been pushed or deployed. Prioritize useful,
working behavior and small changes. Pilot one web provider for search, page reading and browser
control: TinyFish. Select it for normal web work only after the pilot passes;
keep existing connections and avoid adding overlapping providers.

## Status on 19 October 2026: implemented, verified, pending

Branch `claude/dreamy-fermi-h5woha` (pushed; nothing merged into `main`,
nothing deployed). The code scope of this plan is implemented and verified
locally with fake providers. **Deployment and live acceptance are pending:
they count as done only after the owner runs them on the VM.**
`docs/plans/NIGHT_REPORT.md` has the commits, migration order, deployment
commands and running-image checks; `docs/plans/DECISIONS-2026-10-18.md` has
every default taken.

### Implemented and verified locally

| Plan section | What is in the branch | Verified by |
| --- | --- | --- |
| Core web access: search, read and interact | TinyFish connection per organization; `web_search`; `read_webpage` through TinyFish Fetch with a public-address check; links on read pages become known links; browser tools over TinyFish Browser, off until minutes are allowed; Tavily kept as an explicit fallback | `tinyfish` (41 checks), `browser` (20); one live TinyFish Search, Fetch and 60-second Browser session on the test key (18 October) |
| Source choice follows the buyer objective | Google Maps through the built-in scraper first, Apify only when asked or as the approved fallback; Instagram searches wait for an Apify slot; per-platform coverage; Hacker News and Stack Exchange within their limits; Reddit refused until its API approval is recorded | `apify` (70), `research-sources` (42), `web-discovery` (85) |
| Instagram-only prospects (owner's decision, 19 October) | Eligible for Instagram outreach when the profile was read and, for a place, names it; otherwise kept for research with the reason | All 7 earlier Instagram failures now pass, with new positive cases (`apify`, `web-discovery`) |
| Enough research, with clear controls | Per-request lead target, time limit and spend cap (named in the request, else Sending-rule defaults); durable continuation across jobs without an owner message; spend reserved before paid work and settled; stop at target, sources exhausted, budget, time, cancel or failure, with the stop reason stored; leads kept; exactly one final report | `objective` (67): target after a continuation, budget, lost Apify start (process died, or no answer), time limit, pause/cancel, a pause during a continuation, Instagram profiles held by a pause, a new request after a stopped one in Autonomous mode, full slots, restart mid-continuation, second organization |
| Autonomous handoff and report accuracy | Overlap-aware Autonomous and request-approval starts; durable reports by report key; `report` tool scoped and in the organization's time zone | `autonomous` (70), `assistant` (73) |
| Recovery from incomplete model responses | Function-named structured calls; truncated calls refused and retried; a plain failure with Retry after three attempts | `assistant-recovery` (9); one live Claude Haiku 5.5 call through AI/ML API (18 October) |
| Visible work and useful completion; Work and replies across chats | Activity (Work and Replies, across chats): waiting for a slot or a provider limit, outside sending hours, partly done, stalled, failed; each plan's leads, contacted and replied; each request's research and how it ended | `activity` (42) |
| Roomier workspace with frontend and backend wiring | Conversation workspace with Needs you; one set of metric definitions, dates and time zone for Overview and Analytics; current counts labelled apart from period totals; per-source found, qualified and contactable people, each person counted once | `workspace-replay` (107), `metrics-parity` (36); desktop (1366 px) and phone (390 px) screenshots of the plan cards, Leads & replies, Action required, a record and Activity, with three layout fixes |
| Delivery and autonomy status must match actual evidence | Plan cards: who authorized sending, each sender's time zone, gate and next allowed send (email, WhatsApp, Instagram, LinkedIn), per-lead evidence accepted / delivered / read receipt, never "seen" | `delivery-evidence` (30) |
| One brief apology for a wrong-number reply | Wrong-number routes blocked organization-wide; one apology (Automatic) or one draft (Review); "stop" means Do Not Contact | `reply-agent` (105) |
| Implementation and acceptance, item 3 (fake providers) | One request from the prompt through research, qualification, plan, Start, request approval, launch and the final report, with continuation, a launch taken over after a worker died, duplicate callbacks, and a second organization | `full-flow` (18) |

Gates on the final tree: `tsc`, eslint on every changed file, 1686 unit
tests, `db:check`, the 16 e2e suites above (859 checks, 0 failures), and the
upgrade path (the base branch's schema plus the 7 migrations in order, run
twice) giving the same schema as a fresh install. A final review found 11
real defects in the day's work, all fixed with tests that failed first (night
report). The production build passes, and the tenancy-isolation run against
it found no isolation failures (night report).

### Pending: deployment (owner)

1. Run the 7 migrations in order on the VM's database, then deploy the new
   image (commands in the night report).
2. Check the running image (night report, "Running-image checks").
3. Rotate the TinyFish and AI/ML API test keys, then connect the new TinyFish
   key in Settings.

### Pending: live acceptance (owner-only, not yet passed)

- Live research pilot on both buyer examples with an agreed spend cap
  (item 5 above): saved, evidence-backed leads or an honest partial result
  with its exact stop reason.
- One real inbound reply in Review mode (item 5).
- An Instagram-only prospect reaching an approved Instagram plan through the
  connected Unipile account, live (item 1).
- The full discovery-to-outreach path in the running image, with one
  explicitly approved recipient (items 1 and 5).
- A metered TinyFish Browser session from the chat, if a browser allowance is
  set.

### Known limitations kept

- Web-search coverage of a request is counted until the owner's next request
  in the same chat (decision 50).
- Requests served only by `web_search`/`read_webpage` start no objective; a
  follow-up message such as "use Instagram too" is a new request.
- Tavily, AI web-research cost before it is reported, and model tokens are
  outside the dollar cap (decision 41).
- Analytics has no run, request or chat filter; delivery and read receipts are
  recorded for WhatsApp only.
- Reddit has no reader until its API approval is recorded; recording it
  enables nothing yet.

## Current baseline

Work on `claude/new-session-g5hljn`; leave `main` unchanged.

- Frontend workspace pass: local commit `5fb1a51` on that branch. Leads & replies
  now defaults to a wide list; conversations, Action required and Contacts have
  shared navigation. Overview and Analytics share one reporting area. Existing
  APIs provide the data. TypeScript, changed-file lint, 43 focused tests and the
  Node/Webpack build passed. Deployment and manual visual acceptance remain
  pending; see the status note under the workspace requirement below.
- Combined implementation: `a5ec1e7`. Direct Instagram username repair:
  `d832a8c`; 1,368 tests, 27 simulated-provider database scenarios, TypeScript
  and Node/Webpack production build passed in the earlier implementation.
  On 18 October, the owner reported that initial Instagram delivery and an
  automatic reply worked after verifying a restricted Instagram account.
  This confirms that tested conversation; it does not validate every sender,
  recipient, discovery path or reply mode.
- The combined baseline includes outreach AI-response validation (`c47faef`).
  The VM rebuild and Instagram schema setup succeeded on 18 October. The
  Docker packaging repair is `86a648b`; `640b2d6` adds a read-only provider
  delivery diagnostic. The running app image was built at 06:29 UTC that day.
  Keep build/revision evidence for subsequent deploys. Reproduce any remaining
  `lead_sorting` failure in the current deployment before treating an old
  failed card as a new regression.
- Chat accepts supplied Instagram usernames/profile URLs and prepares an
  Instagram plan through the existing Review/Autonomous controls. Repeated
  underscores are preserved; old inbox-only capability wording was corrected.
- Instagram sends one approved initial DM through Unipile; replies follow the
  run's Automatic or Review mode. Inquiry intake is not required for those
  replies. Account gates, DNC/opt-out and uncertain-delivery protections apply.
- Maps, web, LinkedIn and Apify discovery paths already exist. The app does
  not yet reliably pursue one buyer objective across those sources.
- `read_webpage` currently fetches public HTML from supplied/known links;
  it is not a general search-and-read browser loop. Adding that web access
  is essential scope, not an optional extra discovery vendor.
- Existing `assistant_jobs` has stages, progress, claims and heartbeats.
  Chat job cards, audiences, People, outreach plans and delivery ledgers exist.
- Docker builds use Node/Webpack with a 4 GiB heap; production still uses Bun.
  Pulling Git does not replace a running image. Verify the deployed revision.

## The first delivery

An owner describes what they sell and the buyers they want. AgentSDR finds
plausible buyers, verifies useful contact routes, removes duplicates and
prepares outreach. The owner can see the work and gets a final report.

The same path must work for an AI automation seller seeking real estate
agents and a wholesaler seeking buyers for a product. Use saved business
information and an optional website. Ask one focused question only when an
essential buyer/geography choice cannot be inferred. The owner should not
have to supply usernames or URLs for ordinary prospecting.

1. **Find candidates.** Let the existing agent choose available search,
   browser, Maps, LinkedIn or Apify tools for the buyer objective. Read sites,
   directories and suitable public social evidence. Keep one implementation
   per capability; do not run every tool for every request or force Maps first.
2. **Verify and save.** Keep evidence URLs, fit/location/role and check time.
   For social profiles, verify identity and available public information using
   existing supported adapters, including Apify when needed. Unknown fields
   stay unknown. For a city-specific objective, verify location before treating
   a profile as a qualified local lead; a hashtag alone is insufficient. Keep
   unknown-location accounts for further research. Small accounts may qualify;
   no universal follower minimum.
3. **Deduplicate and qualify.** Reuse canonical People/company matching and
   organization scope. Check DNC, opt-out, active/previous outreach and source
   history. One person from several sources counts once. Recontact needs the
   owner's applicable authorization; retrying a job must not re-enroll them.
4. **Prepare outreach.** Reuse audiences, plan cards, connected senders and
   current Start/Autonomous authorization. Research alone does not authorize
   sending. A saved profile/phone is not proof of DM/WhatsApp availability.
5. **Show progress and report.** Display actual work and delivery counts,
   with a durable completion report even when the model cannot summarize it.

A known username goes directly through the implemented contact tool; it
needs no broad search. Public activity or a follow is not buying interest.
Facebook discovery must not imply an implemented Facebook DM channel.

## Useful parts of the helper's discovery sketch

Adopt the workflow from `pipeline-sketch.md` within the existing TypeScript
services and workers:

1. Search from the buyer objective, for example `cleaning agency Chicago
   instagram`, or enrich a business found through Maps or a directory with
   a targeted business-name/profile search. A seed URL is not required.
2. Extract candidate profile links and verify that the profile belongs to
   the intended business. Compare the name, website, niche and location;
   the first search hit is a candidate, not a verified identity.
3. Read available public profile information through existing supported
   adapters; use Apify selectively when structured enrichment is needed.
   A working Unipile username lookup proves an identity/contact route, not
   all qualification fields such as current activity or location.
4. Reuse People/company records, outreach history and DNC checks across
   channels. Preserve underscores and dots in usernames exactly; lowercase
   and removing a leading `@` must not merge distinct handles.
5. Save the qualified lead and evidence in the existing CRM/audience flow.
   CSV/JSON may be an export, not a second contacted-history database.

Follower counts and last-post age are optional fit signals, not universal
100-follower/60-day rejection rules. Private or unavailable content stays
unavailable; profile privacy alone does not prove messaging availability.
Meta's profile APIs have access/consent restrictions and must not be assumed
to provide arbitrary-profile verification. Use only supported fields.

The helper's yield percentages, trial-account details and cost estimates
remain unverified. Measure actual qualified yield in the pilot. Do not add
SerpAPI, Brave or PhantomBuster alongside the chosen web integration merely
because the sketch mentions them. The discovery sketch is not a diagnosis
of the earlier Instagram delivery restriction.

## Keep the implementation small

Extend the current discovery services and `assistant_jobs` worker. Reuse
People, audiences, CRM, outreach queues, channel rules, encrypted credentials
and the existing UI. Prefer one coherent change to the current flow.

Keep just the state required to resume an objective, track attempts/budget
and deliver its report. Add fields or a small additive migration only where
existing records cannot safely express that state. Do not prebuild a second
job platform, separate provider microservices or an agent framework. A stage
called "checking leads" does not need its own agent.

Keep current provider connections working. No removal or migration of them
is authorized by this plan. New integrations must fix an observed gap in the
working flow rather than merely add another vendor to Settings.

## Core web access: search, read and interact

Owner clarification, 17 October: the agent needs useful free web access with
generous allowances. Google, Bing and TinyFish were examples of that missing
capability. Provide a working search-and-read loop as a required first step;
do not leave it conditional merely because specialized discovery exists.

Use one TinyFish integration and API key for three capabilities:

- A general `web_search(query)` tool returns real candidate URLs, titles and
  snippets. The model can refine its query within the task's remaining budget.
- Extend `read_webpage(url)` to read pages found by a successful search and
  follow extracted public links. Update URL/contact grounding to trust only
  recorded owner input or successful scoped search/read results. Keep public
  network/URL protections, evidence URLs and contact validation in place.
- Small browser tools for open, observe/read, click, fill, scroll and close.
  The existing agent chooses actions from observed page state and uses the
  remote Browser API through Playwright/CDP when interaction is useful.

### Provider roles after a successful pilot

| Role | Proposed provider and scope |
| --- | --- |
| Reasoning and tool selection | The existing configured AI provider and agent harness. |
| General web search, page reading and interaction | TinyFish Search, Fetch and Browser through one connection. |
| Connected messaging | Existing Unipile and channel senders, with current authorization. |
| Specialized social data | Existing Apify adapters when the task needs their structured data. |
| Treg's existing feature | Optional specialized work, outside the normal research dependency path. |

TinyFish would replace Tavily's role in normal generic search after passing
real buyer-query and page-reading tests. Preserve the existing Tavily adapter,
credentials and jobs; an explicitly selected fallback may still use it. Do
not invoke both providers routinely or silently incur paid fallback charges.
A saved key alone must not determine the source strategy.

Use the existing encrypted credential store and small API adapters. TinyFish
is a pilot candidate, not a proven deployment. If it fails the real workload,
record the specific gap and compare one alternative before expanding the
provider set. Apify and Treg remain available for their existing specialized
uses rather than becoming required steps for every objective.

### Interactive browser through the same TinyFish connection

Use TinyFish's direct Browser API and returned `cdp_url` with Playwright/CDP.
The existing AgentSDR model decides the actions; TinyFish hosts the browser.
Its separately billed Agent product is not required. Do not add a second
agent framework or hardcoded scripts for every website.

Remote Chromium keeps the additional browser workload off the VM that already
runs the app, database and Maps Chromium. Measure pilot behavior and cost;
the earlier VM OOM incidents make another local browser a poor starting point.
Kernel and a second browser backend are outside this delivery. Local hosting
can be reconsidered only if measured volume, cost and VM capacity justify it.

Search/Fetch operate within their free quotas even at a zero Wallet balance.
Interactive Browser sessions are metered, and the existing model has its own
cost. Prefer search/read for content and use the browser when the task benefits
from interaction. Set an explicit browser spending/time allowance, begin with
one active session and queue further work. Free-only work must wait or report
partial results when a required quota or paid capability is unavailable.

Reuse encrypted credentials, task claims and progress records. Keep browser
session state isolated by organization/task, release sessions on completion,
failure, cancellation or timeout, and retain evidence and actual errors.
Apply public URL/network protections and grounding to browser navigation too.
Browser research preserves the existing outreach authorization and send
boundaries; messaging still goes through the approved channel adapters.
Do not promise unrestricted site access or private social content. Reuse
existing authorized social adapters where appropriate.

If a tested need for Google results remains, evaluate
`apify/google-search-scraper` using the existing Apify credentials and budget.
That Actor is not yet in the app's catalog. Add its adapter only when needed;
leave paid enrichment/AI add-ons off unless selected and budgeted. Google
search results and Google Maps listings are distinct sources.

Bing is an optional future adapter, not a prerequisite. Its old Search APIs
retired on 11 August 2025; current Foundry search/grounding requires a separate
integration and does not expose raw search content through Bing grounding.
Google's older Custom Search JSON API is closed to new customers, with an
existing-customer transition deadline of 1 January 2027. Do not build new
core behavior around those older APIs.

Label the actual provider used. Generic TinyFish/Tavily results must not be
called Google/Bing results without a verified engine contract. Free-only work
cannot silently switch to a paid source. Self-hosting Treg, adding
PhantomBuster or building a browser fleet is outside this first delivery.

## Source choice follows the buyer objective

Make all connected, authorized capabilities available through the existing
tool catalog, with honest availability, cost and input/output descriptions.
The agent chooses a useful source, inspects its actual yield and changes
queries/sources as necessary. A key being present or a tool being listed
first must not set the prospecting strategy. A default search transport is
different from forcing every task through that source.

Maps stays available for suitable local businesses. For decision-maker or
social-profile research, websites, LinkedIn or Apify may fit better. Preserve
those options without a fixed per-industry source script. A listing confirms
a business record, not buying intent or the right recipient. Low replies
alone do not establish that Maps caused the problem: verify qualification,
recipient/channel, confirmed delivery and message relevance separately.

Measure qualified people and contactability per source; evaluate confirmed
sends/replies over an appropriate response window. Preserve multiple source
attributions while counting one person once. Do not adapt to delayed replies
as though they were immediate search failures or promise a reply rate.

### Google Maps routing and requested platform coverage

Owner clarification, 18 October 2026: the initial salon batch used two Google
Maps backends across different cities, not a proven repeat of the identical
query. The later full transcript confirms LinkedIn search did run: 50 profiles
found and a 45-lead plan prepared. That plan's automatic start was blocked by
two overlapping leads. The Instagram attempt switched to web search because
two Apify runs were open; this was not a completed Instagram Actor search.

Current cause: `startDiscovery` in `src/lib/discovery/discovery.server.ts`
prefers Apify's Google Maps Actor when it is usable and within allowance,
then falls back to the built-in scraper. `find_leads` describes that same
priority to the model. This adds a provider to the existing Maps pipeline;
it does not make the request cover additional social platforms.

Correct the roles in one coherent source-routing change:

- Use the existing built-in scraper as the normal Google Maps backend.
- Use existing Apify social Actors selectively for Instagram, Facebook or
  LinkedIn discovery when those sources fit the objective or the owner names
  them. Preserve the separate connected LinkedIn people-search capability.
- Keep Apify Maps as an explicitly selected alternative or a pre-authorized
  fallback when the built-in scraper fails or is unavailable. An enabled
  Apify key alone must not route working Maps searches to paid Actors.
  Record the fallback reason and apply the existing spending controls.
- Choose the source before choosing its provider. Several city searches or
  two Maps providers still count as one source: Google Maps. Do not run both
  providers for the same query routinely. Reuse saved results and deduplicate
  partial work before a permitted fallback continues it.
- When the owner explicitly names platforms, track each requested platform
  in the existing objective/job state as searched, queued/waiting, partial,
  blocked or unavailable with its actual reason. Do not call the request
  complete after only Maps searches. A broad request without named platforms
  still uses the agent's judgment rather than running every provider.
- Published emails or social links found on a business website are contact
  enrichment, not proof of an Instagram or LinkedIn search. Email is a
  contact channel; show the website/listing that supplied the address.
- Label cards with both the actual source and provider, for example
  `Google Maps through the built-in scraper`, `Google Maps through Apify`
  and `Instagram through Apify`. Preserve these labels as stages change.

Acceptance: with both Maps backends configured and the built-in scraper
healthy, a normal Maps query uses the built-in scraper and incurs no Apify
Maps run. A forced fallback requires the saved policy/explicit selection and
records its reason. A request naming Maps, Instagram and LinkedIn must show
separate source coverage or a specific limitation for every named platform.
Test retries, duplicate queries, partial results, full provider slots and
restart without duplicate paid runs or outreach enrollments.


### Free research sources and rate limits

Owner clarification, 18 October 2026: Reddit and useful free sources belong
in the research plan. Add source coverage through the same search/read loop;
do not turn this into another bundle of mandatory provider connections.
Choose relevant sources within the task's cost allowance. Free access still
uses model tokens and infrastructure, and does not imply unlimited access.

| Source | Useful role | Access and allowance checked on 18 October 2026 |
| --- | --- | --- |
| General web through the TinyFish pilot | Find business websites, niche directories, public discussions and published contact routes. | Search: free, 30 requests/minute and 500/hour. Fetch: free, 150 URLs/minute and 1,000/day. Key required; Browser is separately metered. |
| Public business sites, trade/chamber directories and RSS/Atom feeds | Find businesses and first-party evidence of their work or stated problems. | Use permitted public access through the same reader. Limits vary by site; no universal free quota. Cache results and use conditional requests where supported. |
| Hacker News | Relevant startup/software discussions and explicitly stated needs. | Official public API currently lists no rate limit. Impose a conservative app throttle, initially one request/second, and read only relevant items. Its API has no full-text keyword-search endpoint; locate threads through the existing web search. |
| Stack Exchange | Relevant technical questions as evidence of a stated problem. | API quota depends on key/auth/IP; documented default daily quota is 10,000 with sharing rules. Read actual `quota_remaining`, honor method `backoff`, and cache identical queries for at least a minute. |
| Reddit | Relevant discussions and stated needs, only within an approved use case. | Conditional: API access needs approval; commercial use needs explicit written approval. Eligible free API clients have 100 queries/minute per OAuth client ID, averaged over ten minutes. This is not a promise of free commercial access. |

Implement the core web loop first. HN and Stack Exchange are optional sources
for matching objectives, not required calls for local-business searches or
new Settings connections by default. Add a small API reader only if the
pilot demonstrates a useful gap that general search/read cannot cover.
Keep source URLs, dates and minimal supporting evidence in existing records;
a person asking a question is not automatically a qualified buyer. Preserve
attribution and applicable deletion/retention requirements.

Reddit stays unavailable to the commercial research flow until the approved
scope and terms are recorded. Do not use anonymous JSON, scraping, RSS,
browser automation or an Apify Actor to work around missing approval.
Reddit's rules prohibit automated unsolicited DMs/chat requests; this plan
adds no Reddit cold-DM sender. Follow approved data deletion requirements
and do not match pseudonymous authors to off-platform identities.

Use one rate-aware scheduler with the existing worker state. Track the
actual quota scope (provider account/key, IP or OAuth client), alongside
separate organization budgets; a shared quota is not a fresh allowance for
every customer. Honor `Retry-After`, provider reset headers and API backoff.
Checkpoint `nextEligibleAt` and resume after the wait without another chat
message. Use bounded backoff with jitter for transient failures, without
repeating completed searches, paid runs or outreach enrollments.

At quota exhaustion, continue another relevant permitted free source or
wait until reset, then report the partial result and actual resume time.
An authorization/access denial is blocked work, not an endless retry loop.
Free-only mode must not silently start paid Browser, Apify or another paid
fallback. Show the binding quota and waiting reason in Activity.

Acceptance: exercise a 429, an exhausted daily allowance, a shared quota
across two organizations and a worker restart during waiting. Work must
resume once without duplicate results or charges. An unapproved Reddit
request must show its access limitation and continue other relevant sources
when allowed; it must not claim Reddit was searched. Verify the final report
names the actual sources used and distinguishes evidence from buyer intent.

## Enough research, with clear controls

Separate model action batches, worker concurrency, research budget and
outreach sending limits. Eight actions is one model batch, not a chat-wide
allowance. The current six-step normal and sixteen-step Autonomous chat loops
are not a durable task runner.

Current web jobs have three-query/40-page bounds, daily usage caps and two
open slots; Apify also has two open slots. Continue the objective across
checkpointed jobs when its budget permits. Full slots mean waiting, not a
failed objective. Work must resume without another owner chat message.

Use simple target/time/spend controls with sensible defaults. Respect the
organization's allowances and provider quotas. Reserve budget before paid
work under a lock, settle actual usage and preserve uncertain charges after
a lost response. Do not blindly retry charged operations. Pause/cancel stops
new work and preserves saved results. Stop at the target, exhausted sources,
budget/time limit, cancellation or a recorded failure; retain partial leads.

### Fix Autonomous handoff and report accuracy

Observed in `Pasted text(8).txt`, 18 October 2026: Autonomous mode was on
before the original request. Some plans started automatically, but the
LinkedIn 45-lead plan and several Email/WhatsApp plans waited for Start
because a few people were already in other active plans. The later manual
approval events do not prove any LinkedIn invitation or message was sent;
the supplied report recorded zero LinkedIn sends.

Fix these gaps before treating Autonomous discovery-to-outreach as complete:

1. **Resolve overlaps per person.** `autoStartProblem` in
   `src/lib/assistant/autonomy.ts` currently blocks the entire plan when
   `busyPeople > 0`; `autoStartPlan` then asks the owner to press Start.
   Reuse canonical identity and active-run checks to retain already-covered
   people in their existing campaigns, exclude them from the new enrollment
   and continue with the remaining eligible people under the original
   Autonomous authorization. Update plan counts, assignments and samples
   consistently. Recheck ownership, permissions, daily caps, DNC/opt-out,
   concurrent claims and sending rules before starting. Do not bypass the
   overlap check by blindly starting the original plan or recontact someone
   through another channel. An all-overlap result needs an honest no-new-leads
   report, not another approval request for the same objective.
2. **Wait for the requested Instagram source.** In
   `src/lib/discovery/discovery.server.ts`, a temporarily full Apify pool
   currently sends `startInstagramProspects` into generic website fallback.
   Persist a waiting job for Instagram and resume when an authorized slot
   opens, keeping the original objective, request ID and budget. Use the
   existing queue/claims rather than a second scheduler, with fair scheduling
   so repeated Maps jobs cannot starve social research. Authorization denial,
   unavailable Actors and exhausted budgets need their own recorded reasons.
   Supplemental web results must not mark Instagram coverage complete or turn
   an unperformed Instagram search into "0 accounts found".
3. **Ground status in current records.** The transcript called Email/WhatsApp
   plans LinkedIn plans, described finished searches as still running and
   said nothing needed attention while plans awaited Start. Generate channel,
   search, plan, queue and delivery summaries from the corresponding saved
   state. Distinguish reply decisions from plan approvals and show both counts.
   A running plan is not a confirmed send; a LinkedIn profile is not a sent
   invitation. Recheck delivery before asserting emails are already sending.
   For "today in this run", apply both the date and request/run scope rather
   than returning organization-wide daily totals. Explain broader scope when
   requested work cannot yet be attributed precisely.

Acceptance: a 45-person LinkedIn plan with two people already covered starts
the remaining 43 automatically when other checks permit, without re-enrolling
the two. Repeat with concurrent starts, all-overlap, exhausted caps and a
worker restart. With two occupied Apify slots, Instagram stays visibly queued
and runs once after a slot opens, including after restart. Replay the supplied
transcript's status cases: no unsupported channels, stale completion claims,
hidden pending approvals or claimed sends without ledger evidence. Verify
request-scoped reports exclude unrelated runs. These fixes remain planned
until implemented and verified; no change to the owner's mode is required.

### Recovery from incomplete model responses

Observed 18 October 2026: AI/ML API with `anthropic/claude-haiku-5.5` returned
`{}`, then two message-only objects describing searches without an
`actions` list. These were three total attempts: the initial request and
two retries with validation feedback. The harness correctly rejected them;
the rejected batch did not start those searches. The owner then changed the
model and searches started. This confirms a model-dependent compatibility
problem to investigate, not a fix to the original failing path. The exact
DeepSeek response has not been captured in the supplied logs.

Before changing the harness, inspect the outgoing request and provider
response together. Verify the schema and tool/output format against the
actual selected model, including Haiku 5.5. Use one coherent, supported
contract and validate all actions before execution. Never infer executable
actions from prose or treat missing actions as successful empty work.

Keep retries bounded by attempts/time, show Working/Retrying during recovery
and retain completed tool results. A retry resumes the failed step and must
not repeat a successful search, enrollment or send. Existing authorization,
DNC, run state, budgets and delivery-uncertainty checks still apply. Do not
switch to another model/provider or incur a new paid fallback silently.

After recovery is exhausted, show a useful failure summary with a Retry
control and the real completed/remaining work. Keep schema syntax and raw
model diagnostics out of the ordinary chat error. A manual retry must retain
the original objective. Replay the observed invalid payloads in regression
tests and verify real provider behavior before claiming a live fix.


## Visible work and useful completion

Improve existing chat job cards and add a compact Activity panel/view using
the same records. Include the organization's accessible chats/runs; retain
the current brand/theme, apply the navigation rework below and provide a
usable mobile view.

Show the objective and originating chat, actual assigned agent/task/worker,
current action, source or sending account, start/last-update times and next
permitted action. Show idle when nothing is active. Sequential stages must
not appear as several agents working at once. Do not invent an ETA or percent.

Distinguish queued, executing, provider-slot waiting, outside sending hours,
needs approval, retrying, paused, completed, partial, failed, cancelled and
stale execution. A stored running campaign does not prove a worker is active.
Keep updates across chat navigation/reload, with bounded polling/reconnect.
Viewing progress must never start a search or send.

Show unique qualified leads, duplicates/exclusions, queued messages, attempts,
confirmed sends, unique people contacted, replies, failures and uncertain
sends. Attribute counts to the actual task/agent/channel where known. Include
open-chat/results and authorized pause/resume/cancel controls with clear scope.

Acknowledge only after work is persisted. Post one recoverable report in the
originating chat for each completed, partial, failed or cancelled objective:
what was searched, sources, qualified leads/contact routes, recorded spend,
remaining target, exact stop reason and links to saved results. Delivery
reports include actual channel attempts, confirmed sends, replies and waits.

Persist a report reference/idempotency key with terminal bookkeeping and
reconcile pending reports after restart. Duplicate callbacks must not duplicate
reports. If AI wording fails, use deterministic ledger counts. Research can
finish while approved messages remain queued; report both states. One child
job finishing does not finish the whole objective.

### Roomier workspace with frontend and backend wiring

Local frontend status, 18 October 2026: implemented in `5fb1a51`, on
`claude/new-session-g5hljn`; not pushed or deployed. The conversation list is
the default and initially shows all categories. Rows have more room for the
latest reply and status. Smaller screens use cards; record modals are wider,
the conversation is the main pane, and an extra composer opens only for a
pending draft or an explicit manual follow-up. Answer labels use recorded
message evidence, with a neutral fallback when the actor is unknown. Existing
DNC and pending-decision state remains visible. WhatsApp follow-ups after an
answer are labelled optional, and its composer is disabled for DNC contacts.

Shared Conversations/Action required/Contacts navigation and an
Overview/Analytics reporting area are implemented. Reporting summaries are
compact; deeper detail expands when needed. The existing organization-scoped
CRM, message and reporting APIs supply real data. Visible CRM records refresh,
and change events refresh affected rows, navigation badges and reports. Late
responses cannot replace a newer report/filter request; quiet refreshes keep
unsaved reply text while updating messages and restrictions. No server query,
schema, approval or sending behavior was changed in this frontend pass.

Verification: TypeScript and changed-file ESLint passed; 43 focused tests
passed; the Node/Webpack build exited 0 with all 105 static pages generated.
Existing formula-sandbox dynamic-require warnings remained. The local build
had no production auth settings and emitted a standalone tracing `ENOTDIR`
warning caused by the checkout's symlinked dependencies. This is not proof
of a runnable Docker image. Docker/runtime verification and desktop/mobile
visual acceptance are pending. No browser automation or live send was run.
The repository handoff is `docs/plans/FRONTEND_WORKSPACE_REWORK.md`.

The fuller shared Work/Replies view, backend handoff reconciliation, shared
metric definitions and the acceptance scenarios below remain outstanding.

Owner requirement, 18 October 2026: rework Results, Analytics, Action required
and Pipeline together, including the backend wiring for the redesigned views.
The current Pipeline screenshot shows five leads squeezed into one narrow
Waiting column, two large empty columns and an oversized metrics strip.
It also confirms the pricing enquiry is already classified Interested and
visible in Waiting; it is not evidence of a missing conversation. The visible
"Sent 10m ago" is a timestamp. Investigate the separately reported "Send
message" prompt before calling it a failed reply or pending task.

Give the existing surfaces clear roles and reduce duplicate navigation:

| Surface | Intended role |
| --- | --- |
| Overview | Use the current Results as the primary outcome summary. Put deeper historical/channel Analytics in a secondary tab within the same area, with one main navigation entry. Preserve old URLs and their filters through compatible links/redirects. |
| Replies / Action required | One conversation workspace showing all replies, with a clear Needs you filter and count for unresolved reviews/decisions. Keep the existing Action required URL usable. Answered conversations remain visible in All replies. |
| Leads / Pipeline | Default to a spacious list with status/category/channel filters. Keep Board as an optional view; empty columns must not squeeze the useful content by default. |
| Work | The already planned shared view of actual agents/tasks, progress, waits and originating runs/chats. Reuse the same activity records rather than another dashboard. |

Allocate most of the available width to lead rows and the selected
conversation. Use compact summaries, readable message widths, comfortable
spacing and fewer nested cards. On desktop, provide a broad conversation
pane with a collapsible details panel or a full-page conversation option.
On mobile, show one main pane with an obvious way back. Avoid several tiny
nested scroll regions; keep the composer, latest messages and relevant action
visible together. Reuse the existing UI components and brand styles.

Wire the views to authoritative backend state, not decorative sample data:

- Return consistent latest inbound/outbound messages, answer status and actor,
  sending account/channel, effective reply mode, pending draft/decision,
  restrictions and actual next action. Separate an optional manual composer
  from a required action. An answered conversation should say "Answered by
  you" or "Answered by assistant", then "Waiting for their reply" where true;
  its normal action is Open conversation, not an urgent instruction to send.
- Reuse `manualOutbound.ts`, the reply send pipeline and handoff records.
  A confirmed reply from WhatsApp Web/phone or the app must settle the relevant
  pending reply, invalidate stale drafts and update every affected list/count.
  Preserve unrelated unresolved questions and any newer inbound message.
  Manual replying does not silently change the saved AI takeover mode.
- Refresh Replies, Action required, Pipeline, navigation badges and Overview
  from the same state after sends, classifications and webhook events. Reuse
  existing record-change updates and bounded polling. Show syncing/stale/error
  states honestly; preserve idempotency and delayed/out-of-order event handling.
- Every recorded inbound reply remains findable even when it needs no human
  action or its AI classification is still proposed. Highlight a pricing
  enquiry from its actual message; Interested is not a purchase. Missing
  pricing/quote information and genuine handovers must reach Needs you, while
  successfully handled replies do not remain falsely marked action required.
- Show the known business and contact route when the person's name is unknown,
  with source, campaign/run and conversation links. Do not invent an owner
  name or hide useful business context behind "Unknown contact" alone.
- Align metric definitions, date ranges, timezones and organization/run scope
  across Overview and Analytics. Label current waiting/action counts separately
  from period totals. Reuse delivery ledgers and distinct-person counts; viewing
  or refreshing any page must not start a search, approve work or send a message.

Acceptance: replay the pricing enquiry, the bot's answer, the owner's reply
from WhatsApp Web and a subsequent inbound message. Confirm message order,
answer actor, actual next action, stale-draft handling, matching badges and
visibility across all four affected views, reload and a different chat.
Include a pending classification, an unrelated unresolved quote decision,
wrong-number/DNC closure, delayed/duplicate webhooks and unavailable providers.
Manually verify a roomy desktop and mobile layout, filters, deep links,
keyboard navigation and access isolation. Implement and verify frontend and
backend together; a layout mockup alone does not complete this requirement.
The frontend pass is implemented locally. Deployment, manual UI acceptance
and the remaining backend workflow work are still pending.

### Work and replies across chats

The planned Activity tab is shared across the owner's accessible work, not
limited to the currently open assistant chat. It shows actual active tasks,
assigned agent/worker, current source/action, originating chat/run and lead,
send and reply counts. Starting a new chat or leaving the page must not stop
already approved background work.

Include two simple views in that surface:

- **Work:** queued, active, waiting, paused and completed tasks from accessible
  chats/runs, with current status and links to the original chat and results.
- **Replies:** a searchable list of recorded incoming lead messages across
  connected channels and accessible runs. Show person, channel, sender
  account, received time, message preview, originating run/chat and whether
  the assistant answered, is processing, has a draft for review or needs the
  owner. Show agent-generated outbound replies in the conversation too.

Reuse the existing channel inboxes and CRM conversation records for message
history and actions. This is a shared index and navigation improvement, not
a second inbox database or a new provider polling service. Conversation links
must open the correct lead/channel; an original-chat link is supplementary.

Show an unread/new-reply badge that remains visible while another chat is
open. Keep unread, needs-response and waiting-for-owner states distinct:
receiving a reply does not always mean the owner needs to answer it. Preserve
new items across navigation/reload, and provide filters for channel, run,
unread and needs attention. Viewing a notification must not approve a draft,
change the run's reply mode, take over a conversation or start a send.

Reuse the current Needs you / Action required flow for decisions and reply
reviews, and make its count accessible from any chat. Automatic-mode ordinary
replies continue under the original run's saved authorization and rules;
Review-mode drafts and exceptional decisions remain visible for the owner.
Opening a new chat must not change the mode or approval of an earlier run.

Example: on day one, Chat A starts an approved Instagram campaign. On day
two, the owner is in Chat B when one of those leads replies. The incoming
message is recorded against the original lead/conversation and run; the
shared Replies view and badge show it from Chat B. Opening it shows the full
conversation and any automatic answer, with a link back to Chat A. If the
owner must decide or approve something, Needs you / Action required shows
that item until resolved.

Acceptance: exercise an older run replying while a different chat is open,
including after a page reload and on a later date. Verify global visibility,
correct run attribution, the original reply mode, automatic-answer status,
review/decision routing and authorized pause/takeover controls. Duplicate
webhooks must not duplicate messages or notifications. Apply organization and
access checks to every list, badge and deep link.

### Delivery and autonomy status must match actual evidence

Surface account restrictions when the provider reports them. Distinguish
queued work, a provider-accepted send, provider-reported delivery, a read
receipt and an actual inbound reply. Unipile's delivery flag alone must not
be described as proof that a recipient saw a message in the native inbox.
Keep uncertain sends from being resent automatically.

Show the sender account's configured timezone, current gate and next
permitted send time when it can be calculated. Use an IANA timezone such
as `Asia/Kolkata` for an India-based sending schedule. Do not infer the
sender timezone from lead cities, or say "outside sending hours" after
the diagnostic reports no such gate. No gate is not proof of worker liveness.

Show the effective Start/Autonomous authorization and reply mode on the
plan. Explain the effect of changing Autonomous mode during an in-flight
request; an existing draft must not be silently misrepresented as already
started. Plans covered by existing Autonomous authorization should use it
without asking for the same approval again. Nonessential missing prices
must not be presented as a required blocker to otherwise supported outreach.

### One brief apology for a wrong-number reply

Owner requirement, 18 October 2026: when someone replies "Wrong number", send
one brief apology and end outreach to that number. Example: "Sorry about
that—we won't message this number again." Use the recipient's language,
with no sales pitch, question, offer or request for the correct number.

The supplied screenshot shows a wrong-number reply, DNC, "Not interested"
and "Action required". It confirms sending was blocked, but not who set DNC.
The current reply pipeline sends nothing once DNC is applied. This change
must distinguish incorrect contact information from a genuine opt-out.

- Stop queued sales messages and follow-ups to that number immediately and
  record it as wrong for the intended lead, preventing reuse across campaigns
  and duplicate records within the organization. Do not wait for the apology
  to succeed before stopping outreach.
- In an active Automatic run, send the single closing acknowledgement under
  the run's existing authorization; no additional customer toggle is needed.
  In Review mode, prepare it for review and show the outstanding review clearly.
- Use the existing reply/send pipeline with a narrowly scoped, single-use
  closing acknowledgement. Preserve explicit DNC, channel/account rules and
  delivery checks; never clear DNC or enable ordinary messages to send it.
  A pre-existing DNC block or an explicit "stop", "unsubscribe" or "don't
  contact me" takes precedence, including when combined with "wrong number":
  send nothing. Do not send retrospective apologies to previously blocked leads.
- Persist the acknowledgement claim and outcome against the inbound message
  and recipient. Duplicate webhooks, repeated wrong-number replies, concurrent
  workers and restarts must not create another apology. Recheck for a newer
  message, explicit opt-out or owner intervention before dispatch. An uncertain
  send must not be retried blindly.
- Show "Wrong number — outreach stopped", plus acknowledgement sent, awaiting
  review, blocked, failed or uncertain as appropriate. Keep the actor/reason in
  Activity. Remove "Action required" when no review or unresolved issue remains;
  do not label a wrong recipient as an interested or uninterested buyer.

Acceptance: an Automatic-mode "Wrong number" produces one brief apology and
zero subsequent sales messages. Review mode produces one draft and no send
before approval. Test repeated events, restart, concurrent sends, failed or
uncertain acknowledgement, pre-existing DNC and "Wrong number, stop messaging
me". Verify suppression persists even when the apology cannot be sent, and
that explicit opt-outs receive no acknowledgement. This behavior is planned,
not yet implemented or live-verified.

## Implementation and acceptance

1. Verify the running image contains the outreach-response validation and
   Instagram username/outbound fixes; a Git pull or container restart alone
   does not deploy source changes. Record image/build details, test the current
   capability in a new chat and distinguish old failed cards from new attempts.
   The owner's supplied-username send and Automatic reply test passed on
   18 October after account verification. Review-mode live acceptance and
   the full discovery-to-outreach path remain to be checked.
   Verify Instagram-only Apify prospects can reach an approved Instagram plan
   without a published email or phone. Reproduce any remaining failure before
   adding research capabilities.
2. Deliver TinyFish Search/Fetch/Browser as one integration through the existing
   harness. Demonstrate a prompt without seed URLs, reading returned pages and
   following links/pagination through real browser actions when needed. Let the
   agent choose fitting sources and complete qualification, canonical leads,
   approved outreach, progress and reporting. Verify provider behavior before
   replacing Tavily's normal role; retain its existing connection. Web access
   remains core scope, with no Kernel integration in this delivery.
3. Test the full path with fake providers, including continuation beyond eight
   actions, full slots, restart, duplicate events, concurrent budget claims,
   cancellation, provider refusal/outage and lost responses. Include browser
   session cleanup, quota exhaustion and metered-browser spending controls.
   Preserve org isolation, approval, DNC/opt-out and delivery uncertainty.
4. Deliver the workspace rework above with real message, action and reporting
   APIs. Verify the pricing-enquiry/manual-reply example and consistent state
   across Overview, Replies/Action required and Leads/Pipeline. Preserve the
   existing direct URLs, authorization, history and sending controls.
5. Run a small owner-approved live research pilot on both buyer examples with
   an agreed spend cap. Live messaging uses an explicitly approved recipient
   and message within the app's existing authorization. Verify a real inbound
   reply in Review mode and retain the evidence from the owner's successful
   Automatic-mode test. Recheck Automatic mode when the affected reply path
   changes; fake-provider success is not live proof.

Accept only when the buyer examples produce evidence-backed saved leads or
an honest partial result with its exact cause, the owner can see actual work
and sends/replies, and a final report survives reload/restart and AI failure.
Compare qualified yield, duplicate rate, cost and completion time. Add another
provider only if those results show a specific coverage/reliability gap.

## References to recheck before provider changes

Provider references were checked on 17 October 2026. TinyFish pricing and the
free-source API/policy references below were rechecked on 18 October 2026;
prices, limits and contracts must be rechecked before integration. TinyFish
listed free Search at 30 requests/minute and 500/hour; Fetch at 150 URLs/minute
and 1,000/day, with a key required. Browser was listed at
$0.002/minute with up to five concurrent sessions; start the pilot with one.
Search, Fetch and Browser share one API key. The existing agent's model costs
are separate. Recheck account-specific terms; free quotas are not unlimited.

- https://docs.tinyfish.ai/api-reference/search-the-web
- https://docs.tinyfish.ai/api-reference/fetch-and-extract-content-from-urls
- https://docs.tinyfish.ai/browser-api
- https://docs.tinyfish.ai/api-reference/create-a-remote-browser-session
- https://www.tinyfish.ai/pricing
- https://github.com/HackerNews/API
- https://api.stackexchange.com/docs/throttle
- https://support.reddithelp.com/hc/en-us/articles/16160319875092-Reddit-Data-API-Wiki
- https://support.reddithelp.com/hc/en-us/articles/42728983564564-Responsible-Builder-Policy
- https://support.reddithelp.com/hc/en-us/articles/360043512931-Don-t-break-the-site
- https://playwright.dev/docs/library
- https://apify.com/apify/google-search-scraper
- https://apify.com/apify/instagram-profile-scraper
- https://developers.google.com/custom-search/v1/overview
- https://learn.microsoft.com/en-us/lifecycle/announcements/bing-search-api-retirement
- https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/tools/bing-tools
- https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user/business_discovery
- https://github.com/superdesigndev/treg/blob/main/LICENSE

Cross-chat Activity and Replies requirements were clarified by the owner on
18 October 2026. The shared Activity/Replies surface remains planned; current
Instagram messages are available at `/instagram/messages`, conversation
history in CRM, and reviews at `/crm/actions`.

## Handoff sources

- Repository planning base: https://github.com/ravi3594444/AgentSDR/blob/640b2d63baca7284ba6612c1e7eec24fb0579032/docs/plans/MULTISOURCE_RESEARCH_NEXT_SESSION.md
- Delivery diagnostic: https://github.com/ravi3594444/AgentSDR/commit/640b2d63baca7284ba6612c1e7eec24fb0579032
- Unipile message-field semantics: https://developer.unipile.com/docs/message-payload
- Meta profile API access: https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-instagram-login/messaging-api/user-profile
- Owner-provided helper: `pipeline-sketch.md`, 18 October 2026.
- Owner-provided Pipeline screenshot: `image(20261018-154336).png`, and pricing-reply screenshot `image(20261018-153526).png`, 18 October 2026; reviewed with the current CRM list/record, manual-outbound, Results and Analytics code.
- Owner-provided Autonomous-mode transcript: `Pasted text(8).txt`, 18 October 2026; reviewed alongside `src/lib/assistant/autonomy.ts`, `autonomy.server.ts` and `src/lib/discovery/discovery.server.ts`.
- Owner's VM build, read-only diagnostic output and successful account-verification/reply test in this conversation, 18 October 2026.

