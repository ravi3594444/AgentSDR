# Native Claude harness — private prototype, 27 October 2026

Base: `codex/reply-release-20261023` at `15559f4`.
Work branch: `codex/claude-native-harness-20261027`.
The deploy branch and main are not changed. No production deployment or real
model generation has been performed here.

## Behavior

- Personally selecting Claude in AI provider settings enables the native
  assistant loop. One unmodified CLI process calls the app's MCP tools,
  sees the results and chooses its next action. No JSON action batch is
  interpreted by the app on this path.
- A session belongs to one workspace, signed-in owner, chat, request and
  model. Later background continuations explicitly resume its ID. A new
  account, request or model gets a separate session. The process exits at
  the end of a turn; it is not kept warm indefinitely.
- Normal API providers (Included or own), shared private-test logins, and
  CRM classification/drafting/reply-check steps keep their existing paths.
  A failed personal Claude invocation never silently selects a paid API.
- Tool results use the same chat cards, lead lists, objectives, request
  reports and outreach plans as before. Model narration is not streamed
  into the chat as proof of completed work. Its final answer still passes
  the existing checks against recorded tool effects.
- This is a private account pilot, not public customer login. The original
  workspace owner remains eligible. An operator may privately admit an
  exact additional workspace/owner pair as described below. The owner must
  still be the only member unless the existing explicit shared test permits
  otherwise. Each admitted workspace uses its own login; a grant conveys
  neither another account's login nor platform-operator permissions.

## Tool and execution boundary

The MCP SDK supplies one ephemeral HTTP endpoint on `127.0.0.1`. A random
per-turn bearer token is written to a 0600 temporary config, never exposed
as a model argument or stored as a provider credential. Origin, Host and
path are checked. Only enabled app tool names are advertised. The model
cannot provide an organization, user or thread context; the host captures
them and explicitly re-enters that organization for each call.

The CLI starts with `--tools ""` **and** the app's MCP config. The first flag
removes built-ins, not MCP. It also gets `--restricted`, `--strict-mcp-config`,
file/shell denials, empty setting sources, disabled skills and Chrome, an
allowlisted environment, and only the app's MCP tools auto-approved. No
credential file is read by this implementation, and no OAuth client or
patched Claude binary is introduced.

Before authorizing a tool, the stream's init frame must confirm the own
login and the expected tool set. Every call rechecks the account binding,
live feature availability and grounding; calls are serialized so the next
reads the preceding call's committed evidence. Provider budgets, explicit
free-only requests, sending readiness, DNC, duplicate protection and Start
or Autonomous authorization remain in the existing handlers. Preparing a
plan invokes the same server-side automatic-start logic as the API harness.

Replayed MCP request IDs reuse their result; changing arguments under an
already-used ID is refused. An unexpected effect/recording failure ends the
native process, rather than asking it to repeat an uncertain operation.
Access revocation and cancellation abort in-flight model work. Reported
usage limits or extra usage hold the account immediately. Work already
committed remains in the app transcript.

An app tool can need its existing structured writer while the native CLI
waits for the result. A scoped reentrant lease permits only that descendant
to use the same account, still within the physical process cap. Native
parents leave one writer slot available so two waiting agents cannot fill
every slot. Default cap: two processes. With a cap of one, nested writing
fails clearly rather than deadlocking. Other callers retain account
serialization. A native turn uses the existing 24/40 model-turn limit and
has a 15-minute process deadline; long searches remain durable background
jobs and wake another turn when they finish.

## Private pilot admission

This GLOBAL operator-only setting is not editable through workspace
settings. Admission must name the real workspace UUID and its owner's user
UUID. An unapproved workspace remains refused even if it creates its own
workspace-level engine row. Existing owner/membership checks still apply.

For an operator testing a second owner in their own workspace, add an exact
pair (replace both UUID placeholders) using the bundled database:

```sql
INSERT INTO platform_settings (key, value)
VALUES ('claude-private-pilots', jsonb_build_object('grants',
  jsonb_build_array(jsonb_build_object(
    'organizationId', 'WORKSPACE_UUID', 'userId', 'OWNER_USER_UUID'))))
ON CONFLICT (key) DO UPDATE SET
  value = jsonb_set(platform_settings.value, '{grants}',
    coalesce(platform_settings.value->'grants', '[]'::jsonb)
      || excluded.value->'grants'),
  updated_at = now();
```

Delete the pair from that grants array to revoke it. Deleting the entire
`claude-private-pilots` row revokes all additional pilots; the original
operator workspace's eligibility is unaffected. Revocation is checked on
each native tool call and on the periodic binding check.

Select a **personal** Claude login, not the Included/shared private-test
default. The CLI and persistent Claude data volume must be present, as in
`docker-compose.claude-code.yml`. The prototype uses the flags checked on
Claude Code 2.1.306; older binaries should be updated. There are no schema
migrations for this change.

## Evidence

All providers and model answers in database/unit tests are stand-ins. No
real message was sent.

| Check | Result |
| --- | --- |
| Native loop, sessions, account isolation, cancellation, holds, nested writers, HTTP replay | 17 focused tests pass |
| Full unit suite | 2,314 pass, 0 fail on the clean final rerun |
| Typecheck and changed-file ESLint | pass |
| Real chat → local MCP → request → saved contact → guards → final answer | 27 database checks pass |
| Existing Claude login/structured engine | 28 database checks pass |
| Existing research-agent guard suite | 51 database checks pass |
| Existing reply-agent suite | 110 database checks pass |
| Organization-scope contract | pass |
| Webpack production build | passes; offline font fixtures used, font source unchanged |
| Official Claude Code 2.1.306 with empty login directory | app MCP connects; expected tools loaded; no unsupported flags; authentication required; zero app effects |

The database was disposable PGlite behind a serialized PostgreSQL-protocol
adapter, with the unchanged application driver. This is not proof of native
PostgreSQL multi-connection locking. Native PostgreSQL could not be started
under this environment's root-only UID mapping.

The broad `full-flow.ts` suite passed 29 checks, then timed out before its
second Bright Data request completed. It is **not** reported as passing.
The focused native path and the complete existing research/reply suites
above did complete. An early full unit run had two intermittent form/CSV
failures; both passed in isolation, the complete base run passed 2,297,
and the clean final full run passed 2,314. No assertion or production parser
was changed to hide those results.

The generated code graph was rebuilt locally. The report/graph are derived
artifacts; if the connector cannot carry the large graph blob, regenerate
with `graphify update .` after checking out the branch.

## Still required for live acceptance

1. Sign in through the real private owner's CLI flow and select the model.
2. Run a research-only request; verify the tool cards, saved list and one
   final request report. Compare quality/cost/latency with the API harness;
   this prototype makes no measured superiority claim.
3. Prepare outreach to one controlled recipient in Review mode. Confirm the
   writer completes, the preview is grounded and nothing sends before the
   applicable authorization. Then perform the controlled send/reply test.
4. Revoke a pilot while a native turn is running; confirm later tools stop.
5. Build the actual Docker image on the VM. The local production build does
   not prove image packaging or Claude login-volume persistence.

Public launch/authentication approval is separate and remains pending. No
domain purchase is needed for this private development work.

## OpenMausBot comparison

Read current upstream `milind-soni/OpenMausBot` on 27 October:

- `server/drivers/claude-login-auth.ts`: unmodified CLI login, one-time code
  to stdin, confirmation through auth status.
- `server/drivers/claude.ts`: stream-json native execution, session reuse,
  refreshed system prompts, selected account config, app/browser tools in
  `--mcp-config` and explicit tool permissions.
- `server/drivers/turn-mcp.ts`: scoped app integrations, including its own
  authenticated HTTP MCP endpoints.

References: <https://github.com/milind-soni/OpenMausBot/blob/main/server/drivers/claude.ts>,
<https://code.claude.com/docs/en/cli-reference>,
<https://code.claude.com/docs/en/agent-sdk/mcp>.
The new bridge/runtime code is independent; existing adapted login helpers
retain their OpenMausBot attribution and license.
