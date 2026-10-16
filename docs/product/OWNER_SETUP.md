# Owner setup: 22nd X AI Outreach

How to run this build, connect its providers and check it works. Scope: the
owner's own copy of AgentSDR ([ravi3594444/AgentSDR](https://github.com/ravi3594444/AgentSDR)),
the messaging release (Sessions 1–3 of [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md)).
The upstream guides in `docs/` still apply; this page says what is specific
to this build and in which order to do things. Progress and evidence are in
[SESSION_STATUS.md](SESSION_STATUS.md).

**Status: implemented, pending live verification.** Everything below the
live checks (§6) has been verified on a local copy; no real message has
been sent or received yet.

## What this release includes

- **In:** Leads import (CSV/XLSX, phone-only WhatsApp contacts), company web
  research, email / LinkedIn / WhatsApp campaigns with server-enforced
  launch rules and sending rules, reply sync, AI classification and drafts
  that wait for your approval (or, for an outreach run started in Automatic
  mode, are answered automatically when your saved information backs the
  answer, §3b), Action required and the CRM.
- **The assistant** (the first page, `/assistant`): you tell it about your
  business in a chat, attach documents (PDF, Word, text) and contact lists
  (CSV, Excel), and ask it to "find suitable leads and contact them" or "use
  this list and run outreach". It searches, imports, writes the messages and
  shows a plan; **nothing is sent until you press Start on that plan**. It
  creates and manages the campaigns and sequences itself, asks you when a
  lead asks something your information does not answer, and reports results
  in the chat, on the Results page and in a daily summary. See §3b.
- **Email without a domain:** email can send through Google Workspace *or*
  through an inbox linked in Unipile (a personal Gmail, Outlook, iCloud or
  IMAP account). Each mailbox uses its own; see §3.
- **Hidden for this release** (`src/lib/release.ts`; code and data kept):
  WhatsApp calling, call recordings and the recorder extension, image AI
  columns, the standalone LinkedIn Search page, Tables and Prospecting. (The
  assistant uses the same LinkedIn search engine when a LinkedIn account is
  connected, §3b.) Do not set up Cloudflare R2, Deepgram, Twilio,
  AssemblyAI or Bland for this release.

Never paste secrets into this repository, this file or a chat. They go in the
server's `.env` (or `.env.local` from source) or in the app's own settings,
which store them encrypted.

## 0. Get the code onto `main`

This release was developed on the branch `claude/new-session-g5hljn`, not on
`main`. `CLAUDE.md` says every push to `main` triggers a deployment, so merge
the branch into `main` when you are ready for that (on GitHub: open a pull
request from the branch and merge it, or merge locally and push).

## 1. Run it with Docker Compose (recommended)

Plain `docker compose up -d` runs the **published upstream image**, which has
none of this build's changes. Always add the build override.

Prerequisites: a Linux VM with Docker and Compose. A planning estimate for a
starter server is 2 vCPU, 8 GB RAM and 60 GB SSD. That is not a published
minimum, and no GPU is needed.

**Memory is set by the build, not by running the app.** `bun run build`
peaked at about 6.4 GB of total memory when measured in this project's
sandbox (the running server was a few hundred MB). On Google Cloud that
means **e2-standard-2** (2 vCPU, 8 GB). An **e2-medium** (2 vCPU, 4 GB)
will likely run out of memory building the image; use it only with 4–8 GB
of swap, or build the image elsewhere and pull it. Reserve a static
external IP so a DNS name (DuckDNS works) keeps pointing at the VM, and
open ports 80 and 443 for the reverse proxy in "Going live".

```bash
git clone https://github.com/ravi3594444/AgentSDR.git 22nd-x-ai-outreach
cd 22nd-x-ai-outreach

# Secrets for Compose, written once. Refuses to overwrite an existing .env.
umask 077
if [ -e .env ]; then echo "An .env already exists; keep it." >&2; else
  { printf '%s\n' 'APP_URL=http://localhost:3000' 'AUTH_SIGNUP=invite-only'
    for n in BETTER_AUTH_SECRET INTEGRATION_CREDENTIALS_KEY UNSUBSCRIBE_SECRET POSTGRES_PASSWORD; do
      printf '%s=%s\n' "$n" "$(openssl rand -hex 32)"; done; } > .env
fi

docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
docker compose -f docker-compose.yml -f docker-compose.build.yml ps
docker compose -f docker-compose.yml -f docker-compose.build.yml logs --tail=80 app
```

Then open `http://localhost:3000`. On an empty database the app creates its
schema itself, and `/setup` creates the first owner and workspace. After
setup it lands on **Getting started**.

Rules that matter:

- **Back up `INTEGRATION_CREDENTIALS_KEY`** together with the database (the
  `db-data` volume). Without it every saved integration must be reconnected.
  `docker compose down -v` deletes the database volume; plain `down` does not.
