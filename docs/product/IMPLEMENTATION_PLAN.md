# Implementation plan: 22nd X AI Outreach

**Date:** 13 October 2026  
**Product requirements:** [PRD.md](PRD.md)  
**Upstream:** `https://github.com/Kandid-ai/AgentSDR.git`  
**Reviewed baseline:** v0.3.1 / `bdbf5efd2017347181f5bf549b54d89c1ae6e5f5`

**Current next-session plan (updated 18 October 2026):**
[Multi-source research, browser tools and visible agent activity](../plans/MULTISOURCE_RESEARCH_NEXT_SESSION.md).
Use that plan for the upcoming research/browser work and its provider decisions.
The Session 1 instructions below remain the original setup milestone; check the
current baseline before repeating completed work.

## 1. What to do first: fork, then clone

**Recommended default:** the owner forks AgentSDR on GitHub, then the implementation agent clones the owner's fork.

- A **fork** is the owner's GitHub copy, where product changes can be stored.
- A **clone** is the download of a repository onto the agent's development machine or VM.
- Use both for the public-fork route. Cloning only the upstream does not create an owner-controlled destination for future changes.

A fork of this public repository remains public. If the owner wants the customized product code private, create an **independent, empty private repository** instead and use Route B below. Keep the MIT license and upstream copyright notice in either route.

The owner will choose/create the repository. Do not create an additional repository, fork or deployment when the owner has already supplied one.

### Route A — owner creates a public fork

Owner steps:

1. Open [Kandid-ai/AgentSDR](https://github.com/Kandid-ai/AgentSDR).
2. Choose **Fork**, select the owner's GitHub account and create the copy.
3. The fork can retain `AgentSDR` or use an owner-chosen product repository name.
4. Send the fork URL and these two Markdown documents to the implementation agent.

Agent commands, after substituting the real owner repository URL:

```bash
PRODUCT_REPO_URL="https://github.com/YOUR_GITHUB_USERNAME/YOUR_PRODUCT_REPO.git"
git clone "$PRODUCT_REPO_URL" 22nd-x-ai-outreach
cd 22nd-x-ai-outreach
git remote add upstream https://github.com/Kandid-ai/AgentSDR.git
git remote -v
git rev-parse HEAD
git status --short
```

For an existing checkout, inspect and reuse it. Do not run `git remote add upstream` if that remote already exists; verify its URL instead. `origin` must point to the owner's copy and `upstream` to Kandid-ai/AgentSDR.

Optional CLI route for an owner who has not forked yet:

```bash
gh auth status
gh repo fork Kandid-ai/AgentSDR --clone
```

Use the directory printed by the CLI and inspect the remotes. The CLI may set the upstream as its default repository; never rely on that default for a push/PR target. Authentication must use the normal secure GitHub login flow, not credentials pasted into the project.

### Route B — independent private product repository

Owner steps:

1. Create an empty private repository with the desired name.
2. Leave its initial README, `.gitignore` and license creation unchecked so the import starts without unrelated commits.
3. Send its URL to the agent and confirm whether initial upload is wanted now or after Session 1.

Agent commands:

```bash
git clone https://github.com/Kandid-ai/AgentSDR.git 22nd-x-ai-outreach
cd 22nd-x-ai-outreach
git remote rename origin upstream
git remote add origin https://github.com/YOUR_GITHUB_USERNAME/YOUR_PRIVATE_REPO.git
git remote -v
git rev-parse HEAD
git status --short
```

This keeps the source history and an upstream remote without joining GitHub's public fork network. When the owner has requested the upload, push the intended branch to the owner's `origin`, not `upstream`:

```bash
git push -u origin main
```

If the destination already has commits, inspect them and reconcile deliberately. Do not force-push, delete the destination's history or overwrite existing owner work.

## 2. Session 1 contract for the implementation agent

**Goal:** make the existing app usable by the owner with their branding, the known importer fix, a small guided setup layer and working existing owner controls.

**Do now:** requirements S1-01 through S1-09 in the PRD.  
**Do later:** global client administration, central provider credential sharing, scraping automation, new email/DM adapters, automatic AI sends, billing and distributed sending.

A “session” is a bounded implementation milestone, not a guarantee of elapsed hours. Finish and verify its required work before moving on. If live credentials are missing, finish the code and document Pending live verification; do not fake an operational channel.

Keep the current architecture and component system. Favor small improvements over rebuilding the product.

### Repository rules to read before editing

- `AGENTS.md`
- `CLAUDE.md`
- `docs/multi-tenancy/conventions.md` before changing database access
- `docs/database.md` before changing the schema
- `docs/self-hosting/docker-compose.mdx`
- `docs/self-hosting/production.mdx`
- Relevant channel/integration documentation

The reviewed `CLAUDE.md` currently directs work on `main`, with local commits and pushing only when requested. Follow the owner's explicit branch/push instructions if different. Upstream contribution rules about maintainer approval concern contributing to upstream, not ordinary customization in the owner's copy.

The reviewed `AGENTS.md` requests lightweight UI checks and manual verification guidance; browser automation/screenshots need an explicit user request. API/permission regression checks still apply. Do not silently skip UI verification and then label it as passed.

## 3. Runtime setup

Prerequisites: Git, Bun (repository package manager: `bun@1.3.14`), Node.js 20.9+ and Docker with Compose. PostgreSQL 16+ is supported; current Compose supplies PostgreSQL 18. Recheck `package.json` if the checkout differs from the baseline.

For a starter server, use a normal Linux VM. A planning estimate is 2 vCPU, 8 GB RAM and 60 GB SSD; this is not a published minimum or a client-capacity guarantee. No GPU is required for the current hosted-model integration.

### Preferred owner runtime: build the checkout with Docker Compose

**Important:** plain `docker compose up -d` uses AgentSDR's published image. It will not contain the owner's source changes. Use the build override for the branded product.

For a new local installation, create the Compose `.env` securely. The following block intentionally refuses to overwrite an existing configuration:

```bash
umask 077
if [ -e .env ]; then
  printf '%s\n' 'An existing .env is present; preserve it and inspect the setup.' >&2
  exit 1
fi
{
  printf '%s\n' 'APP_URL=http://localhost:3000' 'AUTH_SIGNUP=invite-only'
  for secret_name in BETTER_AUTH_SECRET INTEGRATION_CREDENTIALS_KEY UNSUBSCRIBE_SECRET POSTGRES_PASSWORD; do
    printf '%s=%s\n' "$secret_name" "$(openssl rand -hex 32)"
  done
} > .env
```

Ensure `.env` is ignored by Git. Keep the credential-encryption key backed up with the database and stable across restarts/upgrades. Do not print it in reports.

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
docker compose -f docker-compose.yml -f docker-compose.build.yml ps
docker compose -f docker-compose.yml -f docker-compose.build.yml logs --tail=80 app
```

Inspect logs locally; redact secrets or private messages before sharing diagnostics. Open `http://localhost:3000` and use the existing `/setup` flow to create the first owner and workspace. Do not seed a real owner installation with demo accounts.

For live callbacks, set `APP_URL` to the owner's actual HTTPS origin, add a reverse proxy/domain and restart the app. Saving/re-registering Unipile integration webhooks at the public URL may be necessary after local setup. Google Workspace reply push needs its own Pub/Sub configuration.

Run one app instance. Do not add a second sender process or an external cron that duplicates the built-in send tick.

### Alternative: local source development with an existing PostgreSQL server

This route requires an accessible PostgreSQL 16+ database and an appropriately configured role/password. `createdb` uses the developer's existing PostgreSQL role; it does not create the `agentsdr` database user shown in example URLs.

```bash
bun install --frozen-lockfile
createdb agentsdr_dev
cp .env.example .env.local
```

Edit `.env.local` with the real development database URL and newly generated auth/encryption/unsubscribe secrets. Use `DATABASE_SSL=disable` only for the local non-TLS database. The source route uses `BETTER_AUTH_URL`; the Compose route uses `APP_URL`.

```bash
bun run db:setup
bun run dev
```

Use `db:setup` only for an empty database. It is not an upgrade command. Demo seeding is optional only on a separate disposable local database with no real data.

To test actual background scheduling with the source route:

```bash
bun run build
bun run start
```

`bun run dev` does not run the production senders. Starting the dev server alone is not evidence that outreach scheduling works.

## 4. Session 1 work packages, in order

### A. Establish the baseline

1. Record the owner repository URL, branch, commit SHA and package versions in `docs/product/SESSION_STATUS.md`.
2. Read the repo rules and inspect any existing modifications before editing.
3. Install with the frozen lockfile and establish a fresh local runtime.
4. Run typecheck, lint and the existing test suite. Record failures before changing anything.
5. Inspect the relevant UI/source and make a short list of actual owner-workflow blockers.

Checks:

```bash
bun install --frozen-lockfile
bun run typecheck
bun run lint
bun run test
```

If typecheck exhausts the default JavaScript heap on an adequately sized machine, use:

```bash
NODE_OPTIONS=--max-old-space-size=4096 bun run typecheck
```

Record the adjustment. A stale reported test count is not evidence; capture the result from this checkout.

**Deliverable:** a running baseline and an honest initial status report. Do not refactor unrelated subsystems while establishing it.

### B. Fix the spreadsheet dependency and importer regressions

The reviewed dependency is `xlsx: ^0.18.5`. The ordinary npm release line is outdated; a blind `bun update xlsx` is not an adequate fix.

1. Read the two linked advisories and current official SheetJS installation guidance.
2. Prefer the smallest compatible fix: replace the npm-registry dependency with a pinned official distribution, currently documented as `xlsx-0.20.3.tgz`, or select a maintained replacement if compatibility/security requires it.
3. Confirm the chosen release addresses the known advisories at implementation time. Record its provenance and exact version. Do not suppress a genuine advisory merely to make a scan green.
4. Update `package.json` and `bun.lock`; verify a clean frozen install.
5. Inventory every `xlsx` import so all import/export paths use the fixed dependency.
6. Check CSV/XLSX behavior, malformed inputs, custom fields, duplicate identities and actionable errors. Preserve existing suppression and organization boundaries.

Discovery:

```bash
rg -n 'xlsx|sheet_to_json|readFile|XLSX' src scripts package.json bun.lock
```

SheetJS documentation currently identifies this official tarball:

```text
https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz
```

Use Bun to update the dependency and lockfile. Vendoring the pinned tarball is an option if reliable repeat installs require it. Inspect the resulting package identity/API before committing. Do not introduce npm or Yarn lockfiles into this Bun project.

Regression scenarios should cover a valid CSV, valid XLSX, duplicate/repeated import, custom merge-field preservation, invalid/empty file handling, organization ownership and existing configured size/row limits. Fix the reported critical issue without adding a second lead-import architecture.

**Deliverable:** dependency fix plus meaningful import regression evidence.

### C. Apply the owner branding

1. Add one small client-safe product/brand configuration module for name, wordmark, public assets and product description.
2. Reuse the current theme/component tokens; avoid a full dashboard redesign.
3. Apply the brand to the sidebar, setup/sign-in, metadata/title, relevant auth-email templates and visible legacy logos.
4. Use the working name `22nd X AI Outreach` until the owner chooses another label. If no logo is supplied, use a text wordmark.
5. Use Manrope if the owner supplies/approves the font assets or the existing setup can provide it without build/network fragility. Keep the interface legible in the existing light/dark themes.
6. Preserve `LICENSE`, upstream copyright, third-party attribution and technical provider names such as Unipile/Google Workspace. Do not blindly replace every internal `AgentSDR` identifier.

Useful discovery:

```bash
rg -n 'AgentSDR|AgentSDR_v2|LinkBird|Linkbird|agentsdr\.ai|linkbird' src public extensions .env.example
```

Starting points verified in the reviewed tree:

- `src/app/layout.tsx`
- `src/components/brand/Logo.tsx`
- `src/components/Sidebar.tsx`
- `src/components/linkedin/LinkBirdLogo.tsx`
- `src/app/setup/SetupForm.tsx`
- `src/app/sign-in/SignInForm.tsx`
- `src/app/sign-up/SignUpForm.tsx`
- `src/lib/auth/email.ts`

Recheck assets and imports in the actual checkout. Branding should not change provider callbacks, organization IDs, authentication behavior or legal notices.

**Deliverable:** consistent customer-facing identity, with a short manual visual checklist.

### D. Add a thin Getting Started experience

Implement one useful checklist/overview using existing components and routes. Prefer an existing landing/settings area; introduce a single small route only if needed. Do not add a new setup database/table just to remember checked boxes.

| Item | Readiness basis | Existing destination |
| --- | --- | --- |
| Owner/workspace | Existing authenticated user and organization context | Organization settings |
| Email | Workspace integration/mailbox state, with inbound setup separately identified | `/settings/email-connection`, `/settings/email-accounts` |
| LinkedIn | Unipile integration and linked-account state | `/settings/linkedin-connection`, `/settings/linkedin-accounts` |
| WhatsApp | Unipile integration and synced-number state | `/settings/whatsapp-connection`, `/settings/whatsapp-accounts` |
| AI | Existing eligible provider, default model and routing confirmation | `/settings/ai` |
| Leads | Existing imported people/lead state | `/leads` |
| Campaign | Existing campaign availability and selected channel prerequisites | Existing channel campaign page |
| Replies | Existing inbox/CRM actions | `/crm/actions` and channel inboxes |

Use existing metadata APIs where possible. A new status endpoint must require authentication, resolve the current organization and return only safe metadata—never API keys or full credential records.

Connection verification should happen on explicit connection/test actions, not on every render. A saved credential row is not proof of a successful send or inbound webhook. Unknown/unverified state needs honest wording.

AI setup remains the current OpenRouter/BYOK workflow. Explain its actual steps; do not add a generic API-key box that silently bypasses it. Session 1 must not centralize credentials across organizations.

**Deliverable:** fewer confusing setup steps, with functioning links and trustworthy readiness.

### E. Keep owner control simple and verify the core workflow

Reuse existing owner/admin/member permission helpers and channel settings. Make them easy to reach from Getting Started and the current navigation.

Verify that the owner can:

- Edit their organization's integrations and AI settings.
- Change the existing sending rules/account overrides.
- Import leads, create a campaign and pause/resume it.
- Review replies and approve/edit a draft.

Verify that a member cannot change privileged settings, and that another organization cannot read/mutate this organization's resources. Do not implement a platform-wide client directory, usage ledger, billing system or new operator role in this session.

If there is a real workflow defect, reproduce it and patch the existing implementation. Friendly UI errors should retain useful diagnostics for the operator without exposing credentials or raw private payloads.

**Deliverable:** existing owner capabilities are usable and correctly protected.

### F. Verify, build the product image and hand off

Run the repository's real checks after the changes:

```bash
bun run typecheck
bun run lint
bun run test
bun run build
```

After changing tenant-scoped data access, use a disposable local database and the repository's scope/isolation checks:

```bash
bun run db:check
BASE_URL=http://localhost:3000 bun run --conditions=react-server scripts/e2e/tenancy-isolation.ts
```

Follow the script's requirements and use its isolated local test environment. Never point it at an owner's live data. This is API/data verification; follow `AGENTS.md` separately for browser checks.

Rebuild with the source override and verify persistence through an app-container restart. Add a fresh-schema test only if schema changes were actually needed. Do not use `db:setup` as an upgrade or `drizzle-kit push` as an unexplained migration shortcut.

The owner manual checklist:

1. Create/sign in to the owner workspace and inspect branding.
2. Follow Getting Started and confirm its status matches actual configuration.
3. Import a small CSV and XLSX and inspect duplicates/custom fields.
4. Create a draft campaign and inspect its messages and limits.
5. Configure one real native channel and perform a controlled send/receive test when the owner is ready.
6. Confirm the reply appears and the applicable follow-ups stop.
7. Review/edit a draft without automatic AI sending.
8. Restart the app and verify saved settings/leads/campaign state.
9. Check changed screens on a phone-width viewport.

Mark owner-run checks Pending until the owner supplies results. Live sending or provider setup is not authorized merely by writing this plan; follow the owner's actual instructions when those actions are needed.

**Deliverable:** working owner build or an explicitly labelled build with specific live-verification blockers; no misleading “all done” claim.

## 5. First-session handoff files in the product repository

Copy this PRD and plan into `docs/product/`. Add/update:

- `docs/product/SESSION_STATUS.md` — baseline SHA, completed requirement IDs, checks/results, owner/live verification status, blockers and next-session priorities.
- `docs/product/OWNER_SETUP.md` — exact runtime/provider setup steps for this build, including Compose vs source configuration and public callback setup.

Do not include real secrets, passwords, private lead data or raw provider responses. Preserve the original source instructions; if owner-specific instructions are added, clearly state their scope.

Suggested final status format:

```markdown
# Session 1 status
- Repository / branch / baseline / final commit:
- Readiness: Build-ready | Owner-usable | Pending live verification
- Completed PRD IDs:
- Typecheck / lint / tests / build:
- Import and permission regression evidence:
- Manual owner checks:
- Live channel evidence, using redacted references:
- Missing credentials/domain/access, if any:
- Exact start/rebuild commands:
- Remaining Session 1 blockers:
- Session 2 work deliberately deferred:
```

Only commit the intended files. Follow current repository/owner instructions for committing and pushing. Do not open an upstream pull request as part of building the branded product.

## 6. Trial and external-access checkpoint

Finish source customization, importer fixes and local/fixture verification before starting Unipile's standard seven-day trial. The planned 2–3 connected test accounts fit within the documented trial allowance.

During the trial, verify the actual selected channels: authentication, account mapping, sending, inbound delivery, reconnection handling and reply stopping. Keep account-level provider limits; do not remove WhatsApp warm-up or production safeguards just to speed up a demonstration.

After the trial ends, continued Unipile channel access requires a subscription. The product's UI and other configured services can remain available. Do not describe it as permanently free live LinkedIn/WhatsApp access.

If Google Workspace or AI credentials are missing, report that fact and finish the rest of Session 1. Do not spend Session 1 replacing OpenRouter, building personal Gmail OAuth or substituting Composio for the native LinkedIn/WhatsApp implementation.

## 7. Later implementation sessions

### Session 2 — client admin and managed account onboarding

**Prerequisite:** Session 1 acceptance has passed and the owner has chosen the client-hosting/provider model.

1. Define explicit operator permissions and client suspension/limit semantics.
2. Add any required schema changes through re-runnable TypeScript migrations, matching Drizzle definitions and the tenancy registry/schema snapshot.
3. Implement operator-only APIs for organization/user lifecycle, usage limits and operational status.
4. Build the platform admin UI over those APIs; verify ordinary organization admins cannot access it.
5. Implement central Unipile onboarding with per-client scope/key boundaries and account ownership mapping.
6. Manage hosted authentication, reconnection and shared webhook registration with the correct key permissions. Validate the deployed API/SDK version; current v2 scope documentation is not proof the existing v1 SDK wiring supports it unchanged.
7. Enforce suspension/budgets in entry points and send workers, not just the dashboard.
8. Add privileged-action audit records and isolated-client regression tests.

**Exit:** the operator can onboard and manage a controlled client pilot without clients receiving master provider keys or seeing each other's data.

### Session 3 — sourcing pipeline and necessary email adapters

1. First support an external Gosom CSV through the working importer.
2. Add an explicit source-run/job model only when automatic ingestion is needed.
3. Normalize results, record provenance, deduplicate and qualify with reviewable reasons.
4. Add approved campaign enrollment and repeat-run/idempotency checks.
5. Build the additional email adapter the first client actually needs, covering authentication, send, inbound replies, reconnection and suppression.
6. Choose direct APIs or Composio from verified action coverage and total provider cost.

**Exit:** eligible leads reliably reach campaigns without repeated contacts, and the chosen additional email provider has a verified send/reply flow.

### Session 4 — additional DM channels and opt-in AI sending

1. Verify current Instagram/Facebook provider support and allowed messaging workflows.
2. Implement separate channel adapters, account connections, webhooks and inbox handling.
3. Add optional AI sending only after drafting/classification is proven; define allowed reply types, budget/cap, escalation, pause and uncertain-send recovery.
4. Test duplicate delivery, provider failures and human takeover.

**Exit:** each added channel has a proven complete lifecycle, and AI auto-sending is explicit, bounded and reversible by the operator.

### Later — billing and scale

Implement subscriptions/entitlements and distributed sending only when client demand requires them. A larger VM is the first scaling step for the current single-app sender. Multiple app replicas need a verified distributed coordination design and duplicate-send protection.

## 8. Scope and implementation safeguards

- Do not turn the personal-use Session 1 milestone into a full SaaS rebuild.
- Preserve the existing organization scope and encrypted per-organization integration store.
- Provider keys belong in existing secure settings, not new plaintext environment fallbacks.
- New app/tooling code is TypeScript. Keep new DB fields/tables in sync with migrations, schemas and registry classification.
- Keep the existing SQL/Drizzle table-family constraints; do not delete migration history or blindly run schema-push commands.
- Do not share an unrestricted Unipile key across client organizations; managed client integration belongs to Session 2.
- Do not make unsupported provider integrations appear functional by adding placeholder buttons.
- Do not enable demo mode or seed demo credentials in a real-data deployment.
- Do not enable multiple sender replicas or duplicate cron/send ticks.
- Preserve the MIT license and attribution while changing the customer-facing brand.

## 9. Paste-ready Session 1 instruction for your agent

```text
Use my supplied GitHub repository as origin; the upstream foundation is
Kandid-ai/AgentSDR. Read PRD.md and IMPLEMENTATION_PLAN.md, then implement
Session 1 only: a usable owner version branded as 22nd X AI Outreach.

Clone my fork, or import the upstream into my empty private repository using
the route in the plan. Read AGENTS.md, CLAUDE.md and the tenancy/migration
rules. Record the actual baseline commit and preserve existing work.

Keep the current app architecture. Fix the XLSX dependency/import issue,
apply consistent branding, add a thin Getting Started/status experience
linked to the existing settings, and make the existing owner workflow work.
Use a text wordmark if my logo is unavailable. Reuse owner/admin/member roles
and per-organization integrations. Do not build the platform admin console,
central client-provider system, scraping automation, new email/DM channels,
billing or automatic AI reply sending in this session.

Run meaningful import/permission/readiness regressions and the repository's
typecheck, lint, tests and production build. Follow AGENTS.md for manual UI
verification; do not claim it passed before there is evidence. Build the
custom checkout with docker-compose.build.yml so my deployment contains my
changes, and verify that saved settings and leads survive a restart.

Finish local/fixture work before asking me to start the Unipile trial. If
credentials or HTTPS callback access are missing, complete the implementation
and report Pending live verification with the exact missing steps. Never
pretend mock results are successful real sends. Use only the live actions
and deployment/push steps I have actually requested.

Maintain docs/product/SESSION_STATUS.md and OWNER_SETUP.md. End with the
actual commit/status, commands to run, checks performed, live/manual checks
still pending and a focused Session 2 handoff. Finish Session 1 before
starting anything from later sessions.
```

## 10. Primary references

- [GitHub fork behavior and visibility](https://docs.github.com/en/pull-requests/reference/forks)
- [GitHub CLI fork command](https://cli.github.com/manual/gh_repo_fork)
- [AgentSDR source](https://github.com/Kandid-ai/AgentSDR)
- [Docker source-build override](https://github.com/Kandid-ai/AgentSDR/blob/main/docker-compose.build.yml)
- [Compose setup](https://github.com/Kandid-ai/AgentSDR/blob/main/docs/self-hosting/docker-compose.mdx)
- [Source runtime setup](https://github.com/Kandid-ai/AgentSDR/blob/main/docs/self-hosting/from-source.mdx)
- [Production jobs/webhooks/backups](https://github.com/Kandid-ai/AgentSDR/blob/main/docs/self-hosting/production.mdx)
- [Gmail reply synchronization](https://github.com/Kandid-ai/AgentSDR/blob/main/docs/integrations/gmail-reply-sync.mdx)
- [SheetJS installation and authoritative distribution](https://docs.sheetjs.com/docs/getting-started/installation/nodejs/)
- [CVE-2023-30533 advisory](https://github.com/advisories/GHSA-4r6h-8v6p-xvw6)
- [CVE-2024-22363 advisory](https://github.com/advisories/GHSA-5pgg-2g8v-p4x9)
- [Unipile trial/billing](https://developer.unipile.com/v2.0/docs/billing)
- [Unipile scopes](https://developer.unipile.com/v2.0/docs/scopes)

