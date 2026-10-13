# Product requirements: 22nd X AI Outreach

**Document version:** 1.0  
**Date:** 13 October 2026  
**Working product name:** 22nd X AI Outreach  
**Foundation:** [Kandid-ai/AgentSDR](https://github.com/Kandid-ai/AgentSDR)  
**Companion document:** [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md)

## 1. Product decision

Create a branded lead and outreach workspace by improving AgentSDR. The first implementation session must produce a version the owner can use personally. Bigger work—especially a platform admin console, managed client onboarding and new channels—belongs in later sessions.

The product should make the everyday process easy: connect an account, import leads, prepare outreach, see replies and decide what to do next. Keep the existing application and improve the parts that matter to that process.

The working brand is **22nd X AI**. The product suffix “Outreach” and final logo/domain are configurable choices, not approved permanent assets. Use a text wordmark if the approved logo is unavailable. Asset selection must not block the functional release.

## 2. Users and release stages

| User | What they need | Release |
| --- | --- | --- |
| Owner | A branded, reliable tool for their own leads and outreach; clear setup and existing owner controls | Session 1 |
| Client company | Its own workspace, accounts, leads and conversations, with straightforward onboarding | Session 2 |
| Client employee | Access to the company's campaigns and replies within their assigned role | Session 2 |
| Platform operator | Manage client access, limits, integrations and operational failures across companies | Session 2 |

Session 1 uses one real owner workspace. Existing organization isolation remains intact; using one workspace is not permission to remove multi-tenancy or authorization.

## 3. Verified starting point

Repository review baseline: **v0.3.1**, commit **`bdbf5efd2017347181f5bf549b54d89c1ae6e5f5`**. Recheck the checkout before implementation; later upstream changes may alter this inventory.

| Area | Current foundation | Product implication |
| --- | --- | --- |
| App | Next.js, React, TypeScript, Bun and PostgreSQL with Drizzle | Extend the existing app and UI |
| Leads | People/companies, custom fields, CSV/XLSX import and enrichment tables | Improve reliability and reuse existing import behavior |
| Email | Google Workspace service-account integration | Personal Gmail, Outlook and general SMTP/IMAP support require later work |
| LinkedIn/WhatsApp | Native integrations through Unipile | Configure and test these; do not replace the provider in Session 1 |
| Replies | Conversations, AI classification and drafts awaiting approval | Keep approval as the first-release behavior |
| Access | Organizations, owner/admin/member roles and invitations | Use existing owner controls before building a platform console |
| Sending | Channel/account limits and production background workers | Retain existing scheduling and limits |
| Deployment | Docker Compose with app and database; source-build override available | Build the branded checkout rather than using the stock published image |
| Known issue | `xlsx` dependency resolves to the old npm distribution, currently `^0.18.5` | Fix before exposing spreadsheet upload to other users |

These are current capabilities, not claims that every integration has been verified with the owner's accounts. Provider authentication, sending and inbound delivery need separate live evidence.

## 4. Session 1: owner-usable release

### 4.1 Required scope

| ID | Requirement | Acceptance |
| --- | --- | --- |
| S1-01 | Product branding | App shell, sign-in/setup, page metadata, visible product logos and auth-email copy use the chosen brand. Preserve upstream license notices. |
| S1-02 | Reliable spreadsheet import | CSV and XLSX remain supported; the vulnerable dependency is replaced or updated from a verified source; valid, invalid and duplicate-input cases are checked. |
| S1-03 | Working first-owner setup | An empty installation creates the owner and workspace through the existing setup flow. A restart does not lose accounts, settings or leads. |
| S1-04 | Guided Getting Started page | A short checklist links to real account connections, lead import, campaign creation and reply review. Readiness is calculated from existing state rather than decorative completion buttons. |
| S1-05 | Clear integration status | Show Not configured, Connected, Needs attention or Not yet verified where supported by evidence. Explain missing setup and link to the appropriate existing settings page. Never display a secret. |
| S1-06 | Existing owner controls | The owner can configure integrations/models, manage members, set sending rules and pause campaigns through existing screens. Members cannot perform owner/admin mutations. |
| S1-07 | Complete existing outreach workflow | The owner can import leads, create a campaign, preview its steps, configure limits, start/pause it, receive replies and review a draft on a configured native channel. |
| S1-08 | Fix discovered critical defects | Reproduce and fix blockers in the above workflow. Avoid unrelated rewrites or claiming every possible bug is fixed. |
| S1-09 | Reproducible run and handoff | A fresh source build starts successfully; checks and verification results are recorded; the owner receives exact setup steps and a short manual test checklist. |

### 4.2 Small improvements allowed after required work passes

- Reuse an existing sequence/template through a clear shortcut; add a small starter preset only if the existing mechanism supports it cleanly.
- Improve the specific loading, empty or error states encountered in setup and import.
- Add direct links to campaigns needing attention and drafts awaiting review.
- Polish the changed screens for phone widths and keyboard access using existing components.

These improvements must not delay a functioning owner release. A new template-management system, navigation overhaul or dashboard redesign is outside Session 1.

### 4.3 Session 1 boundary

Do not implement the platform admin console, central shared-provider credentials, self-service client billing, automatic Maps scraping, personal Gmail/Outlook adapters, Instagram/Facebook adapters, automatic AI reply sending, or horizontal app scaling in this session.

The Getting Started page is a thin layer over existing settings and workflows. It is not a replacement authentication system or a new integration platform.

## 5. First-release experience

### Owner setup

1. Start the app and create the owner/workspace.
2. Open Getting Started and select the channel to configure first.
3. Connect the required provider in the existing settings screen.
4. Import a small controlled lead list and review the import result.
5. Create a campaign, inspect messages and sending limits, then run a controlled test when credentials and recipients are ready.
6. Check the received reply in the inbox/CRM and review the proposed answer.

### Everyday use

The owner sees actionable work: replies to review, active campaigns and connections needing attention. Setup links remain available, but completed setup must not obscure normal campaign/inbox work.

### Connection details

- **LinkedIn/WhatsApp:** configure the owner organization's Unipile connection. Existing LinkedIn hosted login is reused. The current WhatsApp flow may still require linking in Unipile and syncing the number; explain it clearly instead of claiming a new in-app QR flow exists.
- **Google Workspace:** use the current service-account and domain-delegation flow. Gmail inbound synchronization requires the Gmail/Pub/Sub setup for reliable reply-aware follow-ups. A simple personal Gmail OAuth button is later scope.
- **AI:** use the existing OpenRouter setup, including its management/inference keys, eligible BYOK provider, selected model and routing confirmation. Guided copy can simplify this; the integration must not silently change its credential model.
- **Optional services:** recordings/R2 and enrichment providers are optional for the first messaging release. Configure them when the corresponding feature is actually used.

## 6. Owner-usable means more than a preview

| Readiness state | Evidence required |
| --- | --- |
| Build-ready | Branded app builds, starts and passes relevant automated checks; local fixtures/manual setup instructions are ready |
| Owner-usable | The owner has a configured native channel and a controlled send/receive workflow has been verified |
| Pending live verification | Implementation is ready, but credentials, a public callback URL, provider access or owner-run tests are missing |
| Client pilot-ready | Session 2 access/onboarding work and per-client isolation/operational checks pass |

If external access is unavailable, finish the code and report **Pending live verification** with the exact missing step. Do not present fixture results as successful real sends.

Session 1 should target Owner-usable on at least one native channel and leave the other native channels accurately marked. Verify LinkedIn and WhatsApp with the owner's 2–3 connected test accounts when the Unipile trial is available. Each enabled production channel needs its own send/receive evidence.

## 7. Session 2: client administration and onboarding

This is the first substantial client-product milestone. It is separate from Session 1.

| ID | Requirement | Acceptance |
| --- | --- | --- |
| S2-01 | Platform operator role | An explicit server-enforced role grants platform management access; ordinary organization owners do not gain cross-client privileges. |
| S2-02 | Client lifecycle | Create client organizations, invite users, view operational status and suspend/reactivate outreach without deleting their data. |
| S2-03 | Per-client limits | Configure account/usage limits and AI budgets; enforce them in APIs, jobs and workers, not only forms. |
| S2-04 | Central provider administration | The operator manages the provider subscription; each client connects only its own profiles/numbers. Credentials remain server-side. |
| S2-05 | Unipile tenant mapping | Use restricted scopes/keys or an equally verified ownership boundary. Map every account/callback/webhook to the correct company. Do not paste one unrestricted key into all organizations. |
| S2-06 | Connection/reconnection experience | Client-facing connection flow, truthful status and a working reconnection path. |
| S2-07 | Operational overview | Client/account counts, failed jobs and useful diagnostics; secrets and raw sensitive payloads are excluded. |
| S2-08 | Audit trail | Record privileged access/limit changes with actor, company, action and time. |

Retain a separate organization for each client company. Teams inside an organization are not a customer-isolation mechanism. Suspension semantics must cover automated sending and manually initiated sending, while preserving the explicitly chosen inbound/read behavior.

A client's Google Workspace authorization still belongs to that client's administrator. Central Unipile onboarding does not automatically solve every email provider's permissions.

## 8. Session 3: lead sourcing and email compatibility

| ID | Requirement | Acceptance |
| --- | --- | --- |
| S3-01 | Basic Maps source | Run Gosom externally and import its results using the supported CSV workflow. Store source information where the model supports it. |
| S3-02 | Automatic source pipeline | Import scraper results, normalize them, deduplicate, qualify and offer eligible leads for campaign enrollment. |
| S3-03 | Review before enrollment | Show why a lead qualified, identify missing/invalid contact data, and avoid contacting suppressed leads. |
| S3-04 | Repeat-run behavior | Rerunning a source does not create repeated contacts or duplicate campaign enrollment. |
| S3-05 | More email providers | Add personal Gmail, Outlook/Microsoft 365 and/or SMTP/IMAP based on the first client's need. Sending and reply synchronization must both work. |

Choose a supported implementation—direct APIs or Composio—after checking exact channel actions, permissions, trigger coverage and cost. A connector listing alone is not proof it can perform the product's complete workflow.

## 9. Session 4: extra messaging and controlled AI automation

| ID | Requirement | Acceptance |
| --- | --- | --- |
| S4-01 | Instagram messaging | Add the adapter, authentication, inbound delivery and inbox UI for the supported account type and permitted messaging workflows. |
| S4-02 | Facebook Messenger | Add a separate supported adapter and permission/webhook setup; do not assume it is maintained in Unipile. |
| S4-03 | Optional AI auto-replies | Keep approval as the default. Add an explicit opt-in policy for selected situations, limits, escalation and an immediate pause path. |
| S4-04 | Safe retry behavior | Prevent duplicate sends during retries and reconnection; record whether an attempted send succeeded, failed or has an uncertain outcome. |

No connector grants permission to send arbitrary cold DMs. Confirm current provider capabilities and messaging rules during implementation, and reflect the actual supported workflow in the product.

## 10. Later operational milestone

Subscription billing, advanced reporting, larger-scale hosting, distributed sending workers and broader integrations can follow the owner release and client pilot. Manual commercial arrangements are sufficient for an initial pilot if the owner chooses them.

The current sender architecture needs a single app instance. Horizontal scaling is a separate engineering change. Do not promise a client capacity from CPU/RAM alone; measure actual workload first.

## 11. Product and engineering requirements

- Keep organization-scoped reads/writes and existing role checks intact. New readiness endpoints are authenticated and scoped too.
- Preserve encrypted provider credentials, Do Not Contact, unsubscribe handling and reply-based stopping.
- Keep AI replies held for approval in Session 1.
- Show actionable errors and honest status; hide unavailable actions behind setup guidance rather than broken controls.
- Preserve saved settings and campaign state through application restarts.
- Use the existing component system. Prioritize legibility, clean spacing, consistent branding and usable phone layouts over decorative redesign.
- Use a single source of truth for product name, wordmark and public brand assets. Keep legal/upstream attribution separate from customer-facing product copy.
- Use TypeScript for new implementation code and follow the repository's migration/tenancy conventions.
- Add meaningful regression checks for changed import, permission, readiness and sending behavior. Branding-only tests that merely repeat constants are unnecessary.
- Keep a progress file with completed requirements, verification evidence and real blockers so another session can continue.

## 12. Dependencies and cost handling

| Dependency | Required when | Handling |
| --- | --- | --- |
| GitHub copy | Development starts | Owner forks the public repo or creates an independent private repo; agent clones that copy |
| Docker/PostgreSQL | App runtime | Fresh development database; customized production build later |
| Public domain/HTTPS | Live provider callbacks | Local UI testing can happen first; localhost does not receive external webhooks |
| Unipile | Native LinkedIn/WhatsApp | Start the standard seven-day trial after the app is ready; 2–3 test accounts fit within its trial account allowance |
| Google Workspace administrator access | Native email | Required for the existing delegation setup |
| Gmail Pub/Sub | Email reply-aware operation | Configure and verify inbound delivery rather than only outbound sending |
| OpenRouter/BYOK | AI classification and drafts | Owner configures the existing credentials and eligible model |
| Resend | Invitation/password-reset email | Configure before inviting users; first-owner setup itself does not require it |
| R2/recorder extension | Recording/transcription | Optional for initial messaging use |

AgentSDR's license does not cover the cost of hosting or third-party services. The trial is not a permanent free Unipile tier. After it ends, connected-channel API access requires an active subscription; the application's UI can still run.

Do UI work, importer fixes and fixture-based checks before starting the trial. Buy a subscription when continued real messaging or a client pilot needs it. Store secrets through the existing app configuration and secure host environment, never in repository files or the handoff report.

## 13. Session 1 acceptance checklist

- [ ] Owner repository is identified and the checked-out commit is recorded.
- [ ] Branded app starts from a fresh source build.
- [ ] First owner/workspace creation works; demo mode is disabled for real use.
- [ ] Product branding is consistent across the changed app/auth surfaces.
- [ ] The known XLSX dependency issue is resolved and lockfile/install behavior is verified.
- [ ] CSV/XLSX import, duplicates, custom fields and actionable invalid-input errors are checked.
- [ ] Getting Started links to working settings and computes readiness accurately.
- [ ] Existing owner controls work; member restrictions remain enforced.
- [ ] Relevant tests, typecheck, lint and production build pass, with unrelated baseline failures clearly recorded if any exist.
- [ ] The manual UI checklist is completed by the owner, or explicitly pending.
- [ ] At least one configured native channel has controlled send/receive evidence, or the release is labelled Pending live verification.
- [ ] A received reply prevents the appropriate remaining follow-ups from continuing.
- [ ] No global admin/billing/new-channel work has entered Session 1.
- [ ] Run instructions, verification results and next-session priorities are written down.

## 14. Reference sources

Repository facts were checked on 13 October 2026. Requirements and session grouping are product decisions for this project.

- [Repository and current setup](https://github.com/Kandid-ai/AgentSDR)
- [MIT license](https://github.com/Kandid-ai/AgentSDR/blob/main/LICENSE)
- [Agent instructions](https://github.com/Kandid-ai/AgentSDR/blob/main/AGENTS.md)
- [Implementation conventions](https://github.com/Kandid-ai/AgentSDR/blob/main/CLAUDE.md)
- [Organizations and roles](https://github.com/Kandid-ai/AgentSDR/blob/main/docs/workspace/organizations.mdx)
- [Sending rules](https://github.com/Kandid-ai/AgentSDR/blob/main/docs/workspace/sending-rules.mdx)
- [AI setup](https://github.com/Kandid-ai/AgentSDR/blob/main/docs/workspace/ai-provider.mdx)
- [Unipile setup](https://github.com/Kandid-ai/AgentSDR/blob/main/docs/integrations/unipile.mdx)
- [Gmail reply synchronization](https://github.com/Kandid-ai/AgentSDR/blob/main/docs/integrations/gmail-reply-sync.mdx)
- [Production requirements](https://github.com/Kandid-ai/AgentSDR/blob/main/docs/self-hosting/production.mdx)
- [Unipile pricing and trial](https://www.unipile.com/pricing-api/)
- [Unipile scopes](https://developer.unipile.com/v2.0/docs/scopes)
- [Spreadsheet prototype-pollution advisory](https://github.com/advisories/GHSA-4r6h-8v6p-xvw6)
- [Spreadsheet ReDoS advisory](https://github.com/advisories/GHSA-5pgg-2g8v-p4x9)

