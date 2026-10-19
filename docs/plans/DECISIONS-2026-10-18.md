# Decisions taken on the night of 18 October 2026

The owner approved the session plan and went to sleep. These records list
what the owner decided and each default taken without asking, with the
alternative. Any of them can be reversed later.

## Decided by the owner

| Decision | Choice |
| --- | --- |
| Base of the work | `claude/dreamy-fermi-h5woha` reset onto `claude/new-session-g5hljn` (`0181203`); `main` untouched |
| Push policy | Push the session branch after every green slice. Nothing deploys from it |
| First slice | TinyFish search and read |
| Reddit | Build the gate and a place to record approval. No reader, no workaround |
| Browser tools | Built, with a per-organization allowance of 0 minutes by default |
| Persistent graph | graphify; commit `graph.json` and `GRAPH_REPORT.md` |
| Test keys | TinyFish and AI/ML API keys used only for live verification from the scratchpad, never committed |
| Instagram-only prospects (19 October, replaces default 16) | **Yes.** An Instagram-only prospect is eligible for Instagram outreach through the connected Unipile account. Identity verification, account eligibility, Autonomous/Review authorization, DNC and sending limits still apply. The eligibility rule taken from the plan's identity and location rules: the account's profile was read and, for a search in a place, the profile or the post names that place. Otherwise it is kept for research with that reason, never called uncontactable. A commenter found under a post is kept for research until its own profile is checked |
| Scope on 19 October | Finish the existing plan; keep TinyFish and the existing integrations; no further provider integrations; deployment and live acceptance stay pending until the owner runs them |

## Defaults taken overnight

