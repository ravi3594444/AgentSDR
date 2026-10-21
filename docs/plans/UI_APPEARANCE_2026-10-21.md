# Illustrated appearance and larger text

Prepared on `codex/golden-clouds-ui`, based on the deployed `652c84d`, in PR #8. This is frontend work; no migration or sending behavior changes are required. It has not been deployed.

## User-visible changes

**White stays the default**, as the owner requested. Existing saved appearance choices are preserved.

Settings → Advanced → Appearance offers four optional illustrated backgrounds:

| Theme | Artwork | Controls |
| --- | --- | --- |
| Golden clouds | Painted apricot and ivory clouds in a blue sky | Warm light surfaces |
| Dark forest | Emerald forest and moonlit mist | Dark green surfaces |
| Deep space | Indigo nebulae, stars and a crescent planet | Dark navy surfaces |
| Moonlit ocean | Silver moonlight across midnight waves | Dark blue surfaces |

Light (plain white), Pure black and System remain available. Native radio buttons allow keyboard selection; the choice takes effect immediately and is remembered on this browser. Other devices keep their own appearance. The sidebar's light/dark toggle remains available.

The pictures fill the signed-in workspace canvas, including behind the assistant. Messages, tables and cards keep solid surfaces. The artwork is decorative and does not intercept clicks. Public landing and sign-in pages do not acquire a scenery background.

Common body text and labels increase from 14 to 15 px; small text increases from 12 to 13 px, with matching line heights. The smallest label token increases from 11 to 12 px. These shared tokens apply across themes; headings and explicit pixel-sized text are not scaled.

## Assets and loading

The four pictures were generated with the built-in image generator. Golden clouds uses the supplied Aryabhatt screenshot only as a painted-sky reference; it includes no website interface, lettering or figures. The other scenes were generated as matching painterly wallpapers.

Generated PNG originals remain unchanged. The app ships optimized WebP copies, with smaller separate thumbnails for the picker:

| File under `public/themes/` | Main artwork | Thumbnail under `previews/` |
| --- | ---: | ---: |
| `golden-clouds.webp` | 73,382 bytes | 7,112 bytes |
| `dark-forest.webp` | 201,332 bytes | 11,370 bytes |
| `deep-space.webp` | 96,782 bytes | 6,160 bytes |
| `moonlit-ocean.webp` | 146,682 bytes | 10,692 bytes |

All use the same 1672 × 941 landscape framing; thumbnails are 400 px wide. Only the selected full-size image is referenced by the workspace's computed background. Plain Light, Pure black and System use no full-size scenery picture. No animation, canvas, external image host, runtime generation or new dependency is added. The picker uses about 35 KB of illustrated thumbnails in total.

### Generation brief

- **Golden clouds:** reinterpret the reference's romantic painted sky alone: ivory foreground cumulus, large apricot and golden peach clouds, dusky blue sky, detailed painterly volume, quiet center; no figures, text or interface.
- **Dark forest:** romantic landscape painting of deep emerald pines and old trunks, layered teal mist, ferns and restrained moonlight; open center, trees framing the edges; no people or interface.
- **Deep space:** midnight navy, muted violet nebulae, delicate stars and one distant crescent planet; painterly texture, dark quiet center; no spacecraft, labels or interface.
- **Moonlit ocean:** low blue waves, silver moonlight, layered clouds and a far horizon, romantic oil-painting texture, uncluttered center; no boats, people or interface.

All four are edge-to-edge landscape backgrounds. These briefs summarize the final prompt set; the built-in tool was used for generation, with WebP compression for delivery.

## Checks completed

- Full TypeScript check and ESLint on the touched theme files plus the existing shell/assistant hooks: clean.
- Tailwind/PostCSS compilation: successful; all four artwork rules and the larger text tokens are emitted.
- 23 cases run against the actual pre-paint script: seven choices with either OS preference, missing/invalid and prototype-key preferences, and blocked storage. White stays the default; illustrated dark themes use the dark control palette.
- The actual settings component renders seven radio options, exactly one selected, with Light selected by default.
- All four full-size pictures and four picker thumbnails are present at the paths used by the code. Docker's existing public-directory copy includes them; no Dockerfile or migration change is needed.
- React review: no added fetch/effect loop or heavy client import; startup and hydrated state share the same validated catalog, and switching between two themes with the same light/dark palette still updates the background.

No production image build or browser UI verification has been run for these illustrated themes. The repository's UI workflow requests static checks and concise manual verification; no deployment or provider call was made for this change.

## Manual review before merging

1. In a browser with no saved appearance choice, open the workspace: the canvas must be plain white. An existing saved Light, Pure black, System or Golden clouds choice must remain selected.
2. In Settings → Appearance, select each illustrated card using a click and the arrow keys. Reload: the picture, selected card and control palette must agree.
3. Switch Dark forest → Deep space → Moonlit ocean and Golden clouds → Light. The background must update even when the control palette stays the same. Switch System and change the device preference.
4. Check Outreach, Inbox, Leads List/Board and Reports at desktop and phone widths: readable messages, headers, tables, long labels and the composer; no horizontal overflow; the art remains behind the work.
5. Return to Light: the plain white canvas and normal light surfaces must return. Check the sidebar's light/dark toggle, and confirm public pages do not gain a scenery picture.

## Existing onboarding and multiple-account behavior

Getting started already provides a configuration checklist with live saved-state indicators and links to account connections, AI settings, sending rules, leads, campaigns and replies. It distinguishes connected credentials from a verified inbound reply. Its outdated approval wording is tracked as L05 in the separate pilot report.

The sending paths load multiple connected accounts within the workspace. Instagram initial DMs are assigned across approved senders; LinkedIn campaigns can associate multiple accounts; WhatsApp and email have their own sender selection and account limits. Replies remain attached to the relevant account and conversation.

This is code inspection, not a new live multiple-account verification. The assistant's LinkedIn discovery path currently selects the first connected account with `limit(1)`; adding accounts does not make that search automatically rotate. Verify two accounts per channel in a controlled pilot before claiming every path scales identically. No sender selection or messaging code is changed by this UI work.
