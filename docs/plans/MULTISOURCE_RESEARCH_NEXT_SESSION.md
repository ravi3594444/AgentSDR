# Next session: buyer-aware research across sources

Status: implementation plan only. The next session starts after the owner tests
the combined Claude branch on the VM. Do not begin this redesign as part of the
Instagram outbound merge.

## Current baseline

Deploy from `claude/new-session-g5hljn`; leave `main` unchanged. Preserve the
existing product, connected providers, organization isolation, approval modes,
Do Not Contact, opt-out handling and delivery uncertainty rules.

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

## Implementation order and acceptance

1. **Task foundation.** Add schema, migration, task service, leases, events,
   usage reservations and cancellation. Demonstrate resume after a process
   restart and duplicate dispatch without duplicate charges or lead writes.
2. **A complete research path.** Connect existing web discovery to durable
   tasks and progress. Allow more than three queries and forty pages across
   child jobs when the selected task budget allows it; do not lift limits
   globally or bypass organization caps.
3. **Additional sources.** Wrap existing Maps, LinkedIn and Apify adapters,
   queue work behind their concurrency limits, then add source selection and
   adaptation based on qualification yield and budget remaining.
4. **Qualification and handoff.** Persist evidence and canonical dedupe,
   distinguish fit from contactability, and prepare an outreach plan through
   existing approval controls.
5. **Owner controls.** Add task budget, source/provider choices, progress,
   pause/resume/cancel, partial results and exact stop reasons to the UI.
6. **Evaluation and VM pilot.** Run deterministic fake-provider cases first,
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

Measure unique qualified leads, qualified yield per query/page and per dollar,
evidence coverage, duplicate rate, completion time and exact stop reasons.
Report delivery and replies only from their delivery/CRM ledgers. Use these
measurements to choose defaults after the pilot instead of guessing a single
universal tool-call limit.
