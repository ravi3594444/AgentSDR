# OpenMausBot

Parts of AgentSDR's Claude Code engine are adapted from
[OpenMausBot](https://github.com/milind-soni/OpenMausBot), commit
`bdcfc44044bc1f59fb49b0315aae85fb3c502e93`:

- `src/lib/ai/claudeCode/login.server.ts` from `server/drivers/claude-login-auth.ts`
  (running `claude auth login` with pipes, showing only Anthropic's sign-in
  link, writing the pasted code once to that process, confirming with
  `claude auth status --json`, signing out with `claude auth logout`);
- `src/lib/ai/claudeCode/cliOutput.ts` (`claudeSignInLink`, `claudeLoginPrompt`,
  `claudeLoginCode`) from the same file, and its limit reading from
  `server/drivers/claude-limits.ts`.

Copyright 2026 Milind Soni and OpenMausBot contributors. Licensed under the
Apache License, Version 2.0 (`LICENSE` in this directory). OpenMausBot's own
NOTICE file names further third-party code that none of the adapted parts
include.

Changes made in AgentSDR: one controller and one pair of CLI directories per
AgentSDR account (organization and person), an allowlisted CLI environment,
a check that a reported login is stored in the account's own directories,
the CLI's login method passed through, sign-out refused while the account's
generations run, AgentSDR's types and wording, and a new reader for the
stream-json frames of one `-p` generation.
