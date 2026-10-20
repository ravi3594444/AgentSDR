# AgentSDR — Pilot fixes, 19–20 October 2026

Status: fix plan and evidence log. Implementation and verification are pending unless an item explicitly says otherwise.

Repository: https://github.com/ravi3594444/AgentSDR  
Implementation branch: claude/dreamy-fermi-h5woha  
Pilot code baseline inspected on 19 October: 1ba023f82a3b5a82f20cdc29c332a57ea1d683cd  
Evidence dates: 19–20 October 2026; user-facing times below are India Standard Time (UTC+05:30).  
Suggested repository location: docs/plans/PILOT_FIXES_2026-10-19.md

Live browser audit added on 20 October. The running image revision was not rechecked in that audit. Section 7 records reproduced issues, checks that passed, and investigations that still need code or database evidence. No application code was changed or deployed by this review.

## 1. Scope: fix the existing product

The owner wants a user to describe their target customers and ask for outreach. The existing agent should select relevant sources, verify matches, choose suitable connected contact channels, run authorized outreach, and explain the actual outcome.

This round repairs that workflow. Keep the existing integrations, interfaces, sending rules, request controls and tenancy boundaries. Preserve the implementation work already underway on this branch.

Out of scope for this round:
- New providers, new social networks, Reddit access or another browser service.
- Mandatory searches on every source for every request.
- Finding an email for every LinkedIn profile, or adding a multi-channel sequence for each person.
- Larger lead limits, different rate-limit windows, model-token billing controls or VM resizing.
- A new dashboard or a rewrite of the agent harness.
- Automatically starting old unapproved proposals, restarting campaigns, or resending messages during verification.

This is a companion to the existing implementation plan, not a replacement for its history. Record the corresponding completion status there when fixes are verified. Do not mark a planned fix complete just because it is listed here.

## 2. What the pilot established

Owner request:
> start outreach find B2B business owners, real estate founders, etc., and people who do not have a website; outreach them

Observed discovery:
- Maps, Chicago real estate: 50 businesses found; 24 contactable, including 22 with email and 13 with phone/WhatsApp routes. Channel counts overlap; 1 duplicate was skipped.
- LinkedIn, “real estate founder”: 50 profiles labelled contactable; the outreach sorter retained 3 and rejected 47.
- The request stopped against its default target of 25. Its report first said 50 qualified, then 74 qualified.
- A later search for the original no-website requirement was refused because this request had already stopped.
- TinyFish web_search nevertheless searched “US real estate agencies with no website” and returned 10 candidates. Two directory/data pages read by the agent returned 0 contacts.

Confirmed channel-selection evidence, from saved tool inputs:
- find_leads: channels ["whatsapp"].
- find_customers_on_web: channels ["whatsapp"].
- prepare_outreach: channels ["whatsapp"].
- LinkedIn preparation: channels ["linkedin"].

Observed outreach:
- Plans launched for LinkedIn and WhatsApp.
- A request-scoped results snapshot recorded 0 confirmed sends, with 15 WhatsApp leads and 3 LinkedIn leads still waiting.
- A later email worker tick recorded 1 send. Its campaign and recipient were not identified by that excerpt.
- The New York email proposal shown elsewhere was created on 18 October and had no approval timestamp. It was not a newly created email plan for this pilot request.

Confirmed sending gates:
- WhatsApp account: connected since 14 October; the new-chat warm-up was therefore not the explanation on 19 October.
- WhatsApp settings: newChatsPerDay = 30; secondsBetweenSends = 5.
- WhatsApp counter: 30 new chats in the preceding rolling 24 hours. Capacity for another new chat was exhausted.
- LinkedIn account: CONNECTED; limitReached = false.
- LinkedIn nextAllowedRun: 19 October 12:00:29.508 UTC, or 17:30:29.508 IST.
- Its 12:00:00 UTC scheduled check ran before that cooldown expired and skipped the account. The normal next half-hour check was 12:30 UTC / 18:00 IST. A future check is not proof of a send.

Other observed quality issues:
- Follow-up samples claimed a previous agency achieved “80%” faster response and “under a minute.” Support in saved business knowledge has not been verified.
- Assistant narration repeatedly promised WhatsApp plans even for a LinkedIn search.
- Narration described completed searches as still running and treated the no-website requirement as a new optional request.
- Incomplete model-answer retries appeared during the run. Campaign launches subsequently completed; the retry notice alone does not establish a failed sender.

## 3. Fix queue

All rows below are open or awaiting verification. Correct engine waiting behaviour is identified separately from product defects.

