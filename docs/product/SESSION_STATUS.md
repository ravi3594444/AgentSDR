# Session status

Last updated 2026-10-15. Run steps are in [OWNER_SETUP.md](OWNER_SETUP.md);
the plan is [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md).

## Where things stand

- **Branch:** `claude/new-session-g5hljn`, pushed. `main` is untouched.
  The latest work is routine automation, controls and results (Session 5,
  below), on top of the owner's assistant (Session 4). Session 6 (existing
  leads and inquiries, optional Instagram, intake and website discovery) is
  on `claude/instagram-intake-discovery`, proposed as a PR into it.
- **Readiness: implemented, pending live verification. Not owner-usable
  yet.** The whole messaging workflow is built and checked locally. One
  real WhatsApp message has reached the owner's own number from the VM;
  no live reply has been answered yet. The release is
  owner-usable only once the live checks in OWNER_SETUP §6 pass; they need
  the credentials, server and test recipients listed under "Blockers".
  Verified against real services so far: Google Maps lead discovery (the
  self-hosted scraper, real websites) and AI calls.
- **Nothing was sent from this sandbox.** Every send here went to a
  recording stand-in, or was refused because no provider was connected.
  The one real message was the owner's own test, sent from the VM.

## Session 6: existing leads and inquiries, optional Instagram, intake and website discovery

Branch `claude/instagram-intake-discovery` (from `claude/new-session-g5hljn`
at `994fb7d`), proposed as a PR into it; not merged, not deployed. Design,
verified provider capabilities, setup and limits:
[INSTAGRAM_INTAKE_DISCOVERY.md](INSTAGRAM_INTAKE_DISCOVERY.md).

Asked for: reuse of what the business already saved; two starting points
("use my existing leads or inquiries", "find potential customers for me")
feeding the same CRM, plans, runs and handoffs; optional website/directory
discovery with exact sources and no invented contacts; Instagram through
Unipile (v1) with history kept apart from fresh messages; optional inquiry
intake (Instagram, authenticated website-form webhook); qualification
before outreach; owner control unchanged; one Automatic/Review choice for a
whole request, including leads found later.

**State: implemented and checked locally against stand-ins. Nothing live.**
No Unipile, Instagram, form tool, search provider or website was called;
no message was sent.

| Part | Where | Default |
| --- | --- | --- |
| Optional features, per organization | `src/lib/features/`, Settings → Organization | all off; off before the migration too |
| Business context reuse, two starting points, qualification, one Start per request, inquiry runs | `src/lib/assistant/{businessContext,existingLeads,qualification,requestApproval,inquiryRuns}*.ts` | on (no provider, sends nothing by itself) |
| Website and directory discovery | `src/lib/discovery/web*.ts`, `websiteContacts.server.ts`, `mailDomain.server.ts` | feature off |
| Instagram messages (Unipile v1) | `src/lib/instagram/`, `src/services/unipile.instagram*.ts`, `src/jobs/replayInstagramWebhooks.ts` | feature off |
| Inquiry intake | `src/lib/intake/`, `/api/intake/form`, Settings → Inquiries | feature off |
| Migration | `scripts/add-instagram-intake-discovery.ts` (7 tables, widened checks, NOT VALID then VALIDATE) | run by the operator |

Review: three independent reviewers (Instagram channel; discovery for
invented data and SSRF; regressions with every feature off) reported 27
issues. Each was fixed (two fix agents in separate worktrees, the rest
directly) or deliberately kept with the reason stated in the PR, and the
fixes were re-verified adversarially, two to three skeptics per finding.
Checks on the final branch are in the PR description.

## Session 5: routine automation, reliable controls and results

Asked for: campaigns and sequences kept internal to the assistant; outreach
that runs on its own after one Start, within the approved audience,
channels and limits; routine replies answered from the owner's saved
information and documents, a focused question to the owner when something
is missing (answer saved for later), opt-outs stopping everything,
escalations with the reason and decision needed; Automatic and Review kept
and explained at Start; pause / stop / resume / takeover that hold; checks
repeated just before each send; an owner dashboard, a daily summary and
results in chat; a simpler owner setup; verification against real services.

**State: implemented and checked locally. Live only for lead discovery and
AI.** No message was sent to anyone; no real reply was received.

### What was built

| Part | Where | What it does |
| --- | --- | --- |
| Reply mode per run | `outreach_runs.autopilot`, `outreach_run_leads`, `/api/assistant/runs/[id]` | Start requires Automatic or Review (Automatic: owners and admins); the run's approved leads are recorded as its members, and automatic replies are queued only for them. The organization-wide switch is gone and `crm_settings.human_send_only` is pinned on again (CHECK restored). Switching a run to Automatic is confirmed with its limits; the assistant can only switch runs to Review. |
| Reply check | `src/lib/assistant/replyCheck*.ts` | A model lists the lead's questions and the reply's claims and promises, each with a supporting quote; only quotes found word for word in the profile, documents and earlier answers count. Prices, amounts, percentages, times, days, links and email addresses are checked directly. Result: send, opt-out, or hold with a decision. |
| Owner decisions | `decisions.server.ts`, `owner_decisions`, `/api/assistant/decisions/[id]` | Missing information, complaint, negotiation, commitment, meeting, uncertain: a card in the chat and on Results with the reason and the decision needed. An answer is saved to the always-included knowledge document "Answers you gave the assistant" and the waiting reply is rewritten; or take over; or dismiss. Interested replies and opt-outs are reported too. |
| Opt-out stop | `src/lib/outreach/optOut.ts`, `crm/policies.ts`, `crm/operations.ts` | Do Not Contact from any source (reply check, classification, CRM) suppresses the person and stops their email, WhatsApp and LinkedIn sequences and run membership at once. |
| Send-time guards | `src/lib/crm/autopilot.ts` (pure gate), `assistant/autopilotRun.server.ts` | The gate runs before the check and again inside a per-organization advisory lock: run status and mode, membership, takeover, newer inbound, answered since, draft revision, edits, Do Not Contact / suppression, classification. Limits (3 per conversation — 10 since the handoff follow-up — and 40 per 24 hours) are counted on `autopilot_replies`; one reservation per (draft, revision); provider idempotency key per revision. Pause holds and Resume requeues; Stop is final. |
| Knowledge retrieval fix | `crm/knowledge.ts`, `crm/drafts.ts` | Retrieval required every word of the query and the drafter never searched with the lead's message, so uploaded documents almost never reached a reply. Now any significant word matches (ranked), with the lead's message first. Found by the real-AI test below. |
| Results | `results.ts`, `results.server.ts`, `/assistant/results`, chat `report` tool | Today / yesterday / 7 / 30 days / all time in the organization's time zone, from recorded events: leads found/imported, duplicates, contactable and left out; contacted; sent per channel with LinkedIn requests apart from messages; replies; interested (not a sale); answered automatically or by you; waiting; still to send; stopped/held with reasons; failures; recorded AI spending (`assistant_usage`) apart from estimates; allowances left. Unrecorded figures read "not measured". |
| Daily summary | `dailySummary.server.ts`, `daily_summaries`, daily rollover part (d) | At each organization's new day: the previous day's results posted in the chat and listed on Results. In-app only. |
| Lead search | `src/lib/discovery/geocode*.ts`, `mapsScraper.server.ts`, `linkedinSearch.server.ts` | Maps: the scraper's place-page mode now returns empty fields from Google, so fast mode over up to 9 geocoded circles (Nominatim, `GEOCODER_URL`), at most 20 businesses each. LinkedIn: the existing search engine, when an account is connected. |
| Unsolicited plans | `assistant/agent.ts`, `tools.server.ts` | A plan or "contact afterwards" needs the owner's own words asking for outreach, quoted and checked against their message. |
| Migration | `scripts/add-assistant-automation.ts` | 6 tables, run status `stopped`, job kind `linkedin_search`, run membership backfill, `human_send_only` pinned on. Registered as scoped, in `OWNED_TABLES` and `db/schema.sql`. |

### Checks run (local PostgreSQL 16)

| Check | Result |
| --- | --- |
| `npx tsc --noEmit`, `npx eslint .` | pass (0 errors; the 6 earlier warnings) |
| `npm test` | pass: 992 tests in 120 files |
| `bun run db:check` (scope `--contract`), `db:schema:dump` | pass; `db/schema.sql` regenerated |
| `scripts/e2e/assistant.ts` without AI | 62/62: Review vs Automatic, a supported answer sent once, an invented quote held, owner answer saved and reply rewritten, discount held, opt-out stopping all channels, Do Not Contact from the CRM, pause/resume requeue, edited draft, old revision, takeover, newer message, production guard, 5 concurrent jobs against 2 remaining → exactly 2 sent, restart recovery, duplicate protection, no plan without an owner request, results equal to recorded events, stop, daily summary, a second organization seeing none of it |
| `scripts/e2e/assistant.ts` with real AI | 85/85, including: the agent prepared no plan when the owner only gave information; a price question answered automatically from the uploaded price list (real classifier, drafter and check); an X-ray question held with a focused question to the owner, answered, rewritten and sent |
| `campaign-engines.ts`, `unipile-email.ts` | 25/25, 23/23 |
| `owner-controls.ts` (production server, sends paused) | 36/36 |
| `tenancy-isolation.ts` (dev server) | 104 reads, 33 writes, 63 pages as a second organization; 0 failures; the decisions route probed with organization A's real decision id |
| `bun run build` | pass; the production server idles at about 475 MB (the dev server reached 11–13 GB under Turbopack and was OOM-killed twice) |
| Upgrade path | a Compose database from the pre-assistant release (90 tables): `create-lead-research`, `add-mailbox-provider`, `create-assistant-tables`, `add-assistant-automation` → 103 tables, scope contract passes; the last one re-run is a no-op |
| Browser (Chromium, 1440 px and 390 px) | `/assistant` (decision cards, run modes) and `/assistant/results`: no page errors, no horizontal scroll. Fixed: plurals on Results |