- **Run one app container.** It runs the senders and schedulers in-process.
  Do not add a second replica or an external cron calling the same ticks.
- **Do not set `DEMO_MODE`** on this database, and do not seed demo data into it.
- **To rebuild after pulling changes:** run the same `up -d --build` command.
  `bun run db:setup` is for empty databases only and is never an upgrade.
- **Upgrading a database created before this release:** run these two
  migrations once (a fresh database already has both; each is safe to run
  again):
  `docker compose -f docker-compose.yml -f docker-compose.build.yml exec app agentsdr-entrypoint bun scripts/create-lead-research.ts`
  and the same with `scripts/add-mailbox-provider.ts` (from source:
  `bun scripts/create-lead-research.ts` and `bun scripts/add-mailbox-provider.ts`).
  Until the first runs, Research says so; until the second runs, the email
  pages fail to load. The assistant needs two more, in this order:
  `scripts/create-assistant-tables.ts`, then
  `scripts/add-assistant-automation.ts` (same command); until they run, the
  assistant and Results pages fail to load. The second also switches off the
  old organization-wide reply autopilot for good (automatic replies are now
  chosen per outreach run, §3b). The handoff (Needs you, §3b) needs one
  more, `scripts/add-handoff.ts` (same command); until it runs, replies that
  need a person fail to be handed over and the Results page fails to load.
- **Lead search (optional):** add `-f docker-compose.discovery.yml` to every
  compose command (or put
  `COMPOSE_FILE=docker-compose.yml:docker-compose.build.yml:docker-compose.discovery.yml`
  in `.env` and drop the `-f` flags). It starts the Google Maps scraper next
  to the app. Read §3b first.

### Going live (public HTTPS address)

Unipile webhooks and Gmail push notifications cannot reach `localhost`.

1. Point a domain at the server and put a reverse proxy (Caddy, nginx,
   Traefik) in front of port 3000 that terminates TLS.
2. In `.env`, set `APP_URL=https://your-domain` (no trailing slash).
3. Recreate the app container:
   `docker compose -f docker-compose.yml -f docker-compose.build.yml up -d`.
4. In the app, open **Settings → LinkedIn → Connection** and **save the
   Unipile connection again**. Webhook registration is skipped on a local
   address, and saving at the public address registers them.

With DuckDNS: create the subdomain, point it at the VM's static IP, and use
Caddy as the reverse proxy; a two-line `Caddyfile`
(`yourname.duckdns.org {` / `reverse_proxy localhost:3000` / `}`) gets and
renews the Let's Encrypt certificate itself. `APP_URL` is then
`https://yourname.duckdns.org`.

Details: `docs/self-hosting/production.mdx`.

### Invitation email (Resend)

Before inviting anyone, set `RESEND_API_KEY` and `AUTH_EMAIL_FROM` in `.env`
(for example `22nd X AI Outreach <auth@your-verified-domain>`) and recreate the
app container. Without them, invitation, verification and password-reset
emails are only written to the app log. Creating the first owner needs none of
this. Guide: `docs/integrations/resend.mdx`.

## 2. Alternative: run from source

Needs Bun, Node.js 20.9+ and PostgreSQL 16+.

```bash
bun install --frozen-lockfile
createdb agentsdr_dev                 # with your existing PostgreSQL role
cp .env.example .env.local            # then edit: DATABASE_URL, DATABASE_SSL=disable for a local DB,
                                      # BETTER_AUTH_URL, BETTER_AUTH_SECRET, INTEGRATION_CREDENTIALS_KEY,
                                      # UNSUBSCRIBE_SECRET (openssl rand -hex 32 for each secret)
bun run db:setup                      # empty database only
bun run dev                           # UI work; does NOT run the production senders
```

To exercise real sending from source, use `bun run build` then `bun run start`.
`next start` prints a warning about `output: standalone`, but it serves the app.
The source route reads `BETTER_AUTH_URL`; Compose reads `APP_URL`.

## 3. Connect providers (follow Getting started)

**Getting started** (the sidebar entry beside Settings) shows each step's
state from what is saved. **Connected** means that the saved credentials passed
their live check and an account is linked. It is not proof that a message was
delivered.