| ID | Priority | Finding | Evidence status |
| --- | --- | --- | --- |
| F01 | P1 | General outreach was narrowed to WhatsApp, excluding email routes | Tool arguments and resulting plans confirm the restriction; upstream cause still needs tracing |
| F02 | P1 | Target completion counted contactable candidates before meaningful fit filtering | Counter definition and 50-to-3 LinkedIn outcome confirmed |
| F03 | P1 | Original requirements and stop state were inconsistent across research paths | Live refusal plus subsequent individual web-tool use confirmed; coordinate with work already underway |
| F04 | P1 | Reports mixed counts, campaign scope and sending states | Conflicting 50/74 totals and misleading narration observed |
| F05 | P1 | Outreach contains case-study claims whose support is unknown | Claims observed; check saved evidence before concluding they are fabricated |
| F06 | P1 | Users cannot understand sender waits and rolling quotas from the current status | Actual account gates confirmed; missing or insufficient explanations observed |
| F07 | P2 | Search queries and qualification wasted results or missed original conditions | 47/50 LinkedIn rejections and weak no-website query observed |
| F08 | P2 | Model recovery needs a current-build regression check | Retries observed; terminal failure or duplicate effects not established |
| F09 | P2 | Deploy health URL malformed when PORT contains a bind address | Earlier VM deployment failure and working HEALTH_URL override confirmed |
| F10 | P1 | Failed WhatsApp recipients are described as messaged; an all-failed plan still says it is sending | Reproduced in campaign overview, lead detail and Activity on 20 October |
| F11 | P1 | Historical contacted counts disagree after a plan is stopped | Same stopped New York beauty plan: Activity 9 contacted; Overview 0 contacted / 9 sent; channel list 0 messaged |
| F12 | P2 | Action required does not identify a concrete remaining human action for a suppressed record | Queue and record reproduced; intended acknowledgment/lifecycle rules still need verification |

### F01 — Preserve relevant email and other channel options

Current behaviour:
- Explicit tool channels override saved preferences and defaults.
- The deployed planner defaults to email, WhatsApp, LinkedIn, Instagram when neither the request nor saved preferences supplies a selection.
- Unavailable senders are filtered out, then each lead receives the first usable channel it actually has.
- Passing only ["whatsapp"] therefore prevents email assignment and leaves email-only leads out.
- LinkedIn discovery currently imports profile identity, role and company without fetching email, and its automatic follow-up selects LinkedIn.

Required correction:
1. Trace where the WhatsApp-only choice came from: prompts, saved preferences, earlier chat context, tool arguments, or background follow-up handling. The immediate restriction is proven; the upstream reason is not yet proven.
2. Distinguish a preferred order from a deliberate “only use these channels” restriction. Inspect existing semantics and preserve intentional restrictions.
3. For a general outreach request, retain suitable connected routes rather than silently choosing WhatsApp-only for the entire audience.
4. Apply the same policy to search-created plans, background follow-ups and direct prepare_outreach calls. Cover the policy in code and meaningful tests as well as assistant instructions.
5. Keep one coordinated channel assignment per lead under the existing design. Do not invent email addresses or add a second campaign for somebody already covered.
6. Explain unavailable or excluded routes using recorded reasons.

Acceptance:
- A general mixed-audience fixture can assign email-only, WhatsApp-only and LinkedIn-only people to their appropriate ready channels.
- A person with multiple routes follows the intended preference order.
- An explicit WhatsApp-only request stays WhatsApp-only.
- An unavailable sender is not selected; an unexplained route exclusion does not disappear from the report.
- Search follow-ups preserve the request's channel policy.
- Existing overlap checks still prevent duplicate active outreach.

#### Email: the observed problem and the required fix

The email issue is included in F01. In the pilot, the Chicago list contained 22 published email routes, but saved search/preparation inputs explicitly selected only WhatsApp. That prevented the planner from assigning email for those plans. A published address alone does not prove that every one of those 22 leads qualifies for outreach.

This is not evidence that the email sending engine is entirely broken. The 20 October Overview and Analytics audit showed 47 recorded email sends for 14–20 October. That establishes historical recorded activity, not delivery to every recipient's inbox or a new email send for this request. The older New York email proposal was still unapproved; it must not be silently started to compensate for this issue.

Fix and verify the complete existing email path:

1. For a general outreach request, keep email eligible when the organization has a usable connected mailbox and the matching lead has a permitted, valid email route. Preserve deliberate channel restrictions and the existing preference order.
2. Trace request → saved tool channels → qualified lead → channel assignment → plan → authorized launch → email queue → worker/provider result. Record the first stage that excludes or blocks email and its real reason.
3. Show distinct reasons for no email plan, awaiting approval, no usable mailbox, outside sending hours, quota/gap wait, suppression, queued work and a recorded send failure. Do not diagnose all of these as “email not working.”
4. Use fake-provider regressions to prove that an email-only matching lead reaches an email plan and an accepted send after authorization, while an explicit WhatsApp-only request stays restricted. Cover unavailable mailboxes and Do Not Contact without sending.
5. Preserve duplicate-outreach protection. Do not add email alongside an existing LinkedIn/WhatsApp campaign for the same person merely because another route is available or a quota is exhausted. Channel changes must follow the existing approved policy.

No email lookup or address guessing is implied for LinkedIn profiles that have no recorded email. The fix must use the actual contact routes and connected accounts already supported by the app.

### F02 — Count matching prospects toward the target

Current behaviour:
- objectiveLeads counts distinct eligible audience members with contact routes.
- Outreach sorting occurs later. In the pilot, 50 contactable LinkedIn profiles became only 3 selected prospects, after the research target had already been satisfied.

Required correction:
1. Preserve the user's criteria through discovery, qualification and planning.
2. Separate found candidates, contactable candidates, qualified matches, plan assignments and contacted people.
3. Count distinct matching, contactable prospects toward a request's qualified-lead target. Contactability alone does not establish relevance or buying interest.
4. Continue within existing request limits when most candidates fail qualification. Reuse stored results; do not buy or fetch the same batch again.
5. If time, source availability or budget ends research first, retain partial results and state the unmet criteria and real stop reason.
6. Keep original hard requirements distinct from optional relevance hints.

For a no-website requirement:
- An empty Maps website field means no website listed there.
- A failed page fetch, a 403/405 response, or a directory saying “without website” is not proof that a business has no website.
- Use existing search/read tools to check promising businesses by name and location.
- Record “no official website found in the checks performed,” with the checked sources; leave uncertainty visible.
- Do not silently include a business with a confirmed website in an audience requiring no website.

Acceptance:
- Fifty profiles with only three matching the criteria do not complete a target of twenty-five qualified prospects.
- “No website listed,” “website could not be checked,” and “official website found” remain different outcomes.
- Distinct-person counts survive duplicate sources, retries and worker recovery.
- Reaching a genuine limit produces an honest partial report rather than a claim that the original request was fulfilled.

### F03 — Keep individual web tools and background research on the same request

The agent was refused a background search because the request was stopped, while still using web_search and read_webpage for that request. Another session is already addressing individual-tool request tracking; coordinate with that work instead of implementing a competing mechanism.

Required correction:
- The same request identity, criteria, channel policy, pause/stop rules and existing resource controls apply to both paths.
- Original requirements remain part of the original task. The assistant should not ask the user to start a new request merely because unrelated or unqualified candidates prematurely satisfied the counter.
- A genuine completed or user-stopped request is respected consistently, with a clear explanation.
- Preserve the existing continuation, idempotency and one-final-report behaviour. Do not add larger budgets as a workaround.

Acceptance:
- A request that still needs qualified matches can continue through existing tools within its limits.
- A paused or stopped request behaves consistently across tool types.
- Retry or continuation does not create a second independent objective or repeat side effects.
- The final report covers the actual work of both research paths.

### F04 — Report current work and recorded delivery accurately

Required correction:
- Reconcile the stored stop-time count with the final count after in-flight searches finish. Explain additional late results instead of printing contradictory totals.
- Report raw candidates and qualified matches with their proper labels.
- Keep contact-route counts distinct from unique-person totals; the same person may have several routes.
- Separate this request's plans from older plans that were merely listed or resumed.
- Distinguish proposed, starting, active, waiting, queued, provider-accepted, failed and replied using existing evidence. Do not claim recipient delivery unless the provider supplies that evidence.
- “Campaign started” means the campaign was activated. “Sending” or “sent” needs corresponding worker/send records.
- Generate channel and progress narration from actual tool/run state. A LinkedIn campaign should not be announced as WhatsApp.
- Label report scope and reporting period. Zero sends for the new request can coexist with activity on an older campaign.
- Explain why a proposal remains unapproved when that reason is recorded. Do not invent a blocker from the word “proposed.”

Acceptance:
- An active campaign with zero recorded sends is not reported as having contacted people.
- A final report contains one consistent set of totals and an explanation for excess results.
- Older unapproved proposals are not described as new failures of today's Autonomous mode.
- Completed jobs are not described as still searching.
- Unknown worker liveness or unknown provider delivery is explicitly left unknown.

