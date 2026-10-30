# Browser integration for the owner's controlled test

Deploy branch: `codex/browser-integration-20261030`.

This continues agent branch `claude/interactive-browser-20261028` at `40d8cde51448e3669c8afbac22199cb45d0ff039`. That commit already contains pilot `1d31259f7b71f211d4f10768d0c17eff682561a6` and Exa (the pilot is an ancestor, 31 commits behind). The integration carries the agent's browser outreach, reply synchronization, native-Claude continuation, permissions, branding and extension 0.18.0, plus the remaining Codex request-status changes. It does not change the agent's delivery implementation.

Overlapping count/status changes use the agent's implementation. Remaining changes retain the recorded research waiting reason, the source/transport label, readable search titles and exact next-check times, and reduce repeated progress framing. A regression fixture reads the request from a disposable database and renders both compact and full React views: 14 distinct found, 6 contactable and 0 matching across overlapping sources, no invented target, ordinary waits without warning, real failures retained, and cross-workspace isolation. The Activity assertion now expects the existing Searching state once the provider run starts.

## Integration verification

- Unit suite: 2,420 pass, 0 fail, 229 files.
- Typecheck with Node's heap set to 4096 MB: pass. The initial run using the default heap ran out of memory.
- Lint of the seven integration source/test files: pass.
- Request workspace suite: pass, including 22 React markup checks (compact and full).
- Activity suite: pass; its intentional socket-error/retry fixture logs an error before checking recovery.
- Browser-outreach upgrade replay against disposable PGlite: all public columns, constraints and indexes match a fresh schema after each of two applications.
- Extension 0.18.0: packaged successfully (17 files).
- Production build (Next.js under Node/Webpack, 4096 MB heap): pass, with the existing dynamic-dependency warnings in the grid sandbox.
- `graphify update .`: completed; no further topology changes after the existing local graph update. The refreshed local JSON is 19.4 MB and exceeds this connector's 16 MiB request limit (also after whitespace compaction), so this branch retains the agent's published graph outputs; the graph refresh is not claimed as uploaded.

The Docker image build and running-container health checks are performed by the VM deployment command, not claimed as completed locally.

Request/Activity and migration checks use disposable PGlite, not native PostgreSQL concurrency. The separate browser-outreach replay reached six checks (qualification, transport choice, Start, Do Not Contact and offline waiting) then timed out in the single-connection PGlite helper; this is not recorded as a passed send/reply test. The agent's native-database, real-extension and model fixture results are in `BROWSER_OUTREACH_REPORT_2026-10-30.md` and are not represented here as independently repeated results.

Real signed-in Chrome, a customer's own Claude login, covered/minimized task windows, VM/proxy behavior and a real checkout remain acceptance work. No real person was messaged. Shared period reporting and request contacted totals can still omit browser sends; this known gap is unchanged.

## Deploy on the existing VM

Run `tmux new -A -s agentsdr-deploy`, then inside tmux:

```bash
cd ~/leads-x
git remote set-branches --add origin codex/browser-integration-20261030
export COMPOSE_FILE=docker-compose.yml:docker-compose.build.yml:docker-compose.discovery.yml:docker-compose.claude-code.yml
unset SKIP_GIT_UPDATE MIGRATIONS
NEXT_BUILD_HEAP_MB=4096 bash docker/deploy.sh --branch codex/browser-integration-20261030
```

The deployment script fetches and switches without discarding local edits, backs up the bundled database, builds the image, applies the additive migrations (including browser access and browser outreach), checks the app and worker, and restores the earlier image if the post-switch health check fails. The Compose files retain the Maps scraper and Claude login volume.

After success:

```bash
git log -1 --oneline
docker inspect agentsdr-app-1 --format 'Revision={{index .Config.Labels "org.opencontainers.image.revision"}}'
```

The container revision must equal `git rev-parse HEAD` on this branch. Download the matching extension from `https://leads-x.duckdns.org/downloads/call-recorder`, replace the existing unpacked extension files and press Reload at `chrome://extensions`. It should show **22nd x ai Browser Assistant 0.18.0**. Approve Chrome's new permission request, reload the app, and reconnect the browser before the controlled test.
