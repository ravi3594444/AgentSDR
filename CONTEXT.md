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
- **Source**: where leads come from, such as Google Maps, Instagram,
  LinkedIn, the open web, a directory, Hacker News or Stack Exchange.
- **Provider**: who fetches from a source, such as the built-in Maps scraper
  (the gosom sidecar), Apify, TinyFish, Tavily or Unipile. Labels always name
  both, for example "Google Maps through the built-in scraper" or "Instagram
  through Apify". Two providers for one source still count as one source.
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
  alone is not a match, and keyword hits are hints, not proof.
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
  sources exhausted, spend cap used, time limit, cancelled, or failed. It is
  stored with the objective and said in its final report.

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
  answer. **Review** means it leaves a draft in Action required.
- **Takeover**: the owner saying "I'll reply myself" for one conversation.
  The agent then stays silent there.
- **Needs you**: open owner decisions such as missing information, a
  complaint, a negotiation or a meeting, and drafts awaiting review.
  Interested and opt-out reports are shown but do not count as Needs you. A
  decision stays in Needs you after the assistant's answer or the owner's own
  reply until the owner settles it.
- **Action required**: CRM records waiting on a person, such as a draft
  awaiting review or an unclassified reply.

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