### F05 — Validate claims throughout the outreach sequence

Observed samples:
> We recently helped a similar agency cut lead response time by 80%.

> We built a simple AI agent for one agency that cut response time to under a minute.

Required correction:
1. Check whether the owner's saved knowledge actually supports these case studies and exact figures.
2. When support is absent, rewrite with factual offer information; do not manufacture a client, result or benchmark.
3. Apply existing grounding checks to group templates and every follow-up, as well as personal opening lines and first messages.
4. Keep sender claims grounded in sender knowledge and recipient claims grounded in that lead's evidence.
5. Keep the preview and launched sequence aligned.

Acceptance:
- Unsupported client stories, percentages and performance numbers do not reach the send queue.
- A genuinely saved, applicable case study can be used accurately.
- A prospect's website keyword matches remain relevance hints, never proof of a need or buying intent.
- Verify with fake providers. Live campaign text is not automatically rewritten or resent as part of testing.

### F06 — Explain sending limits, waits and next availability in the existing UI

The WhatsApp quota and LinkedIn cooldown shown in this pilot are operating as configured. The provided chat/card text did not explain those waits. Inspect the existing Sending status and Activity details first: reuse explanations already present there, repair any missing or incorrect information, and make the reason clear from the affected plan. A collapsed-panel transcript alone does not prove that every detail is absent.

WhatsApp requirements:
- Label the rule “New chats per 24 hours, per number,” reflecting its rolling-window enforcement.
- Show used, limit, available slots and queued leads.
- Explain that all campaigns using the same number share this counter.
- Show when the next capacity becomes available, in the user's display timezone.
- Explain that earlier new chats age out individually; capacity does not reset at midnight.
- Distinguish new-chat capacity from replies in existing chats, which are not blocked by this particular counter.

LinkedIn requirements:
- Show the exact cooldown end with sufficient precision; minute-rounded text hid the 29.508-second boundary in this pilot.
- Show the next scheduled worker check as a separate time.
- Once cooldown has expired, identify waiting for the next scheduled check rather than continuing to label it as an active cooldown.
- Show the LinkedIn account's actual invitation limits and relevant hours, rather than only email/WhatsApp limits on a LinkedIn plan.

Existing plan/status, Activity, report and diagnosis surfaces should explain:
- account connection problems;
- outside sending hours and the next allowed window;
- new-account warm-up;
- rolling quota exhaustion;
- send gaps or account cooldowns;
- waiting for a scheduled worker pass;
- provider refusals, temporary retries, and genuinely unknown worker state.

Use the engines' actual settings, counters, clocks and eligibility checks. Some WhatsApp refusal paths currently release their claim and increment skipped without retaining the reason; make the relevant reason available through the existing status/diagnostic path without exposing message bodies or secrets.

Next availability is an eligibility estimate, not a delivery promise. Recheck the actual gates at send time.

Acceptance:
- At 30/30 new WhatsApp chats, the user sees the exhausted rolling quota and the next capacity time without SQL or logs.
- Counts include other campaigns on the same number.
- If the limit is lowered below current usage, next-capacity calculation waits for enough events to expire, not simply the oldest event.
- The 12:00:00 UTC check and 12:00:29.508 UTC cooldown boundary display correctly in IST and in another organization timezone.
- A quota wait does not become a failed message or an automatic duplicate retry.
- Sender hours, recipient location and display timezone are clearly distinguished.
- Opening a status panel performs no sends or queue mutations.

Do not change the rolling window to a calendar-day reset, raise the limits, bypass warm-up, or alter worker cadence merely to make the pilot send sooner.

### F07 — Improve existing search choices and candidate relevance

Required correction:
- Carry the user's actual business type, location and other conditions into existing source queries.
- Investigate why the broad LinkedIn query returned so many unrelated founders. Verify the saved target geography and use the existing supported query/filter mechanisms.
- Treat the TinyFish query “US real estate agencies with no website” as a candidate-discovery attempt. Search results and directory pages are starting points, not verified people to contact.
- Read promising directories for actual business entries, follow relevant links within existing protections, and refine queries when results are data sellers or irrelevant pages.
- Use the existing Maps, web, LinkedIn, social and free-source tools where they fit the buyer type.
- Explicitly requested sources receive coverage or a truthful reason they could not be used.
- Keep keywords such as “agent” as weak relevance hints. Do not turn generic real-estate text into evidence of a problem our offer solves.
- Preserve uncertainty about location, decision-maker identity and needs when the source does not establish them.

