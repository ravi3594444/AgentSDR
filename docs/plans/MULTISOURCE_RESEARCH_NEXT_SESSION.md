# Next session: one reliable lead-to-outreach flow

Status: plan only. Start after the owner tests the current Claude branch on
the VM. Owner direction, 17 October 2026: prioritize useful, working behavior
and small changes. Provider options are choices, not a bundle to implement.

## Current baseline

Work on `claude/new-session-g5hljn`; leave `main` unchanged.

- Combined implementation: `a5ec1e7`. Direct Instagram username repair:
  `d832a8c`; 1,368 tests, 27 simulated-provider database scenarios, TypeScript
  and Node/Webpack production build passed. Live VM delivery remains untested.
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

1. **Find candidates.** Search for the buyer objective using one primary web
   search provider. Read business sites/directories and extract published
   social profile links. Use existing Maps, LinkedIn or social search when
   they fit the objective; do not launch every source for every request.
2. **Verify and save.** Keep evidence URLs, fit/location/role and check time.
   For social profiles, verify identity and available public information using
   existing supported adapters, including Apify when needed. Unknown fields
   stay unknown. Small accounts may qualify; no universal follower minimum.
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

## Core web access: search and read

Owner clarification, 17 October: the agent needs useful free web access with
generous allowances. Google, Bing and TinyFish were examples of that missing
capability. Provide a working search-and-read loop as a required first step;
do not leave it conditional merely because specialized discovery exists.

Use one integration with two capabilities:

- A general `web_search(query)` tool returns real candidate URLs, titles and
  snippets. The model can refine its query within the task's remaining budget.
- Extend `read_webpage(url)` to read pages found by a successful search and
  follow extracted public links. Update URL/contact grounding to trust only
  recorded owner input or successful scoped search/read results. Keep public
  network/URL protections, evidence URLs and contact validation in place.

TinyFish Search/Fetch is the first implementation candidate: one API key,
ordinary search plus clean page content/links, with JavaScript rendering when
needed by Fetch. Use the existing encrypted credentials mechanism and small
API adapters, without another agent framework. Test the buyer queries and
actual returned pages before selecting it as the default. Existing configured
providers remain usable, with paid fallback explicitly selected by the owner.
A saved Tavily key must not force that provider for every objective.

The documented free allowances are listed below. Search/Fetch can operate at
a zero Wallet balance. Full click/type/login automation is a different
capability: TinyFish Browser and Agent are metered products. Do not present
free Search/Fetch as a free unrestricted interactive browser, or promise it
can read private/login-walled social content. Reuse existing authorized social
adapters for such supported operations. No new paid browser is required for
this first public-web research flow.

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

## Enough research, with clear controls

Separate model action batches, worker concurrency, research budget and
outreach sending limits. Eight actions is one model batch, not a chat-wide
allowance. The current six-step normal and sixteen-step Autonomous chat loops are not
a durable task runner.

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

## Visible work and useful completion

Improve existing chat job cards and add a compact Activity panel/view using
the same records. Include the organization's accessible chats/runs; keep the
current navigation/theme and provide a usable mobile view.

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

## Implementation and acceptance

1. Verify the deployed username fix and reproduce the real research failure.
   Record what already works and the smallest cause of missing/poor leads.
2. Deliver general search-and-read access first, using the TinyFish candidate
   above and real returned URLs without an owner-supplied seed link. Complete
   the path through existing qualification, canonical leads, approved
   outreach, progress and completion reporting. Verify the provider works
   before making it the default; the missing web access remains core scope.
3. Test the full path with fake providers, including continuation beyond eight
   actions, full slots, restart, duplicate events, concurrent budget claims,
   cancellation, provider refusal/outage and lost responses. Preserve org
   isolation, approval, DNC/opt-out and delivery uncertainty behavior.
4. Run a small owner-approved live research pilot on both buyer examples with
   an agreed spend cap. Live messaging uses an explicitly approved recipient
   and message within the app's existing authorization. Verify a real inbound
   reply in Automatic and Review modes; fake-provider success is not live proof.

Accept only when the buyer examples produce evidence-backed saved leads or
an honest partial result with its exact cause, the owner can see actual work
and sends/replies, and a final report survives reload/restart and AI failure.
Compare qualified yield, duplicate rate, cost and completion time. Add another
provider only if those results show a specific coverage/reliability gap.

## References to recheck before provider changes

Checked 17 October 2026; provider prices, limits and contracts can change.
TinyFish currently documents free Search at 30 requests/minute and 500/hour;
Fetch at 150 URLs/minute and 1,000/day, with a key required. Provider usage and
LLM costs are separate. Do not interpret free service as unlimited.

- https://docs.tinyfish.ai/api-reference/search-the-web
- https://docs.tinyfish.ai/api-reference/fetch-and-extract-content-from-urls
- https://www.tinyfish.ai/pricing
- https://apify.com/apify/google-search-scraper
- https://apify.com/apify/instagram-profile-scraper
- https://developers.google.com/custom-search/v1/overview
- https://learn.microsoft.com/en-us/lifecycle/announcements/bing-search-api-retirement
- https://learn.microsoft.com/en-us/azure/foundry/agents/how-to/tools/bing-tools
- https://developers.facebook.com/documentation/instagram-platform/instagram-graph-api/reference/ig-user/business_discovery
- https://github.com/superdesigndev/treg/blob/main/LICENSE
