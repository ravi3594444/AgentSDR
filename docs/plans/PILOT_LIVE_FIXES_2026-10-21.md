# Pilot live-check fixes L01–L05 — 21 October 2026

Branch `claude/pilot-fixes-l01-l05`, from the deployed pilot revision
`652c84d` (`codex/pilot-deploy-20261021`). It fixes only the five findings
of `PILOT_LIVE_CHECK_2026-10-21.md`: no new providers, features or
redesign, no migration. The narrowed AI/ML fallback and the Bright Data
B01–B03 and deadline fixes are untouched. Not merged, not deployed.

## Commits

| Commit | Finding |
| --- | --- |
| `c6336d0` | L01: budget wording never authorizes outreach |
| `0cd8933` | L02: how the research runs is not a requirement |
| `6d5d6fd` | L03: a request keeps working while its research continues |
| `bb0994f` | L04: every chat time is written in the organization's time zone |
| `6ad8991` | L05: Getting started says replies follow each plan's reply mode |
| `f0acf31` | L01 after review: research-only is a veto, genuine requests stay requests |
| `9aa07c6` | L02 after review: the subject keeps every lead condition; the request outranks the saved customers |
| `a80fb45` | L03–L05 after review: paused research, owner-zone times on every outreach page, Inbox wording |

Three adversarial reviews (authorization and qualification; state, time and
copy; regressions and mutation testing) confirmed about twenty problems in
the first five commits, several of them regressions the first L01 fix
introduced ("contact them for me" and "run the email sequence" stopped
counting as outreach). The last three commits fix them, each with a test
that failed first.

## What changed