Acceptance:
- A location-specific fixture does not silently qualify unrelated locations.
- A directory or broker domain is not presented as a verified individual founder.
- The no-website criterion is actually checked or reported as unresolved.
- Relevant leads with no strong need signal can still be potential fits when the user's criteria allow it.
- There is no mandatory run of all providers or platforms on every request.

### F08 — Verify existing model-response recovery

Retry notices appeared for incomplete answers, but the provided run eventually launched campaigns. Do not assume the three-attempt recovery is absent or that a retry notice explains the sender waits.

Required verification:
- Reproduce against the current branch with a malformed or incomplete structured answer.
- Keep valid completed searches and launch state through recovery.
- Distinguish “repairing the model response” from “sending messages.”
- Avoid narration that says work started before the action was recorded.
- Verify exactly-once side effects across retries using the existing durable records.
- If a current defect is reproduced, fix that path with a focused regression. Otherwise record this check as passed; do not rebuild the harness or add arbitrary retry counts.

### F09 — Fix the deployment health URL default

Observed failure:
- PORT contained the valid bind specification 127.0.0.1:3000.
- The script constructed http://127.0.0.1:127.0.0.1:3000/sign-in.
- Explicit HEALTH_URL=http://127.0.0.1:3000/sign-in allowed the deployment checks to complete.

Required correction:
- Derive a valid health URL from supported port/bind configurations.
- Honour an explicit HEALTH_URL.
- Preserve the valid Compose bind configuration and existing backup, migration and rollback behaviour.

Acceptance:
- Numeric PORT, bind-address PORT and explicit HEALTH_URL cases are covered by the existing deploy-script tests.
- shellcheck passes.
- Failure still leaves or restores the prior app image according to the existing deployment contract.
- No VM rebuild or deployment is performed just to edit this document.

## 4. Not defects established by this pilot

These distinctions prevent unnecessary changes:
- WhatsApp pausing new chats at 30 used of 30 allowed in a rolling 24 hours is correct.
- LinkedIn skipping a scheduled check before its cooldown expires is correct.
- Choosing Maps and LinkedIn for real-estate prospects instead of Hacker News is a reasonable source choice.
- A source being free does not mean it must run on every request.
- LinkedIn search returning profile identities without email is the current discovery contract. Email enrichment is outside this fix round.
- A user enabling Autonomous mode does not retroactively approve every old proposal.
- Node for the image build and Bun for the running server is not itself evidence of an old deployment.
- Terminal “command not found” messages caused by pasted result tables are not application delivery failures.
- One logged email send does not identify its campaign or prove recipient-inbox visibility.
- Missing proof of a case study is an investigation item, not proof that the claim is false.

## 5. Implementation order and completion gates

1. Coordinate F03 with the session already working on request tracking.
2. Fix F01 channel choice and F02 qualification/completion, including relevant F07 query propagation.
3. Verify and correct F05 message grounding.
4. Complete F04 truthful reports and F06 sender-wait explanations using the existing surfaces.
   Include F10 failed-recipient outcomes and F11 preserved historical counts. Verify F12's intended human action before changing its queue lifecycle.
5. Run F08 recovery checks and fix F09 deployment URL handling independently.

Use targeted regressions and existing fake providers. Exercise one combined flow:
- General owner request with explicit target criteria.
- Mixed email-only, WhatsApp-only and LinkedIn-only matching candidates.
- Unrelated and uncertain candidates are handled with reasons.
- Rejected candidates do not satisfy the qualified target.
- Authorized plans start through existing approval/autonomy rules.
- An exhausted WhatsApp counter is shown as waiting.
- LinkedIn cooldown and scheduled check are shown accurately.
- Recorded sends and final reporting agree; repair/recovery does not duplicate work.
- A contrasting explicit WhatsApp-only request remains restricted.

Run typecheck, lint and the relevant existing unit/integration/end-to-end checks. Preserve organization isolation in every changed query. Expand verification when a failure or changed shared path warrants it.

Delivery report from the implementing agent:
- Exact commit and branch.
- Root cause and final behaviour for each addressed ID.
- Meaningful regression checks and their results.
- Remaining uncertainties or intentionally untouched items.
- Whether deployed or only pushed; do not conflate these.
- Any exact VM verification needed, performed after the owner deploys.

For live acceptance after deployment, inspect existing queues and recorded messages first. Use a small owner-approved test cohort only where an actual send is needed. Preserve all active campaigns, approvals, suppressions and sending limits.

## 6. Implementation map and evidence references

