# Next session: buyer-aware research and live activity

Status: implementation plan only. The next session starts after the owner tests
the combined Claude branch on the VM. Do not begin this redesign as part of the
Instagram outbound merge.

Owner additions on 17 October: evaluate TinyFish as the first web-search and
page-reading provider, and include a live Activity panel plus reliable chat
completion reports in this implementation. These are requirements for the
next session; this document does not implement or deploy them.

## Current baseline

Deploy from `claude/new-session-g5hljn`; leave `main` unchanged. Preserve the
existing product, connected providers, organization isolation, approval modes,
Do Not Contact, opt-out handling and delivery uncertainty rules.
The combined implementation baseline is commit `a5ec1e7`; the direct Instagram
username repair is `d832a8c` (1,368 tests, 27 simulated-provider database
scenarios, TypeScript and production build passed). VM acceptance is still
required before the research redesign. These checks do not confirm live DMs.

Implemented in the current work:

- Node/Webpack production builds with a 4 GiB V8 heap setting; the production
  server still runs under Bun. Pulling Git does not replace a Docker image.
- Harness validation, normalized tool results, optional website URLs and
  continuation across action batches. Eight actions is a limit on one batch,
  not the lifetime of a chat. The chat loop still has finite model steps.
- Discovery adapters for Maps, web search and Apify social sources, plus
  LinkedIn discovery. Prompt guidance prefers an explicitly requested source.
  This is not yet a persistent, adaptive research planner.
- Approved initial Instagram DMs through Unipile, configurable account rules,
  a durable delivery queue, CRM reply handling and delivery diagnostics.
- Direct Instagram username/profile input in chat through
  `add_instagram_contacts`, with exact-handle validation and the existing
  Review/Autonomous plan controls. Settings and inbox capability copy now
  describe approved initial DMs. Test this repair on the VM before redesign.
- Source counts and recorded sending blockers in Results. A saved contact
  route is not verified deliverability, interest or revenue.

The original repository is `Kandid-ai/AgentSDR`. On 17 October 2026 its main
head `bdbf5efd2017347181f5bf549b54d89c1ae6e5f5` and latest release `v0.3.1`
were already included in the Claude branch. No upstream main merge is pending.

## Problem to solve

An owner should describe what they sell and whom they want to reach. The app
should research suitable buyers using appropriate sources until its agreed
target or budget is reached. A real estate agency search and a wholesaler's
buyer search must use the same system without hardcoded industry templates.
Maps is one useful source, not the default answer to every buyer objective.

The owner also cannot reliably tell whether a chat request is still being
worked on, which agent/task owns it, how many people have been contacted, or
when the work has finished. Visible progress and automatic reports are part
of the complete research flow, not a later cosmetic improvement.

Current limits that must become explicit rather than mysterious failures:

- Eight actions per model reply batch, normally six model steps per chat turn
  and sixteen in autonomous turns. These are execution bounds, not research
  budgets or permission to discard unfinished work.
- Website discovery currently allows at most three search queries and forty
  websites per job (twenty by default), with ten jobs per organization per
  twenty-four hours and two open website jobs.
- Apify has two open run slots and separate configurable usage caps. A full
  slot should queue work rather than terminate the owner's objective.
- Tavily is currently preferred when its key exists; other configured paths
  include OpenRouter web search or an AI/ML research model. Provider usage
  costs money according to the provider. Do not promise free unlimited search.

## Research objective and budget

Create a validated objective from the owner's prompt, existing business
profile and optional website. Record the product or service, plausible buyer
roles, geography, exclusions, target qualified lead count and evidence needed
to qualify a buyer. Ask a single focused clarification only when an essential
choice cannot be inferred, such as business buyers versus consumers.

Let the owner select a bounded research budget: target count, maximum elapsed
time, spend ceiling, queries/pages and allowed providers. Keep five separate
concepts visible in the code and UI: model action batch, worker concurrency,
research task budget, organization usage cap and outreach sending allowance.
Increasing one must not silently increase the others.

## Durable execution

Introduce organization-scoped research tasks, source attempts, candidate
evidence, progress events and a usage ledger through an additive migration.
Workers claim tasks with leases, persist checkpoints and resume after a
restart. Use stable idempotency keys for provider operations and lead writes.
Cancellation and pause must stop new external work while preserving results.

Reserve estimated budget before a paid operation and settle recorded usage
afterwards. For a lost response, retain a conservative reservation until the
provider can reconcile it; do not blindly repeat a potentially charged job.
Enforce caps atomically so concurrent workers cannot each spend the remainder.

