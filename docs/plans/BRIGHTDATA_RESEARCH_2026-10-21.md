# Bright Data social research (pilot, 21 Oct 2026)

Branch `claude/brightdata-discovery`, from the navigation release `373ac3c`
on `claude/dreamy-fermi-h5woha`. The deployment branch is unchanged. Size:
**M**, four stages (B1 client and mapping, B2 settings and ledger, B3 job
and tool, B4 checks). Not merged, not deployed.

## What it is

One more research provider, deeper rather than wider: the assistant gets
one tool, `research_social_sources`, and one job kind, `social_research`,
that read social platforms through Bright Data's Scraper API with the
owner's own key. Everything else is the existing machinery: the request's
objective (target, time, spend cap, pause, stop), the usage ledger
(`provider_usage`), audiences and members with evidence, qualification,
plan preparation, the chat report and the request panel.

- **Reddit** is the one platform Bright Data searches natively: posts by
  keyword (`discover_by=keyword`, up to `num_of_posts` per keyword, with
  the comments it returns) and in named subreddits. It stays **off** until
  an owner turns it on in the Bright Data settings (Reddit's terms restrict
  automated collection; the card says so). `read_webpage` still refuses
  Reddit pages.
- **X, Instagram, Facebook** have no keyword search in Bright Data: their
  post, profile and page URLs come from the web search the organization
  already has (TinyFish, Tavily, the AI provider) or, with none, from a
  SERP API zone the owner created in Bright Data. Only URLs that are
  plainly a post, profile or page are sent (a search page, a login, a
  group would be billed as a failed input).
- **Authors' profiles** are read after their posts, bounded (10 per
  platform, within the job's records limit): on Reddit only authors whose
  words ask for something; elsewhere every post author the search found.
  The websites profiles list are read with the existing contact reader.