Pinned code reviewed for the deployed pilot:
- src/lib/assistant/tools.server.ts — search channel arguments, LinkedIn-only search follow-up, web tools, setup and reporting.
- src/lib/assistant/outreach.server.ts — preferred/default channel selection, assignment, later sorting, plan start and run reports.
- src/lib/assistant/linkedinSearch.server.ts — imported LinkedIn identity fields; no email lookup in this path.
- src/lib/assistant/objective.server.ts — contactable-member counter and final objective report inputs.
- src/lib/assistant/objective.ts — saved stop detail and final report wording.
- src/lib/assistant/autonomy.server.ts — starting newly prepared plans, overlap handling and recorded refusal reasons.
- src/lib/whatsapp/send.ts and guardrails.ts — shared-account rolling 24-hour new-chat checks.
- src/lib/whatsapp/campaigns/engine.ts and engineRules.ts — campaign sending, gates and skipped paths.
- src/lib/channels/rules.ts — WhatsApp rules and labels.
- src/lib/scheduler/schedules.ts — half-hourly LinkedIn outreach schedule.
- src/jobs/runOutreach.ts and src/lib/linkedin/nextAllowedRun.ts — LinkedIn account gates and rounded cooldown text.
- docker/deploy.sh — health URL derivation and deployment checks.

Pinned repository snapshot:
https://github.com/ravi3594444/AgentSDR/tree/1ba023f82a3b5a82f20cdc29c332a57ea1d683cd

Live evidence supplied by the owner in this chat:
- Pasted text(9).txt, including request results and per-channel zero-send counts.
- SQL outputs for saved tool channel arguments, old email proposals, WhatsApp counters/settings and LinkedIn cooldown.
- Worker logs showing the skipped LinkedIn run, WhatsApp ticks and one email send.
- Earlier deployment output showing the malformed health URL and successful explicit override.

Keep the committed fix log free of API keys, recipient phone numbers and personal mailbox addresses. The sample claims quoted here were supplied by the owner for this pilot review.

## 7. Live browser audit — 20 October 2026

### Scope and evidence limits

Inspected the signed-in deployment at https://leads-x.duckdns.org through the owner's connected browser. The audit ended around 13:39 IST (08:09 UTC). It covered Activity, Overview, Analytics, Action required, all replies, record history and full-page records, Pipeline filters, WhatsApp campaigns and lead details, LinkedIn campaigns, and the original pilot chat.

This was an inspection of existing live records. No new research request, outreach, retry, sync, campaign control, classification change or settings change was performed. Existing campaigns continued independently while pages were inspected. There was no direct VM, database, worker-log or provider-API access in this audit. Browser text is evidence of displayed state; it does not independently prove recipient delivery or a provider's current underlying restriction.

The 19 October observations above remain historical evidence. Do not treat an old report's zero sends as the live count, or replace an earlier wait reason with today's reason without preserving its timestamp.

### Current progress: zero does not have one universal cause

| Plan | Current observed progress | Explanation supported by the UI |
| --- | --- | --- |
| Chicago real estate, WhatsApp | 12 leads; 6 contacted; 6 messages sent; 6 failed | Some sends succeeded. Six recipients failed; six leads remain in sequence for follow-ups |
| New York real estate web, WhatsApp | 2 leads; 1 contacted; 1 sent | Work has progressed since the original zero-send snapshot |
| New York cleaning web, WhatsApp | 1 lead; 0 contacted; 0 sent; 1 failed | WhatsApp rejected the only recipient; no queued or in-sequence leads remain |
| Real estate founders, LinkedIn | 3 leads; 3 not invited; 0 invitations; 0 failures | Activity says LinkedIn reported the sender's invitation limit |
| Los Angeles cleaning, LinkedIn | 45 leads; 1 invited/contacted; 44 not invited | Activity reports the same account invitation-limit gate |

The reopened chat cards agree with Activity for Chicago (6 contacted), New York real estate (1), the new LinkedIn plan (0), and New York cleaning (0). A blanket claim that all contact counters are stuck at zero is not supported by this check. Automatic refresh of a chat left open throughout sending was not tested.

For LinkedIn, the current observed wait is the invitation-limit flag, not merely yesterday's 29-second cooldown boundary. The campaign page itself only says Active and 3 not invited. Repair F06 so the existing account reason is visible where users are looking. Verify the stored gate's age, reset/recheck rules and actual provider outcome before deciding whether it is stale. Do not clear or bypass it to force a send. An invitation being accepted may also be required before later sequence messages are eligible; do not promise an immediate DM from an Active label.

