# Decisions taken on the night of 18 October 2026

The owner approved the session plan and went to sleep. These records list
what the owner decided and each default taken without asking, with the
alternative. Any of them can be reversed later.

## Decided by the owner

| Decision | Choice |
| --- | --- |
| Base of the work | `claude/dreamy-fermi-h5woha` reset onto `claude/new-session-g5hljn` (`0181203`); `main` untouched |
| Push policy | Push the session branch after every green slice. Nothing deploys from it |
| First slice | TinyFish search and read |
| Reddit | Build the gate and a place to record approval. No reader, no workaround |
| Browser tools | Built, with a per-organization allowance of 0 minutes by default |
| Persistent graph | graphify; commit `graph.json` and `GRAPH_REPORT.md` |
| Test keys | TinyFish and AI/ML API keys used only for live verification from the scratchpad, never committed |

## Defaults taken overnight

| # | Default | Why | Alternative |
| --- | --- | --- | --- |
| 1 | graphify builds from the free AST pass over `src/`, `scripts/` and `extensions/`; docs are not semantically extracted | The owner asked for subagents only where necessary; a semantic pass over 185 docs costs about 9 agents | Run `/graphify --update` with semantic extraction later |
| 2 | `graph.json` (13 MB) is committed at milestones (start and end of the night), not on every commit | Each commit of it adds about 1–2 MB of history; the post-commit hook keeps the local copy current regardless | Commit it on every slice |
| 3 | The graph hook in `.claude/settings.json` calls `graphify` from PATH, not an absolute path | Works in any container that has graphify installed | Absolute path as generated |
| 4 | The local test database is a Postgres 16 cluster at `/var/lib/postgresql/agentsdr-pg`, port 5433, owned by `postgres` | The scratchpad is root-only and Postgres refuses to run as root | Docker (no daemon in this container) |
| 5 | `instagram_outreach_queue` added to `OWNED_TABLES` | It was the one branch table missing, against the CLAUDE.md rule | Leave it unmanaged |
| 6 | The owner's uploaded plan is copied to `docs/plans/IMPLEMENTATION_PLAN_2026-10-18.md` | Later sessions need the newest plan in the repository | Keep it only in the chat upload |