The chat starts and supervises a task. Discovery must continue without relying
on six or sixteen model turns remaining in an HTTP request. Queue child work
when a provider's concurrency slots are full and surface that waiting state.

## Source and provider policy

Build a source plan from buyer fit and available connections:

- Business websites and directories for companies and published contacts.
- LinkedIn people or companies for professional roles and decision makers.
- Apify Facebook and Instagram adapters for relevant public business profiles
  and permitted public evidence. Public activity alone does not show interest.
- Maps for local businesses when listings are relevant.
- Owner-supplied lists, seed URLs and previous qualified results.

Start with a small useful set, measure yield and diversify when a source is
exhausted or weak. Generate adaptive queries and backfill missing roles or
geographies. Do not launch every platform for every task. Persist why a source
was chosen, attempted queries, candidates found, exclusion reasons and cost.

Make provider ordering an explicit organization setting with capabilities,
timeouts and cost expectations. A saved Tavily key must not force Tavily for
every objective. Existing provider choices must remain supported. Verify
current official provider contracts before changing adapters or quoting limits.

### Google/Bing-backed web search

Owner question on 17 October: the agent should be able to find public social
profiles and websites through ordinary web search, as another agent does.
This is supported as an integration goal. Register a real search adapter in
the harness; a model prompt or saved API key alone does not expose additional
tools. The current Apify catalog includes Maps and social Actors, but not the
Google Search Results Scraper. Keep Maps and organic web search distinct.

Evaluate these options without changing the TinyFish-first evaluation below:

- **Google results through the existing Apify account:** add an adapter for
  Apify's maintained `apify/google-search-scraper` Actor. It accepts search
  queries and returns organic search results, with country/language controls.
  Reuse organization credentials, explicit Actor approval and the task's
  Apify budget/concurrency queue. Start with ordinary organic results; paid
  enrichment, AI answers and other add-ons must stay off unless selected and
  budgeted. A saved Apify key does not mean this adapter already exists.
- **Google's older official JSON API:** as checked on 17 October 2026, Custom
  Search JSON API is closed to new customers and existing customers must
  transition by 1 January 2027. Do not choose it as a new long-term dependency.
- **Bing:** the old Bing Search APIs retired on 11 August 2025. Microsoft's
  current Foundry search/grounding tools are a separate integration with
  project/model requirements. Bing grounding returns model output and
  citations rather than exposing raw search content. Evaluate compatibility
  and result usability before choosing this path; do not treat it as a
  drop-in replacement for a raw search-results API.

Return structured candidate URLs, titles/snippets, query, provider, geography,
check time and recorded cost to the durable research task. Extract canonical
social handles from those results, verify fit/profile evidence, then dedupe
before outreach. A query such as "real estate agents Miami Instagram" must
work without the owner supplying any profile URL or username. Search snippets
alone do not establish identity, buyer interest or messaging permission.

The owner can select a supported search provider and fallback order. Label
the provider/engine actually used; generic TinyFish or Tavily search must not
be presented as Google or Bing unless that engine contract is verified.
Free-only tasks cannot switch to paid Apify or other paid search silently.

Official references checked 17 October 2026:

- https://apify.com/apify/google-search-scraper
- https://developers.google.com/custom-search/v1/overview
- https://learn.microsoft.com/en-us/lifecycle/announcements/bing-search-api-retirement
- https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/tools/bing-tools
- https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/tools/web-search

### Instagram candidate discovery and verification

Owner addition on 17 October: keep discovery separate from profile
verification. Evaluate this pipeline inside the task's existing budget:

1. Search for the buyer niche and geography, including Instagram profile
   results. Extract only canonical profile URLs/handles, with their source
   page and query; a search snippet alone does not verify the business.
2. When Maps fits the objective, enrich its business candidates with published
   social links or targeted business-name searches. Reuse the existing Maps
   adapters; PhantomBuster is not a required additional dependency.
3. Use available social-search/Apify adapters for relevant accounts, hashtags
   or public posts. `social.search` and `instagram-cli` in another agent's
   environment are not capabilities this installation automatically has.
4. Verify candidates through a supported profile adapter: account resolves,
   business/buyer fit, public/private state, activity and available contact
   routes. Record the check time, evidence and unknown/unavailable fields.
   Follower thresholds and recency are objective-specific preferences, not a
   universal minimum of 100 followers. A small relevant account may qualify.
   Owner-supplied test recipients bypass discovery/ranking; the sender still
   resolves their exact identity and enforces delivery rules.
5. Deduplicate against canonical People, active/previous outreach and DNC or
   opt-out history before enrollment. Preserve exclusion reasons and do not
   silently recontact an already messaged person. Explicit later recontact
   requires a new approved plan within the existing rules.