- **L01 (`agent.ts`).** Outreach words of four letters or fewer (send,
  mail, dm) no longer match typos, so "spend" is not "send"; a near-miss
  set covers real words ("each", "constant", "gmail", "following"). A
  research-only or no-contact statement in the owner's latest message is a
  veto with wide recall (curly apostrophes, comma lists of channels,
  Hinglish "mat karo", "zero outreach", "I'll contact them myself") and it
  cancels an earlier pending outreach request. A channel word is data only
  before a detail noun or when the owner is the recipient ("send me their
  emails"); "contact them for me" is still outreach.
- **L02 (`leadFit.ts`, `qualify.server.ts`, `writer.server.ts`).** The
  sorter judges the request's subject (`requestSubject`), which drops only
  clauses that are nothing but an instruction (budget, time, sources,
  research-only, save the list) and keeps every lead condition ("with no
  website", "on Instagram", "reachable by phone"). Its prompt says the
  request's kind and place replace the saved target customers and that run
  instructions are never requirements. With a request, relevance comes from
  `requestFit` alone; a "skip" only means no message (plan preparation
  already leaves skipped leads out). A lead whose facts name no business or
  person is never a match.
- **L03 (`requests.ts`, `requests.server.ts`, `objective.server.ts`).** One
  `requestState` decides the label and open flag: an active objective keeps
  the parent request open through the gap between jobs; a paused one reads
  "Research paused" with "Resume the research" as the next step; the
  objective's driver job is never listed as a child or picked as the
  request. Legacy standalone jobs and runs keep their own entries.
- **L04 (`chatTime.ts`, `AssistantClient.tsx`, Reports, Requests, Needs
  you).** Every owner-visible time is formatted in the organization's time
  zone (`organizationTimeZone`, the policy Reports already use), on the
  server and in the browser alike; `suppressHydrationWarning` is gone.
  Stored instants stay UTC.
- **L05 (`readiness.ts`, Getting started, AI settings, run narration).**
  Replies follow each plan's Review or Automatic mode, and what needs the
  owner waits in the Inbox (Needs you). Wording only: no reply mode or
  sending permission changed.

## Checks offline (stand-in model and fake providers)

These prove the wiring, not a real model's judgement.

| Check | Result |
| --- | --- |
| `npx tsc --noEmit` | exit 0 |
| ESLint on the 35 changed files | exit 0 |
| `npm test` | 1,997 pass, 0 fail, 194 files |
| request-workspace e2e | 30 pass, 0 fail (4 failed before the L03 fix) |
| objective e2e | 85 pass, 0 fail (6 fail with the deployed `agent.ts`) |
| assistant e2e | 73 pass, 0 fail |
| full-flow e2e | 33 pass, 0 fail |
| web-discovery e2e | 110 pass, 0 fail |
| inbox, reply-agent e2e | 22 and 108 pass, 0 fail |

Mutation runs: with the deployed `agent.ts` the objective suite fails six
checks (a contact-after search actually starts under "Research only. Spend
$0. Do not contact anyone."); with the deployed `writer.server.ts` it fails
one; reverting each fix turns its unit tests red.

## Results live (this container, real AI/ML model and real TinyFish)

- **Synthetic CRM reply probe** (`diagnose-reply-agent.ts`'s probe,
  `deepseek/deepseek-chat`, live catalog): the json_schema request was
  refused with HTTP 400 ("response_format.type: Expected 'text' |
  'json_object'"); the one function-call fallback answered HTTP 200 with a
  valid reply decision. Two requests, nothing stored or sent.
- **Lead judging, real model.** The pilot prompt, four fixture leads (two
  Pune clinics, one Mumbai clinic, one directory email naming no clinic)
  and the pilot workspace's profile (target customers real estate agents
  and salons, so dental clinics are a niche override):

  | Revision | Runs | Runs that rejected a Pune clinic | Directory email judged a match |
  | --- | --- | --- | --- |
  | deployed `652c84d` | 8 | 4 ("the owner asked for research only with no outreach") | 0 |
  | `6ad8991` (first fix) | 30 | 2 ("the owner's offer targets real estate agents and salons") | 1 |
  | `9aa07c6` (after review) | 30 | 0 | 0 (unconfirmed every time) |

  With a profile that already targeted dental clinics the deployed code
  passed: the bug needs the niche override to show, which is why the first
  offline checks missed it.
- **The pilot request repeated** ("Research only. Find 3 dental clinics in
  Pune, India. Use free sources only with a $0 source budget, and finish
  within 5 minutes. Save a lead list. Do not contact anyone. No outreach. No
  messages. No campaigns."), real model and real TinyFish Search, in a
  throwaway organization with the same niche-override profile. No Maps
  scraper exists here (it is a VM sidecar), so websites and directories
  were the free source. Three runs on `a80fb45`:

  | Run | Path | Qualified | Not matching | Unconfirmed | Stop | Reports | Spend | Plans, start jobs, campaigns |
  | --- | --- | --- | --- | --- | --- | --- | --- | --- |
  | 3 | inline research (see below) | — | — | — | no objective | 0 | $0 | 0 |
  | 4 | lead search job | 2 | 3 booking platforms | 11 directory emails | sources exhausted, 55 s | 1 | $0 | 0 |
  | 5 | lead search job | 3 | 2 booking platforms | 11 directory emails | target reached, 37 s | 1 | $0 | 0 |

  In runs 4 and 5 the objective took the owner's target, time and $0 cap
  from the words, and the parent request, sampled every two seconds, never
  read Done while its objective was active and stayed the default pick.
  Unidentified directory emails stayed unconfirmed and were not counted.
- **Production build and L04 in a browser**: see the next section.

## Production build and L04 in a browser

Code `a80fb45` (the docs commit after it changes no code), in this
container: no Docker daemon, so the image itself was not built.

- **Build as the Dockerfile builder**: the recorder package, then `next
  build --webpack` under Node 22 with a 4,096 MB heap: exit 0 in 358 s;
  the build's processes peaked at 5.9 GB together.
- **Served as the image's CMD**: `bun server.js` from the standalone output
  with `TZ=UTC`, every sender paused, the local isolation database:
  `/sign-in` 200, the assistant worker's start line present.
- **Tenancy isolation** (`scripts/e2e/tenancy-isolation.ts`, every page):
  no isolation failures. **Smoke**: 14 pages answer 200 (Outreach, Requests,
  Reports, both Inbox views, Leads list and board, Getting started, five
  settings pages).
- **L04 in Chromium**: server in UTC, browser in Asia/Kolkata (Chromium
  names it Asia/Calcutta), organization in America/New_York, an owner
  message stored at 11:18:10 UTC (the pilot's instant: 4:48 PM in India).

  | Where | Shown |
  | --- | --- |
  | Server-rendered HTML | 7:18 AM |
  | After hydration | 7:18 AM |
  | After a full reload | 7:18 AM |
  | After leaving and reopening the chat | 7:18 AM |
  | Hydration warnings | none |

  A first attempt opened the chat seconds after the zone was changed and
  showed 11:18 AM (UTC) in the HTML and the page alike: Sending rules are
  cached 30 s per process, so a zone change reaches pages within 30 s. The
  browser's own zone never appeared, which was the pilot's defect.
- Built inside a nested worktree, Next puts `server.js` under the
  worktree's path in the standalone output; the Docker builder works at
  `/app` and is unaffected.

## Not fixed here (follow-ups)

- **Inline research leaves no objective.** In one of three runs the model
  researched in the chat itself (web search, four clinic pages read, three
  contacts saved as a list) instead of starting a lead search, so no
  objective, no final report and a loop-guard ending ("I stopped here so I
  don't go round in circles"). Nothing was contacted. This path predates
  these fixes; tying inline saves to the request's objective is its own
  change.
- Questions about state ("How many emails did we send?") still read as an
  outreach request, as on the deployed revision.
- `requestSubject` keeps a few control clauses it is unsure of ("free
  only", "then follow up after 3 days"); the sorter prompt says such
  instructions are no requirement.
- A lead the request asks for but the sorter would not message (a
  competitor of the owner, say) now counts toward the target while still
  never being messaged. This is the intended split between relevance and
  messaging.

## Pending (owner and VM only)

- Repeat the same research-only request on the VM after deploying, with the
  Maps scraper as the first source, and check the request panel there.
- One controlled reply test in Review or Automatic mode with an
  owner-controlled recipient (not the customer who already received the
  holding reply).
- The same reply probe on the VM against the owner's organization record:
  `bun scripts/diagnose-reply-agent.ts --record-id <id> --probe`.
- Bright Data stays off until an owner turns it on with a fresh key; rotate
  the key pasted in chat during the Bright Data pilot.

## Deploying (only on the owner's instruction)

No migration. The same deploy as `PILOT_DEPLOY_2026-10-21.md` with this
branch: `git remote set-branches --add origin claude/pilot-fixes-l01-l05`,
then `bash docker/deploy.sh --branch claude/pilot-fixes-l01-l05`. Existing
campaigns, reply modes and sending limits are not changed by it.
