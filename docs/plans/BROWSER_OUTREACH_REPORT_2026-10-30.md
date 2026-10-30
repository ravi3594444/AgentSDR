# Browser outreach, task authorization by kind, and the rest of the 22nd x ai browser work

Branch `claude/interactive-browser-20261028`, continuing from `d936b38`. For review only: nothing merged or deployed.

## What a request like "find leads and outreach them using my browser" now does

1. **Research and qualify** as before. A lead found on X, Instagram, Facebook or LinkedIn can be saved by its profile alone (`add_contacts` `profileUrl`, grounded on the page it was read from). `check_browser_routes` opens profiles read-only and records whether a profile offers a Message button, says the person cannot be messaged, or does not exist.
2. **Plan.** "using my browser" makes the owner's browser the plan's only channel; sites named beside it (Instagram, LinkedIn) are where it goes. X or Facebook named means the browser. When the owner names no channel, the browser comes last, after the providers. A lead with only a profile, or a workspace without Unipile or email, is still reachable.
3. **Start or Autonomous mode.** Nothing changes about authorization: Start, or Autonomous mode's caps, still decide. Start queues one row per message (`browser_outreach_sends`), the claim that keeps it from going out twice. Follow-ups wait for the message before them.
4. **The courier** (production tick, `PAUSE_BROWSER_OUTBOUND`) sends in the background. For each message it:
   - claims it under that browser's lock, re-checking the run, Do Not Contact, a reply already received, the pacing, the new conversations per site account, and the daily new-lead limit;
   - opens the profile in the owner's Chrome, then lets the organization's AI find the way step by step;
   - has the code check every step: only the approved text is typed; one message is opened and sent once, only with that text in the box and the signed-in account confirmed on the page (and the same account earlier messages on that site came from); invite, follow, post and pay are refused.
   
   "Sent" means the page shows the text. Otherwise the message is **uncertain**: it is never resent and its follow-ups stop.
5. **When it cannot send**, the row says why and when it looks again: Chrome offline (with the time it was last seen), Stop pressed in the popup, a sign-in only the owner can do, an old extension, website access, pacing, or the day's allowance. A profile that cannot take a message is **blocked** with the site's own words, and its new-lead place is given back.
6. **CRM and Inbox.** A conversation is a profile seen from `"<site>:<handle>"`. The first reply brings the browser history in, like every other outreach channel. Replies are read from the conversation in the sender's idle browser every `replyCheckMinutes`. A reply counts only when the page shows those words more often than the known conversation does, so the owner's own message (signature and all) is never taken as the lead's. A reply from the Inbox or the reply agent goes out through the same courier; with Chrome offline it is deferred with the reason.

## Restrictions removed and controls kept

**Removed:**
- **Per-domain naming.** The owner no longer names each domain for a task.
- **Website access.** It is now "Allow all websites" or "Choose specific websites" (social sites plus listed domains), asked of Chrome once.
- **Blanket refusals.** The unconditional refusals of messages, replies, invitations, posts, form submissions and purchases are replaced by a grant per request, by kind: `interact`, `message`, `publish`, `purchase` (with the total the owner agreed) and `open_tabs`. One structured call judges the kinds, and it is shown the owner's messages and nothing else; earlier messages are marked as context.
- **Existing tabs.** `browser_tab_use` adopts a tab the owner has open (never closed, put back afterwards); `browser_tab_show` brings a tab up for the owner.
- **Native harness limits.** Turn, call and time limits now checkpoint and resume the session instead of ending the work (agent B).
- **Effort.** The Claude Code engine now stores the owner's effort and passes it to every run as `--effort`.

**Kept, in code:**
- A research request grants nothing.
- Website text never grants anything (the judge never sees it).
- **Messages:**
  - A message names its recipient, checked against Do Not Contact.
  - A first message to a lead the owner did not name goes through the plan and its approval, never directly through `browser_tab_act`.
  - Only the step whose recipient was checked carries `message` to the extension.