Apify's maintained profile scraper accepts usernames/profile URLs and returns
public profile metadata, bio links, follower counts and recent posts. Evaluate
that adapter with the owner's connected Apify account and explicit run/spend
allowances. Meta's Business Discovery API describes other professional
accounts (Business/Creator); it is not a general username lookup for every
personal account. Verify permissions and supported account types before
choosing it. Profile verification never guarantees a DM will be accepted.
The suggested yields (10–20 candidates per query, one-third rejected) are
unmeasured for AgentSDR and must not become promised results or fixed limits.

References checked 17 October 2026:

- https://apify.com/apify/instagram-profile-scraper
- https://developers.facebook.com/documentation/instagram-platform/instagram-api-with-facebook-login/business-discovery
- https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user/business_discovery

### TinyFish evaluation and provider choices

Evaluate a direct TinyFish Search/Fetch adapter first, using the existing
encrypted integration-credential system and organization scope. Select it as
the default only if it meets the buyer examples' relevance, contact coverage,
error-handling and response-time needs. A prompt without a seed URL must work.

As checked on 17 October 2026, TinyFish documents free Search at 30 requests
per minute and 500 per hour, and free Fetch at 150 URLs per minute and 1,000
per day. An API key is required. Recheck the official contract before coding;
queue work within account quotas and the task's remaining time rather than
treating free service as unlimited. LLM calls and other sources have separate
budgets. References:

- https://www.tinyfish.ai/pricing
- https://docs.tinyfish.ai/api-reference/search-the-web
- https://docs.tinyfish.ai/api-reference/fetch-and-extract-content-from-urls

Keep Tavily, existing AI search paths and Treg optional. The owner chooses
provider order and whether paid fallback is allowed within a task's budget.
Treg documents free TinyFish routes that can fall back to paid vendors;
preferring a free vendor alone is not a free-only policy. Test zero-budget
tasks and paid-fallback refusal explicitly. Preserve cost provenance and
report unknown costs honestly.

The current Treg integration targets hosted `treg.to`, defaults to $2 per
rolling day, caps each call at $0.25 and instructs the assistant to use it for
a handful of lookups. These are current app choices, not the new research
task budget. Treg self-hosting is a separate option, not a prerequisite for
TinyFish. Its current LICENSE allows internal organizational use and restricts
hosted/embedded services to third parties without written authorization;
resolve that scope before choosing it for a customer-facing deployment.

- https://github.com/superdesigndev/treg/blob/main/skills/web-access/SKILL.md
- https://github.com/superdesigndev/treg/blob/main/LICENSE

## Qualification and identity

Keep a canonical person/company with multiple source attributions and evidence
URLs, rather than counting one person once per source. Record business fit,
role, location, freshness and exclusion reasons separately from contact routes.

For each route, distinguish published, resolved, provider-confirmed and
unavailable. A phone number is not proof of a WhatsApp account. A public
Instagram or LinkedIn profile is not proof that the owner can message it.
Never invent emails, phone numbers, decision-maker roles or buying intent.
Facebook discovery must not imply an implemented Facebook DM channel.

## Progress and delivery handoff

Show the owner the objective, current sources and why, queries/pages used,
unique qualified leads, excluded leads, remaining target, spend and the next
action. Use exact terminal reasons: target reached, sources exhausted, budget
reached, time reached, cancelled or failed with a recoverable cause. Waiting
for a slot is not completion. Partial results remain available on failure.

Hand qualified leads to the existing audience and outreach plan flow. Show
the proposed channel, sender, message and allowance. Respect the owner's
existing approval/autonomy settings; research alone must not authorize new
outreach. Preserve DNC, opt-out, reply detection, account restrictions and the
rule against automatic resends of uncertain Instagram deliveries. Do not
promise unsolicited Instagram follow-up sequences or unsupported DM channels.

### Instagram username requests and capability consistency

The owner's 17 October screenshot shows a request to contact one supplied
Instagram username being answered with an absolute claim that AgentSDR never
starts Instagram conversations. That is inconsistent with the merged outbound
backend. The screenshot does not establish which image the VM is running.

Verified source gaps in the baseline:

- `add_contacts` accepts phone, email and LinkedIn inputs, but does not accept
  an Instagram username or profile URL. Outbound Instagram audiences currently
  come from discovered/saved profiles; there is no complete direct-handle
  contact-entry tool path for this owner request.
- The Instagram accounts page still contains a description saying new chats
  are never started. Older contract/service comments and intake documentation
  also retain the inbox-only scope, although the assistant's current system
  instructions and outreach backend support approved initial DMs.

