# Instagram, inquiry intake and website discovery

Branch `claude/instagram-intake-discovery`, based on `claude/new-session-g5hljn`
(`994fb7d`). Everything here is **off by default** for every organization
(Settings → Organization → Optional features) and needs the additive migration
`bun scripts/add-instagram-intake-discovery.ts`.

This document records, before the implementation, what the providers were
verified to support and which integrations are required or optional. The
sections after it describe what was built on that basis.

## 1. Verified provider capabilities (checked 2026-10-16)

Sources: Unipile's current documentation and API reference
(developer.unipile.com, v1 and v2.0), its changelog and pricing page, Meta's
Instagram Platform documentation, and the installed `unipile-node-sdk@1.9.3`
source (npm `latest`). Nothing below was verified against a live Unipile
account: this sandbox cannot reach Unipile.

### Unipile API version

| Fact | Source |
| --- | --- |
| v1 (`https://{DSN}/api/v1/…`, `X-API-KEY`) is stable and not deprecated; v2 (`https://api.unipile.com/v2`) is in beta, uses a separate dashboard and account, provider ids instead of Unipile ids (`acc_…`), account-in-path routes, and a different webhook envelope (`type` + `payload`, `message.new`, HMAC `unipile-signature`). | developer.unipile.com/v2.0/docs/migration-from-v1, …/migration-introduction, …/migration-webhooks |
| `unipile-node-sdk@1.9.3` targets v1 (`DEFAULT_API_VERSION='v1'`); its request builder cannot produce v2's routes. The v2 SDK is a different package (`@unipile/sdk`). | installed SDK `dist/cjs/state.js`, `request-sender.js` |
| AgentSDR's LinkedIn, WhatsApp and email already use v1 ids and the v1 webhook format. | `src/services/unipile*.ts`, `src/lib/platform/unipileWebhooks.ts` |

**Decision:** Instagram uses **v1 only**, through the same per-organization
Unipile connection, the same `unipile-message` webhook registration and the
same id formats. No existing channel is migrated. No v2 identifier or webhook
format is read or written anywhere.

### Instagram through Unipile v1

