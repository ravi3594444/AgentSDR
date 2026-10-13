# Session 1 status

Last updated 2026-10-13. The format follows section 5 of
[IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md). The run steps are in
[OWNER_SETUP.md](OWNER_SETUP.md).

## Summary

- **Repository:** origin `https://github.com/ravi3594444/AgentSDR`, with
  `upstream` set to `https://github.com/Kandid-ai/AgentSDR.git` (a local
  remote only).
- **Branch:** `claude/new-session-g5hljn`. `main` is untouched; see
  OWNER_SETUP §0.
- **Baseline:** `bdbf5efd2017347181f5bf549b54d89c1ae6e5f5` (v0.3.1). It is the
  same commit the PRD reviewed.
- **Final commit:** see the branch head; the session's commits are listed
  under "Commits".
- **Readiness:** **Build-ready / Pending live verification.** No provider
  credentials (Google Workspace, Unipile, OpenRouter, Resend) or public HTTPS
  address were available. No real send or receive has happened, so this is
  not "Owner-usable" yet.
- **Toolchain used:** Bun 1.4.2 (`packageManager` pins 1.3.14; the frozen
  install was clean with both, and the Docker image used 1.4.3), Node
  22.22.0, PostgreSQL 16.15 for source runs and 18 (the Compose image) for
  Docker.

## Completed PRD requirements

| ID | State | Evidence |
| --- | --- | --- |
| S1-01 Branding | Done in code. Visual check pending | `src/lib/brand.ts` is the single source. It covers the app shell, sidebar, mobile header, auth pages, page titles, auth email, favicon and Apple icon. The page title `22nd X AI Outreach` was seen on `/setup` (dev, production build and Docker). The owner's manual visual check is still pending. |
| S1-02 Spreadsheet import | Done | `xlsx` now comes from the vendored official tarball, 0.20.3, which fixes CVE-2023-30533 and CVE-2024-22363 (`vendor/README.md`). Every importer reads through `src/lib/spreadsheet/read.ts`. The tests cover CSV, XLSX, UTF-8, Windows-1252, empty and corrupt files, duplicates, custom fields and row numbers. API runs covered CSV, XLSX and PNG (see below). |
| S1-03 First-owner setup and persistence | Done | `/setup` on an empty database worked from source and in the Docker image (fresh PostgreSQL 18). After an app-container restart, sign-in, a changed sending rule, a paused campaign and 4 people (UTF-8 intact) were all still there. |
| S1-04 Getting Started | Done | `/getting-started` computes readiness from saved state. The rules are unit-tested (19 tests). It is authenticated (anonymous visitors are sent to `/sign-in`) and organization-scoped, and the isolation run covered it. |
| S1-05 Integration status | Done | The statuses are Not configured / Not yet verified / Needs attention / Connected. "Connected" also requires the inbound half (a Gmail Pub/Sub topic; registered Unipile webhooks). No secrets are read or shown. |
| S1-06 Owner controls | Done (API). UI pending | `scripts/e2e/owner-controls.ts` passed 32/32 checks. A member got 403 on sending rules, integrations, Unipile disconnect and webhooks, AI settings, invites and role changes, while the owner's probes reached validation (400). |
| S1-07 Outreach workflow | Partly verified | Over the API: import, campaign create → active → paused → active → paused, and delete. Sending, receiving a reply and reviewing a draft need a live channel and AI, so they are **pending live verification**. |
| S1-08 Defects found and fixed | Done for what was found | See "Defects fixed". |
| S1-09 Reproducible run and handoff | Done, with one sandbox caveat | `bun run build` passes. The Docker image built and ran with the override, but see "Docker build in this sandbox". OWNER_SETUP.md and this file are written. |

## Checks

| Check | Baseline (`bdbf5ef`) | After Session 1 |
| --- | --- | --- |
| `bun install --frozen-lockfile` | clean | clean (the lockfile now points at `vendor/xlsx-0.20.3.tgz`) |
| `bun run typecheck` | pass (~60 s, no heap flag needed) | pass |
| `bun run lint` | 0 errors, 6 warnings | 0 errors, the same 6 warnings, all in untouched files |
| `bun run test` | 765 pass / 100 files | 801 pass / 102 files |
| `bun run build` | not run at baseline | pass (~2.5 min) |
| `bun run db:check` | pass (fresh database) | pass |
| `scripts/e2e/tenancy-isolation.ts` | — | pass: 101 reads, 12 writes and 61 pages as organization B, 0 failures and 0 items to review (after the 404 fix below) |
| `scripts/e2e/owner-controls.ts` (new) | — | 32/32 pass |