| # | Default | Why | Alternative |
| --- | --- | --- | --- |
| 1 | graphify builds from the free AST pass over `src/`, `scripts/` and `extensions/`; docs are not semantically extracted | The owner asked for subagents only where necessary; a semantic pass over 185 docs costs about 9 agents | Run `/graphify --update` with semantic extraction later |
| 2 | `graph.json` (13 MB) is committed at milestones (start and end of the night), not on every commit | Each commit of it adds about 1–2 MB of history; the post-commit hook keeps the local copy current regardless | Commit it on every slice |
| 3 | The graph hook in `.claude/settings.json` calls `graphify` from PATH, not an absolute path | Works in any container that has graphify installed | Absolute path as generated |
| 4 | The local test database is a Postgres 16 cluster at `/var/lib/postgresql/agentsdr-pg`, port 5433, owned by `postgres` | The scratchpad is root-only and Postgres refuses to run as root | Docker (no daemon in this container) |
| 5 | `instagram_outreach_queue` added to `OWNED_TABLES` | It was the one branch table missing, against the CLAUDE.md rule | Leave it unmanaged |
| 6 | The owner's uploaded plan is copied to `docs/plans/IMPLEMENTATION_PLAN_2026-10-18.md` | Later sessions need the newest plan in the repository | Keep it only in the chat upload |
| 7 | TinyFish limits are the reference page's (Search 30/min, 500/h, 12,000/day; Fetch 150/min, 1,000/day per key) and AgentSDR stops at them | Beyond the free allowance TinyFish draws on the Wallet; the owner asked for free use without silent paid fallbacks | Let calls continue into the Wallet with a spend cap |
| 8 | TinyFish is not behind an optional feature; its card is always on Settings → Organization | Web access is core scope in the plan | Gate it behind "Website and directory search" like Tavily |
| 9 | `web_search` uses TinyFish; Tavily only when TinyFish is not connected (or turned off for search), within Tavily's daily cap, counted in `provider_usage`; never an AI model's paid search | No silent paid fallback; a saved key alone does not decide strategy | Offer the AI provider's search too |
| 10 | `read_webpage` checks the address is public before sending it to TinyFish, then falls back to a direct read when TinyFish cannot read a page (except not-found, login and invalid addresses) | Internal hostnames never leave the server; direct reads stay free | TinyFish only |
| 11 | URL grounding: same host or a subdomain of a host the owner wrote, a page read linked, or a search returned | The old substring match let `notacme.com` pass for `acme.com` | Registrable-domain matching with a public-suffix list |
| 12 | Website discovery's per-day job cap does not apply when TinyFish searches (its quota waits instead); its job sends keyword queries with the old sentence as `purpose` | TinyFish is free and bounded by its own allowance | Keep the 10-a-day cap |
| 13 | Approving Apify's Google Maps Actor counts as pre-authorizing it as the Maps fallback when the built-in scraper is missing or fails; otherwise Apify runs Maps only when the owner asks (`provider: "apify"`) | Matches "explicitly selected or pre-authorized fallback" without a new setting, and keeps installs without the scraper working | A separate "Maps fallback" setting, default off |
| 14 | A search waiting for an Apify slot gives up after 6 hours and reports "not searched" | Bounded wait; an honest result rather than an endless queue | Wait indefinitely |
| 15 | Per-platform coverage is derived from the request's jobs (`requestMessageId` on job payloads), not a new objectives table | The plan asks for the smallest state that works; S6 may add durable objective state if reports need it | An `assistant_objectives` table now |
| 16 | *Superseded on 19 October by the owner's decision above.* Pre-existing e2e failures left as they are: 2 in `scripts/e2e/web-discovery.ts` and 5 in `scripts/e2e/apify.ts`, all expecting Instagram-only accounts to be excluded or uncontactable | They fail identically on the baseline `640b2d6`; the branch made Instagram-only prospects reachable by DM, so the expectation looks stale, but the intended eligibility rule needs the owner's confirmation | Rewrite the expectations tonight |
| 17 | AI/ML API structured calls name the function to call (`tool_choice`) instead of `"auto"`, and a tool call cut off by the length limit is refused and retried once with double the token budget; OpenRouter keeps `"auto"` | Reproduced live: Claude Haiku 5.5 through AI/ML API with `"auto"` ended with `finish_reason: "length"` and empty `{}` arguments, the owner's "{} / message-only" failures. With the function named it answered on the first attempt | Switch AI/ML API to a JSON-schema response format |
| 18 | After three failed attempts the chat shows a plain failure with a Retry button; Retry resumes the same turn with no new message. Diagnostics stay in the server log | The owner sees what happened and decides; no silent loop | Retry automatically on a timer |
| 19 | A wrong-number route is blocked for every record in the organization that holds it (`crm_wrong_routes`), not only the lead it was reported on | The number reaches someone else whoever it is recorded on; the lead's other channels go on | Block it for that lead only |
| 20 | There is no control yet to clear a wrong number; deleting its `crm_wrong_routes` row clears it | Rare, and an accidental clear would message a stranger | A "Not wrong after all" control on the record |
| 21 | Browser sessions: one per organization, 10 minutes reserved against the day's allowance on open, ended by TinyFish after 5 idle minutes and by AgentSDR at the end of every agent turn; `playwright-core` pinned to an exact version and used only over CDP | Metered by the minute; nothing is left running between turns | Keep a session across turns |
| 22 | Activity lists the last 7 days plus anything still open. "New replies" is per person (`activity_seen`); before a person's first visit, the last 7 days count as new | Each member has their own unread state; a week bounds the first badge | One seen time per organization |
| 23 | A record's workflow state (Needs you, being handled) belongs to its newest reply; an older reply that was answered shows Answered | Otherwise every past message of an open conversation reads "Needs you" | Every reply shows the record's state |
| 24 | Activity can cancel search jobs only. Outreach plans keep their own Pause/Resume/Stop there; a proposed plan is started from its chat, where the reply mode is chosen | Starting needs the Automatic/Review choice and its permission check | A Start button in Activity |
| 25 | A plan card's Sending status is loaded when opened, not in the chat's 10-second refresh | It reads several queues and accounts per plan | Include it in every refresh |
| 26 | LinkedIn senders are not in the delivery snapshot; the card says "Not covered here: LinkedIn" | Their gates live in the LinkedIn engine's own account settings; saying nothing would imply all is well | Port the LinkedIn gates tonight |
| 27 | A plan that started while another plan's request approval was open, without a record of which authorized it, is described as "Started in <name>'s name". New starts under an approval record `plan.startedUnder` | A time window alone cannot tell a Start press from the approval | Attribute by time window |
| 28 | WhatsApp delivery evidence per lead is the latest sent campaign message's flags; Unipile's `seen` flag is shown as a read receipt, never as "seen" | The glossary's evidence ladder; a read receipt is the provider's report, not proof a person read it | Show Unipile's raw flag names |
| 29 | Browser minutes a day are 0 (off) or at least 10, one session's length | 1–9 minutes looked like an allowance but could never open a session | Allow short sessions |
| 30 | "New replies" in Activity are judged by when AgentSDR recorded the reply, not the provider's sent time; the seen mark only moves forward | A late-ingested reply would otherwise never count as new | Keep the provider's time |
| 31 | A requested platform counts as searched on the web when the assistant ran `web_search`/`read_webpage` for that request, not only when a website-search job ran | The coverage line said "not started" after the assistant had searched | Count jobs only |
| 32 | Activity offers Cancel for search jobs only; a plan's start job is controlled by the plan's own Stop | Cancelling a launch half-way could not stop what it had created | Cancel any job |
| 33 | An explicit stop in a wrong-number message means Do Not Contact whoever confirms it, read in `closeWrongNumber` for every caller | CONTEXT.md's rule; reading the message itself can only ever send less | Trust each caller's own reading |
| 34 | A WhatsApp wrong route is the number that wrote: the chat's own number, else the privacy id (`<id>@lid`), never the Person's current phone when a chat row exists | An operator's corrected number must not be blocked, and the number that wrote must not stay open | The Person's phone (round one) |
| 35 | When a run leaves "starting" during its launch, the launch records and stops what it created | Stop must stop everything; senders do not read the run's status | Have every sender check the run |

