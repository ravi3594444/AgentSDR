# AgentSDR glossary

Use these words in code, commits, docs and chat. Each entry says what the
word means here and, where it matters, what it does not mean.

## Prospecting

- **Objective**: one owner request pursued to an end, such as "find real
  estate agents in Pune who might buy AI automation". It owns a target, a
  budget, the platforms the owner named and one final report. It is
  identified by the owner's message id (`requestId`). Several jobs and plans
  can serve one objective. A child job finishing does not finish the
  objective.
- **Brief** (research agent v2): the model's written-down reading of one
  request (`brief.ts`): its goal, the number of leads, whether to contact
  them, the only channels allowed, the spend cap, the time limit and what
  "done" means, taken from every owner message about it (an answer to the
  assistant's question included) and stored on the objective. The model
  may tighten a limit freely; a limit above the organization's default
  stands only when the owner wrote that number. Searches wait for it; the
  plan, the judge and the final report read it.
- **Research-only request**: a request whose latest words say not to contact
  anyone ("research only", "no outreach", "do not contact anyone", "kisi ko
  contact mat karo"). It is a veto: nothing in it authorizes outreach, and it
  cancels an earlier outreach request nothing has acted on yet
  (`researchOnlyStated`, `agent.ts`). A false "yes" contacts people; a false
  "no" only makes the assistant ask.
- **Request subject**: what a request asks to find, without how the research
  runs (`requestSubject`, `leadFit.ts`): "Find 3 dental clinics in Pune,
  India." of the pilot request. Leads are judged against it; budgets, time
  limits, sources and "do not contact" are never requirements a lead fails.
  A kind or place it names replaces the saved target customers for that
  request.
- **Source**: where leads come from, such as Google Maps, Instagram,
  LinkedIn, the open web, a directory, Hacker News or Stack Exchange.
- **Provider**: who fetches from a source, such as the built-in Maps scraper
  (the gosom sidecar), Apify, TinyFish, Tavily, Bright Data or Unipile.
  Labels always name both, for example "Google Maps through the built-in
  scraper", "Instagram through Apify" or "Reddit through Bright Data". Two
  providers for one source still count as one source.
- **Social research**: one `social_research` job through Bright Data
  (`socialResearch.server.ts`): Reddit posts with their comments found by
  keyword and in named subreddits (only when the owner turned Reddit
  research on), and X, Instagram and Facebook posts, profiles and pages a
  web search (or the owner's SERP zone) returns, then the authors' profiles
  and the websites they list. It answers "what are people saying", not
  "who runs a business here" (that is a lead search).
- **Finding**: one thing read from a social platform: a post, a comment, a
  profile or a page, kept with its link, the words quoted, who wrote them
  and when Bright Data read it. A finding is research evidence. Its author
  is a lead only when their own profile or page, or the website it lists,
  publishes an email or a phone, or (Instagram) a username for a DM; every
  other author stays in the list as excluded, with the reason. AgentSDR
  never messages anyone on Reddit, X or Facebook.
- **Platform coverage**: the state of each platform the owner named:
  searched, queued, partial, blocked or unavailable, with the actual reason.
  A website's Instagram link is contact enrichment, not an Instagram search.
- **Known link**: a URL the agent may read: one the owner wrote, one returned
  by a successful `web_search`, or one found on a page already read.
  Grounding refuses any other URL.
- **Evidence**: the URL and check time that support a lead's fit, location,
  role or contact route. Evidence is not buying intent. A follow, a post or a
  question does not mean someone wants to buy.
- **Observation**: something a business's own website shows that bears on
  the owner's saved offer: a published booking or contact option, an opening
  that matches the offer, an explicit request for suppliers, its own
  description, or a person it names with a role. It keeps its page, the time
  the page was read and how sure it is. Relevance is inferred from matching
  words and is never buying intent; only an explicit request for suppliers
  counts as a need. What the pages read did not show is "not found on the
  pages read", never "does not exist". A person a website names is not the
  owner of a general address (info@, contact@) found beside them.
- **Qualified lead**: a person or company that is contactable (a route) and
  that the judging found to match the owner's request (`fit = match`,
  `leadFit.ts`), deduplicated against People and outreach history. Each
  person counts once, however many sources found them. A contact route
  alone is not a match, and keyword hits are hints, not proof. In research
  agent v2 the model may correct a verdict (`set_lead_fit`), only with a
  quote found in a page it read or in the lead's own saved facts; a name,
  title or @handle is a hint, never proof of a place.
- **Lead funnel**: a request's leads by distinct person: found, contactable,
  then of the contactable: match, no match (with the reason), unconfirmed (a
  requirement could not be checked, such as "no website") and not judged
  yet.
- **Website status**: what is known of a lead's website: none listed (on its
  Maps listing or profile; not proof it has none), listed but not checked,
  found and read, or a company domain on record, not checked.
- **Channel policy**: the channels a plan may use. Only the owner's own words
  restrict them; anything else only orders them, and each lead gets its
  first ready route (`channelPolicy.ts`).
- **Mark reviewed**: what the owner does with a Do Not Contact record once
  they have read the reply. It moves to idle, and Do Not Contact stays.

## Limits and money

- **Slot**: one concurrent unit of a provider that the organization may use.
  Apify has two open runs per organization, website discovery has two open
  jobs, and the browser has one session. A full slot means the work waits.
  It is not a failure.
- **Allowance**: what an organization may spend or use, set by the owner,
  such as the Apify monthly budget, Treg's daily dollar cap, Tavily
  searches per day or browser minutes per day. Browser minutes default to 0,
  so a metered browser never runs without an explicit choice.
- **Quota**: a provider's own limit, such as TinyFish Search at 30 requests a
  minute and 500 an hour, or Stack Exchange's `quota_remaining`.
- **Quota scope**: what a quota is counted against: the API key, the IP or
  the OAuth client. Two organizations sharing one key share one quota. An
  organization's allowance never creates new provider quota.
- **Reserve, then settle**: paid or metered work is recorded under an
  advisory lock before the provider call, then settled with the actual
  usage. A lost response keeps the reserved amount and is never blindly
  retried.

- **Credit (Bright Data)**: what Bright Data bills per record delivered, a
  failed input included. AgentSDR counts credits itself from delivered
  records against the owner's monthly limit, reserved at a collection's
  most before it starts; the count is "estimated" because the API does not
  report the account's balance. It never tops up or upgrades the account.

## Background work

- **Job**: one `assistant_jobs` row that the in-process worker steps
  through its stages. A step returns `wait`, `stage`, `done` or `failed`.
- **Claim**: a worker's hold on a job (`locked_by` plus `heartbeat_at`). A
  claim older than three minutes counts as stale and can be taken over.
- **Waiting**: a job that is queued with a `run_after` and a recorded reason,
  such as a provider slot, a quota reset or sending hours. Waiting is not
  running and not failed.
- **Report key**: the idempotency key of an objective's or job's terminal
  report. It ensures one report per outcome, even after duplicate callbacks
  or a restart.
- **Continuation**: the objective's driver resuming the request's chat turn
  without an owner message, once its searches have ended short of the
  target, with a note of what each source yielded. The model chooses the
  next source or query; a continuation that starts nothing means the
  sources are exhausted.
- **Stop reason**: why an objective ended, the first of: target reached,
  finished (research agent v2: the assistant called `finish_request` once
  the brief's done condition was met), sources exhausted, spend cap used,
  time limit, cancelled, or failed. It is stored with the objective and
  said in its final report.

## Outreach

- **Plan**: an `outreach_runs` row in `proposed`, prepared by the assistant.
  Preparing a plan never sends anything.
- **Start authorization**: the owner pressing Start, a request approval
  covering one request for 24 hours, or **Autonomous** mode on the chat,
  switched on by an owner or admin. Research alone never authorizes sending.
- **Overlap**: a person in the new plan who is already active in another
  running plan. Overlapping people stay in their existing campaign and are
  excluded from the new plan. They never block the rest of the plan.
- **Reply mode**: per run. **Automatic** means the reply agent may send an
  answer. **Review** means it leaves a draft in the Inbox. Switched on the
  plan card, or from an Inbox row (owner or admin for Automatic).
- **Takeover**: the owner saying "I'll reply myself" for one conversation.
  The agent then stays silent there.
- **Needs you**: the Inbox's first view, and its badge. Open owner decisions
  (missing information, a complaint, a negotiation, a meeting) shown first,
  then every conversation waiting on a person (`crmAttentionSql`): the Action
  required queue plus any draft awaiting review. Interested and opt-out
  reports are shown but never count. A decision stays until the owner
  settles it, even after the assistant's answer or the owner's own reply.
- **Action required**: a CRM record's workflow state, and the queue of
  records waiting on a person (an error, a classification to confirm, a
  draft, a due follow-up). It is part of Needs you, no longer a page of its own.
- **Inbox**: `/inbox`. Every channel's replies in one list: **Needs you** and
  **All conversations** (every conversation a reply arrived on, answered or
  not), with a channel filter. Each channel's own inbox stays under Advanced.
- **Request**: one piece of outreach work, followed from start to finish
  (`src/lib/assistant/requests.ts`). Usually an owner's message in a chat,
  with the searches and plans that carry its id; an older plan or search
  with no request id stands alone; a campaign made by hand is its own. Its
  summary: matching, contacted, replied, interested and failed, what blocks
  it, and the one next step. Shown beside the chat and on Outreach →
  Requests.

## Delivery evidence, weakest to strongest

queued → attempted → **accepted** by the provider → provider-reported
**delivered** → **read** receipt → an actual inbound **reply**. An
**uncertain** send (the response was lost) is never resent automatically.
Unipile's delivered flag is not proof that a person saw the message.

## Contact restrictions

- **DNC (Do Not Contact)**: the person asked not to be contacted, or the owner
  set it. Nothing is ever sent again, not even an apology.
- **Wrong number**: the contact route reaches someone other than the
  intended lead. Outreach to that route stops at once, and the route is
  recorded as wrong for that lead. In Automatic mode one brief apology may be
  sent. In Review mode it is drafted for review. An explicit "stop" or
  "unsubscribe" in the same message means DNC instead, so nothing is sent.
  The route is blocked for every record in the organization that holds it
  (crm_wrong_routes); the lead's other channels go on.
- **Closing acknowledgement**: that one apology. Claimed once per wrong
  route, so a repeat, a duplicate webhook, a retry or a second worker never
  sends another; never retried when it fails or is uncertain.