| Step | Where | What you need | Guide |
| --- | --- | --- | --- |
| Email, option A: **Unipile** (no domain needed) | Settings → Email → Connection (the Unipile card; the same connection as LinkedIn and WhatsApp), then Email → Accounts → **Sync from Unipile** | A Gmail, Outlook, iCloud or IMAP inbox **linked in the Unipile dashboard** (Accounts → connect an email account). Sync makes each linked inbox a mailbox and, if needed, registers Unipile's **email webhook**, which is how replies arrive (it needs the public HTTPS address; on `localhost` it is skipped). Getting started says **Connected** once a Unipile mailbox exists and the email webhook is registered. Read the limits under "Email through Unipile" below. | `docs/integrations/unipile.mdx` |
| Email, option B: **Google Workspace** (your own domain) | Settings → Email → Connection, then Mailboxes → Add mailbox | Google Workspace service account with domain-wide delegation. For replies to stop follow-ups you also need a **Gmail Pub/Sub topic** (saved on the same card; `gmail-api-push@system.gserviceaccount.com` must be allowed to publish to it) and a push subscription to `https://your-domain/api/outreach/webhooks/gmail-watch`. The card then shows **Reply sync: Gmail watching N mailboxes**; the watch registers when you save and when a mailbox connects, and renews daily. Give each mailbox a **display name**: replies and AI drafts are signed with it. A personal Gmail cannot be used this way (domain-wide delegation needs a Workspace domain); use option A for it. | `docs/integrations/google-workspace.mdx`, `docs/integrations/gmail-reply-sync.mdx` |
| LinkedIn | Settings → LinkedIn → Connection, then Accounts | A Unipile workspace (API key and DSN). LinkedIn profiles link through Unipile's hosted sign-in. | `docs/integrations/unipile.mdx` |
| WhatsApp | Settings → WhatsApp → Integrations, then Numbers | The same Unipile connection (no R2 in this release). Link the number **in the Unipile dashboard** (scan the QR code there), then press **Sync from Unipile**. New numbers start no new chats for 24 h. | `docs/whatsapp/accounts.mdx` |
| AI | Settings → AI provider | Pick **one** provider for the whole workspace. **AI/ML API** (verified in this release): one key (aimlapi.com → Keys), then select structured-output models and a default; no management key, BYOK or routing step. For **company web research**, also tick **Perplexity Sonar** in step 2 and choose it as the research model in step 4, with a daily run limit (default 25). **OpenRouter**: an inference key and a management key, at least one BYOK provider, a default model and the shared-capacity confirmation; research stays off with it in this release. Drafts wait for your review either way, unless the reply autopilot (§3b) is on. | `src/lib/ai/README.md`, `docs/workspace/ai-provider.mdx`, `docs/integrations/openrouter.mdx` |
| Sending rules | Settings → Email / LinkedIn / WhatsApp → Sending rules | Owner or admin only. | `docs/workspace/sending-rules.mdx` |
| Phone default | Settings → Organization (General) → Default phone country | Set it if your lists have local numbers without `+` (for example `09876543210`). Without it, imports report those rows with the reason instead of guessing a country. | `docs/workspace/organizations.mdx` |
| Knowledge and instructions | Settings → AI → Knowledge, Instructions | Your company description, offer and scheduling details: drafts may only state what is there or in the conversation. | `docs/crm/` |

**AI/ML API key hygiene.** The key is checked with AI/ML API and stored
encrypted for your organization only; it is never shown again in the app.
A key that has been pasted into a chat, ticket or document should be rotated
in the AI/ML API dashboard and re-entered under Settings → AI provider.

To check AI end to end after setup (it spends a little real usage and never
sends anything), against a local copy of the database:
`ORGANIZATION_ID=<id> AI_LIVE_INLINE_WORKER=1 bun run --conditions=react-server scripts/e2e/ai-live-crm.ts`.

After you save Unipile, its dashboard lists three webhooks named
**22nd X AI · …** (connections, messages, and email replies). Upstream docs
call them "AgentSDR · …"; only the label changed, and they are still matched
by URL. A workspace that saved Unipile before email support gets the email
webhook on its next **Sync from Unipile** (or **Register again** on the
LinkedIn connection page).

### Email through Unipile: what to know first

- **Sending cold email from a personal Gmail risks that Gmail account.**
  Google limits a personal account to roughly 500 recipients a day and may
  suspend one that sends unsolicited mail or collects bounces and spam
  reports. Keep the mailbox's daily limit low (the default is 30), warm the
  address up, and send only to people you may lawfully contact. Unipile
  does not change any of this; it sends as that account.
- **No `List-Unsubscribe` header.** Google Workspace sends add it; this
  build does not set it on Unipile sends (Unipile does not document passing
  that header through), so these emails carry the unsubscribe link in the
  body only. Gmail and Outlook weigh the header, so expect somewhat lower
  deliverability.
- **The sender name** is the one set on the inbox itself (in Gmail:
  Settings → Accounts → Send mail as), not the mailbox's display name in
  this app. Set the display name here anyway: AI drafts are signed with it.
- **Threading:** a follow-up with a blank subject, and a reply from the
  CRM, are sent as replies to the earlier email through Unipile's
  `reply_to`. If Unipile no longer knows that email, the message is sent on
  its own (with "Re:" in the subject) rather than not at all.
- **Not verified live yet** (see SESSION_STATUS). The request shapes follow
  Unipile's API reference and SDK, and a stand-in check passes, but the
  first real send and reply on your server are the proof (§6).

**The Unipile trial is seven days.** Finish everything else (the local checks,
imports and campaign drafts) before starting it, then use the trial to verify
the LinkedIn/WhatsApp accounts you actually plan to run. After the trial,
connected-channel access needs a paid Unipile subscription.