## Defaults taken on 19 October

| # | Default | Why | Alternative |
| --- | --- | --- | --- |
| 36 | A request's lead target, time limit and spend cap default to 25 leads, 4 hours and $5, as "general" Sending rules (`objectiveLeadTarget`, `objectiveHours`, `objectiveSpendUsd`). Values named in the request are clamped to 1–1000 leads, 5 minutes–72 hours and $0–$500 | Sending rules are where operational numbers live; the bounds keep a typo from running for days | Ask the owner every time |
| 37 | A $0 cap means free sources only; it never stops a request as "budget spent" | "Spend nothing" is a choice of sources, not a limit reached | Treat $0 as already spent |
| 38 | A qualified lead is a distinct person with a contact route across the request's lead lists. When several limits hold at once, the stop reason is the target, then spend, then time | One person found twice is one lead; the owner most wants to know the target was met | Count list entries |
| 39 | "Sources exhausted": a continuation started nothing, or two continuations in a row found no new lead | Bounded; stops paying for searches that yield nothing | A fixed number of continuations |
| 40 | After a stop, the final report waits up to 30 minutes for searches still running; the time limit keeps counting while a request is paused; any member can pause, resume or cancel a request | The report then includes what was still arriving; a pause does not extend the owner's deadline | Report at once; owners and admins only |
| 41 | Costs outside the dollar cap: Tavily (counted in credits; its price is not guessed), AI web research before its cost is reported, and model tokens | The spec named the three ledgers; guessing a price would make the cap look exact when it is not | Estimate them |
| 42 | An Apify start whose answer was lost is never started again, and its reserved amount stays counted against the request | A charged operation is never blindly retried | Retry once |
| 43 | Shared metrics: sent is provider-accepted only; contacted is distinct people with an accepted send (calls and messages typed on the phone are not outreach); reply rate is people contacted in the period who replied after their first send in it, over people contacted | One definition for Overview and Analytics; the old Analytics rate could exceed 100% | Keep each page's own counts |
| 44 | Analytics uses the organization's time zone; `?tz=` stays as an explicit, labelled override. Today, 7 and 30 days run to the end of the local day on both pages | Both pages must give the same number for the same period | The browser's time zone |
| 45 | Per-source counts: Google Maps through the built-in scraper and through Apify are separate rows; a person found by several sources counts once in the total and lists every source | Source and provider are different things (CONTEXT.md) | One Google Maps row |
| 46 | Activity reads senders for the newest 5 running plans only; a plan is "Outside sending hours" only when every sender is outside its hours and nothing without a known end holds it (a disconnection is named instead) | Keeps the 10-second refresh cheap; "outside hours" must not hide a disconnected account | Every running plan |
| 47 | A plan's "contacted" in Activity is a lead whose message was at least accepted for sending; an uncertain or failed send is not counted | The delivery evidence ladder | Count attempts |
| 48 | A launch records each campaign on its run as soon as it is created, before activation; a retried launch reuses it; a launch that finds the run stopped leaves it inactive | Stop and a retry must both find what a launch created | Record at the end of the launch |
| 49 | A page the model opened that repeats what the model wrote into its address (query values, fragment, path segments with an address or a long number) grounds none of it, including after a redirect; the page's own host is kept | An echo is not evidence | Trust the page text |
| 50 | Web-search coverage of one request is counted until the owner's next request in the same chat. A continuation of the first request that runs after a second request is counted under the second | Known limitation, kept: it changes a coverage line only, not spending, stopping or sending | Tag every tool call with its request |
| 51 | A business found with only a phone is named by its business name in plans and in the facts given to the writer, not by its number | Found by the full-flow test | — |

