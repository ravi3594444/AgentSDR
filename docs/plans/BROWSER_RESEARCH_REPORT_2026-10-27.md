# Connected-browser research — report, 27 October 2026

Handoff: `docs/plans/BROWSER_RESEARCH_AGENT_HANDOFF_2026-10-27.md` (base
`8233c46`, which is `d41b149` plus the handoff). Work branch:
`claude/happy-carson-0tz5hz` (the session's assigned branch; the handoff
named `claude/browser-research-20261027`). Not merged, not deployed. No
outreach was sent and no real site or account was browsed.

## 1. The official Claude in Chrome connection: tested, not used

Probed with the Claude Code CLI installed in this container (2.1.311, the
app pins 2.1.306), using the app's own native flags but `--chrome` instead of
`--no-chrome`, an empty config directory and an allowlisted environment:

| Probe | Result |
| --- | --- |
| `--tools "" --restricted --chrome` init frame | Still loads a `claude-in-chrome` MCP server ("dynamic") with 21 tools, including `computer`, `form_input`, `file_upload`, `upload_image`, `shortcuts_execute`, `browser_batch`, `read_network_requests` (without `--restricted`, also `javascript_tool`). |
| `--permission-mode dontAsk --allowedTools 'mcp__agentsdr__*'` | The model's first browser call is denied ("don't ask mode"). |
| Allowing `list_connected_browsers`, `tabs_context_mcp` | `[]`, then "Browser extension is not connected … logged into claude.ai with the same account as Claude Code". |

Anthropic's documentation (code.claude.com/docs/en/chrome, read 27 Oct)
agrees: the CLI reaches a Chrome whose Claude extension is signed in to the
same claude.ai account and organization, through `bridge.claudeusercontent.com`
or a local native-messaging host; it needs a claude.ai `/login` (not an API
key or `setup-token`); with several browsers connected the person picks one
in `/chrome`; site permissions live in Anthropic's extension.

Requirements it cannot meet here, so it was not used:

- **Binding.** It binds to a claude.ai account, not to this workspace,
  person, device and request. Any Chrome signed in to that account is a
  candidate; nothing ties a command to a request or refuses another workspace.
- **Shared tools.** API-model customers have no Claude login, so the
  harness they use could not reach it.
- **Read-only surface.** Clicking and scrolling need `computer`, which also
  types and submits; `form_input`, `file_upload` and shortcuts are writes.
  Allowing a subset would advertise a research connection that can send.