Notes on these checks:

- **Build warnings.** The build prints 2 Turbopack "Module not found:
  Can't resolve <dynamic>" warnings. Both come from
  `src/lib/grid/runners/sandbox.ts`, the Tables formula sandbox, which this
  session did not touch. The same warnings appear in `bun run dev`.
- **Lint after a build.** A `bun run lint` run after `bun run build` used to
  add 22 warnings from the gitignored `extensions/whatsapp-recorder/dist`.
  It is now ignored, like `.next`.
- **Isolation runs against `bun run dev`.** Run against `bun run start`,
  Better Auth's production rate limiter answers the script's rapid sign-ins
  with 429, so the script has to run against the dev server.

## Import and permission evidence

All of this was run against a disposable local database:

- **People import, CSV.** The file had a UTF-8 accent and a Devanagari name,
  a blank line, an in-file duplicate differing only by case, and an invalid
  email. The import created 2 people and updated 1. The invalid row was
  reported as **row 5**, its real row in the file. Re-importing created 0
  and updated 3. Names stayed intact (`José`, `राज शर्मा`), and a blank cell
  did not erase an existing title.
- **People import, XLSX.** 2 created, and `skippedNoIdentity: 1` for a row
  with neither an Email nor a LinkedIn URL. That row used to be dropped
  without any report.
- **Unreadable files.** A PNG uploaded as a spreadsheet now gets a 400 with
  "Could not read that file. Upload a CSV or an Excel workbook (.xlsx)." That
  holds for People, email-campaign preview and import, and the LinkedIn
  uploads. The email-campaign preview used to throw a 500.
- **Without a session**, the import API returns 401 and pages redirect to
  sign-in.
- **The owner-controls script** checks:
  - member and owner role enforcement;
  - that an invited address can sign up on an invite-only instance;
  - that a member still has normal product access;
  - that a member sees "Only an owner or admin…" on integration steps.

## Defects fixed

1. **Vulnerable `xlsx` 0.18.5.** It was replaced with the official 0.20.3
   tarball, vendored, and the Docker deps stage now copies `vendor/`. A test
   fails if a release older than 0.20.2 comes back.
2. **UTF-8 CSV turned into mojibake** (pre-existing in 0.18.5 too). The
   People, Calling contacts, LinkedIn campaign, LinkedIn search and WhatsApp
   importers read BOM-less UTF-8 as Latin-1, so "José" became "JosÃ©". The
   old proof: the probe in this session showed the same output from 0.18.5
   and 0.20.3 before the fix.
3. **Row numbers in import errors were wrong** after blank or filtered rows
   (People, Calling, email campaigns).
4. **The invite-only sign-in page mailed `pulkit@kandid.ai`** (the upstream
   maintainer) to ask for "AgentSDR Managed" access. It now uses
   `BRAND.accessRequestEmail`, which is null by default, so no link is shown.
5. **`PATCH /api/outreach/campaigns/:id` stored any status string.** There is
   no CHECK constraint, so a bad value hid the campaign from every filter.
   Unknown statuses now get a 400.
6. **Cross-organization ids returned 200 instead of 404** on `DELETE
   /api/outreach/campaigns/:id`, `…/merge-fields` and `…/leads`. Nothing
   leaked or changed, but DELETE claimed success. These were found by the
   isolation script.
7. **The People import dropped rows without an identity silently.** It now
   reports how many.

## Docker build in this sandbox

The committed `Dockerfile` changed only by adding `COPY vendor ./vendor` to
the deps stage.

In this cloud sandbox, outbound HTTPS from build containers passes through
a TLS-intercepting proxy, so `apk add` and `bun install` inside the build
failed certificate checks. The image (`agentsdr:local`) was therefore built
from a **scratch copy** of the Dockerfile. That copy only added the proxy's
CA after each `FROM`, passed in as a BuildKit build context; nothing about
it is committed.