- **Purchases:**
  - A purchase needs the page's total, within the agreed limit and shown in the latest reading. Only that step carries `purchase`; screen-point steps never do.
  - Passwords, full card numbers and codes are never read or typed; the owner types them, with `browser_tab_show` bringing the tab up for them.
- **Lost answers:** a change whose answer was lost blocks further changes in that tab until it is read.
- **Native Claude harness:** `--no-chrome`, `--tools ""`, `--restricted`, the MCP allowlist and the file-read denials stay. There is no fallback model or provider.
- **Outreach rules:** Do Not Contact, the daily lead limit, per-channel pacing, Start / Autonomous approval, no double sends, and tenancy.

## Checks, and what each used

| Check | Kind | Result |
|---|---|---|
| `npm test` (229 files) | unit | **2,420 pass**, 0 fail |
| `npx tsc --noEmit` | types | pass |
| `eslint src scripts/e2e extensions/whatsapp-recorder/src` | lint | 0 errors (6 warnings, all in LinkedIn files this branch never touched) |
| `scripts/e2e/browser-page-rules.ts` | real Chromium DOM, page script | **77 pass** |
| `scripts/e2e/browser-tasks.ts` | real database and bridge routes, stand-in extension, scripted judge | **35 pass** |
| `scripts/e2e/browser-outreach.ts` | real database, stand-in extension, scripted courier and writer | **19 pass** |
| `scripts/e2e/browser-research.ts` | real database, stand-in extension | **69 pass** |
| `scripts/e2e/research-agent-v2.ts` | real database, guard rails through `runTool` | **51 pass** |
| `scripts/e2e/browser-tasks.live.ts` | **real extension** (0.18.0) in Chromium under Xvfb, real local server, fixture sites | **31 pass** |
| `scripts/e2e/browser-outreach.live.ts` | **real extension**, real server, X-like fixture; `LIVE_REAL_CLAUDE=1` | **11 pass**; **real Claude** (this machine's CLI login, Sonnet) delivered the approved text in 4 checked steps, verified on the page |
| `scripts/e2e/tenancy-isolation.ts` | real server and database | 0 failures: A's data from 21 tables, 133 reads, 14 writes, 66 pages as B |
| Fresh `db/schema.sql` + migrations twice + `check-organization-scope --contract` | new empty database | pass |
| `bun run build` (Next.js and extension zip, 17 files) | production build | pass |
| Inbox and lead record at 1440 and 390 px, light/dark preference | real server, Playwright | browser conversation named Browser, reply shown, no horizontal overflow (`browser-outreach-2026-10-30/`) |
| `scripts/e2e/channel-policy.ts` | real database | 3 email-queue checks fail **on `3b5b00c` too** (before this work); the one change this work caused is expected and updated |

## Not tested, said plainly

- **No signed-in real site.** Every delivery ran on fixture pages that I wrote (X-like profile, Message button, contenteditable box, Send). X's, Instagram's, Facebook's and LinkedIn's real DOMs (Draft.js editors, message overlays, request folders) are untested. The model-driven courier is meant to adapt, but that is unproven until a controlled account is used.
- **No real desktop.** Xvfb only, as before: covered or minimized task windows, OS focus, and Chrome's own surfaces (autofill, passkey and payment sheets) were not exercised. The extension cannot operate Chrome's own UI and does not claim to.
- **No real checkout.** Purchases were checked against a fixture checkout page; no sandbox payment provider was run.
- **Capacity.** The courier is an in-process tick that delivers one message at a time per server process; a delivery takes several AI calls.
- **Reply reading.** Replies are read from the conversation's visible text (the reading is capped), so very long threads can hide older messages.
- **Reporting gaps.** Period reports (`REPORT_CHANNELS`) and wrong-number routes do not cover the browser channel yet; the run report does.
- **From agent B's report:** Opus on a customer's own login, and the 60-minute turn pause, have no live run.