## 3b. The assistant, lead search, automatic replies and results

**Who sets up what.** The operator (whoever runs the server) sets up
hosting, the AI provider (Settings → AI provider) and the optional lead
search services (the Maps scraper overlay and `GEOCODER_URL`, below). The
owner connects the sending accounts (Settings → Email / LinkedIn /
WhatsApp → Connection), tells the assistant about the business and approves
plans. The strip at the top of the assistant says what is missing and who
sets it up.

**What the owner does:** use the Assistant page. Tell it what the business
sells, to whom, where, and who signs the messages, which problems the offer
solves, and what an interested lead should be offered next (a call, a
visit, a quote; a short call with you when you say nothing); attach brochures or
price lists; then either ask it to find leads and contact them, or attach a
contact list and ask it to run outreach. It answers with a **plan card**:
the leads, the channel each gets, how it sorted them (below), a sample per
kind of lead and channel with real lead details filled in, every message
written for one lead, the daily limits, how long it takes and the
estimated AI cost. **Start outreach** on that card is the only thing that
sends, and the server refuses a start that did not come from that button.
The assistant creates and manages the campaigns and sequences; you do not
need the campaign pages for ordinary outreach. It prepares a plan only when
you ask for outreach in your own words: a question, or saving information
about the business, never creates one.