Repair this before relying on the broader research workflow:

1. Accept an explicitly supplied Instagram handle/profile URL through an
   appropriate typed contact/recipient tool. Normalize it, preserve meaningful
   characters such as repeated underscores, and use the existing
   organization-scoped canonical-profile dedupe. Do not invent email or phone
   identities. Adding a known recipient needs no city, seed website or broad
   paid discovery search.
2. Feed the recipient into an Instagram outreach plan using the existing
   approval/autonomy authorization, account, DNC, limits and uncertain-delivery
   controls. Lookup/import must not itself send a DM. Resolve the provider's
   messaging identity through the established delivery boundary.
3. Align tool descriptions, current capability instructions, settings copy and
   documentation with the actual feature. An old assistant refusal in chat
   history must not override current capabilities. When unavailable, give the
   measured gate (feature off, no connected account, account restriction,
   waiting hours or approval), not an invented permanent prohibition.
4. Expose the running artifact's revision in owner-facing support/settings
   diagnostics so Git checkout and the deployed app image can be distinguished.
   Use build provenance, not the local checkout's current HEAD, as evidence.

Acceptance: simulate the exact shape of the screenshot's username-only
request, including a username with repeated underscores, in Review and
Autonomous modes. Cover existing and new recipients, stale inbox-only chat
history, disconnected accounts, hours, refusal, confirmed send and uncertain
delivery. The flow must prepare or authorize the correct scoped plan, show
its real Activity state and report the result without claiming a DM was sent
before confirmation. A live check remains limited to an owner-approved test
recipient after VM deployment is verified.

## Live Activity panel and automatic reports

### What the owner sees

Provide an Activity view across the organization's accessible chats and runs,
plus an inline task card in the originating chat. On desktop the current
request can have a side panel; on mobile use an accessible drawer or tab that
preserves the draft and chat position. Keep the existing product navigation,
styling and approval controls.

Each task card shows:

- The owner's objective, originating chat and task/run identity.
- The actual assigned agent when one exists, otherwise the owning task or
  worker, plus its current action. Use readable labels such as researching,
  checking leads, writing messages, sending or handling replies only when
  backed by real work. Sequential stages must not appear as several agents
  simultaneously working. Show idle explicitly when nothing is active.
- The source/provider or sending channel/account relevant to that action,
  start time, last meaningful update and elapsed time. Do not invent an ETA.
- Separate counts for records found, unique qualified people, duplicates,
  excluded people, awaiting approval, queued messages, attempts, confirmed
  sends, unique people contacted, replies, failures and uncertain delivery.
  Provide per-task/agent and per-channel breakdowns where attribution exists;
  show unattributed activity honestly instead of assigning it to an agent.
- A readable status: queued, working, waiting for a provider, waiting for a
  sending window, needs approval, retrying, paused, completed, partial,
  failed or cancelled. Show the reason, next permitted time with timezone
  when known, and the owner's next action when one is required.
- Open chat, view leads/results and role-authorized pause/resume/cancel
  controls, with clear scope. Do not offer a send retry for uncertain
  delivery or imply that stopping can recall an already submitted message.

Use recorded job progress, events, fresh execution heartbeats and delivery
ledgers. A stored `running` campaign is not proof an agent is currently
executing or a sender is delivering messages. Distinguish stale execution
from a disconnected UI: show the last known update and verify before claiming
failure. Updates must persist when the owner switches chats, reloads or
returns later. Do not invent percentages from elapsed time.

Add a concise chronological activity trail: for example, a search started,
pages were read, qualified leads were saved, a plan needs approval or a send
was confirmed. These are action summaries from real events, not hidden model
reasoning or a stream of internal implementation details. Use incremental
updates or bounded polling, with reconnect/backoff and restrained accessible
announcements; viewing progress must not launch provider calls or overload
the existing VM.

### Chat acknowledgement and completion reports

Once a task has been persisted successfully, acknowledge it in chat with the
objective, current status and a link to its Activity card. If it is queued or
waiting for approval, say that instead of claiming execution has started.
Publish useful milestones without flooding the chat on every heartbeat.

Automatically post a durable report in the originating chat and Activity
history when research completes, partially completes, fails or is cancelled.
Include what was searched, sources used, unique qualified leads, contact
routes, duplicates/exclusions, recorded spending, remaining target, exact stop
reason and links to results. An outreach report additionally shows attempted
and confirmed messages, unique people contacted, replies, queued work,
failures and uncertain deliveries by channel/attributable agent.

Research completion and outreach completion are different milestones. A
research report must state when approved messages remain queued or scheduled;
an ongoing outreach run stays visible until its own terminal state. Finishing
one child job does not finish the owner's entire request.