### Follow-up: the chat, after the owner's first real use (2026-10-15)

On the VM, "hey" ran a business-information save with nothing in it
("Remembered: ."), and "do outreach" showed refused searches as red cards
with "Search started…" under each, three times, before one search ran on
the whole USA. Fixed and checked with the real AI in a browser:

- The model's planned tools are checked before anything runs or is shown:
  no tools on a greeting; a business-information save must change
  something and use the owner's own words (messages and documents);
  outreach needs the owner's latest message to ask for it, a "yes" to the
  assistant's offer, or a request in their previous two messages that
  nothing has acted on (so "which cities?" → "Austin" keeps it).
- Calls the server refuses for their arguments are kept for the model and
  hidden from the owner; a message is shown only when every tool in its
  step worked; a turn never repeats a message.
- A lead search of a whole country is refused with the reason; the
  assistant asks for cities (one search per city).
- The chat: a welcome screen with four starting points, the conversation
  menu (greetings no longer name conversations), one readiness indicator,
  the assistant's turns with an avatar, routine results as one quiet line,
  a typing indicator naming the current step, suggested replies, and a
  growing message box with attach, paste and drag-and-drop.

Checks: `npm test` 1003/1003; `assistant.ts` 62/62 without AI and 85/85
with real AI; `campaign-engines.ts` 25/25, `unipile-email.ts` 23/23;
build; browser (1440 and 390 px, no page errors, no horizontal scroll):
"hey\\" → a one-line greeting with suggestions and no card; business
details → one "Saved business information" line; "…in USA and do outreach
on whatsapp" → a question about which cities, no refused cards; "Austin,
Texas" → one real search (48 businesses, 23 with email), whose plan was
refused because WhatsApp is not connected, and the assistant said so.

### Follow-up: choosing cities, contacts in the chat, links (2026-10-15)

From the next screenshots: told "any city where we get most leads", the
assistant asked again and claimed it could search only one city at a time;
a WhatsApp number typed in the chat could not be used without a CSV.

- Left to choose (or given a whole country), it picks the three largest
  cities for that kind of business and starts one search per city at once.
  A country-wide search is refused before it runs; when the map lookup is
  down the search is not started (it would return almost nothing).
- `add_contacts`: phones, emails and LinkedIn links typed in the chat
  become a lead list (People import, numbers normalized); only values the
  owner wrote or a read page shows; without a country code and no Default
  phone country the owner is asked. With "contact them" the plan follows
  automatically.
- `read_webpage`: one public page from a link the owner gave (SSRF-guarded
  fetcher); login-walled networks are refused by name.
- Instagram, Facebook, X and TikTok are not supported, and the assistant
  says so.

Checks: `npm test` 1006/1006; `assistant.ts` 62/62 and 85/85 with real AI;
new `assistant-chat-live.ts` (real model, the owner's own conversations)
passing on four runs after the fixes; `campaign-engines.ts` 25/25,
`unipile-email.ts` 23/23; lint; build.

### Follow-up: the first real WhatsApp message (2026-10-15)

The owner's test reached their own WhatsApp through the VM — the first real
delivery on any channel — but their reply got no visible answer, and the
message read "Hi  team" / "managing  in  is" (blank merge fields).

- Messages use only merge fields every lead of the run has
  (`availableTokens`): a contact typed in the chat or a bare list has no
  company or city, so the writer greets plainly and leaves them out.
- The running plan card lists each reply and what became of it (answered,
  going out at a time, waiting for the owner and why, failed), and the chat
  refreshes every 15 s while a run is live; before, a decision card or an
  answer appeared only after a reload.
- A list of places sent as an array is saved as text instead of failing.
- The reply check no longer counts "not in the list" as an answer.

Not yet known: why the owner's reply got no answer on the VM (still
waiting the 10 minutes, held for a decision, or never delivered by
Unipile). The diagnostic in the chat reply reads the VM's records.

### Follow-up: the assistant sorts the leads itself; better replies (2026-10-15)

Asked: one message for every lead is both good and bad; let the AI decide
per lead whether the standard message fits or a personal one, do most of
it on its own, and reply better in chats. Contacts with no information
must still get the normal message.

- **Sorting** (`writer.server.ts sortLeads`, one call per 25 leads): each
  lead gets a kind ("Dental clinics"), an approach (standard, personal,
  or left out) and a reason, from its known facts only. At most 4 kinds
  (`settleGroups`, the rest share "Other") and 10 personal leads per plan.
  Leads with no facts beyond a name skip sorting and get the standard
  message; nobody is left out for lack of information.
- **Writing:** each kind gets its own sequence per channel, with only the
  merge fields all its leads have; personal leads get a first message
  written for them alone (checked like every template; one that fails
  falls back to its kind's), then their kind's follow-ups. Left-out leads
  are listed with reasons; `prepare_outreach includeSkipped` contacts them
  on request.
- **Sending:** the campaign steps are `{{key_bN}}` / `{{key_sN}}`, and each
  lead's own texts are written to `people.raw` at Start
  (`writeLeadTexts`), so one campaign per channel serves every kind and
  every personal message. No schema change: the plan is jsonb.
- **Plan card:** how the leads were sorted, the left-out list, a sample per
  kind and channel, every personal message; after Start a Leads list with
  each lead's status (`runLeads.ts`: sequence status per channel, CRM
  category) next to Replies.
- **Replies:** the drafter answers first, in the lead's language
  (Hindi/Hinglish included), offers only next steps the knowledge offers
  and never proposes day or time windows. `unbackedRefusal` holds a draft
  that says "no"/"only"/"sirf"/"nahi" without a limit stated in the
  evidence (the X-ray case had been sent as "No, we only…"). A reply held
  only for a proposed time is rewritten once without it and re-checked
  (`autopilotRun.server.ts`).

Checks: `npx tsc --noEmit`, `npx eslint .` (0 errors, the 6 old warnings);
`npm test` 1017/1017 in 122 files; `assistant.ts` 62/62 without AI and
89/89 with real AI on three runs (sorting into kinds, every lead
accounted for, per-lead lines, a Hinglish question answered in Hinglish);
`campaign-engines.ts` and `unipile-email.ts` pass; build; browser on the
production server (sends paused): the sorting summary, the left-out list,
Leads and Replies on the plan card, no page errors.

### Follow-up: replies that sell, and the handoff to a person (2026-10-15)