### F10 — Tell the truth about failed recipients and remaining work

Confirmed reproduction A:

1. Open WhatsApp → Campaigns → “cleaning agencies — New York, USA (web)” created on 19 October.
2. The campaign overview says Active, Queued 0, In sequence 0, Leads 1, Messaged 0, Messages sent 0 and Failed 1.
3. Under Leads, it nevertheless says “Everyone has been messaged.” The same page also says “No messages sent yet.”
4. Open its Leads tab. The only row is Failed, 0 of 1 sent, Nothing sent. Its reason says WhatsApp rejected the recipient and registration was not confirmed.
5. Open Activity. The corresponding plan says Working and “sending within each channel's hours and daily limits,” with 0 contacted.

Confirmed reproduction B:

- The Chicago campaign has 12 leads, 6 messaged, 6 first messages sent, 6 failed and 6 in sequence. Its Leads helper also says “Everyone has been messaged.” That sentence is false for the six failed recipients, even though the numerical sent count is correct.

The provider refusal itself is not an application defect established by this audit. The UI's success wording and all-failed plan's sending explanation are defects. These views must distinguish queued, attempted, sent, failed, and awaiting a later step. Keep administrative Active state separate from whether any delivery work remains. An empty initial-send queue is not proof everyone was contacted.

Required correction:

- Derive the helper from actual send evidence and remaining states. For example: “No leads waiting for their first attempt; 1 failed, 0 contacted,” when that is the truth.
- Surface failed-recipient counts and the existing recorded reason from the plan/status/Activity views. Do not require the owner to search a channel-specific lead table to discover an all-failed outcome.
- When no eligible or scheduled work remains, show a completed/partial/failed outcome according to the existing lifecycle, with accurate wording. A configured Active campaign can remain active for future additions if that is intentional, but must not claim current sending.
- Do not silently retry terminal provider refusals or bypass restrictions. Preserve recorded attempts and suppression rules.

Acceptance with fake providers:

- One rejected lead produces 0 contacted, 0 sent and 1 failed on all relevant views; no success claim and no generic claim that sending is underway.
- A mixed six-sent/six-failed campaign reports both outcomes and preserves legitimate future follow-ups for the six sent leads.
- All queued, all failed, all sent with follow-ups pending, and no remaining work each produce the correct existing status and helper.
- Merely viewing or refreshing these pages does not enqueue or send anything.

### F11 — Preserve historical contact evidence after Stop

Observed for the same stopped “beauty salons — New York, USA” plan created on 18 October:

| Surface | Displayed WhatsApp outcome |
| --- | --- |
| Activity, finished plans | 9 contacted, 0 replied |
| Overview, last 7 days | 0 contacted / 9 sent / 0 replied / 46 stopped |
| WhatsApp campaign list, all time | 46 leads, 0 messaged |

The Overview column order is Contacted / Sent / Replied / Stopped. Those are message-sending totals for a stopped plan, not simply “who is active now.” At least one surface is losing or redefining historical contact evidence. This is a confirmed cross-surface inconsistency; the exact query causing it was not inspected in this audit. Do not infer nine unique people from nine messages without examining the send records.

Required correction and acceptance:

- Trace contacted/messaged calculations to durable accepted-send evidence rather than only current recipient status or active campaign membership.
- Stopping, pausing, failing later, removing a lead or receiving a reply must not erase an earlier valid contact event.
- Keep historical people contacted, messages sent, and currently waiting/stopped people separate, with the same intended scope on each page.
- Add a regression: first accepted send → Stop → reopened chat/Activity/Overview/channel campaign. The distinct contacted count stays correct while current work moves to stopped.
- Also cover removal and duplicate/overlapping identities using existing deduplication rules. Do not inflate unique-person counts by equating them with message totals.

### F12 — Make the remaining human action explicit

Observed at `/crm/actions`:

- Needs you 0, drafts 0, errors 0, but Action required 1.
- The sole queue record is an older wrong-number reply, currently Not interested and Do Not Contact. It says Outreach stopped and “Nothing runs for this classification.”
- Its record says Action required, but does not explain what the owner still needs to do. The composer and Send are disabled by the contact restriction.
- Overview says “Nobody is waiting for you” while also displaying Action required 1. This may distinguish reply decisions from other actions, but the wording hides that distinction.

Record history matters: this older record has an inbound wrong-number message and a contact-restriction event, followed by the authenticated operator changing Not interested → Interested → Not interested on 18 October. It is not a clean new acceptance test of the current wrong-number apology flow. The audit did not trigger a new reply or inspect a fresh apology attempt.

