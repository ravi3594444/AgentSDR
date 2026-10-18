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
| 16 | Pre-existing e2e failures left as they are: 2 in `scripts/e2e/web-discovery.ts` and 5 in `scripts/e2e/apify.ts`, all expecting Instagram-only accounts to be excluded or uncontactable | They fail identically on the baseline `640b2d6`; the branch made Instagram-only prospects reachable by DM, so the expectation looks stale, but the intended eligibility rule needs the owner's confirmation | Rewrite the expectations tonight |
