# Pilot deployment — 21 October 2026

This branch combines the finished navigation work, Bright Data research and the narrowed AI/ML reply fix for one VM pilot. Claude subscription login is deferred until the deployed product passes live acceptance. No new outreach was sent while preparing this branch.

## Contents

- Bright Data parent: `d14cf74bc3eca3459b9dfc4c72f2e030b793988c` (`claude/brightdata-discovery`), including B01–B03. It already contains the navigation release at `373ac3c`.
- Reply parent: `da7f61969429c49800224aadccb2c0fe397c0ca7` (`pr7-narrow`). JSON schema remains the first request for models tagged for structured output. Only an AI/ML HTTP 400 can cause one function-call fallback, and only for a model tagged for tools. Validation remains in place. No fake holding reply is sent on a generation failure.
- Final integration fix: preserve a provider's full Retry-After instead of shortening it to 15 minutes. If the wait exceeds the research task's remaining 20-minute lifetime, wake at that deadline and finish the task before another trigger or SERP request. Collection retries keep their original not-before time in the ledger; SERP waits retain the returned delay too. Earlier partial results remain available.

This is an isolated pilot branch, `codex/pilot-deploy-20261021`. Neither main nor `claude/dreamy-fermi-h5woha` is changed by its publication.

## Checks on the combined tree

- TypeScript and focused ESLint: pass. The production build also ran TypeScript after the final database regression checks were added.
- Focused checks: 106 pass, zero fail, including deploy packaging, reply generation, provider fallback, Bright Data mapping and wait deadlines.
- Full unit suite: 1,938 pass, four fail. The same four failures reproduce on the unchanged navigation baseline: two local date-display expectations in `runEvidence.test.ts`, one parsed date in `intake/fields.test.ts`, and one spreadsheet date in `grid/import.test.mjs`. These environment-sensitive failures have not been changed in this branch.
- Production build: recorder packaging followed by Node with a 4,096 MB heap and `next build --webpack` completed with exit 0. Existing dynamic-import warnings in the grid sandbox remain. Build-time auth warnings occur without the VM's configured environment.
- Two database regression checks were added for the long Retry-After deadline. Native PostgreSQL and Docker are unavailable in this environment, so those checks and the combined database suites were not rerun here. Earlier branch results reported by the other agent are not a new verification of this combined tree.
- Not verified here: the actual Docker image, real DeepSeek response, real delivery, or a contactable Bright Data prospect. These remain live acceptance work.

## Deploy on the existing VM

In the persistent terminal (`tmux new -A -s agentsdr-deploy`), run:

```bash
(
set -euo pipefail
cd ~/leads-x
unset MIGRATIONS SKIP_GIT_UPDATE DEPLOY_REEXEC
export COMPOSE_FILE=docker-compose.yml:docker-compose.build.yml:docker-compose.discovery.yml
export NEXT_BUILD_HEAP_MB=4096
bash docker/deploy.sh --branch codex/pilot-deploy-20261021
git log -1 --oneline
docker inspect agentsdr-app-1 --format 'Revision={{index .Config.Labels "org.opencontainers.image.revision"}} Started={{.State.StartedAt}}'
)
```

The script backs up the database, saves tracked VM edits as a patch, checks memory, pauses the Maps scraper during the build, runs migrations before switching, and checks the sign-in page, image revision and worker startup. Its checkout step refuses conflicting or unsaved tracked changes; inspect that error instead of discarding VM edits. Existing approved campaigns can resume when the app starts.

Use the existing swap; these commands do not create or overwrite a swap file. Do not set `SKIP_GIT_UPDATE=1` for the initial invocation, since the checkout must first reach this pilot branch.

The nine default migrations are:

1. `add-tinyfish`
2. `add-research-sources`
3. `add-browser-sessions`
4. `add-wrong-number`
5. `add-activity`
6. `add-assistant-job-reports`
7. `add-objectives`
8. `add-pilot-fixes`
9. `add-brightdata`

## Live acceptance after deployment

Record the deployed revision and results; keep failures in this document rather than adding features during the pilot.

| Flow | Required evidence | Status |
| --- | --- | --- |
| Deployment | Successful script checks, expected running revision, all nine migrations | Pending |
| Workspace | Outreach, Inbox, Leads and Settings load; old links preserve their destination | Pending |
| AI reply | Synthetic provider probe with the configured model; distinguish HTTP success from a valid reply decision; no customer message used for the probe | Pending |
| Research | A small request reaches its qualified target or reports its actual stop reason; evidence and exclusions are visible; no duplicate job or contact | Pending |
| Bright Data | One bounded approved-target search produces a contactable, relevant prospect with evidence, or honestly records why it did not; usage matches the ledger | Pending |
| Outreach and replies | Existing Email, WhatsApp, LinkedIn and Instagram plans show actual sends and explicit blockers; one owner-approved test conversation verifies Review and Automatic modes; do not resend to the customer who already received the holding line | Pending |

Read the deploy script's rollback tag printed at the end and retain the backup. A passed build is not a passed live pilot. Start a separate Claude-login research session only after these results are reviewed.
