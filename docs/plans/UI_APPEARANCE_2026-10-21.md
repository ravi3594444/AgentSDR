# Optional appearance and larger text

Prepared on `codex/golden-clouds-ui`, based on the deployed `652c84d`. Review separately from the pilot logic fixes. No backend or migration change is required.

## User-visible changes

- Settings → Advanced → Appearance has a fourth choice, **Golden clouds**, alongside Light, Pure black and System. It uses a warm cloud-shaped gradient behind the workspace and opaque, near-white surfaces for cards, tables and the message composer.
- The background uses static CSS gradients, with no image download, animation, canvas or additional dependency.
- Common body text and labels increase from 14 to 15 px; small text increases from 12 to 13 px, with matching line heights. The smallest label token increases from 11 to 12 px. These shared text tokens apply across themes; headings and explicit pixel-sized text are not scaled.
- The selected theme remains a browser preference. Existing light/dark/system selections and the sidebar theme button continue to work. Golden clouds uses light-mode native controls, with its own workspace appearance attribute. The public landing/sign-in pages do not acquire the cloud background.

## Checks completed

- Full TypeScript check and ESLint on the five changed TSX files: clean.
- Tailwind/PostCSS compilation: successful; the new appearance rules and larger text tokens are emitted.
- Eight checks of the actual pre-paint initialization script: missing/invalid preference, explicit light/dark, system light/dark, and golden with either OS preference all resolve as expected.
- Golden small-text colors were checked against its near-white card surface and darkest gradient stop; the two adjusted text colors exceed 4.5:1 for those color pairs.
- React review: native radio controls keep keyboard selection; preference changes trigger application even when both choices resolve to light; the pre-paint script sets the appearance before hydration. No heavy client import or runtime network call was added.

No production build, browser automation, screenshot or desktop/mobile visual check was run for this UI branch. The repository's UI workflow requests concise manual verification after implementation.

## Manual review before merging

1. Open Settings → Appearance. Select Golden clouds with the keyboard and with a click, then reload: the selected card and workspace background should agree, without a white/dark flash.
2. Switch through Light, Pure black and System, then return to Golden clouds. Check the sidebar toggle and an OS preference change while System is selected.
3. Open Outreach, Inbox, Leads List/Board and Reports. Check readability, table rows, long labels, the request summary and the composer. The clouds should remain behind content, not cover it.
4. Check the settings dialog and pages at desktop and phone widths: four appearance options must wrap without horizontal overflow; the larger text must remain usable.

Deploy together with the reviewed pilot fixes when the owner is ready. This branch has not been deployed to the VM.

## Existing onboarding and multiple-account behavior

Getting started already provides a configuration checklist with live saved-state indicators and links to account connections, AI settings, sending rules, leads, campaigns and replies. It distinguishes connected credentials from a verified inbound reply. Its outdated approval wording is tracked as L05 in the separate pilot report.

The sending paths load multiple connected accounts within the workspace. Instagram initial DMs are assigned across approved senders; LinkedIn campaigns can associate multiple accounts; WhatsApp and email have their own sender selection and account limits. Replies remain attached to the relevant account and conversation.

This is code inspection, not a new live multiple-account verification. The assistant's LinkedIn discovery path currently selects the first connected account with `limit(1)`; adding accounts does not make that search automatically rotate. Verify two accounts per channel in a controlled pilot before claiming every path scales identically. No sender selection or messaging code is changed by this UI work.
