# UI and UX polish — 25 October 2026

Branch: `codex/ui-ux-polish-20261025`, on top of the research-intent fixes.
The public waitlist is a separate Site, published at
https://join-22nd-x-ai.belugaremodeling.chatgpt.site/ .

## Public waitlist

- Name, wordmark, browser title, metadata, favicon and sharing image now say
  **22nd x ai**. The Site ID and signup database stayed the same when its
  URL changed.
- A warm neutral palette, editorial typography, clearer product copy,
  interactive workflow illustration and FAQ explain the product and early access.
- Signup uses the existing protected endpoint and private database. The build,
  typecheck, twelve endpoint checks and browser rendering passed. An owner
  signup was also confirmed in the live database; no address is stored here.
- The owner can view `waitlist_signups` in Site settings → Database, or
  request a read/export through the connected Site tools. Visitors do not
  have a public list endpoint. Page visits alone do not identify a person.

## App changes

- The central brand copy now matches **22nd x ai** and includes Instagram in
  the product description. Technical identifiers and upstream attribution
  retain their existing names.
- Requests and Reports share one More menu in the chat header. Inbox and
  New chat stay directly accessible. The composer has a short sending-mode
  note instead of repeating the full autonomy explanation.
- A live activity group names its current tool in ordinary present-tense
  language. Completed steps remain in the expandable log.
- A failed update has a short explanation, expandable error details and
  Refresh status. This button reads saved status; it does not replay a tool
  or send a message. The notice can be dismissed.
- The phone request bar names the actual request and state. Its expanded
  view retains the next action and controls. The desktop request panel is
  narrower to leave more room for the conversation.
- Panel data is keyed to its chat/request, and stale responses are rejected
  with the existing response gate. The chat also rejects stale poll and
  navigation responses, reports conversation-loading errors, and prevents
  actions while a conversation switch is unresolved. Background work is
  not cancelled by viewing another chat.
- Failed status reads preserve the last good summary with an out-of-date
  notice and a Refresh action, rather than silently removing the panel.
- Contact details start closed on devices without an explicit saved choice;
  an existing open/closed preference is kept. Inbox notices wrap on phones
  instead of cutting off the reason. An empty channel-filtered Inbox names
  that channel rather than implying every channel is clear.

## Validation and limits

Typecheck and changed-file lint pass. The full application/scripts suite
passes under TZ=UTC: 2,245 tests, zero failures. Six unchanged parser
timing checks exceeded their limits during a concurrent AST rebuild; the
serial run passed without changing their assertions. The production
Next.js webpack build exits 0. Fonts used a build-only offline fixture
outside the repository; no Docker image was built here.
The earlier research-card fixture was also corrected to use its typed
message/job factories and an explicit timezone on the parent branch.

The app was not exercised in a browser or on the VM for this pass. Repository
instructions prefer implementation and lightweight checks for UI changes.
These changes do not verify live provider delivery or close the separate
safety-audit findings. No schema change is introduced by this UI pass; an
older VM still needs the parent research branch's migration.

The AST graph is rebuilt locally. Its generated graph exceeds the
connector's snapshot limit and can be recreated with `graphify update .`.

After deployment, the focused visual check is: open Outreach on a phone;
switch between two chats and check that each shows its own request; open
Requests/Reports from More; and open the Inbox's contact details explicitly.
