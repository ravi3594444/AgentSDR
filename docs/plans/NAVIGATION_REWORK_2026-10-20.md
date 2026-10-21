# Navigation rework: Outreach, Inbox, Leads (four stages)

Branch `claude/dreamy-fermi-h5woha`, on top of `fc121e0`, which is deployed. Size: **XL**, in four stages:
- **N1, N2, N4:** me.
- **N3 (settings):** one worktree sub-agent, in parallel with N2. Its files barely overlap N2's.

No new providers or outreach features. Nothing is sent, and no live provider is called.

## Context

The owner's MCP review found that customers piece one outreach job together across too many screens:
- **Duplicate navigation:** "Leads & replies" and "Pipeline" both open `/crm/pipeline`.
- **Scattered replies:** they compete across Activity → Replies, Action required, Pipeline, Needs you and four channel inboxes.
- **Overloaded settings:** one long General page.
- **Buried business info:** the business profile can only be edited by chatting. Its Knowledge copy is overwritten one way.
- **Dense chat reports.**
- **Contradictory labels:** "Nothing is waiting on you" next to "Immediate reply".
- **Getting started omits Instagram.**

Target: three destinations, **Outreach**, **Inbox** and **Leads**, with **Settings** in the footer. Channels become filters.

### Owner decisions (20 Oct)

- **Overview + Analytics** become one **Reports** view inside Outreach: summary numbers, with expandable details.
- **Pipeline board** lives inside **Leads**, with a **List / Board** switch.
- **Manual channel campaign pages** stay, under **Advanced**. Everyday Outreach and Inbox use channel filters.
- Include the server changes: the summary beside the chat needs reliable data.

### Requirements (the owner's)

1. One request workspace: chat, live progress, leads, blockers and next action together, with child searches and campaigns underneath.
2. One Inbox across all channels, with **Needs you** and **All conversations**. Approval, manual replies, Automatic mode and Mark reviewed stay reachable there.
3. Older work stays findable: manual campaigns, and older runs with no research-request id.
4. Old links keep working: bookmarks and notifications keep their conversation/campaign ids and filters through the redirect.
5. "Your business" edits the existing structured profile (`assistant_profiles`) and keeps its Knowledge copy consistent.
6. Historical chats stay readable: compact rendering falls back for older events that lack structured fields.

## Route and navigation map (all stages)

### Sidebar

**Main:**
- **Outreach** → `/assistant`. The page keeps its URL, because `/outreach/*` is the Email section's gated layout.
  - Tabs: **Chat** (`/assistant?thread=`), **Requests** (`/assistant/requests`, new), **Reports** (`/assistant/reports`, new).
- **Inbox** → `/inbox` (new). Views `needs_you` and `all`, with a channel filter. Badge: one "needs you" count.
- **Leads** → `/leads`. `view=list` (People / Companies, as today) or `view=board` (the CRM pipeline board).

**Footer:**
- **Advanced** group (collapsible):
  - Email campaigns, Email inbox
  - LinkedIn campaigns, LinkedIn messages, LinkedIn search
  - WhatsApp campaigns, Call campaigns, WhatsApp messages
  - Instagram messages
  - Sequences
  - Tables and Prospecting, when released
  - Developers
- **Getting started**
- **Settings**

Every page URL keeps working. Detail pages (`/crm/records/[id]`, campaign `[id]` pages) keep their URLs; only navigation and labels change.

### Redirects

One pure table, `src/lib/nav/legacyRoutes.ts`, feeds `next.config.ts` `redirects()` and its own unit test. Query strings carry over.