| Capability | Supported | Endpoint (v1) | Used here |
| --- | --- | --- | --- |
| Connect an account (hosted sign-in) | Yes | `POST /hosted/accounts/link` with `providers: ["INSTAGRAM"]`, `notify_url` → `{status: CREATION_SUCCESS\|RECONNECTED, account_id, name}` | Yes |
| Connect with password / session cookie, 2FA checkpoint | Yes | `POST /accounts`, `POST /accounts/checkpoint` | No (hosted sign-in keeps passwords out of AgentSDR) |
| Account status webhook | Yes | `source: account_status` | Yes (existing `unipile-account` route syncs Instagram too) |
| List chats | Yes | `GET /chats?account_type=INSTAGRAM&account_id=` | Yes (history import) |
| List messages of a chat | Yes | `GET /chats/{chat_id}/messages` | Yes (history import; the new-chat check before an inquiry) |
| Send in an existing chat | Yes | `POST /chats/{chat_id}/messages` | Yes (replies) |
| Start a new chat | Yes (`attendees_ids` = the profile's `provider_messaging_id`) | `POST /chats` | **No** — no cold Instagram outreach in this release |
| Message webhook | Yes; `account_type: "INSTAGRAM"`; the account's own sends also arrive as `message_received` (tell them apart by `is_sender` or `account_info.user_id` = `sender.attendee_provider_id`) | `source: messaging` | Yes |
| Webhook delivery | 200 within 30 s, else up to 5 retries; dedupe on `message_id` | docs/webhooks-2 | Ledger key + unique message id |
| Retrieve a profile | Yes | `GET /users/{username\|provider_id}?account_id=` | Yes (discovery) |
| List a user's posts / get a post | Yes | `GET /users/{id}/posts`, `GET /posts/{id\|shortcode}` | Yes (discovery) |
| List a post's comments / reactions | Yes | `GET /posts/{provider_id}/comments`, `GET /posts/{id}/reactions` | Comments yes; reactions are engagement only |
| Followers / following | Yes (25 per page) | `GET /users/followers`, `GET /users/following` | No (a follow is not a need) |
| Comment, like, follow | Yes | `POST /posts/{id}/comments`, `POST /posts/reaction`, `POST /users/invite` | **No** — nothing is posted on the owner's behalf |
| Keyword, hashtag or people search on Instagram | **Not documented** in v1 or v2 (`/linkedin/search` is LinkedIn-only; v2 has only "search locations") | — | **Not supported** |
| Facebook / Messenger search | Not documented; Messenger messaging is documented but "no longer maintained" | — | **Not supported** |
| Messaging people who do not follow you / message requests | Not documented | — | Not relied on |

Unipile's documented limits for Instagram: about 100 actions a day and 10 an
hour per account for follows, outreach, likes and comments; replying to
inbound messages is fine. Pricing is per linked account and the same for
every channel (€49/month up to 10 accounts, then €5 → €3 per account,
post-paid on the monthly peak; unipile.com/pricing-api).

### Search providers (website and directory discovery)

An ordinary language model is not a search engine. Discovery uses only
providers that **return the sources of a real web search**, and only the URLs
those providers return are ever used (URLs written in the model's text are
ignored), exactly as the existing company research does
(`src/lib/research/research.ts researchSources`).

| Provider | How it searches | Already integrated |
| --- | --- | --- |
| OpenRouter | `plugins: [{ id: "web" }]` (returns `url_citation` annotations) | Yes: the organization's AI connection |
| AI/ML API | a research model with `web_search_options` (Perplexity Sonar was verified live on 13 Oct 2026 for company research) | Yes: Settings → AI provider → research model |

### Optional adapter for Instagram hashtag discovery

Instagram hashtag or keyword discovery needs a provider Unipile is not:

| Provider | Requirements | Cost |
| --- | --- | --- |
| Meta Instagram Graph API — hashtag search (`GET /ig_hashtag_search`, `/{hashtag-id}/recent_media`) | An Instagram **Business or Creator** account linked to a Facebook Page; a Meta app that passed **App Review** for *Instagram Public Content Access* and `instagram_basic`; a user access token. Limits: 30 unique hashtags per rolling 7 days; `recent_media` covers the last 24 hours, 50 per page, without usernames. | No fee stated by Meta. |
| Apify "Instagram Hashtag Scraper" | An Apify account and token. Public data only; scraping — check Instagram's terms before use. | From $1.90 per 1,000 results. |

AgentSDR ships the Meta adapter as **optional, not configured, and never
called during development**; no account was created and no paid call was
made.

## 2. Required versus optional integrations

| Integration | Needed for | Required? |
| --- | --- | --- |
| PostgreSQL migration `scripts/add-instagram-intake-discovery.ts` | Everything below | Required before turning any feature on (without it every feature reads as off) |
| Unipile (existing per-organization connection) + an Instagram account linked in it | Instagram messages, Instagram inquiries, Instagram profile/post/comment reading in discovery | Required for Instagram; optional otherwise |
| AI provider (existing) | Drafting replies (all channels), reply checks | Required (as today) |
| A web-searching AI model (OpenRouter, or AI/ML API research model) | Website and directory discovery | Optional: without it, discovery from a description says it is unavailable; Google Maps and LinkedIn search work as before |
| The owner's website-form tool (Zapier, Make, Webflow, WordPress plugin, a developer…) | Website-form inquiries | Optional; a one-time setup in that tool (AgentSDR cannot connect a site's forms by itself) |
| Meta Instagram Graph API (Business account + App Review) | Instagram hashtag discovery | Optional adapter, off |

## 3. What was built: the assistant's two starting points

Both starting points end in the same lead lists, plan card, Start button,
CRM conversations, replies, decisions and handoffs. Nothing in this section
needs a feature switch: it adds no provider and sends nothing by itself.

### Reusing what the business already told AgentSDR

`src/lib/assistant/businessContext*.ts`. Before asking anything, the
assistant reads, besides the business profile:

- the saved knowledge documents (titles and kinds) — a document saved as
  *pricing* or titled like a price list answers price questions, and the
  assistant reads documents with `search_knowledge` before asking for an
  offer or customers;
- the names the connected accounts send as (mailbox display names,
  LinkedIn, WhatsApp and Instagram account names) — when the profile has no
  sender name and every account uses the same one, outreach is signed with
  it (visible in the plan's samples before Start); when they disagree, the
  assistant asks which one;
- the reply instructions saved in Settings → Instructions.

Its context gains `ALREADY KNOWN ELSEWHERE`, and `STILL MISSING` lists only
what none of those holds; prices are "worth asking once", never blocking.
The profile gains an optional **prices** field.

### "Use my existing leads or inquiries"

Welcome card and tool `use_existing_leads`: a lead list from people already
in the lead database — everyone, the latest import, a word to match (name,
company, title, email or saved details such as a city), or the people who
sent inquiries. People already in a running or paused outreach run are left
out (no second sequence), Do Not Contact and unsubscribed people are
excluded with the reason, and inquiries from imported history are left out
unless asked for. A person who inquired keeps their inquiry's words (as
evidence and as something the messages may refer to) however the list was
made. `list_inquiries` summarizes the last 30 days.

### "Find potential customers for me" (optional)

The existing Google Maps search and LinkedIn search, plus website and
directory discovery (section 4) when that feature is on.

### Qualification before outreach

`src/lib/assistant/qualification*.ts`, `GET /api/assistant/audiences/[id]/prospects`,
and "Review the leads" on every lead-list and search card. For each lead:
source and date, why it matched (recorded at discovery, or derived from what
was actually searched for older lists), each contact route with the page it
came from, and only the lead's own words as evidence of need.

| Status | Means |
| --- | --- |
| Potential match | Found or listed; no evidence that they want anything |
| Inquired | They wrote in themselves (website form, Instagram) |
| Replied | They answered outreach; not classified interested |
| Interested | The CRM classified their reply as interested |
| Left out | Cannot be contacted, with the reason |

A follow, like, reaction or generic comment is shown as engagement and never
changes the status. Location and budget read **Unknown** unless the source
stated them.

### One Start for a whole request

"Find dentists in Pune, Mumbai and Nagpur and contact them" runs one search
per city, and each prepares its own plan. The plan card's Start offers
**Apply to the rest of this request** (on by default): the request's other
plans — already waiting, or prepared later when their searches finish —
then start on their own with the same reply mode (`requestApproval*.ts`).
They still go through `startOutreachRun`, the same launch rules as a Start
press, and each start is announced in the chat.

A *request* is one owner message: every plan it produces carries that
message's id (`plan.requestId`), so two requests worded the same — two
"yes" answers — are never one request. An approval covers only plans with
the same request id in the same conversation, only the channels the
approved plan used, at most 100 leads per plan (or the approved plan's size
when larger), never an inquiry run, never a plan in which someone is
already in another running or paused plan, and nothing once the approving
run is paused, stopped or 24 hours old. The reply mode is the approving
run's at the moment each plan starts: switching it to Review makes the rest
of the request start in Review. A plan it does not cover waits for its own
Start and the chat says why. The card starts with the reply mode the owner
chose last time selected (inquiry runs excluded).

### Inquiry runs: the scope for answering inquiries automatically

`src/lib/assistant/inquiryRuns*.ts`. Answering inbound inquiries without
review is never on by itself. The owner asks for it, the assistant proposes
an inquiry run (`prepare_inquiry_replies`), and the owner presses Start
choosing Automatic or Review. While it runs, each person whose **fresh**
Instagram inquiry arrives (first message of a new chat, on an account that
treats new messages as inquiries) becomes a member on channel `instagram`,
so the existing reply autopilot applies to them with every existing check:
the run's mode, Pause/Resume/Stop, Do Not Contact, takeover, edited or
outdated drafts, newer messages, the per-conversation and daily limits, the
support check and the handoff to the owner. It sends nothing first. It never
covers imported history, chats that began earlier, people AgentSDR already
knew, another channel, or an Instagram account that was not listed on its
card when it was started. One inquiry run at a time (an advisory lock per
organization); Stop is final.

