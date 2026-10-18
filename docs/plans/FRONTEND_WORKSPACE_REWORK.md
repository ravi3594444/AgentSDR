# Frontend workspace rework

18 October 2026. Based on `claude/new-session-g5hljn` at `640b2d6`.

Frontend implementation: `5fb1a51`, ready for agent testing on
`claude/new-session-g5hljn`. Deployment and visual acceptance remain pending.
The views use the existing organization-scoped APIs. Research and workflow
fixes in the implementation handoff remain separate work.

## What changes

- Leads & replies opens the CRM conversation list by default. All categories
  are visible initially. Board remains available as an alternative.
- Conversations, Action required and Contacts link to each other. The saved
  People/company database remains available under Contacts.
- Pipeline rows give the latest reply and status more width, without an
  empty draft column. Smaller screens use full-width cards.
- Records open in a wider conversation workspace. A second composer is shown
  only for a pending draft or when explicitly opened. A WhatsApp follow-up
  after an answer is labelled optional; DNC disables that composer.
- Answer status comes from recorded inbound/outbound messages. Actor labels
  use recorded evidence and otherwise say Reply sent.
- Visible records refresh from the CRM, and record-change events refresh
  affected rows, navigation badges and report data. Unsaved editing remains
  protected; viewing a record does not send or approve anything.
- Overview replaces the separate Results navigation entry. Analytics stays
  available as its reporting tab and through its existing URL. Summary numbers
  are smaller; detailed reporting sections are expandable.
- Analytics keeps its real charts and date controls, with compact headline
  metrics and expandable CRM detail.

## Verification

- TypeScript: `NODE_OPTIONS=--max-old-space-size=4096 node node_modules/typescript/bin/tsc --noEmit` passed.
- ESLint passed on every changed TypeScript/TSX file.
- 43 focused tests passed across conversation summary, navigation, manual
  outbound handling, CRM state transitions and source-result summaries.
- Node/Webpack production build completed with exit 0, including TypeScript
  and all 105 static pages. The recorder package had already been built.
- `git diff --check` passed.

The build retained existing dynamic-require warnings in the formula sandbox.
Local production auth settings were absent, so Better Auth also warned about
its URL and secret. Standalone tracing reported `ENOTDIR` while copying the
local symlinked `node_modules`; this does not validate a runnable standalone
package or Docker image. Docker packaging and authenticated runtime behavior
still need verification in the deployment environment.

No browser automation, screenshots, production migration or live send was
performed. Visual acceptance is still pending.

After deploying, manually check:

1. Open Leads & replies: the default is a readable list; open Board and return.
2. Open the pricing enquiry: read the full thread and the recorded answer.
   Confirm a manual follow-up is optional and the contact's current category
   and restrictions remain visible.
3. Type without sending, wait for a refresh, and confirm the text is preserved.
   A newer inbound reply or DNC update must still appear and prevent stale sends.
4. Answer from WhatsApp Web and verify the record, list and badges refresh.
5. Open Action required, Contacts, Overview and Analytics. Check filters, old
   direct links, channel selection, keyboard focus and narrow-screen layout.

## Remaining work

The shared Work/Replies surface, objective continuation, source routing,
per-person overlap resolution, wrong-number apology and deeper reporting/
handoff correctness remain in the implementation plan. Existing server-side
sending, approval, DNC, takeover and uncertain-delivery behavior is preserved.