- **A finding is evidence.** A post, comment, profile or page keeps its
  link, the words quoted, the author and the time Bright Data read it
  (`retrievedAt`). Its author becomes a contactable lead only when their
  own profile or page, or the website it lists, publishes an email or a
  phone (checked like every other), or an Instagram username for a DM
  under the same rule as other Instagram profiles; everyone else is kept
  as excluded with the reason ("their words do not ask for anything, so
  their profile was not read", "their Facebook page publishes no email or
  phone; AgentSDR cannot message anyone on Facebook").
- **No messaging on Reddit, X or Facebook**, ever. Instagram DMs go the
  existing way (a connected sender, an approved plan).

## Datasets verified (schemas on 21 Oct 2026; live records in the probes)

| Platform | Dataset | Method and inputs | Live |
| --- | --- | --- | --- |
| Reddit posts (+comments) | `gd_lvz8ah06191smkebj4` | `discover_by_keyword` [keyword, date ∈ Past hour…All time, num_of_posts]; `discover_by_subreddit_url` [url, keyword, sort_by, num_of_posts]; `collect_by_url` | full post records with `comments[]` (2 records, probe) |
| Reddit profiles | `gd_mgnh0p8w16o65lmhp` | `collect_by_url` → `social_links`, `description` | — |
| X posts | `gd_lwxkxvnf1cynvib9co` | `collect_by_url` [url]; no keyword discovery | — |
| X profiles | `gd_lwxmeb2u1cniijd7t4` | `collect_by_url` [url, max_number_of_posts] → `biography`, `external_link`, `is_business_account` | 1 record (probe) |
| Instagram profiles | `gd_l1vikfch901nx3by4` | `collect_by_url` → `email_address`, `external_url(s)`, `biography` | error record `dead_page` (probe; billed) |
| Instagram posts | `gd_lk5ns7kz21pck8jpis` | `collect_by_url` → `latest_comments` | — |
| Facebook pages | `gd_mf124a0511bauquyow` | `collect_by_url` → contacts nested in `contact_and_basic_info.contact_info` | 1 record (probe) |
| Facebook posts | `gd_lyclm1571iy3mv57zw` | `collect_by_url` → `content`, `page_url` | — |

Two things the docs did not say and the probes did: Reddit keyword
discovery returns full post records (not URLs to collect again), and a
Reddit commenter's `user_url` is malformed (`…/svc/shreddit/…/undefined`),
so the profile URL is built from the name. The API answers some failures
as plain text, not JSON (the client reads text first). A dataset being
listed does not make it operational: the settings card shows, per dataset,
only what this organization's collections returned.

## Usage

- 1 credit per delivered record (a failed input included); 1 per SERP
  request. List price $1.50 per 1,000 past the free tier (5,000 shared
  credits a month). With deposited funds Bright Data keeps serving past the
  free tier, so the owner's monthly limit here is the hard stop. The API
  does not report the balance: every figure says "estimated from delivered
  records".
- Reserve, then settle: a collection is a `provider_usage` row (provider
  `brightdata`, products `records` and `serp`) reserved at its most
  credits (`inputs × limit_per_input` for discovery, one per URL
  otherwise) under the organization's `brightdata-start` lock, after the
  monthly limit, the open-collections cap (3) and the request's spend
  guard, then triggered; settled at `records + errors` once ready.
- Never twice: a retried step finds its job's collection by
  `collectionKey` and polls it; the same inputs settled within 7 days are
  downloaded again for free; a trigger whose answer was lost stays
  `uncertain` (counted) and is never sent again; a collection nothing
  polled for 35 minutes is swept as uncertain.
- Rate limits: a 429 is a wait with Bright Data's `Retry-After`, never a
  quick retry (25 within 5 minutes blacklist the IP).
- Spend: `brightdataUsd` / `brightdataCredits` in the request's
  `SpendBreakdown`, at the list price, so the request's cap and the
  continuation note count it.

## Where it shows

- Settings → Providers & features → **Bright Data research** (feature
  switch), then the card: key (write-only), credits a month, records per
  search, SERP zone, the Reddit switch, this month's estimated use, and
  per dataset what the organization's collections returned.
- The chat: the tool's line names each platform searching or NOT searched
  with the reason; the job's report names each platform's yield and the
  credits used; the compact line reads "Reddit, X (Bright Data)".
- The request panel and reports: the search appears as "Reddit, X through
  Bright Data" with its yield; platform coverage understands "reddit" and
  "x" in the owner's words.

## Checks

Offline (every outside call stood in):

- Unit: `src/lib/brightdata/mapping.test.ts` (records → findings with the
  live field shapes, URL rules, credits, errors), plus the existing suites
  (1,914 pass).
- `scripts/e2e/brightdata.ts` (51 checks): the gates (feature, key, Reddit
  switch, URL finder), a full four-platform run with evidence and reasons,
  what was sent (canonical URLs only), the ledger, the settings card, the
  same research reused for free, a retried step, a lost answer, a rate
  limit, a used-up account, the monthly limit, the open cap, a stale sweep,
  the spend guard, a failed snapshot, a cancelled one, pause and stop, a
  SERP zone, and a second organization.
- `scripts/e2e/full-flow.ts` (33 checks): a second request in the same chat
  goes Reddit → Bright Data → qualification → a WhatsApp plan → the final
  report ("Reddit through Bright Data: 1 search, 2 found … 2 credits,
  estimated from delivered records").
- `npx tsc --noEmit`, ESLint, `check-organization-scope --contract`,
  `docker/deploy.test.ts`, the production build.

Live (the owner's key; research only, nothing sent; 34 of the 100 credits
allowed):

- Probes before the code (5 credits): Reddit keyword discovery (2 full
  post records with comments), an X profile, an Instagram profile (a dead
  page, billed as 1), a Facebook page.
- `scripts/e2e/brightdata-live.ts` through the real tool and job (29
  credits, 5½ minutes), Reddit only (the environment holds no web search
  key for the other three): two keyword inputs at 10 posts each delivered
  19 posts with 168 comments (187 discussions, 19 credits); the authors'
  profile hop read 10 profiles (10 credits; 2 more authors were over the
  job's 30-record limit, and the report says so). The ledger settled both
  rows at what Bright Data reported; the card showed 29 used, both
  datasets "verified" with their record counts; the settings row was
  deleted afterwards.
- Outcome: 170 people found, 0 contactable, 170 kept as research with the
  reason (158 "their words do not ask for anything, so their profile was
  not read", 10 "their Reddit profile publishes no email or phone", 2
  "the limit on authors' profiles read was reached"); 12 asked for
  something in their own words. That is Reddit as designed: discussions
  are evidence, and Reddit profiles rarely publish a contact route.
- Two things to know: the plain keyword "missed calls at the front desk"
  also pulled hotel front-desk threads (r/TalesFromTheFrontDesk) beside
  the relevant ones (r/Businessowners "Do missed calls actually cost you
  business?"), which the request's qualification step filters when the
  job serves an objective (it did not here); and the need heuristic
  (`needSignal`, shared with web discovery) counted a few questions that
  are not asks ("What's the pricing?"). Narrower keywords and named
  subreddits are the owner's levers.

## Deploying (not yet)

1. `bun run scripts/add-brightdata.ts` (packaged in the image and in
   `docker/deploy.sh` DEFAULT_MIGRATIONS): `brightdata_settings`, the
   `social_research` job kind, the `brightdata` feature key, an index on
   `provider_usage.job_id`. Additive, re-runnable, `lock_timeout 10s`.
2. Deploy the code. Nothing changes for an organization until an owner
   turns the feature on and saves a key; Reddit stays off until switched on.
3. Rotate the key the owner pasted in chat during the pilot.

## Not done

- No Instagram or Facebook keyword search through Bright Data (none
  exists); Apify's `find_social_leads` remains the way to find pages and
  accounts by keyword and place. The prompt tells the model not to run both
  for one question.
- A cancelled job's open collections are left to the sweep (35 minutes);
  nothing cancels them at Bright Data on the spot.
- The live check covers Reddit; X, Instagram and Facebook were verified
  by single-record probes only.