Required verification/correction:

- Identify whether a real manual acknowledgment or restriction decision is intentionally outstanding. Show that concrete action and reason if so.
- If no action is outstanding, remove the record from the actionable queue under the existing lifecycle while keeping it available in replies/history. Do not silently clear Do Not Contact.
- Align “Nobody is waiting for you” with its actual scope, or explicitly say there are no replies to review but another action remains.
- Preserve the disabled composer for restricted contacts. Do not resend an old apology as an audit shortcut.
- Regress normal wrong-number handling, manual classification changes, and already-resolved suppression events with fake inbound fixtures.

The confusing queue presentation is reproduced. Whether the record should automatically leave Action required remains an investigation until the intended acknowledgment rules and state transition are checked.

### Metric definitions that still need investigation under F04

Overview's “Same period in Analytics” link correctly opened the last 7 days, 14–20 October, using Asia/Kolkata. Both pages showed 130 contacted, 148 total sends across channels, 20 inbound replies from 6 people, and the same found/qualified/contactable totals. Overview's rounded 5% and Analytics' 4.6% reply rates agree for 6 of 130; that is not a calculation bug.

Two distinctions need checking before any numerical change:

- Analytics shows 3 Positive people; Overview and the Pipeline Interested filter show 2. Determine whether Positive is historical period classification and Interested is the current state. The older wrong-number record was briefly manually marked Interested before being corrected. That is a possible explanation, not a proven root cause. Either align equivalent definitions or label their different meaning and drill-down clearly.
- Analytics/Overview show 3 LinkedIn requests in the period, while the all-time channel campaign list shows only 1 invited across the displayed campaigns. Activity also retains 2 contacted for an older stopped LinkedIn plan whose channel campaign list shows 0 invited. Investigate loss of historical membership/status in channel totals under F11 before declaring provider sends missing or counting the same event twice.

### Checks that passed and must be preserved

| Check | Observed result |
| --- | --- |
| Overview → same-period Analytics | Same dates, timezone, contacted/reply totals and source totals |
| Live chat plan counts after reopening | Chicago 6, New York real estate 1; matched Activity |
| Activity wait evidence | LinkedIn invitation-limit reason is present; earlier quota/hours reasons also existed |
| Replies from older chats | All replies lists 6 records; conversations remain available outside the originating chat |
| Answered pricing enquiry | Shows Answered by you / Waiting for their reply; record shows optional follow-up and preserves the owner's later messages |
| Full record page | Opens from the drawer and retains the conversation |
| Do Not Contact | Restricted wrong-number record's composer and Send stay disabled |
| Pipeline category filter | Interested returns 2 matching records; resetting restores the 6-record view |
| Recipient failure detail | Failed WhatsApp lead shows Nothing sent and the recorded rejection reason |

These passes do not replace a controlled live Review-mode or provider-delivery acceptance test. No new send was made to perform them.

### Unverified areas and tool limitations

- The browser screenshot operation failed with an image-readback error. That is a browser-tool limitation, not evidence of an AgentSDR image or layout bug. Desktop/mobile overflow and board layout were not visually certified.
- Overview initially returned only the navigation shell before later loading. Loading duration and reproducibility were not measured; investigate loading feedback only if reproduced. Do not file a permanent blank-page defect on this evidence.
- Some answered reply rows also show “Immediate reply” while saying nothing is waiting. Check whether that label describes an actual outstanding automatic action or stale due text before changing reply state.
- Sending status disclosure controls were not exposed as clickable references by this browser tool. Their expanded contents were not verified. Do not claim they lack information solely because the panel stayed collapsed.
- No fresh Autonomous search, paid research, real outreach or inbound reply was created. F01–F03, F05, F07–F09 and the new fixes still need their targeted implementation/regression checks and any necessary owner-approved live acceptance.
- No running-image revision, latest repository head, migration state, provider reset time, or worker heartbeat was independently checked today. Preserve those as pending rather than inferring them from loaded pages.

### Implementation handoff

Retain F01–F09 and their acceptance criteria. Add F10 and F11 to the existing reporting/status work, and investigate F12 with the current CRM lifecycle. Treat the metric-label and due-label questions as investigations until evidence establishes a defect. Do not introduce providers, increase quotas, rewrite the workspace, start old proposals, or resend rejected messages as part of these fixes.

The implementing session should report addressed IDs, root causes, regressions and exact commit. Mark this audit as recorded, not implemented. Recheck the named existing plans after the owner's normal deployment; test any new outbound path only against fake providers or a specifically approved test recipient.

