# Live pilot check — 21 October 2026

## Verdict

The VM is running the expected release, `652c84ddd7633efa2dfc0735a115b971e334fe1c`. The new workspace loads and real providers return research results. Live acceptance is **not complete**: the research-only pilot exposed a qualification error, and a local reproduction on this exact revision exposed an outreach-authorization error. Fix these before starting Claude subscription-login work.

This report records inspection and one bounded research test. It changes no application code, account settings, sender limits, plan approvals or campaign states. No test outreach plan was prepared or started and no test recipient was messaged. Existing approved campaigns were already running.

## Checks that worked

| Flow | Evidence on the deployed app | Limit of the check |
| --- | --- | --- |
| Deployment | The owner's Docker inspection reports revision `652c84d`, started `2026-10-21T11:01:07.908913937Z` | Individual database column checks were not rerun through SSH |
| Main navigation | Outreach, Inbox, Requests, Reports, Leads List/Board, business settings, research settings, provider settings and Getting started load | Desktop browser only; no mobile viewport control is exposed by this browser tool |
| Inbox | Needs you has one conversation, matching the sidebar badge. All conversations has seven, including Instagram and WhatsApp; the interested conversation is visible. Instagram filtering yields one conversation | Reading existing conversations does not prove a new inbound webhook |
| Replies and Do Not Contact | An existing Instagram conversation displays the opening DM and subsequent inbound/outbound messages. Answered rows say they await the lead's reply. The wrong-number record is blocked and offers Mark reviewed | No review was marked complete and no draft was approved |
| Email | The LA real-estate email campaign records 20 contacted, 20 emails sent, zero failed sends, nine new contacts today. Reports also shows nine emails today | These are recorded accepted sends, not proof of recipient-inbox delivery |
| WhatsApp | The Chicago plan shows six contacted and six failed. Failures identify recipient rejection instead of claiming everyone was contacted | No new send or registration check was forced |
| LinkedIn | Existing plans show a recorded invitation-limit blocker and the next local sending window. The seven-day report distinguishes three invitations from zero direct messages | Provider reset time was not independently verified; do not clear or raise the limit to make this check pass |
| Research providers | The new pilot uses the built-in Maps scraper, then websites/directories through TinyFish Search. Results and website evidence are saved; one final stopped report appears | Its qualification result is incorrect: see L02 |
| Default AI | Settings and Getting started identify AI/ML `deepseek/deepseek-chat` as the default; the live assistant request and continuation answered without a visible format/HTTP failure | This does not verify the CRM reply-decision schema, nor prove which wire format was used |
| Defaults | Research settings show 25 qualified leads, four hours and a $5 source cap. The pilot overrides these to three leads, five minutes and free sources only | AI chat/judging/writing token charges are excluded from the source cap |
| Old links | Opening `/activity?view=replies&channel=instagram` reaches `/inbox?view=all&channel=instagram`, preserving the filter | Other redirect paths were not all retested live |

## L01 — Research budget wording can authorize outreach

**Confirmed locally on the deployed revision. High priority; authorization defect.**

`outreachRequested("Research only. Spend $0. Do not contact anyone.")` returns **true**. Replacing `Spend` with `Budget` makes it return false. No live request containing this failing wording was submitted.

Root cause visible in `src/lib/assistant/agent.ts`: `isOutreachWord` accepts a one-character edit for `send`, so `spend` matches; `outreachIntent` accepts any positive match even though another clause explicitly forbids contact. Similar nouns such as an email requested as data also need regression coverage rather than automatically granting permission.

Reproduce without network calls or sends:

```bash
bun --conditions=react-server -e 'import { outreachRequested } from "./src/lib/assistant/agent"; for (const text of ["Research only. Spend $0. Do not contact anyone.", "Research only. Budget $0. Do not contact anyone."]) console.log(JSON.stringify({text, outreachRequested: outreachRequested(text)}));'
```

Expected: both are research-only. Fix intent interpretation without removing support for genuine outreach requests or their common typos. Explicit research-only/no-contact language must prevent inferred outreach permission. Add server-path checks proving that such a request cannot create contact-after work, auto-start a plan or enqueue a send in Autonomous mode. Do not test this by turning Autonomous on against real prospects.

## L02 — Sending restrictions contaminate lead qualification

**Confirmed live. High priority; blocks the research-only acceptance case.**

Exact submitted prompt:

> Research only. Find 3 dental clinics in Pune, India. Use free sources only with a $0 source budget, and finish within 5 minutes. Save a lead list. Do not contact anyone. No outreach. No messages. No campaigns.

The test chat's Autonomous switch was off. Its unambiguous wording returns false from the authorization helper.

- Thread: `869817f7-6121-420a-b301-3b5a1d5cb09f`.
- Request: `523f3f80-c1f5-4fab-9d99-6790ee08dacd`.
- Maps job: `01fb7246-ca59-4490-85f5-3cfead4e593b`.
- Maps: five found and five contactable, but zero qualified. At least one is unambiguously a dental clinic in Pune: its listing, Pune address and own website all establish that. Its own site was read and evidence kept.
- Continuation: TinyFish websites/directories, 23 found and 21 contactable, again zero qualified.
- Final report: 27 distinct found, 26 contactable, zero of three qualified; stopped as sources exhausted. Recorded source spend is zero. No outreach plan appears.
- The assistant explicitly explains that it treated `do not contact anyone` as a condition no clinic could satisfy. The report's no-match reasons also include the lack of outreach permission. Some directory results genuinely lack an identifiable clinic; those should remain excluded.

Likely code path: `assessMembers` in `qualify.server.ts` passes the entire request to the outreach-oriented `sortLeads` prompt in `writer.server.ts`; `verdictOf` in `leadFit.ts` also turns a messaging `skip` into a qualification rejection. Inspect stored `fit_reason`/`fit_request_id` for this request before choosing the smallest fix; do not rely only on the assistant's explanation.