| Old URL | New URL |
| --- | --- |
| `/activity` (and `?view=work`) | `/assistant/requests` |
| `/activity?view=replies&channel=` | `/inbox?view=all&channel=` (a `has` query rule) |
| `/crm/actions?view=actions\|needs_you&…` | `/inbox?view=needs_you&…` (filters kept) |
| `/crm/actions?view=replies` | `/inbox?view=all` |
| `/crm/pipeline` | `/leads?view=board` |
| `/analytics?view=&range=&tz=` | `/assistant/reports?view=&range=&tz=` |
| `/assistant/results` | A tiny client page. `#needs-you` → `/inbox?view=needs_you`; anything else → `/assistant/reports`, query kept (the fragment can't reach the server) |

Existing page `redirect()`s drop their query string: `/crm`, `/linkedin`, `/calling`, `/instagram` (which loses `?chat`), `/calling/[id]`. Fix them to pass the query on (shared helper `withQuery()`).

### Links and entry points to update

- The Needs-you email (`handoff.server.ts:245`) → `/inbox?view=needs_you`.
- Readiness links (`readiness.ts:503,556,584`).
- Sign-in, sign-up, onboarding, accept-invitation, demo and organization switch land on `/assistant` instead of `/analytics`.
- `WorkspaceNavigation.tsx` tabs.
- Component links from the explore map: ResultsClient, NeedsYouList, ActivityClient, CrmRecordClient's back link, CrmActionsClient, CrmPipelineClient, InboxClient, the channel inbox clients, PeopleTable.

## N1: Navigation and Inbox (L)

### Server

- **One "needs you" definition.** `listCrmActions` gains scope `attention`: `crmActionableSql OR crmNeedsYouSql`.
  - This covers drafts, classification review, Do Not Contact review, errors, delivery reconciliation, due follow-ups and handoffs, each with its action group.
  - `navBadgesSql` gains `inbox` = attention records, plus open owner decisions that have no CRM record.
  - The old `actionRequired` and `needsYou` badges stay computed for the Advanced pages.
- **Owner decisions join Needs you:** `listNeedsYou` items, linked by `crmRecordId`.
- **The Inbox route** reuses the existing ones:
  - `/api/crm/actions?scope=attention|replies` and `/api/assistant/needs-you`;
  - drafts: PATCH/send/regenerate/discard;
  - records: classification, `reviewed`, snooze, stage;
  - `/api/assistant/decisions/[id]`;
  - `/api/assistant/runs/[id]` with `{action:"mode"}`.
- **Rows carry the run's id and reply mode** (`summary.replyMode` and `lastRun.id`, both already there). That lets the Inbox switch Review/Automatic, owner/admin only, with the same confirmation as the plan card.

### UI

- **`src/app/inbox/page.tsx` + `InboxClient`**, built from `CrmActionsClient`'s rows and inline tools, not a rewrite:
  - **Needs you:** owner decisions first (the `NeedsYouList` cards: answer, resolve), then attention rows.
  - **All conversations:** the `replies` scope.
  - Channel chips: All / Email / WhatsApp / LinkedIn / Instagram.
  - Rows open `/crm/records/[id]` in the existing modal.
  - Inline **Mark reviewed** on Do Not Contact rows. Inline **reply mode** for rows in a run.
  - The URL holds `view`, `channel`, `category`, `group`, `record`.
  - The old values `view=actions` and `view=replies` are accepted.
- **Leads:** `view=board` renders `CrmPipelineClient`'s board inside `LeadsClient`, behind a List / Board switch. `CrmPipelineClient` reads `?view` and `?channel`/`?category`.
- **`navConfig.ts`:** the new three plus the footer. The duplicate entry disappears. Palette items follow.
- **Small UI fixes:**
  - the record page's back link goes to `/inbox`, or to `/leads?view=board` when that's where you came from (`?from=`);
  - the compact Needs-you banner above the chat links to the Inbox.

### Tests

- Unit:
  - `navConfig.test.ts`: three destinations, the footer, `activeHref` for old and new paths;
  - `legacyRoutes.test.ts`: every row in the table, with ids and filters kept;
  - `readiness.test.ts` hrefs.
- e2e `inbox.ts`, new, with fake inbound on two channels:
  - attention includes a draft, a Do Not Contact review, an error and an owner decision;
  - the channel filter;
  - Mark reviewed and a decision answer, both through the route functions;
  - reply mode Review → Automatic needs owner/admin;
  - a second organization sees nothing.

## N2: Outreach request workspace and Reports (L)

### Server

`src/lib/assistant/requests.server.ts` (new) plus `requests.ts`, which holds the pure parts and their tests.

**A request key covers every kind of work:**
- `r:<requestMessageId>`: an objective, or plans carrying `plan.requestId`.
- `run:<runId>`: older runs with no request id.
- `campaign:<email|linkedin|whatsapp>:<id>`: manual campaigns no run owns.

**`listRequests({channel, state, limit, cursor})`:** the newest first, 30 days by default plus anything still open. Each row: title, kind, state, channels, counts, `updatedAt`.

**`requestSummary(key)`** returns `{matching, contacted, replied, interested, failed, blocker, nextAction, children}`. Each number comes from an existing source:

| Field | Source |
| --- | --- |
| matching | `objectiveFacts().funnel.qualified` (with the funnel). For plan-only keys, the plan's assignments |
| contacted, replied, interested | `results("all_time", scope)` with `requestScope`, `runScope`, or a new `campaignScope`. These come from send evidence and applied classifications, so they survive Stop |
| failed | `reportRun` per run, or the engine's lead statuses for campaign keys |
| blocker | The objective's `waiting`. Else the first open plan's `planState` reason, plus the first blocking sender gate from `diagnoseDelivery` (at most 5 open plans, the same limit Activity uses) |
| nextAction | Pure `nextActionFor(summary)` in `requests.ts`. First applicable of: answer N in Inbox; press Start on plan X; connect or fix a sender; wait until HH:MM (reason); research running; done |
| children | Searches (jobs carrying the key's request id: state, found/contactable/match); plans (state, counts, reply mode); campaigns (links to their Advanced pages) |

**`campaignScope`** extends `reportFilter` with direct campaign ids, so manual campaigns get the same numbers.

**Routes**, every query org-scoped:
- `GET /api/assistant/requests`
- `GET /api/assistant/requests/[key]`
- `GET /api/assistant/threads/[id]/requests`: the requests a chat started, its newest first.

### UI

- **Chat page:** a right-hand **Request panel** beside the chat, for the thread's current request, with a switcher when the thread has several:
  - the seven numbers;
  - the blocker;
  - the next action, as a button: Inbox, Start, Settings, …;
  - children underneath;
  - expandable research evidence (objective sources, spend, provider) and the full final report.
  - It polls with the chat's existing rhythm.
  - Phone: a sticky summary bar above the chat that expands.
- **`/assistant/requests`:** replaces Activity's Work list, with channel and state filters. A "Manual campaigns" section lists campaigns no run owns.
- **`/assistant/reports`:**
  - `ResultsClient`'s summary numbers and period on top;
  - Analytics' tabs (overview, email, LinkedIn, WhatsApp) in expandable sections below;
  - `?view`, `?range` and `?tz` respected.
  - Same metric module, so nothing is recalculated.

### Tests

- Unit:
  - `nextActionFor` for each case;
  - request-key parsing.
- e2e `request-workspace.ts`, new, with fake providers. Three kinds of work:
  - an objective request with a plan, sends and a reply;
  - an older run with no `requestId`;
  - a manual WhatsApp campaign.

  Each summary's contacted/replied/interested/failed must equal what `reportRun` and `results()` report for the same scope, and must still hold after Stop. The blocker and next action follow a paused sender, then an open decision. A second organization gets 404s.
- The existing `metrics-parity` e2e must stay green, since Reports reuses its numbers.

## N3: Settings and "Your business" (M, sub-agent in a worktree)

### Settings rail

| Group | Contents |
| --- | --- |
| **Your business** | `/settings/business` (new: profile form, organization name and URL), Members, Teams, Instructions, Knowledge |
| **Connected accounts** | Each channel's Accounts and Connection tabs, plus the AI provider |
| **Sending & automation** | Each channel's Sending rules, plus `/settings/sending`: the "general" rules time zone, day start, phone country and the Autonomous caps |
| **Research & budget** | `/settings/research`: the objective defaults (target, hours, spend), TinyFish, research sources |
| **Advanced** | `/settings/advanced`: optional providers (Apify, Tavily, Treg) and features, plus Lead categories, Lead columns, Inquiries, Appearance |

- `SETTINGS_HOME` → `/settings/business`.
- `/settings/organization` redirects there, keeping its query.
- Every other settings URL is unchanged.
- `ChannelRulesForm` takes a `keys` subset, so the general rules split across two pages without changing storage.

### Server

- `GET/PATCH /api/settings/business-profile`, owner/admin to write, wrapping `getBusinessProfile`/`updateBusinessProfile` (`profile.server.ts`).
  - Validates against `PROFILE_TEXT_FIELDS` and `preferredChannels`/`language`.
  - Returns `profileChanges`.
- Keeping the Knowledge copy consistent:
  - `syncKnowledge` also rewrites the document when the profile is emptied, instead of leaving the old text.
  - The Knowledge page shows that document read-only, with "Edit in Settings → Your business". The Knowledge PATCH route refuses edits to it with that reason, so the copy can't drift.

### Tests

- Unit: settingsNav groups.
- e2e `business-profile.ts`:
  - a PATCH updates the profile and its Knowledge document together;
  - emptying a field empties it in both;
  - a member's PATCH is refused;
  - a Knowledge PATCH on that document is refused;
  - the chat's `save_business_info` still writes the same row;
  - another organization sees nothing.

## N4: Compact chat reports, labels, onboarding, gates (M)

### Structured events

`toolResult.data.event` with a `kind`, alongside the unchanged text:
- `search_report`: job id, source, found, contactable, funnel, note (`register.server.ts reportFinishedJob`);
- `plan_ready`: run id, leads, channels and counts (`planChannelsLine`'s inputs);
- `outreach_started`: run id, launches;
- `continuation`: n, leads, target, spend, time left;
- `autonomy`;
- `request_approval`.

### Client

- `EventRow` renders a compact line of counts, status and next action for known kinds. "Show details" opens the full text.
- **Any event without `data.event` (all older chats) renders exactly as today.** The fallback is a pure `compactEvent()` returning `null`, and it's unit-tested on stored-text-only events.

### Fixes

- **"Immediate reply" next to "Nothing is waiting on you".** Cause: `crmDueState` (`stateMachine.ts:168`) returns `immediate_reply` for a proposed classification whatever the workflow state. Meanwhile `describeConversation` (`conversationSummary.ts:196`) asks for confirmation only in `action_required`.
  - Fix: align `crmDueState` with `describeConversation`. A proposal counts as immediate only while `action_required`; otherwise the schedule decides.
  - Unit tests cover both rows from the explore map: off the queue, and `classifying` with an older proposal.
- **Getting started:** add Instagram (an `instagram` readiness item when the feature is on, reading the same connection check `channelAvailability` uses), plus `readiness.test.ts`.

### Gates

- tsc, eslint, the full unit suite;
- every e2e suite on a fresh database, plus the new `inbox`, `request-workspace` and `business-profile`;
- upgrade path (no migration expected; if any is needed, it's additive with `IF NOT EXISTS`);
- `check-organization-scope --contract`;
- `deploy.test.ts`;
- Webpack production build plus `bun server.js`: tenancy isolation (it walks every page automatically) and the smoke check, updated for the new routes;
- browser screenshots at desktop and phone width: the Outreach chat with its Request panel, Requests, Reports, both Inbox views, the Leads board, Settings → Your business, a redirected old link (`/crm/actions?view=replies&channel=whatsapp`), and an older chat's events rendered as before.

### Docs

- `docs/plans/NAVIGATION_REWORK_2026-10-20.md`: this plan, with the status of each stage.
- It supersedes the overlapping parts of `FRONTEND_WORKSPACE_REWORK.md` (marked there).
- `CONTEXT.md`: Request, Inbox, Needs you.
- Night report section, decisions, `graphify update .`, commit and push the session branch.
- Report: commit per stage, what changed, what's unverified, and VM steps (`deploy.sh` with no new migrations unless N2 or N3 needs one).

## Verification (summary)

- Every old URL in the redirect table lands on the new page with its ids and filters (unit + browser).
- The request summary's numbers equal the existing sources for objective, plan-only, older-run and manual-campaign work, and hold after Stop (e2e).
- The Inbox reaches every action: approve, edit, send, manual reply, reply mode, Mark reviewed, answer decision (e2e + browser).
- "Your business" and its Knowledge copy stay identical (e2e).
- Older chats render unchanged (unit + browser).

## Status (21 October)

All four stages are built and committed on `claude/dreamy-fermi-h5woha`.

| Stage | Commits | State |
| --- | --- | --- |
| N0 plan | `4ef89e2` | Done |
| N1 navigation and Inbox | `4df0a8a` | Done |
| N2 requests and Reports | `b9a4bd4` (server), `1f9a845` (pages) | Done |
| N3 settings and Your business | `debe2aa`, `51ea04f`, `5b1ded5`, `10d2e01`, merged in `e13d500` | Done |
| N4 compact reports, labels, onboarding | `a754f83`, `8947043` | Done; gates below |

### Where the build differs from the plan

- **Needs you rows and decisions are not double-counted.** The rows are
  `crmAttentionSql` (the Action required queue plus any draft awaiting
  review); open owner decisions are listed above them as cards. A record
  whose only reason is a decision appears once, as its card. The badge is
  rows plus decisions, and the Needs you tab shows the same number.
- **Advanced is a folded section in the sidebar**, not a footer group: it
  holds the channel groups, Sequences, data and developer pages, and opens
  by itself when it holds the current page.
- **The Leads board is board-only.** The pipeline's own list mode was the
  same rows as the Inbox's All conversations, so it was dropped.
- **Activity and Analytics pages are retired** behind redirects (their API
  routes stay). Activity's row component moved to `WorkRow.tsx`.
- **Manual replies** are written from the conversation (rows open it), not
  inline in the Inbox list; approve, edit, send, reclassify, Mark reviewed and
  reply mode are inline.
- **Structured chat events** cover search finished, plan ready, outreach
  started and research continuing. Autonomy and request-approval notices are
  already one sentence and keep their text.
- **Settings labels** (N3): Business profile, Sending defaults, Lead
  research, Providers & features; channel rule rows read "Email sending
  rules" and so on so labels stay unique in ⌘K.

### Gates (21 October, on a fresh local database)

- Upgrade path: the base schema plus the 8 migrations, run twice, matches a fresh install. No new migration in this rework.
- e2e: all 25 suites pass, including the new `inbox` (22), `request-workspace` (23) and `business-profile` (31). `assistant` first failed 72/73 on its own expectation of the old alert-email link; with the test updated it passes 73/73.
- Unit 1,904 pass; organization-scope contract passes; tsc clean; eslint 0 errors (6 warnings, all in LinkedIn files this work did not touch).
- Production build (webpack under Node, 4 GB heap) in 316 s, peak 6.3 GB on the machine; served by `bun server.js`: worker starts, tenancy isolation passes on every page and route (the same 16 review items as the last release), smoke 13/13 pages, and 38 browser checks at desktop and phone width (Inbox views, Leads board, sidebar, Requests, Reports, the request beside the chat, old links redirected with their filters, older chat events unchanged and new ones compact).
- `docker/deploy.test.ts` now fails if a default migration is missing from `.dockerignore`'s allow list (the gap fixed in `dad5303`).

### Deploying

Nothing new to migrate: `docker/deploy.sh` with its default `MIGRATIONS` re-runs the existing, re-runnable ones. Old bookmarks and the alert emails already sent keep working through the redirects.
