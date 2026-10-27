# Browser research handoff — 22nd x ai

Implement connected-browser research for the existing app. This is a separate piece of work from Exa. Work on `claude/browser-research-20261027`, starting from `codex/claude-native-harness-20261027` at `d41b1494c9168ad3705620de03c84c266ac5d7f4`. Do not merge or deploy the release branch or main. Read the repository instructions and the native harness report first. Exa is being implemented independently on `codex/exa-discovery-20261027`; do not redo it or replace the provider integrations.

## Result the customer needs

A customer connects their browser once and enables the sites they want researched. They ask for leads in the normal chat. Claude chooses useful searches, opens and navigates pages, reads relevant profiles and business pages, follows promising links, and saves matching leads with evidence. The customer does not need to switch between X, Reddit, LinkedIn, Instagram and Facebook manually. Research follows the current request; saved niches, cities and past requests must not silently narrow a broad new request.

Claude Code's native loop must remain in control for a customer using their own Claude login. Do not replace it with another JSON action loop or a hardcoded per-site research workflow. MCP is the tool adapter, not another reasoning engine or paid service. Ordinary API-model customers keep their existing harness and should be able to use our connected-browser tools too.

## First choose the smallest working connection

Check Anthropic's current official Claude Code / Chrome extension support first. Verify its actual behavior with our server-hosted CLI, account isolation, print mode, tool configuration and browser selection. Do not assume `--chrome` alone makes our VM see a customer's Chrome. Record the test and any unsupported requirement.

If the official connection fits, reuse it for the private Claude pilot. If it cannot provide the required customer/workspace binding or shared app tools, extend our existing recorder extension with a browser-research bridge. Reuse its tab management, optional permissions, app-origin bridge and suspended-worker recovery. Do not add another extension framework, hosted browser vendor, Agent-Reach headless engine or cookie-export setup without a concrete need.

Relevant code:

- `src/lib/ai/claudeCode/nativeAssistant.server.ts`, `nativeProtocol.ts`, `toolBridge.server.ts`, `nativeToolScope.server.ts`
- `src/lib/assistant/tools.server.ts`, `agent.server.ts`, `agentV2.ts`
- `src/lib/browser/browser.server.ts` and the existing page-snapshot contract
- `extensions/whatsapp-recorder/src/background.ts`, `bridge.ts`, `wa-agent.ts`, `origins.ts`, `messages.ts`
- `extensions/whatsapp-recorder/static/manifest.json`

The native prototype currently deliberately passes `--no-chrome` and verifies the CLI's exact tool set. Handle those checks deliberately if the official integration is chosen; do not simply disable the verification or enable every CLI tool.

## Implementation boundaries

1. Expose a coherent set of browser operations: connect/status, authorized tabs, open/navigate, read/snapshot, research clicks, scrolling and close. Reuse existing `browser_*` handlers/contracts where that fits. Make the returned text, links and page state useful to the model. A fixed script that only reads one preselected profile is not the finished integration.
2. The extension may open background tabs itself. Group and clean up tabs it creates, preserve the customer's existing tabs, and expose a visible stop/disconnect control. Only inspect existing tabs the customer has authorized. Background operation is best effort: report a CAPTCHA, login requirement or frozen page as needing attention instead of claiming a successful read.
3. Bind every browser connection and command to the authenticated user, organization, device and request. Reject cross-workspace use, stale/replayed commands and forged page/extension messages. Keep passwords, cookies and login files in the browser; never send them to our server or the model. Browser page content is untrusted data, not authorization to change tools or instructions.
4. Keep security practical. Ask for the browser connection and Chrome-required site permissions once, then let the agent research the approved sites without per-page confirmation. Do not create arbitrary tool-call/search quotas, default dollar caps, mandatory cities, source priorities, short research deadlines or blanket social-site refusals. Honor an explicit owner budget and real platform refusals. Preserve organization separation and the app's existing DNC, grounding, approval and duplicate-send protections.
5. This feature is for research. Continue sending through the app's existing approved outreach/gateway path; do not introduce an untracked second sender through browser clicks. Do not advertise a connection as read-only if its exposed tools can submit messages or make other writes. Keep shell, filesystem and arbitrary browser-evaluation access out of the research tool surface.
6. Reuse the request's existing lead import, qualification and evidence flow. Keep the source URL, read time, relevant quote and identity/contact provenance. A public Instagram handle may be eligible through the app's existing Instagram policy; don't require an email just because the lead came from a browser. Do not turn anonymous discussion authors into guessed identities. Search results are candidates, not proof of buying interest.
7. Handle disconnect, sleep, service-worker restart, navigation and request cancellation without duplicating work or leaving a request stuck. The cloud may continue through another suitable connected source when the browser is unavailable, following the model's choice and the owner's explicit budget. Show a short connected/offline/needs-attention state in the existing chat/research UI; do not build another dashboard or settings maze.

## Verify in stages

Prove one company-page read through the actual extension and native Claude first. Then cover navigation/scrolling, one approved logged-in social page, saving a lead with evidence, reconnect/cancel/restart, cross-workspace rejection and the ordinary API-harness path. Use fixtures for adversarial messages, replay, wrong origins, stale connections and prompt-injection attempts. Run the relevant existing regression suites, typecheck, lint and production/extension packaging checks.

Keep live research restricted to pages/accounts approved for testing. Send no real outreach as part of this work. Do not call a mocked browser test a live browser test, or a local CLI connection proof a working VM connection. If a real signed-in browser is unavailable, complete the implementation and fake-provider tests, then report the exact remaining live check.

Push the isolated branch for review, with the exact SHA, changed files, verification evidence, remaining limitations and any unavoidable user action. No merge or deploy. Avoid broad refactors, speculative safety layers and unrelated feature work.