Expected: business type, place and factual requirements decide whether a lead matches. Research-only, sending permissions, budgets, time limits and delivery readiness control execution, not factual relevance. A matching clinic can count without an outreach plan. Keep the distinction between a relevant prospect and buying interest. Do not loosen geographic or identity checks, or automatically approve unidentified directory emails, to raise the count.

Required regression: an explicit research-only request for a new niche/place outside the saved default audience counts genuinely matching leads, retains evidence, reaches its target or an honest stop reason, and creates zero outreach plans/sends. Run one bounded real-model check after the offline check passes.

## L03 — Parent request can say Done while its research is continuing

**Confirmed live on the new pilot; not just a legacy-data problem.**

After the Maps job finished, the parent panel displayed `Done` and `(finished)` while showing `0 of 3 wanted`, `Research is running`, five minutes left and `the assistant is choosing the next source`. A continuation then started a web search. The parent was not finished at that point.

`requests.server.ts` computes `open` using the active objective, but chooses `stateLabel` from a completed child. `threadRequests` derives its open flags from child jobs/plans. The default picker also initially selects the standalone child `job:` instead of the parent `r:` request; reloading resets the user's selected parent.

Expected: the active objective keeps the parent active through the gap between jobs. Prefer the parent request as the default summary when the search belongs to it; keep child details underneath. Preserve access to genuine standalone legacy jobs. Add a test for the no-open-child/active-objective interval, not just the moment a child is running.

Related historical issue: an older request simultaneously shows `0 of 25`, an ended report saying 50 qualified, and one search still finishing while the displayed searches are done. Do not silently recount old requests or resume them. Clearly distinguish unavailable legacy qualification data from a measured zero, and reconcile the status display.

## L04 — Chat time changes after a full reload

**Confirmed in browser; medium priority.**

The pilot's owner message initially displays `4:48 PM` in the connected browser. After full navigation back to that same thread it displays `11:18 AM`, a 5:30-hour shift, and remains so on a later snapshot. The UTC timestamp itself was not edited.

`AssistantClient.tsx` formats the time with locale defaults during render and uses `suppressHydrationWarning`; there is no explicit time zone. This is consistent with UTC server rendering versus the browser's India time zone.

Expected: one clearly defined display time zone, consistent before/after hydration, a full reload and reopening history. Use the existing organization/browser time policy rather than adding another setting. Do not change stored UTC instants. Check a server/browser zone mismatch in verification.

## L05 — Getting started still promises approval for every reply

**Confirmed live; copy defect.**

Getting started says that AI drafts always wait for review and that none is sent without approval, although this release supports per-run Automatic replies and existing runs use it. It also calls the destination Action required even though the links correctly point at Inbox.

Expected: explain that replies follow each plan's Review or Automatic mode, with decisions needing the owner in Inbox. Update the text to describe existing behavior. Do not change sending permissions or reply modes to match the old text.

## Setup blockers and checks still pending

- **Bright Data:** its feature is Off in this workspace. The deployed card/feature description exists, but the provider pilot was not run. Enable and configure it in the app with a fresh key and a bounded credit allowance before testing. Password inputs require the owner to fill them; do not paste the key into chat. The separate native Reddit API source's approval switch under Lead research is also off; it is distinct from Bright Data's own Reddit option, which was not inspected.
- **Reply transport:** no new inbound/outbound test was performed in Review or Automatic mode after deployment. Use one owner-controlled recipient; do not resend to the real customer who already received the holding response. A working assistant chat is not proof of a working CRM reply.
- **Email and LinkedIn inbound:** Getting started reports that no inbound reply has yet been received on either channel. Readiness is pending, not proven by a connected badge.
- **Account email:** Getting started reports that invitation/password-reset emails go only to logs until `RESEND_API_KEY` and `AUTH_EMAIL_FROM` are configured. This is a server setup requirement before a paying-user pilot, not a new feature request.
- **WhatsApp rejection rate:** historical reports show many recipient rejections. Do not equate every public telephone number with a deliverable WhatsApp route. Audit the evidence/provider result before proposing a routing fix; no new registration/paid enrichment service was added here.
- **Data-quality follow-up:** existing leads include apparent directory/platform contact addresses attached to a different business. Ownership needs checking from saved provenance before declaring or suppressing them. A domain mismatch alone is not proof that an address is wrong.
- Requests initially showed loading placeholders across several reads, then loaded. This is an observed slow load, not yet a measured regression or diagnosed database fault.
- Mobile visual checks, real sender reset times, database isolation, the full Docker regression suites and real CRM reply-schema probes were not rerun through this browser session.

## Handoff to the fixing agent

Work from `codex/pilot-deploy-20261021` at `652c84d` in a separate branch. Fix L01–L05 only; no Claude login, new providers, new features or redesign. Preserve the narrowed AI/ML fallback and the Bright Data B01–B03/deadline fixes.

Start with failing tests for L01 and L02, including budget wording, contact-details-as-data, explicit research-only, target-niche overrides, and an otherwise genuine outreach request. Cover L03's continuation interval and L04's server/browser time-zone mismatch. Run focused checks and the affected database suites, and package any required migration in the Docker build if one is genuinely needed. Do not claim a scripted stand-in model proves real-model qualification quality.

After the changes, repeat the same three-clinic, five-minute, free-source research-only request. It must keep its source cap, produce a single final report, show a consistent parent state and create no plans or sends. Then perform the configured-model synthetic CRM probe and one controlled reply test. Record actual results separately from pending checks. Do not deploy or change existing campaigns during the fix without the owner's deployment instruction.
