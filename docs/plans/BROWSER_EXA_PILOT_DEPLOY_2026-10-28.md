# Browser + Exa pilot deployment, 28 October 2026

Deploy branch: **`codex/browser-exa-pilot-20261028`**. This is an isolated integration of reviewed browser `1fa56593525597d7a57003c40152040afdabbcdb`, final-review/handoff docs `ee39a2ab1b76e6ea2d057346158da4a9ee8bb770`, and Exa `4a82788dffbbf24db15e04e224592462e044ccbf`. Main and `codex/reply-release-20261023` are unchanged. The future interactive/screenshot worker is not part of this pilot.

Five list conflicts retain both branches' entries: `.dockerignore`, `Dockerfile`, `docker/deploy.sh`, `docker/deploy.test.ts`, `src/lib/assistant/agent.ts`. Other overlapping files merged automatically. The deployment script stays executable (`100755`). Browser and Exa migrations are both packaged and included in the default migration sequence.

Local verification on the combined application: **2,340 unit tests pass**, typecheck/lint pass, extension zip builds (17 files), final form and earlier DOM probes each 4/4. On the preceding combination the review DB probe was 9/9, Exa 30/30, browser 69/69 and native harness 27/27 (disposable PGlite, stand-in providers/browser). The last change is the page-script form guard; those DB suites do not run that script. See the final review for the exact split.

No Docker daemon is available here. The VM command below performs the actual image build, migrations and running-image checks. A failed build or migration leaves the current application serving; a failed post-switch check triggers the script's rollback. The first real VM/proxy, signed-in Chrome and personal-login checks remain live acceptance.

## On this VM

Use the existing bundled database and preserve the Claude CLI/login volume by including its Compose override. Run inside tmux. The VM already has swap; the deploy script checks available memory plus swap before starting.

```sh
cd ~/leads-x
git remote set-branches --add origin codex/browser-exa-pilot-20261028
export COMPOSE_FILE=docker-compose.yml:docker-compose.build.yml:docker-compose.discovery.yml:docker-compose.claude-code.yml
unset SKIP_GIT_UPDATE MIGRATIONS
NEXT_BUILD_HEAP_MB=4096 bash docker/deploy.sh --branch codex/browser-exa-pilot-20261028
```

The added fetch ref handles this VM's single-branch clone; the script fetches the branch, saves tracked local edits and refuses an unsafe checkout/fast-forward. Do not reset away VM edits. It also backs up the database before the build/migrations and pauses/restores the Maps scraper.

After success:

```sh
git log -1 --oneline
docker inspect agentsdr-app-1 --format 'Revision={{index .Config.Labels "org.opencontainers.image.revision"}} Started={{.State.StartedAt}}'
```

The revision must equal `git rev-parse HEAD` on the pilot branch. Keep the script's printed database-backup and rollback-image paths.

## Browser update and first check

Download the matching extension while signed in: **https://leads-x.duckdns.org/downloads/call-recorder**. Extract over the existing unpacked extension folder and press **Reload** for it at `chrome://extensions`; its version should be **0.16.0**. Then reload the app tab.

In the app's chat use **Connect browser**, choose a public website for the first check and finish the real Chrome permission request. This app extension is distinct from Browser Link, which gives Codex access to the tab: also enable the app tab in Browser Link when asking Codex to test it.

Start with research only: read one public business page, follow a useful link, save a published contact with the correct page and quote, then check Stop/reconnect. A real social page can be tested next with the owner's approval. Send no outreach during these first checks. Only after live acceptance should the pilot be promoted to the normal release branch.