Persist report delivery as part of terminal-event bookkeeping, with an
idempotent report key/outbox or equivalent reconciliation. A process restart,
closed browser, failed callback or duplicate terminal event must not lose or
duplicate the report. If AI report wording fails, a ledger-based fallback
still delivers the actual results. Unknown metrics remain unmeasured.

### Existing foundations to extend

`assistant_jobs` already records stage, progress, claim owner and heartbeat;
the chat polls job cards and active run/lead status. Reuse these records and
the existing channel send ledgers rather than building a second source of
counts. The current finish callback runs after the terminal job write and
logs reporting errors; make report delivery recoverable instead of relying
on that callback alone. All Activity reads, event subscriptions, attribution,
reports and controls must enforce organization and user permissions.

## Implementation order and acceptance

1. **Baseline and VM acceptance.** Verify the VM artifact revision and test the
   implemented Instagram username-entry repair with the screenshot's
   single-recipient request through plan, delivery state, inbound reply and
   reporting before adding the wider research redesign. Build provenance
   diagnostics remain part of this baseline work.
2. **Task and reporting foundation.** Add schema, migration, task service,
   leases, activity/attribution events, usage reservations, cancellation and
   recoverable completion-report delivery. Demonstrate resume after a process
   restart and duplicate dispatch without duplicate charges or lead writes.
3. **A complete visible research path.** Evaluate TinyFish on the buyer
   examples, connect the selected web adapter to durable tasks, and deliver
   the live Activity card/panel plus automatic chat report in the same slice.
   Allow more than three queries and forty pages across child jobs when the
   selected task budget allows it; make research allowances configurable
   without bypassing organization budgets or provider account quotas.
4. **Additional sources.** Wrap existing Maps, LinkedIn and Apify adapters,
   queue work behind their concurrency limits, then add source selection and
   adaptation based on qualification yield and budget remaining.
5. **Qualification and handoff.** Persist evidence and canonical dedupe,
   distinguish fit from contactability, and prepare an outreach plan through
   existing approval controls.
6. **Owner controls and activity across channels.** Extend Activity to the
   existing outreach/reply engines and organization-wide view, including
   per-agent/task delivery counts, history, budget/source choices,
   pause/resume/cancel, partial results and exact waiting/stop reasons.
7. **Evaluation and VM pilot.** Run deterministic fake-provider cases first,
   then a small owner-selected live research task inside an agreed spend cap.
   Live messaging requires an explicitly approved recipient and message.

Required evaluation scenarios:

- An automation seller finds real estate decision makers from websites,
  LinkedIn and suitable public social sources without Maps-only results.
- A wholesaler finds plausible business buyers for a described product using
  the same objective model, without a niche-specific workflow.
- A task exceeds eight tool actions across batches and continues without the
  owner sending a new chat message.
- Both provider slots are full: later attempts remain queued and resume.
- Provider refusal, outage, lost response, restart, duplicate event,
  cancellation and simultaneous budget claims preserve recorded results and
  respect the spend ceiling.
- Source counts distinguish source records from unique qualified buyers;
  contact routes, confirmed sends and replies are separate measurements.
- Cross-organization isolation and existing DNC/opt-out/approval tests pass.
- TinyFish's relevance, contact coverage, latency, refusals and rate-limit
  behavior are evaluated on both buyer examples. Free-only tasks cannot
  silently switch to a paid provider; paid fallback respects the agreed cap.
- Starting work from chat creates a visible, truthful task card. The owner
  can identify the actual assigned agent/task, current action and last update
  across chat navigation, browser reload and reconnect.
- One multi-stage worker does not appear as several active agents. Queued,
  provider-waiting, outside-hours, approval-waiting, paused and stale tasks
  are distinguishable from active execution and from disconnected UI updates.
- Per-agent/task and channel counts reconcile with the send ledgers. Queued,
  attempted and uncertain messages do not inflate confirmed sends; one person
  appearing in multiple sources/worker stages does not inflate unique totals.
- Every terminal request produces one report with results or partial results
  and the exact stop reason, even after a restart, duplicate event, closed
  browser, report-generation error or temporary report-write failure.
- Research completion with remaining outreach clearly reports both states;
  the UI never presents pending scheduled sends as completed delivery.

Measure unique qualified leads, qualified yield per query/page and per dollar,
evidence coverage, duplicate rate, completion time and exact stop reasons.
Report delivery and replies only from their delivery/CRM ledgers. Use these
measurements to choose defaults after the pilot instead of guessing a single
universal tool-call limit.