`docker compose -f docker-compose.yml -f docker-compose.build.yml up -d
--no-build` then ran that image. On a normal host,
`docker compose -f docker-compose.yml -f docker-compose.build.yml up -d
--build` should work unchanged; that is an inference, not tested on the
owner's machine.

## Manual owner checks

All nine checks in OWNER_SETUP §5 are **pending**. No browser or UI
automation was run (AGENTS.md).

## Live channel evidence

None yet. Google Workspace, Unipile, OpenRouter and Resend were not
configured in this session, and the server had no public HTTPS address.
Every channel is "Not configured" in Getting started, which matches reality.

## Missing to reach Owner-usable

1. A public HTTPS domain for the server (`APP_URL`), behind a reverse proxy.
2. At least one channel:
   - **Google Workspace:** service account with domain-wide delegation, plus
     a Gmail Pub/Sub topic and push subscription;
   - **or Unipile:** start the 7-day trial after the steps above, and link
     2–3 test accounts.
3. OpenRouter keys and a BYOK provider, for reply sorting and drafts.
4. Resend (`RESEND_API_KEY`, `AUTH_EMAIL_FROM`) before inviting anyone.
5. A controlled send to the owner, a reply, and confirmation that follow-ups
   stopped (OWNER_SETUP §5, items 5–7).

## Exact start and rebuild commands

See OWNER_SETUP §1 (Docker Compose with `docker-compose.build.yml`) and §2
(from source). In short:

```bash
docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
```

## Known issues not fixed (deliberately left for later)

- **CSV numbers are inferred.** A CSV value like `007` or `09876543210`
  loses its leading zero. Local phone numbers without `+` are only kept when
  the organization's Default phone country is set.
- **Duplicate rows in one file.** For a person repeated within one People
  import, the last non-empty value wins.
- **Launch is guarded only in the UI.** The email-campaign checks (connected
  mailbox, steps, leads) run in the UI; the API accepts `status: active`
  without them.
- **No explicit file-size limit** on the People, Calling, LinkedIn and
  email-campaign uploads. WhatsApp (20 MB) and Tables (25 MB) have one.
- **Upstream names left in place:**
  - The Call Recorder extension is still named and drawn as AgentSDR.
  - The demo-only copy says "Self-host AgentSDR".
  - The Help menu links to upstream docs (docs.agentsdr.ai) and upstream
    GitHub issues (`src/lib/support.ts`).
- **`next start` warns about `output: standalone`** on the source route. It
  still serves; Docker uses `server.js`.

## Commits (on top of `bdbf5ef`)

- `3273a5f` Spreadsheet import: SheetJS 0.20.3 and UTF-8 CSV that stays UTF-8
- `caa6329` Brand the product as 22nd X AI Outreach
- `046ee96` Getting Started: a readiness checklist over the existing setup
- `e2180fa` Email campaigns: another organization's id is a 404 on three routes
- `6e0c55c` Lint: ignore the recorder extension's build output
- `fe9fc9c` Getting Started: use the settings' own page names; link Sending rules
- the documentation commit that adds `docs/product/`

## Follow-up: AI/ML API as a second AI provider

Requested after Session 1: add AI/ML API to AI Settings with encrypted
per-organization credentials, adapt the runtime, verification and model
selection, drop OpenRouter's management-key/BYOK/routing requirements for
AI/ML connections, teach Getting Started about it, and test reply
classification and drafting with a structured-output model.

What was built (design notes in `src/lib/ai/README.md`):

- **One active provider per organization**, chosen in Settings → AI
  provider (OpenRouter or AI/ML API). The OpenRouter panel is unchanged; the
  AI/ML panel is key → models → default.
- **Credentials:** an AI/ML connection is the existing encrypted
  `grid_providers` / `grid_provider_credentials` pair, organization-scoped,
  holding only `apiKey`. It is verified with `GET /v1/key` (free; 401 on a bad
  key). The public model list cannot verify a key.
- **Runtime:** `getAiRuntime` (was `getOpenRouterRuntime`) applies a pure
  gate, `runtimePlan.ts`. OpenRouter keeps strict provider routing, the
  BYOK-only confirmation and function-call answers. AI/ML needs no
  confirmation and answers through strict `response_format: json_schema`;
  strict mode is dropped only for a user-written column schema that strict
  mode would reject.
