# Interactive connected browser — agent handoff, 28 October 2026

Build the next browser capability for **22nd x ai** while the existing research version is tested. Work on a separate branch, `claude/interactive-browser-20261028`, starting from the commit carrying this handoff on `codex/interactive-browser-handoff-20261028`. Its application baseline is reviewed browser commit **`1fa56593525597d7a57003c40152040afdabbcdb`**. Read AGENTS.md, CLAUDE.md, the original browser report and the final review first. Do not change main, the release/deploy branch or the tested research behavior; no merge or deployment.

Exa is independently on `codex/exa-discovery-20261027` at `4a82788dffbbf24db15e04e224592462e044ccbf`. Its combination has been trialled locally, not published as a release. Keep its tools/evidence compatibility when integration is requested; do not redo Exa or overwrite one branch's tool/migration lists with the other's.

## Result the user needs

A user connects their own Chrome once, asks for a browser task in the app, and the agent carries it out using the sites already signed in there. It should navigate, inspect, fill, click and verify the result without making the user move between pages. Examples: research founders and save relevant leads; enter selected leads into the user's CRM; update records; fill and submit a requested form; prepare a draft. The task follows the current request, not past niches or cities.

Claude Code's **native loop** remains in control for a personally connected Claude login. MCP is the adapter to the app/extension, not a replacement reasoning loop. Ordinary API models use the same browser capabilities through their existing harness. Do not turn this into another fixed per-site script or another text-only reader.

## Interaction: elements plus real visual fallback

1. Reuse and extend the DOM snapshot/action path for identified fields, contenteditable editors, buttons, selects, checkboxes/radios, keyboard input, scrolling, navigation and tabs. Recheck targets after page changes. Keep the current research tools' read-only contract intact; a separate task authorization permits the owner-requested mutations.
2. Add an actual screenshot tool and visual coordinate actions for UI that cannot be operated through useful elements, including a canvas fixture. The model must receive the **image**, not just an image URL, base64 text or a verbal description. Audit `agent.server.ts`'s MCP result adapter and both model transports: a result's `structuredContent` must not hide its text or image blocks. Prove the model saw information available only in pixels. Text-only API models keep usable DOM tools and get an honest unsupported-vision result; never silently switch to a paid/other model.
3. Bind visual actions to a tab and fresh screenshot/viewport. Define CSS versus image pixels, scale, device-pixel ratio, zoom, scroll and frame coordinates. Navigation, resize or a different tab must invalidate a stale target rather than click a different place. Read/capture after actions to verify progress. Include click, type/key, scroll and a drag where needed for the canvas proof.
4. Evaluate the existing extension's scripting APIs versus `chrome.debugger`/CDP for capture and reliable input. `tabs.captureVisibleTab` captures the visible tab, so never mistake an unrelated active tab for the task's page. If debugger access is required, use Chrome's real permission/attachment flow and target only this connection's authorized tabs. Document any focus requirement. Prefer reusing the extension/bridge over adding a local helper, second extension or hosted browser vendor.

Relevant files: `src/lib/browser/connected/{contract,connections.server,format}.ts`, `extensions/whatsapp-recorder/src/research.ts`, the manifest/popup/Connect files, `src/lib/assistant/{tools.server,agent.server,agentV2}.ts`, and `src/lib/ai/claudeCode/{nativeAssistant.server,toolBridge.server,nativeToolScope.server}.ts`.

## Authorize useful work without a settings maze

The owner's actual instruction authorizes the requested task and sites. Ask for missing consequential details when needed; do not ask before every click or create another mode-switch checklist. The server/extension must carry that authorization with the task, so page text or a model tool argument cannot grant new powers. A research-only request continues to refuse writes; an explicitly requested update/form task must actually be able to complete those writes.

Maintain the existing person/workspace/device/request binding, fresh connection fencing, Stop/disconnect and cancel propagation. Keep cookies, passwords and Claude login files out of server/model tool results; retain the native runtime's filesystem/shell denials. Do not expose arbitrary JavaScript evaluation or an unrestricted CDP command tool to the model. Site content supplies information, never authorization.

Keep all outreach under the app's existing approval/Autonomous authorization, DNC, sender readiness, limits, grounding and message tracking. If a browser-delivered send is implemented, integrate it as a tracked transport behind those same checks; do not create an untracked second sender. Reserve effects before dispatch, verify outcomes and handle lost acknowledgments as uncertain: do not blindly retry a send/submit that may already have happened. Never promise exactly-once delivery on a remote website.

No arbitrary new search/action quotas, default dollar caps, mandatory cities or source priorities. Honor explicit owner budgets and real provider/site refusals. Do not replace the model's tool choices with a hardcoded Maps-first workflow. Add only the UI needed to connect, see progress, stop, resolve a blocker and read the final result. Preserve lead imports and per-page evidence; do not invent page text to make screenshot-only facts pass grounding.

## Visible Chrome and headless

The first working path is the user's connected, signed-in Chrome, with background task tabs where practical. Background tabs are **not headless**, and some visual actions may require a visible/active target; measure and report that behavior.

Do not assume a VM browser inherits the user's laptop session. Headless needs its own established browser/profile in the environment where it runs. Do not add cookie export or a headless infrastructure project speculatively. Keep the browser interface reusable for a future headless transport, and report any concrete task that requires one. Login/CAPTCHA handoff remains to the owner; Chrome must stay available for the connected path.

## Verify and hand back

- Drive complete tasks from a user prompt: research/import with evidence; fill/save a CRM or form record and verify it; visual-only canvas interaction; ordinary API-model DOM operation; a vision-capable path receiving the real screenshot.
- Test read-only versus explicitly authorized writes, non-English UI, stale screenshot/DOM targets, form submissions/reset, connection replacement, cancellation/Stop, sleep/restart, cross-workspace rejection and a lost result without a repeated effect.
- Use fixtures for destructive, replay and prompt-injection cases. Real checks are limited to an owner-approved page/account or controlled test app; send no real prospect outreach during implementation. Keep fixture browser, real visible browser, real model and VM results labelled separately. Do not call a fake LinkedIn page a signed-in social test.
- Run the relevant tests, typecheck/lint, extension packaging and production build; apply any added migration twice and package it in the existing deploy path. Update the code graph with the repository's graphify workflow. Push the isolated branch with the exact SHA, actual verification and remaining blockers. No release merge or deploy.

Primary references checked for the design:

- Chrome content scripts: https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts
- Chrome tabs/capture: https://developer.chrome.com/docs/extensions/reference/api/tabs
- Chrome debugger/CDP transport: https://developer.chrome.com/docs/extensions/reference/api/debugger
- Chrome headless: https://developer.chrome.com/docs/chromium/headless
- Claude Code MCP: https://code.claude.com/docs/en/mcp

The point is a capable browser worker the user can operate from one chat. Preserve practical ownership/account protections while enabling the task the owner asked it to do.