**How the assistant sorts the leads.** Before writing, a model reads what
is known about each lead (category, title, company, website, rating,
review count, a list's own columns) and decides three things on its own:

- **What kind of lead it is** ("Dental clinics", "Hospitals"). Each kind,
  at most 4 per plan (smaller ones share "Other"), gets its own first
  message and follow-ups, written for that kind.
- **Standard or individual.** Most leads get their kind's message with
  one opening line about them. A few, where the facts show something
  specific worth mentioning, get a first message written for them alone
  (at most 10 per plan, so you can read every one on the card); their
  follow-ups are their kind's.
- **Left out.** A lead that clearly does not fit your offer (a hospital
  chain when you sell to single-doctor clinics) is not contacted. The card
  lists each one with the reason; say "include the left-out leads" for a
  new plan that contacts them too.

Contacts with nothing known about them but a name and a number or address
(a number typed in the chat, a bare list) skip the sorting: they all get
the standard message, with merge fields limited to what every one of them
has. Nobody is left out for lack of information. Each lead's own texts are
stored on that lead at Start, so one campaign per channel still sends
every kind and every individual message.

**Each lead's progress.** After Start the plan card lists the run's leads
with where each is: waiting to send, first message or follow-up sent,
LinkedIn invitation sent or accepted, all messages sent with no reply,
replied (with the CRM category, such as Interested), unsubscribed or
asked not to be contacted, bounced or could not send (with the reason).
Below it, **Replies** shows every reply from the run's leads and what
happened to it: answered automatically, answered, an answer written and
the time it goes out, waiting for you (with the reason), or failed (with
the reason).

**Reply mode, chosen at Start.** The plan card shows two choices and what
each does:

- **Automatic replies** (owners and admins): a reply from one of this run's
  leads is answered automatically when your saved information backs the
  answer. Each automatic reply is checked and sent **as soon as its draft is
  ready**, with no artificial wait; at most **10 per conversation** (then a person takes over) and
  **40 per organization in any 24 hours**; only from a production server.
- **Review**: every reply waits for you in Action required.

The mode belongs to that run's leads only. Starting an Automatic run never
makes replies automatic for anyone else, and there is no organization-wide
switch any more. The card's Switch to Review / Switch to Automatic changes
it (switching to Automatic is confirmed first, with the limits); the
assistant itself can only switch a run to Review. Anything that widens what
you approved — new leads, another channel, another list — comes back as a
new plan to Start ("send the same to this list" reuses the approved
messages).

**Pause, Resume, Stop, takeover.** Pause holds the run's campaign sends and
its queued automatic replies. Resume restarts the same campaigns in the
run's original mode; every send still passes the engines' current checks
(account connected and not restricted, daily limits, sending hours, Do Not
Contact). Stop ends the run for good: its campaigns are closed, its leads
stop and no automatic reply is sent for them afterwards. "I'll reply
myself" on a decision takes the conversation over: the autopilot does not
reply there again. Editing a draft, or answering the lead yourself, holds
that reply for you to send.

**The reply agent answers each message in one step.** For a lead of a
running assistant run, one model call reads the message with your business
information, your instructions and next step, what is known about the lead
and the whole conversation, and decides: reply, tell you, stop contacting
them, or no reply needed. A reply can carry a note for you (ready to buy,
wants a person, a complaint, a question your information does not answer):
the lead still gets an answer and you get a card in Needs you. Before
anything goes out, the app checks the reply for an amount, day, time or
link your information does not contain, a placeholder, or a claim that
something was already sent or booked; a problem is handed back to the agent
to fix, up to three tries. If it still cannot answer without guessing, or
the AI provider is down, the lead gets a short holding line ("Thanks! Let
me check on that and get back to you shortly", at most once a day per chat)
and you get a card. The Replies list shows what happened and how long the
answer took. Opt-out messages, leads outside a running run, and chats you
took over with **I'll reply myself** still go through the older steps
described below. Setting `REPLY_AGENT=off` in the server environment
switches the agent off.

**Which model answers.** The model you choose as the default in Settings →
AI provider answers every reply. Measured on AI/ML API with five short
replies each: Gemini 3.5 Flash Lite answered in about 0.9 s, GLM 5.3 Flash
in about 4.6 s (slowest 6.4 s) with sensible decisions. Both are in the
AI/ML catalog with structured output. A faster model gives faster answers;
the rest of the path adds about one to two seconds.

**What is checked immediately before an automatic reply is sent:** the run
is still running and Automatic and the lead still in it; nobody took over;
no newer message came from the lead; the draft is the revision that was
queued and nobody edited it; the person is not Do Not Contact or
suppressed; the limits, counted under a per-organization lock so jobs
running at the same time cannot overshoot them; and the reply is backed by
your saved information (business profile, documents, your earlier
answers). A model lists the lead's questions and the reply's claims and
promises, each with the passage that supports it, and the app keeps only
passages found word for word in that information; separately, every price,
amount, percentage, time, day, link and email address in the reply must
appear in it. An "interested" classification is not enough on its own.
Each send happens at most once per draft revision.

**Every reply from a run's lead is handled.** The CRM leaves a reply it
is unsure about (a bare "Hey", anything it files as "other") for a person
to confirm in Action required; for the leads of an assistant run a reply
is written anyway and goes through the same checks, so it is answered,
held with the reason, or handed to you, never left silent. Customers and
"they left / ask someone else" replies always come to you.

**How replies are written.** Replies continue the conversation naturally.
The draft answers the lead's question in its
first sentence, in the lead's language (Hindi and Hinglish are answered in
kind), from your saved information only. Then, if the lead has not said
what problem they have, it asks one short question about their situation
(at most one per message, without repeating a question they answered or
ignored); when they describe a need your information covers ("Problems
we solve", the offer), it connects it in your words and offers the **next
step**: what you set in the business information (a call, a visit, a
quote), or a short call with the sender when you set nothing. It never
invents urgency, discounts or results. It offers only next steps your
information offers, never proposes days or time windows, and never says
"no" or "only" about something your information simply does not mention:
a draft that does is held as missing information, because a list of
services is not proof you do not offer something else. Unsupported additions
the draft made (a claim, price, link, promise or proposed time) are corrected
once and the new revision is checked immediately. An actual unanswered
business question still comes to you.

The checker receives the writer's recent conversation (up to 20 messages
and 12,000 characters), so short follow-ups keep their context. A plain
greeting is answered naturally by the model; it does not ask you what the
lead needs. When the lead needs to specify their own situation or an unclear
reference, the assistant can ask them one clarification. Conversation
history explains intent but cannot substantiate business facts or prices.

After upgrading, an incorrect handoff opened by the older version still
needs resolving: read its reason in Results → Needs you and use **Dismiss**
or **Done**, then send a fresh test reply. **I'll reply myself** hands the
conversation to you. The diagnostic script now prints each handoff's actual
reason and the question waiting for the owner.

**When it needs you: the handoff (Needs you).** The assistant hands a
chat to you when:

- the lead is **ready to buy**: agrees to the next step, asks to buy or
  book, or for a call, a visit or a quote for their order (a question about
  the price is answered, not handed over);
- they **ask for a person**, or **complain**;
- they ask what your information does not answer (**answer needed**), want
  a discount or price you have not published, a meeting time, or a promise
  it cannot back;
- the chat reached **30 automatic replies** (a safety net against two
  bots talking to each other, not a conversation length);
- or it is unsure (an auto-reply, someone who left, a message nobody
  understood: "Take a look").

Then, at once:

1. The lead gets **one** message, from the same number, mailbox or profile
   and in their language: "Thanks for your message! I'll get back to you
   personally on this soon." (for a ready lead: "…to take this forward").
   It names no time and promises nothing else. At most one a day per chat;
   none in Review mode, none for "Take a look", none outside production.
2. The assistant **keeps answering** the lead in that chat (their next
   question, a greeting back), in the same way as before; it just does not
   repeat the handover message and opens no second card for the same thing.
3. The lead appears in **Needs you** at the top of the Results page, most
   urgent first (Ready to buy, then a person or a complaint, then
   questions, longest wait first), with the label, a short brief written
   from the conversation ("3 chairs, one keeps breaking down; wants a call
   to set up the monthly plan"), their message, the wait, whether they were
   told, and new messages since. The menu shows the count next to Results,
   and the assistant chat shows a banner. It is also posted in the run's
   chat.
4. Owners and admins get an **email** (Resend, the sign-in email service)
   once, and **one reminder** if it is still open after 3 hours.

It leaves Needs you when you **reply in the chat** — from Action
required, the Messages tab or your phone — when you **Answer** in the card
(saved to the knowledge document "Answers you gave the assistant" for every
later conversation, and a reply with your answer is written and sent
automatically once it passes the checks), or when you press **Done**. None
of these stops the assistant: it keeps answering that lead. **The only
thing that takes a chat away from the assistant is "I'll reply myself"**
on a card, and **"Let the assistant reply"** (shown on the plan card under
that reply) gives it back and answers the latest message at once. An "ok"
or "thanks" after an answer gets no reply: the chat simply ends there. A
bare greeting ("Hey", "Hi") is answered as a greeting and is never counted
as interest, whatever the AI's first reading of it. Replies of Review-mode
runs are counted under Needs you with a link to Action required.

**Opt-outs.** A reply asking to stop or unsubscribe, a Do Not Contact
classification, or marking the person Do Not Contact in the CRM suppresses
them and stops every open email, WhatsApp and LinkedIn sequence for them at
once. Nothing more is sent, not even a polite sign-off.

**Results.** The Results page (`/assistant/results`) and "how are we
doing?" in the chat give, for today, yesterday, 7 days, 30 days or all
time, in the organization's time zone (Settings → Organization): leads found
and imported, duplicates merged, contactable and left out with reasons;
people contacted; emails and WhatsApp messages sent; LinkedIn connection
requests separately from LinkedIn messages; replies; interested (a
classification, not a sale); replies answered automatically and by you;
decisions and replies waiting for you; follow-ups still to send; stopped,
opted-out and held replies with reasons; failures with reasons; recorded AI
spending (costs recorded per call, kept apart from the plan card's
estimates) and the automatic replies left. All of it is counted from
recorded events, so a lead who unsubscribes later still counts as
contacted. A figure the app does not record is shown as "not measured",
never estimated.

**Daily summary.** At the start of each day in the organization's time zone
the assistant posts the previous day's figures in the chat; Results lists
them too. In the app only (no email or push).

**Lead search (Google Maps).** It runs a self-hosted copy of
[gosom/google-maps-scraper](https://github.com/gosom/google-maps-scraper)
(MIT licence, `docker-compose.discovery.yml`) and then reads each business's
own website (home page plus up to three contact/about pages) for the email
addresses, phone numbers and LinkedIn pages it publishes. Every contact is
stored with the page it came from; nothing is guessed (no `info@domain`
patterns). Emails are checked for format and that their domain receives
mail; phones are normalized with the listing's country. Duplicates are
merged. Businesses without a usable contact stay in the list as "left out",
with the reason.

Read this before turning it on:

- **Scraping Google Maps is against Google's Terms of Service**, and Google
  can rate-limit or block the server's IP address. When that happens the
  search fails and the chat says so; uploaded lists keep working.
- **Coverage is limited.** As of October 2026 the scraper's detailed
  place-page mode returns empty fields from Google, so the app uses its
  fast mode: the place is located with OpenStreetMap's Nominatim (free, one
  request per search; set `GEOCODER_URL` to a self-hosted Nominatim, or
  `off`), and up to 9 circles over the area are searched, each returning at
  most 20 businesses in Google's own order. One search therefore finds at
  most about 180 businesses, fewer in a small area, and not necessarily the
  best ones. Fast mode gives name, address, phone, website, rating and
  category; emails come only from the businesses' own websites.
- **It finds businesses that have a public Maps listing**, not private
  individuals, and not every potential customer. If the customers are
  people, or businesses that are not on Maps, upload a list instead.
- **It costs no fees**, but the scraper runs a headless browser: budget
  about 1 GB of memory (the e2-standard-2 VM has enough). A search of 50
  businesses takes a few minutes.
- Without the overlay, `GMAPS_SCRAPER_URL` is empty and the assistant says
  that lead search is not set up.

**Lead search (LinkedIn).** When Unipile and a LinkedIn account are
connected, the assistant can also search LinkedIn people by keywords ("clinic
owner Pune") through the existing LinkedIn search engine, within that
account's daily search allowance (one LinkedIn search runs at a time per
server). LinkedIn gives profiles only, no email or phone, so those leads are
contacted on LinkedIn (a connection request, then messages). The standalone
Search page stays hidden in this release.

**Contacts typed in the chat.** "Pitch this WhatsApp number: +91 80847
94983" (or emails, or LinkedIn profile links) adds those people as a lead
list and, when you asked to contact them, prepares the plan right away. A
number without + and a country code needs a Default phone country
(Settings → Organization), otherwise the assistant asks which country; it
never guesses. It adds only contacts you wrote or that are on a page it
read for you.

**Links.** Give the assistant a link (your website, a page listing people)
and it opens that one page and reads its text and the emails, phones and
LinkedIn links on it. It opens only links you give; it does not search the
web.

**Not supported:** Instagram, Facebook, X and TikTok, for finding leads or
reading pages: they need a login and do not allow automated reading. On
LinkedIn it can search people (below) but cannot open LinkedIn pages.

**Lists.** CSV and Excel go through the same People import as Leads →
Import (same column handling, same errors). Leads with no usable contact on
any connected channel are reported with the reason (for example "reachable
only by WhatsApp, which is not used in this run"). Lists work without any
lead search service.

**AI cost.** Sorting is one model call per 25 leads (none when there is
nothing to sort by); writing is one call per kind of lead, plus one per 5
leads written to individually; each standard lead's opening line costs one
call per ten leads, at Start; checking a reply before it is sent
automatically is one more call, and each handoff's brief one more. The plan card shows the estimate before you
press Start; Results shows what was recorded.

## 4. Brand settings

Everything customer-facing reads `src/lib/brand.ts`:

- `name`, `shortName`, `wordmark` and `description`.
- `accessRequestEmail`: on an invite-only sign-in page, the address "Need
  access?" writes to. It is `null` by default, which shows the hint without a
  link. Upstream mailed the AgentSDR maintainer; this build never does.
- `monogram`: the letters on the app tile. `src/app/icon.svg` (the favicon) and
  `src/app/apple-icon.tsx` draw the same tile; change all three together.

To use a drawn logo instead of the text wordmark, replace the contents of
`AppIcon` and `Logo` in `src/components/brand/Logo.tsx` and the two icon files.
The wordmark font is Manrope, loaded through `next/font` like the other faces,
in `src/components/brand/font.ts`.

`LICENSE` and the upstream copyright stay as they are. This product is built on
AgentSDR (MIT). The Call Recorder Chrome extension is still named "AgentSDR Call
Recorder".

## 5. Manual owner checks

Session 3 ran all nine in a browser on a local copy (results in
SESSION_STATUS.md: 1–4, 7 (review and edit) and 8–9 pass; 5, 6 and the
send in 7 are blocked on credentials). Repeat them on your own server once
a channel is connected, and record the results in `SESSION_STATUS.md`.

1. Create or sign in to the owner workspace, and check the branding on sign-in,
   setup, the sidebar (expanded and collapsed), the mobile header, the browser
   tab title and the favicon, in light and dark themes.
2. Follow Getting started and confirm each status matches what you configured.
3. Import a small CSV and an XLSX on Leads. Check accents, duplicate rows (the
   second import should only update), custom columns, and the row numbers in
   any errors.
4. Create a draft email campaign and check its steps, merge fields
   (`{{firstName}}`, custom columns) and the sending rules it will follow.
5. Configure one real channel and send a controlled test to yourself.
6. Reply to it and confirm the reply appears in Action required, and that the
   remaining follow-ups for that person stop.
7. Review and edit an AI draft, then send it yourself. Outside an outreach
   run started in Automatic mode, nothing is sent automatically.
8. Restart the app container and confirm that settings, leads and campaign
   state are still there.
9. Check Getting started, Leads import and the campaign pages at phone width
   (about 390 px).

## 6. Live verification, per channel

Do this on the deployed server (public HTTPS), with **test recipients you
control**, never a prospect list. Use a campaign of one test lead and a
sequence of at least two steps with a short wait, so a follow-up is due.

For each connected channel (email, LinkedIn, WhatsApp; for email, each way
you send: Google Workspace and/or Unipile):

1. **Delivery:** launch the campaign; confirm the first message arrives at
   the test recipient.
2. **Reply sync:** reply from the test recipient. Within about a minute it
   must appear in **Action required** of *this* workspace, and Getting
   started → Incoming replies must list the channel's last reply.
3. **Follow-ups stop:** the lead shows Replied / reply received, and the
   second step never sends (check again after its wait has passed).
4. **AI:** the reply is classified and a draft waits for review. Check that
   it is signed with your name (mailbox display name, LinkedIn or WhatsApp
   account name) and claims nothing you have not done.
5. **Approved response:** edit the draft if needed, then Approve & send;
   confirm the test recipient receives it.
6. **CRM:** the record shows both messages in its conversation and the
   stage the classification set.
7. **Pause / resume / restart:** pause a running campaign and confirm
   nothing sends; resume; restart the app container
   (`docker compose -f docker-compose.yml -f docker-compose.build.yml restart app`)
   and confirm campaigns, settings, leads and the conversation are intact.

A simulated webhook, a mocked provider or a successful API submission is
not proof; only the message arriving, and the real reply arriving back, is.

**The assistant, live** (after the channel checks above pass; test
recipients only — make the test list from your own addresses, never
from search results):

1. Ask for a small lead search ("find 10 dental clinics in Baner, Pune");
   open a few results and check the contacts against the businesses'
   websites (each shows its source page). Do not start outreach to them.
2. Upload a list of your test recipients and ask the assistant to contact
   them. Check the plan card (samples, limits, reply mode) and press Start
   in **Automatic** mode.
3. From a test recipient, reply with a question your uploaded price list
   answers. As soon as the draft is ready and checked, the answer must
   arrive, and the remaining follow-ups for that recipient must not send.
4. Reply with a question your information does not answer: a decision
   card appears in the chat; answer it; the rewritten reply arrives.
5. Reply "please stop": the recipient is suppressed, everything to them
   stops, and nothing more arrives.
6. Pause the run, reply from another recipient: nothing is sent until
   Resume. Press "I'll reply myself" on a decision: nothing more is sent
   there. Restart the app container mid-run: nothing is sent twice.
7. Stop the run: nothing more is sent for it.
8. Compare Results (today) and the next morning's daily summary with what
   the recipients actually received.

## 7. Re-running the automated checks

```bash
bun install --frozen-lockfile
bun run typecheck && bun run lint && bun run test && bun run build

# Against a disposable LOCAL database only (each script refuses anything else):
bun run db:check
# Owner vs member permissions and the owner workflow (server running, any AUTH_SIGNUP):
INITIAL_OWNER_EMAIL=… INITIAL_OWNER_PASSWORD=… BASE_URL=http://localhost:3000 \
  bun run scripts/e2e/owner-controls.ts
# Tenant isolation: start the dev server with its own auth URL first, e.g.
#   AUTH_SIGNUP=open BETTER_AUTH_URL=http://localhost:3100 NEXT_PUBLIC_APP_URL=http://localhost:3100 \
#     bun run dev -- -p 3100
# Under `bun run start` Better Auth's production rate limiter answers its rapid
# sign-ins with 429; with the wrong BETTER_AUTH_URL sign-in fails "Invalid origin".
# The dev server (Turbopack) can use 11+ GB of memory once the suite has
# compiled every page; give the machine room, or restart it between suites.
INITIAL_OWNER_EMAIL=… INITIAL_OWNER_PASSWORD=… BASE_URL=http://localhost:3100 BETTER_AUTH_URL=http://localhost:3100 \
  bun run --conditions=react-server scripts/e2e/tenancy-isolation.ts
# Campaign engines (email and WhatsApp) on a throwaway organization, with a
# recording sender instead of Gmail/Unipile; sends nothing. No server needed:
bun run --conditions=react-server scripts/e2e/campaign-engines.ts
# Email through Unipile against a stand-in Unipile API (fetch intercepted for a
# fake host; sends nothing): sync, campaign send and follow-up threading, the
# email webhook's gate, a reply stopping follow-ups, a CRM reply. No server needed:
bun run --conditions=react-server scripts/e2e/unipile-email.ts
# The assistant, against stand-ins for the Google Maps scraper, the businesses'
# websites and Unipile (nothing leaves the machine but AI calls). Stop any
# running server first: its worker would claim the script's jobs. Without
# AI_SOURCE_ORGANIZATION_ID the model-backed steps are skipped:
AI_SOURCE_ORGANIZATION_ID=<org with AI Settings> bun run --conditions=react-server scripts/e2e/assistant.ts
#   (it includes scripts/e2e/assistantAutomation.ts: Review vs Automatic,
#   supported and unsupported answers, owner answers, opt-out, pause/resume,
#   stop, takeover, edits, newer messages, concurrent limits, restart
#   recovery, duplicates, results against recorded events, the daily
#   summary, and a second organization seeing none of it)
# The reply agent: a lead's message through the classification job, the agent's
# loop and the CRM send path, with a stand-in model and a recording sender
# (sends nothing). With AI_SOURCE_ORGANIZATION_ID it also prints real answers
# and timings; REPLY_AGENT_E2E_MODEL=<model id> tries another model of it:
bun run --conditions=react-server scripts/e2e/reply-agent.ts
# The owner's own conversations against the real model: a greeting, "any city",
# a WhatsApp number typed in the chat, Instagram, a link (queues searches and
# cancels them; sends nothing):
AI_SOURCE_ORGANIZATION_ID=<org with AI Settings> GMAPS_SCRAPER_URL=http://127.0.0.1:8080 \
  bun run --conditions=react-server scripts/e2e/assistant-chat-live.ts
# The real Google Maps scraper and real websites (needs the scraper running,
# e.g. docker compose … -f docker-compose.discovery.yml; sends nothing):
GMAPS_SCRAPER_URL=http://127.0.0.1:8080 bun run --conditions=react-server scripts/e2e/discovery-live.ts "dental clinics" "Baner, Pune, India" 40
# Real AI calls (a little AI/ML usage; never sends). The worker can run in-process:
ORGANIZATION_ID=<id> AI_LIVE_INLINE_WORKER=1 bun run --conditions=react-server scripts/e2e/ai-live-crm.ts
ORGANIZATION_ID=<id> bun run --conditions=react-server scripts/e2e/research-live.ts
```
