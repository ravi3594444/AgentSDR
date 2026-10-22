# Handoff: research default and Claude effort controls

Branch: `codex/research-default-on-20261022`.
Base: `codex/pilot-deploy-20261021` at `5c1d03f`.

The owner requested that another agent finish this work. This is a WIP
handoff branch. Do not deploy it until the effort UI and checks below are
finished. Nothing from this branch has been deployed to the VM.

## Requests

1. Research v2 should be on by default for existing and new workspaces.
   People can turn it off; a saved Off choice must survive deployments.
2. Claude settings should expose reasoning effort: Model default, Low,
   Medium, High, Extra high (`xhigh`), Max.
3. Show the actual model version after checking it, and explain why Use
   Claude Code is disabled. Never invent a model version or account access.

## Completed: default-on policy

`src/lib/features/catalog.ts` defaults `research_agent_v2` to true and
exports `featureStateFromRows`. `flags.server.ts` uses the saved rows as
overrides, including explicit false. Missing feature tables keep the legacy
all-off fallback. Other feature defaults are unchanged. No migration needed.
Settings copy and the research-v2 document are updated.

Tests: five new policy tests pass. Typecheck and scoped ESLint passed before
the subsequent effort work. The full unit run had 2,142 pass and 7 fail:
four existing locale/time-zone failures already reproduced on the baseline,
plus three timing failures during parallel typecheck/graph generation.
The timing files (`docker/deploy.test.ts`, `websiteProfile.test.ts`) passed
alone: 74/74. The initial focused run passed 25/25.

## Partially implemented: effort backend

These are WIP changes; recheck them rather than treating them as finished:

- `contract.ts`: effort list/type/validator, check-to-effort matching, checked
  model version label helper. Status includes the selected effort. Old
  model checks with no effort mean Model default.
- `engine.server.ts`: stores/normalizes effort in the existing JSON config;
  old settings default to `default`. Checks record the effort used. Binding
  returns it. No schema change.
- `runtime.server.ts` passes effort to `runner.server.ts`, which passes it
  to `generationArgs` in `cliOutput.ts`. Explicit choices add `--effort`;
  default omits it.
- `/api/ai/claude-code`: validates effort for Check/Use, checks the same
  model/effort combination, then saves it. An old/default check does not
  authorize another effort level.
- `claudeCode.test.ts`: added argument forwarding test (failed before the
  backend changes) and updated the legacy normalization expectation.

Latest handoff check after these backend edits: feature defaults plus the
Claude engine unit suite pass **39/39** with a fake CLI. Typecheck and real
Claude checks have not been rerun after the effort edits. The effort UI is
still absent, so this is not a completed feature.

## Finish this next

1. Update `ClaudeCodeSettingsClient.tsx` with a labeled effort select using
   existing Select components. Load the saved value, include it in Check
   and Use requests, and treat a changed effort as an unapplied change.
   Keep the owner's selection stable during async status refreshes.
2. A successful check must match the selected model AND effort before Use
   is enabled. Changing either invalidates the displayed check. Explain
   the disabled state inline: sign in first, check this selection, or the
   existing account/organization blocker. Keep the server-side check too.
3. Use `claudeCodeModelLabel` to display a reported version, for example
   Sonnet 5.5, after Check supplies its actual ID. Before that, show the
   family alias. The CLI is installed and the owner was signed in in the
   supplied screenshot; Sonnet was selected, but had no check result.
4. Explain that higher effort consumes more time and plan usage. The CLI
   can lower unsupported effort or enforce organization caps; do not claim
   that a successful call independently proves a requested maximum applied.
5. Add meaningful tests for old configuration compatibility, normalization
   and persistence, invalid effort rejection, stale check rejection,
   runtime-to-fake-CLI forwarding, checked model labels, and unchanged
   account isolation/usage holds. Extend the existing fake CLI/e2e suite.
6. Typecheck, lint and focused Claude/default-feature tests first; then
   appropriate regression checks. No real provider/model call, sign-out,
   engine switch or outbound test without the owner's instruction.
7. Update the Claude login doc, run `graphify update .`, commit and publish
   the finished branch. Merge it after review into the deploy branch and
   give the owner the same deployment command. Do not publish WIP to deploy.

## Primary references checked on 22 October

- <https://code.claude.com/docs/en/model-config> — model aliases and effort
  support; current 5.5 Sonnet/Opus/Haiku support all five effort levels.
- <https://code.claude.com/docs/en/cli-reference> — the per-session
  `--effort` flag. This app starts a new isolated CLI process per AI call.

The app pins Claude Code 2.1.306. The screenshot confirms that version is
installed on the VM. Keep its official binary unmodified, its per-account
login isolation, limits, and no automatic switch to paid APIs.

`AGENTS.md` asks for static UI checks unless browser verification was
explicitly requested. The React review skill has been read for the two
settings screens; check hook dependencies, labels and phone layout.