Asked: the assistant should sell like a salesperson (ask about the lead's
problem, connect it to the product, offer the next step), know when a chat
is finished instead of sending endless messages, and hand interested leads
to a person in one place on the dashboard ("chat needs you", "answer
needed"), telling the lead something while nobody has answered yet.

- **Selling:** the business information gains `problemsSolved` and
  `nextStep` (default: a short call with the sender). The drafter answers
  first, asks at most one question per message (about three per chat),
  connects the lead's need in the owner's words and offers the next step;
  when the lead is ready it asks nothing more.
- **Handoff** (`handoff.ts`, `handoff.server.ts`, `autopilotRun.server.ts`):
  the reply check recognises `ready`, `wants_person` and `acknowledgement`
  (a price question is not "ready"). New decision kinds `ready`, `person`,
  `limit`. A handoff opens a decision with a model-written brief, sends the
  lead one fixed message in the sender's voice and the lead's language
  (English, Hindi, Hinglish; at most one a day per chat; never in Review
  mode, for "uncertain", or outside production), and keeps the autopilot
  quiet in that chat until it is settled. An "ok"/"thanks" after an answer
  gets no reply. The per-chat limit went from 3 to 10 and now ends in a
  handoff instead of silence.
- **Settling:** answering in the card saves the answer and writes a new
  reply (sent once it passes the checks); a person's reply in the chat
  (Action required, Messages, or the phone) settles it and the chat stays
  theirs; Done settles it.
- **Needs you:** at the top of Results (ready to buy first, then the
  longest wait), a banner in the assistant chat, a count next to Results
  in the menu; Review-mode replies are counted with a link to Action
  required. Owners and admins are emailed once (Resend) and reminded once
  after 3 hours (`startHandoffAlerts`, a claim per row so two servers never
  send the same email).
- **Migration:** `scripts/add-handoff.ts` (kinds CHECK, `brief`,
  `handover_sent_at`, `alerted_at`, `reminded_at`, an index); in the
  Dockerfile; `db/schema.sql` regenerated; scope contract passes.

Checks: `npx tsc --noEmit`, `npx eslint .` (0 errors); `npm test`
1026/1026 in 123 files; `assistant.ts` 70/70 without AI (new: a ready lead
told once and listed first, quiet while waiting, the alert email once and
one reminder, the owner's reply settling it, no reply to "ok, thanks", the
10-reply limit handing over); 99/99 with real AI (a real "sounds good,
please call me" became Ready to buy with the brief "wants to set up the
monthly maintenance plan for their 3 chairs, one keeps breaking down;
requested a call", the lead told once; a plain price question was still
answered automatically; the X-ray question handed over, answered by the
owner, and the new reply sent); campaign engines, build; browser on the
production server (sends paused), 1440 and 390 px: Needs you with three
items in the right order, the menu count, the chat banner, no answer box on
a Ready to buy card, no page errors, no horizontal scroll.

Changed after a review of this work: a reminder counts from the first
email (not from when the lead wrote), handoffs older than three days are
not emailed after an upgrade, and only handoffs the lead is told about keep
a chat quiet (an out-of-office "Take a look" does not).

### Follow-up: WhatsApp replies that got no answer — found and fixed (2026-10-16)

`scripts/diagnose-whatsapp-replies.ts` (read-only, run in the VM's app
container) showed the owner's replies ("Hey", "Yeah thats cool") reached
the server, the lead and the CRM, in a running Automatic run, and stopped
there: each classification was **proposed** (the classifier was unsure, or
filed it as "other", which always needs review), and the CRM drafts only
after a classification is applied. So no draft, no autopilot, no decision:
a silent dead end. Fixed: for an active lead of an assistant run, an
unconfirmed classification still gets a draft (`handlers.ts`), and the
autopilot gate lets the support check decide instead of stopping; it still
hands over customers, "left the company" / "different contact", and
rejected or failed classifications, and holds out-of-office replies.
Checks: unit 1027/1027; `assistant.ts` 71/71 (new: an unsure "Hey" gets a
draft and is answered).

### Follow-up: automatic replies without an artificial wait (2026-10-16)

Removed the fixed ten-minute wait before checking and sending a ready
automatic reply. New drafts and drafts requeued after Resume are immediately
eligible for the CRM worker; AI processing and provider delivery still take
time. The plan card and confirmation now describe that behavior. Existing
jobs retain their stored due time until they run or are requeued. Open
handoffs in Needs you still wait for the owner; removing the timer does not
settle them.

Checks: full TypeScript check passed; exercised the real enqueue function
with a transaction stand-in and confirmed WhatsApp, email and LinkedIn jobs
are due immediately. Review, pause, opt-out, newer-message and owner-handoff
holds still pass their checks. No live messages were sent.

### Follow-up: normal conversations before an owner handoff (2026-10-16)

Code review found that the writer saw the thread but the reply checker saw
only the latest message. Greetings and ambiguous references could become
missing-information decisions, and unsupported additions in the draft went
straight to a handoff. The existing time-only repair also relied on
requeuing an auto_send job while that same job was still running, so its
rewritten draft could be left without another check.

The writer now stores a bounded conversation snapshot with its request
metadata and the checker receives that same context. Greeting handling
keeps factual checks, while a real question asking the lead to clarify
their needs can continue the conversation. Unsupported draft additions get
one rewrite followed by an immediate check of the new revision in the same
job. Genuine missing business answers, complaints, requests for a person,
opt-outs, limits and explicit buying decisions retain their existing rules.
No schema migration or extra conversation query is needed.

Validation: full TypeScript check passed; 39 focused tests passed (11 new
conversation regressions plus existing draft, classification and instruction
tests). Four checks of the actual autopilot runner with mocked persistence
and model/provider boundaries passed: repaired revision sent once without a
handoff; unsuccessful repair attempted only once and not sent; a newer
inbound during repair stopped the old answer; pausing during repair held
the send. These are local checks, not a live model-quality evaluation.
Existing handoffs are not automatically closed. The VM diagnostic now prints
the stored reason, kind and owner question, so the screenshot's exact
historical handoff can be checked on the server.

### Follow-up: the assistant never goes quiet (2026-10-16)

On the VM a WhatsApp "Hey" got "Waiting for you: you are handling this
conversation yourself" and an "Interested lead" card. The owner had pressed
nothing: `settlePersonReplies` created a takeover on its own whenever a
message went out from the business number after a handoff (the owner had
typed in WhatsApp on the business phone), the Needs you "Done" button did
the same, the autopilot stayed quiet while any handoff was open, and an
unconfirmed "interested" classification was reported as interest. The owner
wants the assistant to answer everything and only be told.

Changed: no automatic takeover (only "I'll reply myself" creates one);
"Done" settles the card and nothing else; a new **Let the assistant reply**
button (`POST /api/assistant/conversations/[id]/release`) removes a takeover
and queues the waiting answer at once; the "waits for you" gate is gone, so
the assistant keeps answering while a lead is in Needs you (one card per
chat and kind, the handover said once; a ready lead who writes again is
answered when the reply passes the ordinary checks); `isBareGreeting`
(code, not prompt) keeps a bare "Hey"/"ok" from being applied as
interested, and interest is reported only from a confirmed classification;
the per-chat limit is 30 (a loop safety net). `scripts/add-handoff.ts`
deletes the takeovers the old code created, so the stuck chats answer again
after the update. Checks: unit 284 (crm + assistant) and the deterministic
`assistant.ts` suite below; not yet run against the real AI or the VM.

### Follow-up: the reply agent, one loop instead of a pipeline (2026-10-16)

The owner saw slow or missing answers ("Hey bro" marked "No answer
needed", no answer at all on some days). The old path made three to four
model calls in a row (classify, draft, check, sometimes a repair) with
queue hops between them, and decided with word lists and special cases.
The model was never the slow part: on AI/ML API Gemini 3.5 Flash Lite
answered in about 0.9 s and GLM 5.3 Flash in about 4.6 s (median of five
probe calls each).

The **reply agent** (`src/lib/assistant/replyAgent/`) replaces that path for
leads of a running assistant outreach run, from the CRM's classification
job, so it starts the moment the message is stored:

- **One model call per message.** The agent gets the business information,
  the owner's instructions and next step, the lead's facts and the whole
  conversation, and returns one of four actions: reply, tell the owner,
  stop contact, or no reply. A reply can carry a note for the owner (ready,
  wants a person, complaint, a question the information does not answer),
  which becomes a Needs you card while the lead still gets an answer.
- **A harness, not rules in prompts.** The harness checks a reply only for
  what must never go out: an amount, day, time or link not in the
  business information, a placeholder, talk about instructions, a claim
  that something was already done. A problem is handed back to the agent
  with what to fix, up to three turns. After that, or when the model is
  down, the lead gets an honest holding line (at most once a day per chat)
  and the owner a card.
- **Hard rules stay in code:** Do Not Contact, suppression, the run not
  running, "I'll reply myself", a newer message (that one is answered with
  the whole conversation), already answered, 30 per chat and 40 per day,
  read again under the organization's lock before the send. Sends use the
  same path as Approve & send. Review mode only drafts.
- **Every step is recorded** in `reply_agent_runs` (unique per message, so a
  retried job never answers twice): each turn with its time and problems,
  the outcome, and the time from the message arriving to the answer. The
  Replies list shows it ("Answered automatically in 4.2 s").
- The dashboard refreshes every 4 s while a run is live (was 15 s), and
  Needs you every 10 s (was 30 s).

Explicit opt-outs, leads outside a running run, and chats the owner took
over still go through the classifier as before. `REPLY_AGENT=off` in the
environment returns everything to the old path. The table is created by
`scripts/add-handoff.ts`.

Checks: unit 1,246 (all), the new `scripts/e2e/reply-agent.ts` (23 checks:
greeting, price from the information, an invented price fixed on the second
turn, holding line after three unbacked turns, ready lead, stop, an
acknowledgement, Review mode, retry, newer message, takeover, outsider,
model outage, the Replies list) and the existing `assistant.ts` suite
(73 checks). **Not run against the real model:** the AI key saved locally
now returns 401 and no other key was available in this session. The real
run is on the VM.

### Follow-up: first messages people answer, and Autonomous mode (2026-10-16)

**Pitch.** The first WhatsApp the owner saw go out opened two sentences
with "Listen", listed five services in one sentence and greeted "Sold By
Tereza Inc.". The cause was in the writer: the owner's style ("open
casual, like 'listen'") was applied word for word to both the per-lead
line and the message, which were written apart, and the greeting used the
listing's legal name. Now (`src/lib/assistant/pitch.ts`, `writer.server.ts`):

- business names in greetings drop the legal form ("Inc.", "LLC",
  "Pvt. Ltd.") and a listing's tagline, keeping words that belong to the
  name ("The Cleaning Company", "Smith & Co");
- every message is checked for shapes busy readers skip: a word opening
  two sentences, a list of more than three things, a first message longer
  than one phone screen (WhatsApp 260 characters of its own text, lead's
  line at most 120). A problem goes back to the writer with what to fix,
  up to two rewrites, then its best version is kept (a pitch problem never
  stops a plan);
- the writer is told how a cold first message earns a reply (one problem
  that kind of business has, what the owner does about exactly that, one
  easy question) and that the owner's style is a tone, not a script;
- a second model reads each first message as a busy owner of that kind of
  business and, when it would likely be ignored, the messages are
  rewritten once with its reasons;
- each lead's line is written seeing the message it goes in front of and
  may not open or repeat like it; reused messages that fail the checks are
  written afresh.

**Autonomous mode** (`src/lib/assistant/autonomy*.ts`): a switch in the
chat header. Only an owner or admin can turn it on (anyone can turn it
off). While on, plans the assistant prepares start on their own through
the same `startOutreachRun` as the Start button, in Automatic mode,
approved in the name of the person who turned it on (checked again at each
start); it does not ask "want me to…?"; a turn may take 16 steps; a
finished search (also an empty or failed one) wakes it to continue, and a
"find and contact" request stands for the work that follows. New caps,
per organization in Settings → Organization (the "general" Sending rules):
plans started on their own a day (10), leads in them a day (300), searches
a day (20). A plan past a cap, or with leads already in another running
plan, waits for Start and the chat says why. Every channel's sending
limits, Do Not Contact, opt-outs and the reply agent's checks still apply.
Columns `assistant_threads.autonomous/_by/_at` come from
`scripts/add-handoff.ts`.

Checks: unit 1,259 (all), `scripts/e2e/autonomous.ts` (16 checks: off,
on, owner's name, same launch job, no double start, busy leads, both
caps, uncounted waiting plans, demoted approver, search count, off again),
`reply-agent.ts` (23) and `assistant.ts` (73). The writer's new prompt and
reviewer were not run against a real model here (no working AI key in
this session).

### Follow-up: social media search through Apify, beta (2026-10-16)

The owner asked for lead search where the leads are, on Facebook,
LinkedIn and Instagram profiles, not only Instagram hashtags. Built on the
existing Apify integration (the same approvals, monthly budget, per-run
cap, 2 open runs, durable `apify_runs` and partial results). It adds three
Actors, each runnable only once an owner ticks it:
`apify~facebook-search-scraper` (business pages with published phone,
email, website), `apify~instagram-search-scraper` (Instagram's own account
search, then the Profile Scraper) and `harvestapi~linkedin-company-search`
(companies with their website). The assistant tool is
`find_social_leads(platform, what, where, …)`. It works with "and contact
them" and with Autonomous mode, and counts toward the daily search cap.

- Every lead's website is read for contacts; nobody is messaged on
  Facebook or Instagram, so a page without a published email or phone is
  excluded with the reason.
- **Risk the owner accepts by approving it:** the LinkedIn Actor reads
  LinkedIn without logging in, which LinkedIn's User Agreement does not
  allow. Its approval card says so.
- Input fields come from each Actor's published input schema. Output
  fields are read defensively.
- **Not run against real Apify:** only against the stand-in in
  `scripts/e2e/apify.ts`. Its new checks: the refusal before approval,
  each Actor's input, the Facebook page and LinkedIn company contacted by
  the email their websites publish, the Instagram search, and the
  isolation checks.

Checks: unit 1,271 (all), `scripts/e2e/apify.ts` all passed, tsc and lint
clean.

### Follow-up: Treg tools, beta (2026-10-16)

The owner asked for a source where they can add their Treg API key, used
when it is available. Treg (treg.to) is one prepaid key for thousands of
paid data APIs (email find and verify, enrichment, Maps and web search,
social profiles). Code: `src/lib/treg/`, `src/services/treg.ts`. The
feature is the optional **Treg tools** switch, plus a **Treg** card in
Settings → Organization.

- **The key:** checked with Treg (`GET /auth/me`) before it is saved,
  stored encrypted and never shown again. The card shows its team name
  and a hint.
- **The tools:** the assistant has `treg_search` (Treg's public catalog,
  free) and `treg_call`. A call uses a catalog id only, never a URL. Its
  price and method come from Treg's own catalog page, not from the model.
- **Spending:** a call is refused if its endpoint has no published price,
  costs more than $0.25 a call, or would pass the daily cap (default $2,
  last 24 hours).
  - Each call is recorded in `treg_calls` before it is made, under the
    organization's advisory lock. Its ceiling counts as reserved, so two
    calls cannot both take the last of the cap.
  - The ceiling (what is left of the cap, at most $0.25) is also sent as
    `X-Treg-Route-Max-Cost`. Treg refuses a call above it and charges
    nothing. That is the hard limit for per-result prices, whose real
    cost depends on the rows returned.
  - The cost recorded is the `X-Treg-Cost-Micro` Treg reports. Every
    call has an Idempotency-Key.
  - A call whose outcome is unknown (the connection dropped) keeps its
    ceiling counted.
- **Contacts:** emails and phones in a successful answer may be added
  with `add_contacts`.
- **Top-ups:** AgentSDR never tops up Treg. An empty balance (402) is
  reported in the chat.
- **Migration:** the tables `treg_settings` and `treg_calls`, and the
  `'treg'` feature key, are in `scripts/add-instagram-intake-discovery.ts`,
  which the update steps already run.

Not run against the real Treg: only against the stand-in in
`scripts/e2e/treg.ts` (35 checks). The protocol was read from
https://treg.to/llms.txt on 2026-10-16.

Checks: unit 1,273 (all), `scripts/e2e/treg.ts` all passed, tenancy
isolation (114 reads, 39 writes, 67 pages as a second organization, no
findings), `check-organization-scope --contract` passed, tsc and lint
clean.

### Live services vs stand-ins

- **Live, real services:** gosom/google-maps-scraper v1.18.1 against Google
  Maps (fast mode), OpenStreetMap Nominatim, the businesses' own websites and
  their DNS (MX). "dental clinics" in Baner, Pune: 32 businesses, 30
  contactable, 16 with an email from their own website (each with its
  source page), 2 left out with the reason. AI/ML API for the agent,
  classifier, drafter and reply check (a few cents).
- **Stand-ins:** Unipile (fetch intercepted for a fake host; this sandbox
  cannot reach Unipile), Gmail (a recording sender), inbound replies
  (injected through the same ingest path the webhooks use), the scraper in
  `assistant.ts`.
- **Not verified by anyone yet:** delivery to a real inbox, WhatsApp or
  LinkedIn account; a real reply arriving; automatic replies on a production
  server with real providers; the daily summary at a real day boundary on
  the VM. No channel is marked ready.

### Defects found and fixed in this session

- Uploaded documents rarely reached replies (retrieval, above); the
  real-AI price question was held until it was fixed.
- One Automatic run could have made unrelated conversations automatic (the
  organization-wide switch); now per run.
- Maps place-page mode returned empty businesses; switched to fast mode.
- "We run Bright Path" counted as an outreach request; the words run, start
  and market no longer do.
- Switch to Automatic took effect without confirmation; now confirmed with
  its limits.
- Links and email addresses in a reply were not checked directly; now they
  must appear in the saved information.

### Blockers, and what resolves each

- **VM not updated:** this sandbox has no SSH access to it. Run the steps in
  OWNER_SETUP §1 on the VM (pull the branch, `up -d --build`, the four
  migrations, then check `/assistant/results` loads).
- **No real send or reply on any channel:** Unipile's API is not reachable
  from this sandbox, and no test recipients were designated. Run OWNER_SETUP
  §6 (channels, then "The assistant, live") on the VM with recipients you
  control.
- **Credentials shared in earlier chats** (AI/ML key, Unipile key, the Google
  service-account JSON) should be rotated and entered only in the server's
  settings.

### Known limitations

- Maps coverage: at most about 180 businesses per search, in Google's
  order; against Google's Terms of Service; may be blocked.
- The reply check is English-pattern based for amounts, times and days.
- The automatic-reply limits (10 per conversation, 40 per 24
  hours) are constants (`AUTOPILOT_LIMITS`), deliberately not yet Sending
  rules while the system is being verified.

## Session 4: the owner's assistant (AI lead hunting and outreach)

Asked for: an owner chat that performs real actions (business information,
documents, contact lists, lead search, outreach, launch, pause, report),
lead discovery without CSV from a self-hosted open-source source, automatic
personalized outreach on the existing campaign engines after one approval,
and routine replies handled automatically. The request message was cut off
after "Keep campaigns and"; the rest is still to come.

**State: implemented and checked locally; not verified live.** No message
was sent to anyone. The scraper, Unipile and the businesses' websites were
stand-ins; AI calls were real (AI/ML API, a few cents).

### What was built

| Part | Where | What it does |
| --- | --- | --- |
| Chat agent | `src/lib/assistant/agent*.ts`, `tools.server.ts`, `/assistant`, `/api/assistant/*` | The model answers with a message and tools to run (strict JSON schema). Tools: check_setup, save_business_info, search_knowledge, find_leads, lead_search_status, list/describe_audiences, prepare_outreach, list_runs, report, pause/resume_outreach, turn_off_autopilot. Each runs an existing service and is stored as a card with its real result. A message sent with tools is shown after they run and dropped if one fails; a reply claiming an action without a successful tool is rejected and retried; a question to the owner ends the turn. Starting outreach is not a tool. |
| Memory | `assistant_profiles`, CRM knowledge | Business profile (offer, customers, places, sender, preferences) saved from the chat and mirrored into a knowledge document that every AI draft reads. |
| Documents | `documents.server.ts` | PDF (unpdf), DOCX (mammoth), TXT/MD into knowledge; clear errors for scans (no OCR), passwords, `.doc`, over 10 MB. |
| Lists | `ingest.server.ts`, `importPeopleRows` | CSV/XLSX through the existing People import, into a lead list with the channels each lead can be reached on, or the reason it cannot. |
| Lead search | `src/lib/discovery/`, `docker-compose.discovery.yml` | Google Maps via self-hosted gosom/google-maps-scraper, then each business's own website (SSRF-guarded, 1.5 MB / 10 s / 3 redirects / 3 contact pages). Contacts keep their source page; MX check; E.164 phones; dedupe; closed and unreachable businesses kept as "left out" with the reason. A background job with stages, resumed after restarts. |
| Outreach | `outreach.server.ts`, `writer.server.ts`, `messages.ts` | A plan per lead list: channel per lead from what is connected and preferred, sequences written once per channel from the profile and knowledge (checked for placeholders, unknown merge fields, false claims, channel limits; signed with the sender's name), one opening line per lead from its public facts, samples, limits, duration and AI cost. Start (owner only) personalizes in batches and creates and activates the existing email / WhatsApp / LinkedIn campaigns under their own launch rules. |
| Reply autopilot | `src/lib/crm/autopilot*.ts`, `crm_jobs` kind `auto_send` | Off by default; owners/admins turn it on. Ten minutes after a draft is ready, sends it for confidently classified interested / not-interested replies; holds everything else for a person, with the reason recorded. 3 per conversation, 40 per day, production only, idempotent per draft revision. |
| Migration | `scripts/create-assistant-tables.ts` | 7 tables (registered as scoped, in `OWNED_TABLES` and `db/schema.sql`); `crm_jobs` checks allow `auto_send`; drops the CHECK that pinned `human_send_only` on. |

### Checks run

| Check | Result |
| --- | --- |
| `npx tsc --noEmit`, `npx eslint .` | pass (0 errors; 6 earlier warnings) |
| `npm test` | pass (34 new tests: contacts, Maps CSV, messages and sign-off, agent parsing and claim guard, profile, channels, autopilot policy, PDF/DOCX/TXT extraction) |
| `bun run db:check`, scope `--contract` | pass |
| `scripts/e2e/assistant.ts` without AI | pass: tools, documents, list import with a bad row, SSRF refusal, search of 7 listings → 3 contactable (2 email, 1 phone), 3 left out with reasons, 1 duplicate, failed and empty searches, outreach refused without AI |
| `scripts/e2e/assistant.ts` with real AI | pass: the agent saved the owner's details (tool call), started a search marked "contact afterwards", the plan was prepared when it finished and waited for Start; samples signed and without unfilled fields; Start wrote a valid line per lead and activated the email campaign; an inbound reply was classified and drafted by the CRM worker and the autopilot held it (non-production), then sent it through the stand-in Unipile once with the guard lifted, and not again |
| Browser (Chromium, desktop and 390 px) | the full chat flow: list import with its error row, saved info, search progress, plan card with samples; no page errors, no horizontal scroll. It found five defects, all fixed: unsigned sample emails, raw ids/JSON in tool cards, the post-search plan left to the model, the owner's message shown twice while working, "1 rows" / "$0.00" |
| `tenancy-isolation.ts` against `bun run dev` | pass: 103 reads, 32 writes, 62 pages as a second organization (the assistant routes and page included), 0 failures, 0 to review |
| `campaign-engines.ts`, `unipile-email.ts` | pass (25 and 23 checks) |
| `bun run build` | pass |

### Known limitations

- **Google Maps scraping is against Google's Terms of Service** and may be
  blocked; it only finds businesses with a public listing.
- **Model compliance varies.** With Gemini 3.5 Flash Lite the assistant
  sometimes offers outreach the owner did not ask for, or checks a search's
  progress needlessly. The guards in code (no false claims, no starting,
  plans prepared by the server after a "find and contact" search) do not
  depend on that.
- **The claim guard is English-pattern based**, like the draft checks.
- **LinkedIn lead search** (the existing Unipile search, hidden in this
  release) is not wired into the assistant; LinkedIn reaches only leads with
  a profile URL from a list or a company page found on a website.
- **Not verified live:** the real scraper against Google, real websites,
  real sends and the autopilot on a production server.

## Session 3: the complete messaging workflow

Asked for: imports through campaigns, scheduled sends, replies stopping
follow-ups, AI classification and reviewable drafts, approved sending, CRM
history and stage; plus web research for imported companies, a usable and
simplified interface, live verification and this handoff. Calling, image
generation, automatic AI sending, billing, the central admin panel and
scraping stayed out.

### Implemented (commits)

| Commit | What |
| --- | --- |
| `8531f38` | **Imports.** Every lead importer reads cells as text (`readTextSheet`): leading zeros survive (`09876543210`, zip `00123`), XLSX numbers are no longer `9.19877E+11`, and every error carries its real file row. `checkPhone` normalizes with the organization's Default phone country and says why a number is unusable (no country code, invalid for the country, too short or long). People import accepts phone-only rows as WhatsApp contacts; a bad phone on an identified row is a warning instead of a silent drop. Upload checks (empty, over 10 MB, not a spreadsheet) with a sentence, client-side too; the proxy body limit is raised to 26 MB so no route is truncated silently. |
| `f5f9e32` | **Campaign launch rules on the server and send races.** Email launch/resume is refused (409, every reason listed) unless Google Workspace and a mailbox are connected, the sequence is complete, and a lead can still receive it; sequences are validated and renumbered on save, and activating rebuilds the day's queue so a mid-day launch starts today within the remaining allowance. LinkedIn: Unipile connected and a valid sequence; WhatsApp: Unipile connected; only workable leads count. Engines: the email tick respects the daily limit and no longer overwrites a reply that lands mid-send; LinkedIn follow-ups re-check the lead and campaign before each claim and cannot overwrite REPLIED; WhatsApp claims re-check that the campaign is active. **Bug found and fixed:** a failed database write after a successful WhatsApp send was treated as a failed send, deleting the claim and retrying (a duplicate message). Size limits on every lead upload route. |
| `97b9a97` | **AI drafts.** The prompt carries the real sender (mailbox display name and signature, LinkedIn profile, WhatsApp number, organization) and `completedActions` (messages sent, stage moves recorded). A draft that claims a booked meeting, a sent invitation or document, or an attachment without that record, leaves a placeholder such as `[Your Name]`, or talks about its own prompt or limits is rejected and retried with the reason; one that still fails is stored as failed with the reason, never offered for review. CRM email replies carry the mailbox display name. |
| `b1e99a0` | **Web research** (Leads → Companies → row menu → Research company): see below. |
| `0d136b6` | **Release scope and reply-sync readiness.** `src/lib/release.ts` hides calling (call campaigns, Call buttons, call history, recorder extension, R2 recordings), image AI columns, LinkedIn lead search, Tables and Prospecting from navigation, settings and buttons; code and data stay. Gmail watch registration is stored and shown on the Email connection card, and now registers when a mailbox connects or Google settings are saved (it used to wait for the next daily rollover, so a new setup missed replies until the next day). Getting Started: Email is "Connected" only once Gmail is watching; a new **Incoming replies** step stays "To do" until a real reply has arrived on each connected channel. |
| `86c1886` | **Found during the browser owner checks:** People import dropped custom columns (now kept on the person, as merge fields); `Favourite Café` became `{{favouriteCaf}}` (accents now folded); Approve & send with no provider showed "CRM configuration request failed" and left the draft looking ready (now a 409 "Not sent: <reason>" and the record re-reads); consistent page titles. |
| `07d77b8` | A refused send reads "The reply was not sent"; research answers are shown as plain text. |
| `27cf8dc` | The Docker image ships `scripts/create-lead-research.ts` for upgrading installs. |

### Follow-up: email through Unipile (no domain needed)

Asked for after the owner reported having no domain: let the Gmail account
linked in Unipile be a sending mailbox. Google Workspace stays the other
option; each mailbox uses its own.

- **Mailboxes:** `outreach_mailboxes.provider` (`google` | `unipile`) and
  `unipile_account_id` (unique across organizations, a provider identity);
  migration `scripts/add-mailbox-provider.ts`, also shipped in the Docker
  image. **Email → Accounts → Sync from Unipile** makes every email inbox
  linked in the organization's Unipile workspace (Gmail OAuth, Outlook,
  iCloud, Exchange, IMAP) a mailbox, refreshes status (Unipile's
  `CREDENTIALS`/`PERMISSIONS`/`STOPPED` become "failed" with the reason),
  marks inboxes no longer linked as failed (never deleted), and refuses an
  address another organization holds. A new account linked through hosted
  auth syncs the same way. "Test again" re-reads the account from Unipile.
- **Sending** (`src/lib/outreach/mailboxProviders.ts`): one dispatcher used
  by the campaign tick, CRM replies and the test send.
  `POST /api/v1/emails` with the account, recipients, subject and HTML body
  (signature and unsubscribe link included). The scheduler checks each
  mailbox's own provider, so a Unipile-only workspace sends and one without
  Google is no longer skipped as a whole. Follow-ups with a blank subject
  and CRM replies go as `reply_to` the earlier email; a 4xx on that target
  resends without it (nothing was sent on a 4xx). Provider ids are stored
  prefixed with the account (`gmail_message_id` is unique across all
  mailboxes; an IMAP provider's ids need not be).
- **Replies:** a third Unipile webhook, `/api/webhooks/unipile-email`
  (`mail_received`), public in `proxy.ts` and held to the same gate as the
  messaging webhook (`org=` + secret, account must be this organization's
  mailbox). It records the delivery in the webhook ledger, answers 200, then
  files the email through the same `ingestGmailReply` as Gmail: bounces,
  Master Inbox, CRM, and the lead's follow-ups stop. A delivery without its
  body is read in full from Unipile. Sync registers the webhook if the
  organization's registration predates it.
- **Launch rules and readiness:** launch needs one connected mailbox whose
  provider is connected (either one). The email pages unlock with Google or
  Unipile. Getting started: Email is "Connected" for Unipile once a
  Unipile mailbox exists and the email webhook is registered (no Gmail
  topic needed). The Email connection page shows both options.

Checks: `tsc` pass; lint 0 errors (6 baseline warnings); **915 tests pass /
111 files** (new: mappers, stored ids, reply target, launch and readiness
rules, webhook registration); `db:check` pass; `campaign-engines.ts` 25/25;
the new `scripts/e2e/unipile-email.ts` **22/22** against a stand-in Unipile
API (global `fetch` intercepted for a fake host, nothing sent): sync of four
accounts, campaign send through the real dispatcher with the unsubscribe
link, follow-up as `reply_to` the first, the webhook refusing a wrong
secret and dropping a foreign account and non-`mail_received` events, a
reply stopping the follow-ups through the real CRM ingestion, no duplicate
on redelivery, a body-less delivery fetched in full, a CRM reply as
`reply_to` the lead's email, and the 404 fallback. That run found one real
issue (provider ids colliding on the global unique index), fixed above.
A review pass added two more: a refused Unipile send is now reported as
"Unipile refused the email (HTTP 4xx): reason" and counts as not sent
(the SDK's error had an empty message and hid the status), and Sync only
re-registers webhooks for owners and admins. `bun run build` passes.

Browser (production build, Chromium, 1440 px and 390 px, the test owner's
workspace, no horizontal overflow anywhere): with no email provider, the
campaign and Email accounts pages show "Connect Google Workspace or Unipile
to use this" with both buttons; with a stand-in Unipile connection and one
Unipile mailbox, Email accounts shows **Sync from Unipile** and the mailbox
"via Unipile", the campaigns page opens, Getting started shows Email
Connected, and Sync against the unreachable stand-in host shows "Could not
sync from Unipile: … fetch failed". The stand-ins were removed afterwards.

**Not verified live.** This sandbox cannot reach the owner's Unipile DSN
(port 17056 is refused by its egress proxy), so no real Unipile call was
made. Unverified until the first live run (OWNER_SETUP §6): that Unipile
accepts these exact requests, the `provider_id` it returns, the webhook
payload's field names, and its error body's `status` (the 4xx fallback reads
it).

### Web research

- **What it is:** a question about one company already in Leads (overview,
  website, parent company, or your own question), answered from public web
  pages by a search model, saved with the source URLs and cost
  (`lead_research`). **It is not lead discovery and not social-media
  scraping**; the modal and settings say so.
- **Provider format, checked live and against AI/ML API's per-model
  schemas (13 Oct 2026):** chat completions with
  `web_search_options: { search_context_size }`. Sources come back as
  Perplexity's top-level `citations` / `search_results`, or as
  `url_citation` annotations. 240 catalog models carry the `web_search`
  tag; of three probed, `perplexity/sonar` returned 9–10 real sources,
  `google/gemini-flash-latest` returned an empty answer, and
  `openai/gpt-5.4-mini` answered "according to web search results" with no
  sources at all.
- **No fabricated citations:** only provider-returned URLs count; URLs in
  the answer text are ignored. An answer, or a "not found", without any
  source is stored as **failed**, never as a finding.
- **Bounds:** one call per run, one retry only for 429/5xx (never after a
  timeout), 60 s deadline, 800 output tokens, low search context, and a
  per-organization daily limit (default 25, failed runs count).
- **Settings:** Settings → AI provider → step 4. The research model is
  separate from the default model and must be an enabled AI/ML model marked
  Web search. OpenRouter connections keep research off in this release.
- **Upgrade:** a fresh database gets the table from `db/schema.sql`; an
  existing one runs `bun scripts/create-lead-research.ts` once.

### Checks run (all on a disposable local PostgreSQL 16)

| Check | Result |
| --- | --- |
| `bunx tsc --noEmit` | pass |
| `bun run lint` | 0 errors; the 6 baseline warnings, all in untouched LinkedIn files |
| `npm test` | **892 pass / 110 files** (was 819 / 103); new tests for every fix above |
| `bun run build` | pass (≈2.7 min), three times through the session |
| `bun run db:check` | pass (`lead_research` classified scoped) |
| `scripts/e2e/owner-controls.ts` against `bun run start` | **36/36 pass**, including launch refusal with every reason, sequence validation, phone-only import, refusal of a PDF upload, and member 403s |
| `scripts/e2e/tenancy-isolation.ts` against `bun run dev` | **pass:** 102 reads, 25 writes, 61 pages as a second organization, 0 failures, 0 items to review (covers the new research routes) |
| `scripts/e2e/campaign-engines.ts` (new) | **all 25 checks pass** (17 email, 8 WhatsApp). Email: daily allowance, send gap, mid-day rebuild grants nothing extra, daily limit, reply via the real CRM ingestion stops the follow-up, a reply landing mid-send is kept, pause/resume, an existing claim is never re-sent, 4 sends recorded. WhatsApp: launch refused without Unipile, one first message per number per tick, pause/resume, a reply stops the enrollment, an existing claim advances instead of re-sending. Sends went to a recording stand-in, not a provider |
| `scripts/e2e/ai-live-crm.ts` with `AI_LIVE_INLINE_WORKER=1` | **pass**, real AI/ML calls through the app's CRM worker (`google/gemini-3.5-flash-lite`): two replies asking for an invite and pricing were classified `interested` and drafted. One draft is signed "Asha Rao" from the mailbox, one has no name and no placeholder, neither claims anything was sent, nothing was sent. The first run exposed a draft leaking "completedActions" to the prospect; the prompt and a leak check were fixed and the rerun was clean |
| `scripts/e2e/research-live.ts` (new) | **pass**, real AI/ML calls: Sonar answered the parent-company question about stripe.com with 10 sources ($0.0068); the no-source model was refused and nothing was saved as a finding |
| Docker build override | The fork's image built from the repository (≈3 min) and contains `lead_research` in its schema and the Research UI. The rebuild after `27cf8dc` (one added `COPY` line) was blocked by Docker Hub's anonymous pull limit (429); the migration was run inside the built image instead and reported `lead_research present`. Sandbox note as before: the build used a scratch Dockerfile that only adds this sandbox's proxy CA |
| Browser sweep (Playwright, Chromium) at 1440 px and 390 px | 13 pages × 2 widths: all 200, **no horizontal overflow**, consistent titles, simplified navigation. The only console errors are Google favicon 404s for the fake test domains |

### The nine owner checks (OWNER_SETUP §5), run in a browser

Browser checks were authorized for this task. They ran against the local
production build, signed in as the test owner of a disposable workspace.

| # | Check | Result |
| --- | --- | --- |
| 1 | Branding | **Pass.** Sign-in, sidebar (expanded and collapsed), mobile header and menu, light and dark: "22nd X AI Outreach", tile favicon (`/icon.svg`) and Apple icon. Your own visual sign-off on your server is still worth doing |
| 2 | Getting started matches reality | **Pass.** Channels Not configured (true: no credentials), AI ready via AI/ML API, Incoming replies Not configured |
| 3 | CSV and XLSX import | **Pass after fixes.** CSV: 2 created, the in-file duplicate updated the same person, failures at file rows 6 and 7 (the blank line counted), accents intact, phone-only row created; same file again: 0 created, 3 updated. XLSX: leading-zero phone kept as typed, `919876543210` normalized, zips `00123`/`04567`. Custom columns were being dropped; fixed and rechecked |
| 4 | Draft email campaign, merge fields, rules | **Pass, with a local stand-in Google row** (email pages require a connected Google Workspace; the stand-in could not authenticate and was removed). Name → spreadsheet upload with column mapping → sequence → review: Launch disabled, and the server refused launch with "Connect at least one sending mailbox". Preview rendered `{{firstName}}`, `{{jobTitle}}`, `{{company}}`, `{{zip}}` = `00123`; `{{favouriteCafe}}` was empty because of the accent bug, fixed. Sending rules: 30 a day, 18–24 min gaps, Mon–Fri 09:00–18:00 IST |
| 5 | Real send to yourself | **Blocked:** no channel credentials and no designated test recipients |
| 6 | Reply in Action required, follow-ups stop | **Blocked live.** Shown locally only with a recording stand-in and real CRM ingestion (`campaign-engines.ts`), which is not proof of delivery or reply sync |
| 7 | Review, edit and send an AI draft | **Review and edit pass** on a real AI/ML draft; Save works. **Send** was refused visibly ("The reply was not sent — Google Workspace is not connected") with the attempt recorded as failed; after the fix the page says so clearly. A real send is blocked on credentials |
| 8 | Restart and persistence | **Pass** (local production server, not a container): after a stop, rebuild and start, the session, 17 people, 3 email campaigns, the failed draft, the research rows, AI settings and sending rules were all unchanged |
| 9 | Phone width (390 px) | **Pass:** Getting started, Leads, import modal, research modal, campaigns, Action required, CRM record, Settings: no horizontal overflow |

### Live channel evidence

**None.** No send or receive was attempted on any provider. For every
channel, these remain not run: delivery, a real reply in the right
workspace, follow-ups stopping, AI classification and a reviewable draft
for that reply, sending an approved response, CRM history and stage, and
pause/resume with persistence after a restart.

| Channel | Needs | State |
| --- | --- | --- |
| Email (Unipile) | The Unipile connection, the Gmail inbox linked in Unipile synced as a mailbox, the email webhook registered; public HTTPS; a test inbox you control | Built and checked against a stand-in; not run live |
| Email (Google Workspace) | Service account with domain-wide delegation (needs a Workspace domain, which the owner does not have) + mailbox + Gmail Pub/Sub topic and push subscription; public HTTPS | Not configured |
| LinkedIn | Unipile DSN and key, a linked test account, a second profile you control; public HTTPS | Not configured |
| WhatsApp | Unipile, a linked test number, a second number you control; public HTTPS | Not configured |
| AI | AI/ML API key (stored) | Working: classification, drafts and research verified live |

### Blockers, and exactly what resolves them

1. **No server or public HTTPS address.** Provide a VM with SSH access and
   a domain; then follow OWNER_SETUP §1 (Docker with the build override)
   and §1 "Going live".
2. **Channel credentials.** The owner has a Unipile workspace with a
   Gmail inbox, a LinkedIn account and a WhatsApp number linked; the key
   was shared in a chat, so **rotate it** and enter the new one only in the
   app. It could not be used from this sandbox (port 17056 unreachable).
   A Google service account was also shared; its token check passed, but
   without a Workspace domain it cannot send (domain-wide delegation), and
   the Pub/Sub API is off in its project. Use email through Unipile, and
   **rotate that service-account key** too (delete it in Google Cloud →
   IAM → Service accounts → Keys).
3. **No designated test recipients.** An inbox, a second LinkedIn profile
   and a second WhatsApp number that you control. Nothing is sent to
   anyone else.
4. **Resend** (optional): `RESEND_API_KEY` and `AUTH_EMAIL_FROM`, before
   inviting anyone.
5. **Rotate the AI/ML API key** that was pasted into a chat, and enter the
   new one under Settings → AI provider.

Then run OWNER_SETUP §6 for each channel and record the results here.

### Known limitations of this session's work

- **Draft checks are pattern-based.** They catch the common false claims
  ("I've booked…", "I sent the invite", "please find attached") and
  placeholders in English. An unusual phrasing can slip through, so review
  stays mandatory, and an ordinary sentence can occasionally be rejected and
  retried.
- **The daily research limit** is checked before the call, so two
  simultaneous runs at the limit can both proceed (at most one over).
- **Gmail reply sync proof.** The stored watch result proves Gmail accepted
  the watch, not that pushes reach the server. "Incoming replies" turns done
  only on a real reply.
- **Email pages need Google Workspace or Unipile connected** even to
  draft (the existing `RequiresPlatform` convention); LinkedIn and WhatsApp
  pages need Unipile.
- **Email through Unipile:** no `List-Unsubscribe` header (link in the body
  only); the sender name comes from the inbox, not the app's display name;
  a personal Gmail has Google's own daily limits and suspension risk; Getting
  started judges a mixed setup (Google and Unipile mailboxes) by the Google
  rules only.
- **Hidden, not removed:** calling pages, Tables and Prospecting still
  answer at their URLs; WhatsApp analytics can still list call campaigns
  that already exist.
- **LinkedIn "sent today"** still counts from the server's midnight, not the
  organization's.
- **CRM record pages** have the generic tab title.

Session 1's own checks, evidence and defect list follow, unchanged except
where this session fixed something.

# Session 1 status

## Completed PRD requirements

| ID | State | Evidence |
| --- | --- | --- |
| S1-01 Branding | Done in code. Visual check pending | `src/lib/brand.ts` is the single source. It covers the app shell, sidebar, mobile header, auth pages, page titles, auth email, favicon and Apple icon. The page title `22nd X AI Outreach` was seen on `/setup` (dev, production build and Docker). The owner's manual visual check is still pending. |
| S1-02 Spreadsheet import | Done | `xlsx` now comes from the vendored official tarball, 0.20.3, which fixes CVE-2023-30533 and CVE-2024-22363 (`vendor/README.md`). Every importer reads through `src/lib/spreadsheet/read.ts`. The tests cover CSV, XLSX, UTF-8, Windows-1252, empty and corrupt files, duplicates, custom fields and row numbers. API runs covered CSV, XLSX and PNG (see below). |
| S1-03 First-owner setup and persistence | Done | `/setup` on an empty database worked from source and in the Docker image (fresh PostgreSQL 18). After an app-container restart, sign-in, a changed sending rule, a paused campaign and 4 people (UTF-8 intact) were all still there. |
| S1-04 Getting Started | Done | `/getting-started` computes readiness from saved state. The rules are unit-tested (19 tests). It is authenticated (anonymous visitors are sent to `/sign-in`) and organization-scoped, and the isolation run covered it. |
| S1-05 Integration status | Done | The statuses are Not configured / Not yet verified / Needs attention / Connected. "Connected" also requires the inbound half (a Gmail Pub/Sub topic; registered Unipile webhooks). No secrets are read or shown. |
| S1-06 Owner controls | Done (API). UI pending | `scripts/e2e/owner-controls.ts` passed 32/32 checks. A member got 403 on sending rules, integrations, Unipile disconnect and webhooks, AI settings, invites and role changes, while the owner's probes reached validation (400). |
| S1-07 Outreach workflow | Partly verified | Over the API: import, campaign create → active → paused → active → paused, and delete. Sending, receiving a reply and reviewing a draft need a live channel and AI, so they are **pending live verification**. |
| S1-08 Defects found and fixed | Done for what was found | See "Defects fixed". |
| S1-09 Reproducible run and handoff | Done, with one sandbox caveat | `bun run build` passes. The Docker image built and ran with the override, but see "Docker build in this sandbox". OWNER_SETUP.md and this file are written. |

## Checks

| Check | Baseline (`bdbf5ef`) | After Session 1 |
| --- | --- | --- |
| `bun install --frozen-lockfile` | clean | clean (the lockfile now points at `vendor/xlsx-0.20.3.tgz`) |
| `bun run typecheck` | pass (~60 s, no heap flag needed) | pass |
| `bun run lint` | 0 errors, 6 warnings | 0 errors, the same 6 warnings, all in untouched files |
| `bun run test` | 765 pass / 100 files | 801 pass / 102 files |
| `bun run build` | not run at baseline | pass (~2.5 min) |
| `bun run db:check` | pass (fresh database) | pass |
| `scripts/e2e/tenancy-isolation.ts` | — | pass: 101 reads, 12 writes and 61 pages as organization B, 0 failures and 0 items to review (after the 404 fix below) |
| `scripts/e2e/owner-controls.ts` (new) | — | 32/32 pass |

Notes on these checks:

- **Build warnings.** The build prints 2 Turbopack "Module not found:
  Can't resolve <dynamic>" warnings. Both come from
  `src/lib/grid/runners/sandbox.ts`, the Tables formula sandbox, which this
  session did not touch. The same warnings appear in `bun run dev`.
- **Lint after a build.** A `bun run lint` run after `bun run build` used to
  add 22 warnings from the gitignored `extensions/whatsapp-recorder/dist`.
  It is now ignored, like `.next`.
- **Isolation runs against `bun run dev`.** Run against `bun run start`,
  Better Auth's production rate limiter answers the script's rapid sign-ins
  with 429, so the script has to run against the dev server.

## Import and permission evidence

All of this was run against a disposable local database:

- **People import, CSV.** The file had a UTF-8 accent and a Devanagari name,
  a blank line, an in-file duplicate differing only by case, and an invalid
  email. The import created 2 people and updated 1. The invalid row was
  reported as **row 5**, its real row in the file. Re-importing created 0
  and updated 3. Names stayed intact (`José`, `राज शर्मा`), and a blank cell
  did not erase an existing title.
- **People import, XLSX.** 2 created, and `skippedNoIdentity: 1` for a row
  with neither an Email nor a LinkedIn URL. That row used to be dropped
  without any report.
- **Unreadable files.** A PNG uploaded as a spreadsheet now gets a 400 with
  "Could not read that file. Upload a CSV or an Excel workbook (.xlsx)." That
  holds for People, email-campaign preview and import, and the LinkedIn
  uploads. The email-campaign preview used to throw a 500.
- **Without a session**, the import API returns 401 and pages redirect to
  sign-in.
- **The owner-controls script** checks:
  - member and owner role enforcement;
  - that an invited address can sign up on an invite-only instance;
  - that a member still has normal product access;
  - that a member sees "Only an owner or admin…" on integration steps.

## Defects fixed

1. **Vulnerable `xlsx` 0.18.5.** It was replaced with the official 0.20.3
   tarball, vendored, and the Docker deps stage now copies `vendor/`. A test
   fails if a release older than 0.20.2 comes back.
2. **UTF-8 CSV turned into mojibake** (pre-existing in 0.18.5 too). The
   People, Calling contacts, LinkedIn campaign, LinkedIn search and WhatsApp
   importers read BOM-less UTF-8 as Latin-1, so "José" became "JosÃ©". The
   old proof: the probe in this session showed the same output from 0.18.5
   and 0.20.3 before the fix.
3. **Row numbers in import errors were wrong** after blank or filtered rows
   (People, Calling, email campaigns).
4. **The invite-only sign-in page mailed `pulkit@kandid.ai`** (the upstream
   maintainer) to ask for "AgentSDR Managed" access. It now uses
   `BRAND.accessRequestEmail`, which is null by default, so no link is shown.
5. **`PATCH /api/outreach/campaigns/:id` stored any status string.** There is
   no CHECK constraint, so a bad value hid the campaign from every filter.
   Unknown statuses now get a 400.
6. **Cross-organization ids returned 200 instead of 404** on `DELETE
   /api/outreach/campaigns/:id`, `…/merge-fields` and `…/leads`. Nothing
   leaked or changed, but DELETE claimed success. These were found by the
   isolation script.
7. **The People import dropped rows without an identity silently.** It now
   reports how many.

## Docker build in this sandbox

The committed `Dockerfile` changed only by adding `COPY vendor ./vendor` to
the deps stage.

In this cloud sandbox, outbound HTTPS from build containers passes through
a TLS-intercepting proxy, so `apk add` and `bun install` inside the build
failed certificate checks. The image (`agentsdr:local`) was therefore built
from a **scratch copy** of the Dockerfile. That copy only added the proxy's
CA after each `FROM`, passed in as a BuildKit build context; nothing about
it is committed.

`docker compose -f docker-compose.yml -f docker-compose.build.yml up -d
--no-build` then ran that image. On a normal host,
`docker compose -f docker-compose.yml -f docker-compose.build.yml up -d
--build` should work unchanged; that is an inference, not tested on the
owner's machine.

## Manual owner checks

Pending at the end of Session 1 (no browser automation was run then).
Session 3 ran them; see "The nine owner checks" above.

## Live channel evidence

None yet. Google Workspace, Unipile, OpenRouter and Resend were not
configured in this session, and the server had no public HTTPS address.
Every channel is "Not configured" in Getting started, which matches reality.

## Missing to reach Owner-usable

1. A public HTTPS domain for the server (`APP_URL`), behind a reverse proxy.
2. At least one channel:
   - **Google Workspace:** service account with domain-wide delegation, plus
     a Gmail Pub/Sub topic and push subscription;
   - **or Unipile:** start the 7-day trial after the steps above, and link
     2–3 test accounts.
3. OpenRouter keys and a BYOK provider, for reply sorting and drafts.
4. Resend (`RESEND_API_KEY`, `AUTH_EMAIL_FROM`) before inviting anyone.
5. A controlled send to the owner, a reply, and confirmation that follow-ups
   stopped (OWNER_SETUP §5, items 5–7).

## Exact start and rebuild commands

See OWNER_SETUP §1 (Docker Compose with `docker-compose.build.yml`) and §2
(from source). In short:

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

## Known issues not fixed (deliberately left for later)

- ~~**CSV numbers are inferred.**~~ Fixed in Session 3 (`8531f38`): cells
  are read as text, and an unusable phone is reported with the reason.
- **Duplicate rows in one file.** For a person repeated within one People
  import, the last non-empty value wins.
- ~~**Launch is guarded only in the UI.**~~ Fixed in Session 3 (`f5f9e32`).
- ~~**No explicit file-size limit**~~ on the lead uploads. Fixed in Session 3
  (`8531f38`, `f5f9e32`).
- **Upstream names left in place:**
  - The Call Recorder extension is still named and drawn as AgentSDR.
  - The demo-only copy says "Self-host AgentSDR".
  - The Help menu links to upstream docs (docs.agentsdr.ai) and upstream
    GitHub issues (`src/lib/support.ts`).
- **`next start` warns about `output: standalone`** on the source route. It
  still serves; Docker uses `server.js`.

## Commits (on top of `bdbf5ef`)

- `3273a5f` Spreadsheet import: SheetJS 0.20.3 and UTF-8 CSV that stays UTF-8
- `caa6329` Brand the product as 22nd X AI Outreach
- `046ee96` Getting Started: a readiness checklist over the existing setup
- `e2180fa` Email campaigns: another organization's id is a 404 on three routes
- `6e0c55c` Lint: ignore the recorder extension's build output
- `fe9fc9c` Getting Started: use the settings' own page names; link Sending rules
- the documentation commit that adds `docs/product/`

## Follow-up: AI/ML API as a second AI provider

Requested after Session 1: add AI/ML API to AI Settings with encrypted
per-organization credentials, adapt the runtime, verification and model
selection, drop OpenRouter's management-key/BYOK/routing requirements for
AI/ML connections, teach Getting Started about it, and test reply
classification and drafting with a structured-output model.

What was built (design notes in `src/lib/ai/README.md`):

- **One active provider per organization**, chosen in Settings → AI
  provider (OpenRouter or AI/ML API). The OpenRouter panel is unchanged; the
  AI/ML panel is key → models → default.
- **Credentials:** an AI/ML connection is the existing encrypted
  `grid_providers` / `grid_provider_credentials` pair, organization-scoped,
  holding only `apiKey`. It is verified with `GET /v1/key` (free; 401 on a bad
  key). The public model list cannot verify a key.
- **Runtime:** `getAiRuntime` (was `getOpenRouterRuntime`) applies a pure
  gate, `runtimePlan.ts`. OpenRouter keeps strict provider routing, the
  BYOK-only confirmation and function-call answers. AI/ML needs no
  confirmation and answers through strict `response_format: json_schema`;
  strict mode is dropped only for a user-written column schema that strict
  mode would reject.
- **Model selection:** only AI/ML chat models tagged `structured_output` in
  its live catalog are offered (319 of 932 catalog entries on 13 Oct 2026).
  They are revalidated on save, and a default is required.
- **Refused clearly with AI/ML**, rather than half-working:
  - call transcription (your separate compatibility check is still to do);
  - web-research and image AI columns in Tables, and the qualification
    parent lookup (all need OpenRouter's web plugin or image endpoint).
    Company web research in Leads uses AI/ML's search models since
    Session 3.
- **Getting Started** shows "Ready: <model> through AI/ML API" with no BYOK
  or routing step.

Evidence (local disposable database, production build, real AI/ML calls):

- **Probes against AI/ML:** strict JSON schema with the real CRM classifier
  and draft schemas succeeded on these three models:
  - `openai/gpt-4o-mini`
  - `google/gemini-3.5-flash-lite`
  - `anthropic/claude-haiku-latest`

  `mistralai/mistral-small-2603` returned 429 "rate-limited upstream"; the
  retry loop treats that as transient.
- **API checks:**
  - A bad key gets a 400 ("AI/ML API rejected this key"), and an
    OpenRouter-only credential field gets a 400.
  - The real key verified and was stored encrypted; the plaintext key
    appears in no database row.
- **Settings save rules:** each of these got a 400:
  - transcription switched on;
  - a model without structured output;
  - an OpenRouter provider slug on an AI/ML connection;
  - no default model.

  A valid save stored `byokOnlyConfirmed: false`.
- **Live CRM pipeline** (`scripts/e2e/ai-live-crm.ts`): an inbound reply
  went through the running server's CRM worker. It was classified
  `interested` (0.95, auto-applied) and a draft was written that waits for
  review, with no send attempt. This passed with both
  `openai/gpt-4o-mini` and `google/gemini-3.5-flash-lite`. The stored
  request shows strict JSON schema with no tools or routing.
- **Tables AI column through the real runner:** a content cell completed; a
  web-research cell was refused up front.
- **Permissions** (`scripts/e2e/owner-controls.ts`): all checks pass. A
  member gets 403 on adding an AI/ML key and on changing AI settings; the
  owner's probes reach input validation.
- **Repository checks:** typecheck passes, lint shows the 6 baseline
  warnings, tests are 819 pass / 103 files, and `bun run build` passes.
- **Isolation** (`tenancy-isolation.ts`): no failures, with organization A's
  AI/ML connection among the fingerprints. Its 96 "review" items were
  HTTP 500 pages from the dev server, whose Turbopack-generated CSS was
  corrupted in this sandbox (`globals.css:3840`, garbage bytes); the source
  file is unchanged and the production build compiles it. Replayed as
  organization B against the production server, those 96 requests returned
  no 5xx and nothing of A's. Probed directly as B, A's AI/ML connection id
  gives a 409 when reading its catalog, a refused save (nothing stored)
  when set in AI settings, and a 404 on delete.

Open points:

- ~~**Draft wording.**~~ Drafts promised actions not taken and once left
  `[Your Name]`. Fixed in Session 3 (`97b9a97`): sender details are filled
  in and ungrounded claims, placeholders and prompt leaks are rejected.
- **Call transcription with AI/ML API:** not attempted, as requested. It is
  refused in code and in the settings save until checked.
- **The test key was pasted into a chat:** rotate it in the AI/ML API
  dashboard and re-enter it.

## Session 2: deliberately deferred

None of this entered Session 1:

- a platform admin console;
- an operator role and client lifecycle;
- per-client limits and budgets;
- central Unipile onboarding;
- an audit trail;
- scraping or sourcing automation;
- new email or DM adapters;
- automatic AI sending;
- billing;
- multiple app replicas.

Suggested Session 2 order (PRD §7):

1. Pass Session 1 acceptance: the owner checks plus one live channel.
2. Define server-enforced operator permissions and suspension semantics.
3. Add schema changes through re-runnable TypeScript migrations, plus the
   tenancy registry.
4. Build operator-only APIs, then the admin UI.
5. Central Unipile onboarding with per-client scoping.
6. Enforce suspension and limits in workers.
7. Audit records.

Before building on it, also consider moving the email-campaign launch checks
server-side and adding upload size limits.