- **Model selection:** only AI/ML chat models tagged `structured_output` in
  its live catalog are offered (319 of 932 catalog entries on 13 Oct 2026).
  They are revalidated on save, and a default is required.
- **Refused clearly with AI/ML**, rather than half-working:
  - call transcription (your separate compatibility check is still to do);
  - web-research and image AI columns, and the qualification parent lookup
    (all need OpenRouter's web plugin or image endpoint).
- **Getting Started** shows "Ready: <model> through AI/ML API" with no BYOK
  or routing step.

Evidence (local disposable database, production build, real AI/ML calls):

- **Probes against AI/ML:** strict JSON schema with the real CRM classifier
  and draft schemas succeeded on these three models:
  - `openai/gpt-4o-mini`
  - `google/gemini-3.5-flash-lite`
  - `anthropic/claude-haiku-latest`

  `mistralai/mistral-small-2603` returned 429 "rate-limited upstream"; the
  retry loop treats that as transient.
- **API checks:**
  - A bad key gets a 400 ("AI/ML API rejected this key"), and an
    OpenRouter-only credential field gets a 400.
  - The real key verified and was stored encrypted; the plaintext key
    appears in no database row.
- **Settings save rules:** each of these got a 400:
  - transcription switched on;
  - a model without structured output;
  - an OpenRouter provider slug on an AI/ML connection;
  - no default model.

  A valid save stored `byokOnlyConfirmed: false`.
- **Live CRM pipeline** (`scripts/e2e/ai-live-crm.ts`): an inbound reply
  went through the running server's CRM worker. It was classified
  `interested` (0.95, auto-applied) and a draft was written that waits for
  review, with no send attempt. This passed with both
  `openai/gpt-4o-mini` and `google/gemini-3.5-flash-lite`. The stored
  request shows strict JSON schema with no tools or routing.
- **Tables AI column through the real runner:** a content cell completed; a
  web-research cell was refused up front.
- **Permissions** (`scripts/e2e/owner-controls.ts`): all checks pass. A
  member gets 403 on adding an AI/ML key and on changing AI settings; the
  owner's probes reach input validation.
- **Repository checks:** typecheck passes, lint shows the 6 baseline
  warnings, tests are 819 pass / 103 files, and `bun run build` passes.
- **Isolation** (`tenancy-isolation.ts`): no failures, with organization A's
  AI/ML connection among the fingerprints. Its 96 "review" items were
  HTTP 500 pages from the dev server, whose Turbopack-generated CSS was
  corrupted in this sandbox (`globals.css:3840`, garbage bytes); the source
  file is unchanged and the production build compiles it. Replayed as
  organization B against the production server, those 96 requests returned
  no 5xx and nothing of A's. Probed directly as B, A's AI/ML connection id
  gives a 409 when reading its catalog, a refused save (nothing stored)
  when set in AI settings, and a 404 on delete.

Open points:

- **Draft wording.** With both models, the draft promised actions not taken
  ("I've scheduled…", "I have sent over the calendar invite") and once left
  `[Your Name]`. The draft prompt and sender details come from Settings →
  Instructions and Knowledge, not from the provider. Drafts always wait for
  review, but this is worth tightening (prompt rules, or filling in sender
  details) before relying on them.
- **Call transcription with AI/ML API:** not attempted, as requested. It is
  refused in code and in the settings save until checked.
- **The test key was pasted into a chat:** rotate it in the AI/ML API
  dashboard and re-enter it.

## Session 2: deliberately deferred

None of this entered Session 1:

- a platform admin console;
- an operator role and client lifecycle;
- per-client limits and budgets;
- central Unipile onboarding;
- an audit trail;
- scraping or sourcing automation;
- new email or DM adapters;
- automatic AI sending;
- billing;
- multiple app replicas.

Suggested Session 2 order (PRD §7):

1. Pass Session 1 acceptance: the owner checks plus one live channel.
2. Define server-enforced operator permissions and suspension semantics.
3. Add schema changes through re-runnable TypeScript migrations, plus the
   tenancy registry.
4. Build operator-only APIs, then the admin UI.
5. Central Unipile onboarding with per-client scoping.
6. Enforce suspension and limits in workers.
7. Audit records.

Before building on it, also consider moving the email-campaign launch checks
server-side and adding upload size limits.