## 4. Website and directory discovery (optional)

Feature switch: **Website and directory search** (Settings → Organization →
Optional features). Code: `src/lib/discovery/webSearch.server.ts`,
`webDiscovery.ts`, `webDiscovery.server.ts`; assistant tool
`find_customers_on_web`; job kind `web_discovery`. Google Maps and LinkedIn
search are unchanged and need no switch.

How it works, for "find gyms in Pune that might need a booking app":

1. **Search** — up to 3 queries derived from the owner's description, each
   one real web search through the organization's own AI provider:
   OpenRouter with its `web` plugin, or AI/ML API's web research model.
   Only the URLs the provider returns as sources are used; a URL in the
   model's text is ignored. With neither configured, the tool answers that
   discovery is unavailable and how to enable it — nothing is guessed.
2. **Classify** each returned URL: a business's own website, a directory or
   list page (Justdial, Sulekha, IndiaMART, Practo, Yelp, "top 10" lists…),
   a public Instagram profile or post, or something to skip (search engines,
   social sites other than Instagram, files, platforms).
3. **Read** (reusing the Maps discovery page reader, `fetchPublicPage`, with
   its private-address refusal, size and time limits): a business site's
   pages for the emails and phones it publishes; up to 5 directory pages and
   up to 20 business links on each; with the Instagram feature on and an
   account linked, up to 6 Instagram starting points — a profile's listed
   website and public contact buttons, or a post's comments (up to 50).
4. **Save** — each email is checked for syntax and for the domain's mail
   servers (MX, else A/AAAA); this proves the domain can receive mail, not
   that the mailbox exists, and the UI says so. Phones are normalized to
   E.164 with the organization's default country. People are matched to
   existing ones by email, then phone, before anyone is created (source
   `discovery:web-search`). Each contact keeps the exact page URL it was read
   from; each lead keeps why it matched (the provider's title and snippet and
   the query that found it) and any signal.