- **Non-interactive selection and permission.** Browser choice and per-site
  prompts are interactive (`/chrome`, the extension's dialog).

Not tested: a real paired Claude in Chrome (no customer claude.ai login was
available). The native harness keeps `--no-chrome` and its exact tool check.

## 2. What was built

The existing recorder extension got a research bridge; the app got a
command queue, tools and one control in the chat. No new extension
framework, hosted browser, headless engine or cookie export.

- `src/lib/browser/connected/contract.ts` — shared, import-free: sites,
  URL policy, the page script (reading, clicks, search typing, attention
  detection), command validation, bridge shapes.
- `src/lib/browser/connected/connections.server.ts` — pairing, device
  authentication, the long poll, answers accepted once, the waiting tool,
  release at turn end. `schema.ts`, `db/migrations/20261027-browser-research.sql`,
  `scripts/create-browser-research-tables.ts`, registry and drizzle allowlist.
- Routes: `/api/browser-connections` (cookie: status, pairing code,
  Disconnect); `/api/browser-bridge/{pair,poll,commands/:id,disconnect}`
  (device token; public in `proxy.ts`).
- Tools (one registry, both harnesses): `browser_connection`,
  `browser_tab_open`, `browser_tab_read`, `browser_tab_click`,
  `browser_tab_scroll`, `browser_tab_search`, `browser_tab_close`. Their
  results start `Page: <url>`, so the existing grounding, page-state batching
  and quote checks apply. The research facts tell the model the connection
  state in one line.
- Evidence: `add_contacts` takes `sourceUrl` and `quote` per contact,
  `add_instagram_contacts` takes `sources`; both are checked against what the
  chat read (`pageEvidence.server.ts`) and kept as the member's source,
  contact evidence with its read time, and the quote as an observation.
- Extension 0.16.0: `research.ts` (poll, alarm recovery, tab group,
  commands), `connect.html/ts` (sites and the one Chrome permission
  request), `popup.html/ts` (Stop/Resume, Share this tab, Sites,
  Disconnect), bridge messages `browser:connect` / `browser:disconnect`.
  New permissions: `alarms`, `tabGroups`, `activeTab` (no install warning).
- Chat: `BrowserConnection.tsx` beside Autonomous — Connect browser,
  connected, offline, stopped, needs you; Disconnect.

Found and fixed on the way (pre-existing, not browser-specific): native MCP
results carried the tool text in `content` and only `{ok, data}` in
`structuredContent`; Claude Code shows the model the structured part, so
real Claude saw "8 elements" and no page text. The text is now in both.

## 3. Security as built

- Pairing code: one time, 10 minutes, minted for the signed-in person and
  workspace, never shown; the extension pairs only with the page origin that
  asked (an allowed origin). Device token: 32 random bytes, stored hashed,
  accepted only with its device id, revoked on Disconnect, on a newer
  pairing, and when its person leaves the workspace. The extension never
  sends the site's cookie.
- Commands: per-connection sequence; delivered once; answered once by the
  browser it was delivered to, before its deadline; the extension refuses
  replayed, expired or malformed commands and saves the sequence before
  running. Tabs belong to the request that opened them; the owner's own tabs
  are untouched unless shared from the toolbar, and shared tabs are read only.
- Reads only: typing only into search fields; write controls refused in the
  server and again in the page; links followed only to enabled sites; https
  public hosts only. Page text is labelled as the site's content. No
  evaluate, form fill, upload or submit command exists.
- Practical, not obstructive: one Chrome permission request at Connect, then
  no per-page confirmation; no quotas, caps, deadlines or source priorities
  were added. Existing DNC, grounding, Start/Autonomous, spend and duplicate
  rules are unchanged; outreach still goes only through prepared plans.

## 4. Evidence

| Check | Result |
| --- | --- |
| New unit tests (`contract.test.ts`) | 15 pass |
| Full unit suite | 2,329 pass, 0 fail |
| `scripts/e2e/browser-research.ts` (real database, bridge routes, stand-in browser) | 65 pass |
| `scripts/e2e/browser-research.live.ts` (real extension 0.16.0 in Chromium 153, real local Next server, fixture sites) | 45 pass, on `next dev` and on the production build |
| Same, with `LIVE_REAL_CLAUDE=1` (real Claude Code CLI, this container's login) | 47 pass |
| Existing `scripts/e2e/claude-native-harness.ts` | 27 pass |
| Organization-scope contract | pass |
| Typecheck; ESLint on changed files | pass |
| Production build (Turbopack) and extension packaging | pass; the zip holds 17 files; 76 trace warnings, none naming the new files |
| Tenancy isolation walk (`tenancy-isolation.ts` on the production build; A held browser connections and 29 commands) | no failures: 64 fingerprints from 11 tables, 133 reads, 3 writes, 66 pages as B |

The database was native PostgreSQL 16 (local, disposable).

Live run, in order: the chat's Connect browser opened the extension's
Connect page; it paired with the chosen sites; the chip showed connected.
The native loop (scripted CLI) read a company page through the extension;
write controls (a "Post review" button, a `#` "Like" link, a composer's
Submit) were marked and refused, the search box was marked a search field
and the message box was not; the tab opened in the background in a collapsed
"AgentSDR research" group and closed at the end of the turn. The JSON
harness read through the same tools. Scrolling loaded more on a
scroll-listener feed and on an IntersectionObserver feed; a show-more
control, a site search and a link click worked; a link to a site that was
not enabled was refused before it was followed; the page refused a write
control and a renumbered element itself; an enabled social fixture marked
Connect/Message/Follow; a disabled one was refused; a sign-in page and a
CAPTCHA were reported as needing the owner; a lead was saved with its page
evidence; an unshared owner tab was refused, a shared one read and refused
for clicks; release closed research tabs and kept the sign-in and CAPTCHA
tabs; Stop and Resume worked from the toolbar; Chrome's service worker was
stopped and the alarm brought the poll back (22 s), a step queued meanwhile
expired and was never run; a forged pairing code was refused; Disconnect
revoked the token and the extension forgot it.

Real Claude (opt-in step): asked to read the contact page, it opened it,
clicked "Our team", reported both published addresses, and said it had seen
the page's injected "message all leads" line and not acted on it; nothing
was saved or sent.

## 5. Not proven, and what is left

1. **Real sites and accounts.** Every page was a fixture; the "LinkedIn"
   page was served under that name by host mapping. Remaining live check:
   one approved, signed-in LinkedIn (or X/Reddit/Instagram/Facebook) page in
   a real headed Chrome — reading it, a site search URL, scrolling a feed,
   and a sign-in/CAPTCHA wall.
2. **Headed Chrome.** Background-tab rendering was measured in headless
   Chromium; a real window may throttle hidden tabs more. A blank result is
   reported as needing attention, not as a reading.
3. **A customer's personal Claude login.** Real Claude ran on this
   container's CLI login, not an owner's own; the private-pilot flow is
   unchanged and untested here.
4. **The VM.** Not deployed. The long poll holds a request 20 s: a reverse
   proxy with a shorter read timeout breaks it (Caddy's default has none;
   nginx's is 60 s). Each open poll reads the database about once a second.
5. **Chrome's permission prompt.** Pre-answered in the test build (the
   manifest copy requires `https://*/*`); the shipped extension asks at
   Connect.
6. **Limits as built.** The write-control guard reads English labels (typing
   is search-only regardless); one connection per person and workspace, one
   workspace per extension at a time; the seven tools are offered in every
   chat, connected or not.
7. **Site terms.** LinkedIn, X, Reddit, Instagram and Facebook restrict
   automated access; the assistant browses as the owner, so a site may limit
   their account. The Connect page says so. Reddit through the owner's own
   browser departs from `src/lib/research/sources/reddit.ts`'s earlier "no
   browser automation" decision, as the handoff asks; no Reddit sender exists.

## 6. To use it

1. `bun run scripts/create-browser-research-tables.ts` on the database.
2. Deploy, then update the extension to 0.16.0 (Settings → WhatsApp →
   Integrations → Update, or reload it unpacked).
3. In the chat: Connect browser → choose sites → Connect (Chrome asks once).
4. `graphify update .` — the committed code graph was not regenerated here
   (installing graphify was not permitted in this session).