Never invented: an email, phone, person or page that was not on a page the
provider returned (or a page those pages link to as above). A business that
publishes no contact stays in the list as **excluded** with the reason. A
comment is a need only when its own words ask for something ("looking for a
physio near Baner"); a follow, like, reaction or emoji-only comment is
engagement. Instagram-only people are listed but excluded with "reachable
only on Instagram — open the post/profile to reply yourself", because
AgentSDR starts no Instagram chats.

Cost: up to 3 provider searches per request (the provider's own price; the
job stores the cost the provider reports) plus at most 6 Unipile reads.
Bounds: 5–40 sites per request (default 20), a 60 s deadline per search,
one retry only for a rate limit or server error.

**Instagram hashtag and keyword discovery** is not possible through Unipile
(section 1). `src/lib/discovery/socialAdapters.ts` holds an optional Meta
Graph API hashtag adapter, built only from credentials passed to it
explicitly; nothing in the app constructs or calls it, and no Meta app,
account or token exists. Turning it on later needs the requirements in
section 1 and a settings page that does not exist yet. There is no Facebook
search of any kind.

## 5. Website-form inquiries: one-time setup

Feature switch: **Inquiry intake** (Settings → Organization → Optional
features). Code: `src/lib/intake/`, `src/app/api/intake/`, Settings →
Inquiries (shown only with the feature on).

**Entering a website address does not connect its forms.** A website's
forms send their submissions wherever their form tool is told to; AgentSDR
cannot reach into a site and attach itself. The setup is done once, by the
owner or whoever manages the website:

1. Settings → Inquiries → **Create a webhook**. AgentSDR shows the URL
   (`https://<your AgentSDR>/api/intake/form`) and a secret token **once**
   (copy it; it can be rotated later), plus a ready-made `curl` example.
2. In the form tool, add a webhook that POSTs each submission to that URL
   with the header `X-AgentSDR-Token: <token>` (or `Authorization: Bearer
   <token>`). Zapier and Make: "Webhooks → POST"; Webflow, WordPress
   (Elementor, Contact Form 7 via a webhook add-on), Tally, Typeform and
   others have a webhook option; a developer can call it from any backend.
   Only for tools that cannot send headers: `?token=<token>` on the URL (it
   may end up in that tool's logs).
3. Send a test submission and check it under **Recent inquiries**.
4. If the form's field names are unusual, map them under **Field mapping**
   (email, phone, name, first/last name, company, message, page URL,
   submission id, submitted at). Common names are recognized without it.

Contract:

| Request | Response |
| --- | --- |
| `application/json` (an object; fields may sit in `data`, `fields: [{name, value}]`, Webflow's `payload.data`, Tally's `data.fields`), `application/x-www-form-urlencoded`, or `multipart/form-data` (text fields), ≤ 64 KB | `202 { ok, inquiryId, duplicate, status }` |
| unknown or malformed token | `401` |
| endpoint turned off | `403` |
| Inquiry intake off for the organization | `409`, nothing stored |
| over 64 KB / other content types / no fields | `413` / `415` / `400` |
| more than 300 submissions in the last hour on this endpoint | `429` with `Retry-After`, nothing stored |
| `?historical=1` | stored as history: listed, never acted on |

What happens to a submission: the email is checked for format and kept only
if valid (an address is never repaired or invented; one carrying a NUL byte
or other control character is dropped, not stripped); the phone is
normalized with the organization's default country or dropped with the
reason; a page URL is kept only if it is an http(s) address. Every stored
key and value is cleaned of NUL bytes and lone surrogates. The
person is matched to an existing one by email, then by phone (a phone shared
with a person who has a different email is not merged), else created
(source `intake:website-form`). A retried delivery is recorded once: the
de-duplication key is the form's submission id together with a hash of the
content (email, phone, message, submitted-at), or that hash alone, so a
different submission that reuses an id is still recorded. Two submissions
with the same new email at the same moment make one person. A submission with neither a usable email
nor phone is kept as **unusable** with the reason. Fresh submissions send
nothing and create no CRM record by themselves: they become contacts with
their message as evidence of need, ready for "use my existing leads or
inquiries" and a plan the owner starts.

Limits per endpoint: 300 submissions an hour (more get `429` with
`Retry-After`; the form tool can resend them later), and 500 new contacts in
24 hours — past that a submission is still stored, as **unusable** with the
reason "Daily limit of new contacts from this form reached", and no person
is made, so nothing a visitor sent is lost. A leaked token is handled by
rotating it or turning the endpoint off; both (and deleting) work while
Inquiry intake is off, and turning the feature back on never turns an
endpoint back on.

## 6. Instagram messages through Unipile

Feature switch: **Instagram messages** (Settings → Organization → Optional
features). Code: `src/lib/instagram/`, `src/services/unipile.instagram.ts`,
`src/app/api/instagram/`, `src/app/api/webhooks/instagram-message`,
Settings → Instagram accounts and Instagram → Messages (both shown only with
the feature on). API v1 only, through the organization's existing Unipile
connection.

One-time setup, by an owner or admin:

1. The Unipile integration must already be connected (Settings → LinkedIn
   or WhatsApp → Connection). Nothing new is registered: Unipile's one
   messaging webhook (`/api/webhooks/unipile-message`, saved with that
   integration) already receives every messaging account's events and now
   routes `account_type: "INSTAGRAM"` to `/api/webhooks/instagram-message`.
   An install whose webhook was registered before should re-save the Unipile
   integration once only if Instagram messages do not arrive.
2. Turn on **Instagram messages**, open Settings → Instagram accounts and
   **Connect Instagram**: Unipile's hosted sign-in (`POST
   /hosted/accounts/link`, provider `INSTAGRAM`), so the password never
   passes through AgentSDR. An account linked in the Unipile dashboard is
   picked up with **Sync from Unipile**. The member who connects is recorded
   as the account's owner in AgentSDR.
3. Optional: **Import history** — the account's recent chats (2 pages) and
   up to 30 messages each, stored as history. Optional: **Treat new messages
   as inquiries** on the account (needs the Inquiry intake feature).

What arrives and what happens:

| Message | Stored | Unread | CRM | Inquiry | Answered |
| --- | --- | --- | --- | --- | --- |
| Imported history | Yes, `historical` | No | No | No | Never |
| Webhook message sent before the account's history cutoff (first time it was seen connected) or more than 6 h old on arrival | Yes, `historical` | No | No | No | Never |
| Fresh reply from someone AgentSDR knows (the chat is linked to a person) | Yes | Yes | Inbound on an `instagram` conversation: classified, drafted, in Action required | No | After the owner's review, or by an inquiry run in Automatic |
| Fresh first message of a new chat from someone unknown, account treats new messages as inquiries | Yes | Yes | Yes (as above) | Yes (`intake:instagram`, one per sender per account) | Only inside a running inquiry run (section 3); otherwise reviewed |
| The same, but Unipile's copy of the chat has earlier messages (a customer whose chat was never imported), something the account sent, or cannot be read | Yes | Yes | No | No | No (Instagram inbox only) |
| Fresh first message, inquiries off for the account | Yes | Yes | No | No | No (Instagram inbox only) |
| The account's own message typed in the Instagram app (echo) | Yes, origin `phone` | No | Recorded as outbound: the person was answered | No | — |
| AgentSDR's own send (echo) | Attached to the reserved row, origin `agentsdr` | No | — | — | — |

Webhook handling: every delivery is written raw to the existing webhook
ledger first (account type `INSTAGRAM`), keyed so Unipile's retries
collapse into one; a message is stored once by its Unipile id. The route
answers 200 as soon as the delivery is recorded and processes it
afterwards; only a failure to record answers 500, so Unipile retries.
Unipile never retries a 200, so a delivery whose processing fails — a
database error, or the CRM not recording a stored message — is marked
errored and taken up again by the webhook replay job
(`src/jobs/replayInstagramWebhooks.ts`, run every 10 minutes with the
LinkedIn replay; the ledger's backoff, 8 attempts, then `dead`), as is one
left `processing` past the ledger's 5-minute lease. Processing again is
safe: a stored message is not stored twice, and a fresh one not yet on the
CRM is forwarded again under the same idempotency key. The organization
comes from the payload's account (`gateUnipileWebhook`, `org=` and the
secret); with the feature off the delivery is acknowledged and nothing of
it is recorded.

Sending: a reply only, into the chat the person wrote in, from the account
that chat is on — AgentSDR never starts an Instagram chat (no cold
Instagram outreach). Through the CRM's existing send path
(`sendInstagramThroughCrm`, the send attempt ledger and its duplicate-send
protection, stale-draft checks and limits). Refused before Unipile is
called when the feature is off, the account is unknown or not connected,
the chat is not that account's, the person is Do Not Contact, or the text is
empty or over 1,000 characters. The message row is reserved before the
Unipile call so an early echo is recognised. A 4xx from Unipile (other than
a 408 timeout; 409 and 429 included) removes it and fails the draft
definitely — nothing was sent. A timeout or 5xx keeps it (the message may
have gone): the attempt is marked delivery-uncertain and reconciled rather
than resent, and an echo arriving up to 24 h later attaches to the reserved
row instead of being stored again as typed in the app. A 2xx without a
message id counts as sent; the row gets its id from the echo.

Account changes: the existing `unipile-account` webhook now also syncs
Instagram accounts, so a disconnected or credential-expired account shows
as such and stops sending immediately. Disconnecting never deletes chats.

Not built: Instagram unread count in the sidebar badge, group chats (skipped
on import), attachments sending, comment replies, and any cold Instagram
outreach.

## 7. Validation: simulated versus live

Everything below ran in this sandbox against a disposable local PostgreSQL
16 and **stand-ins** for Unipile and the search providers. Nothing was
verified against a live Unipile account, a live Instagram account, a real
form tool or a paid search call: the sandbox cannot reach Unipile, and the
brief forbids paid calls and real messages.
