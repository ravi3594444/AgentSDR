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

Light (plain white), Pure black and System remain available. Native radio buttons allow keyboard selection; the choice takes effect immediately and is remembered on this browser. Other devices keep their own appearance. The sidebar's button flips Light and Pure black; with an illustrated background selected it opens Settings → Appearance instead of replacing the picture, and its tooltip says which.

The pictures fill the signed-in workspace canvas, including behind the assistant. Messages, tables and cards keep solid surfaces. The email, LinkedIn, WhatsApp, calls, Instagram and tables sections and the Leads list keep a mostly opaque (88%) surface, so the picture shows faintly behind dense lists. The artwork is decorative and does not intercept clicks. Public landing and sign-in pages do not acquire a scenery background.

The theme colours are set on `<html>`, so menus, popovers, dialogs and the phone navigation drawer (rendered outside the app shell) match the workspace. The dark themes' rules outrank the device dark-mode block, so a device in dark mode keeps their colours. Tints and text colours were chosen against each artwork's own pixels, where text sits (the header band and the chat column):

| Theme | Tint | Secondary / hint text under 4.5:1 |
| --- | ---: | --- |
| Golden clouds | 55% ivory | none (worst 5.7:1 and 4.9:1) |
| Dark forest | 62% | 0.1% / 0.4% of header pixels |
| Deep space | 62% | 0.1% / 0.2% |
| Moonlit ocean | 62% | 0.0% / 0.2% |

Before, Golden clouds put about two thirds of the header area under 4.5:1 for secondary text, and the dark themes up to 12% for hints.

**Bigger text everywhere** (the owner found it too small). The shared scale moves up two pixels where most text lives, with matching line heights; headings are unchanged:

| Size | Before | Now |
| --- | ---: | ---: |
| Small text (`paragraph-xs`, `label-xs`, Tailwind `text-xs`) | 12 px | 14 px |
| Body text (`paragraph-sm`, `label-sm`, Tailwind `text-sm`) | 14 px | 16 px |
| Medium text (`paragraph-md`, `label-md`, Tailwind `text-base`) | 16 px | 17 px |
| Smallest labels (`label-2xs`) | 11 px | 12 px |

The 310 fixed-pixel text classes of 8–14 px (in 48 files) and the landing page's 8–14 px text take the same step; the chart axes and the enrichment grid follow. Small boxes that held text were resized where the bigger text would not fit (the Inbox filter counter, the 20 px avatar, the Notes and Tasks avatar).

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

## Checks after the bigger-text change (21 Oct)

Code: this branch merged into `claude/pilot-fixes-l01-l05` (what would deploy together), built as the Dockerfile builder does (`next build --webpack` under Node, exit 0), served with `bun server.js`, and measured in Chromium against today's build side by side, signed in as the demo owner, at 1440×900 and 390×844.

- **Text size**, average over the visible text of each page, plain Light: every one of the 18 pages, the landing page included, is about 2 px bigger at both widths. For example the chat 12.9 → 14.8 px, Inbox 13.4 → 15.4 px, Reports 12.2 → 14.2 px, the landing page 15.4 → 17.1 px.
- **Layout**: no text clipped by a box, no horizontal page scroll and no page errors on any page, before or after. Text cut with "…" in narrow columns rises where expected (the phone Leads list 29 → 44 entries, all conversations in the Inbox 44 → 56).
- **Themes**: 204 page views (six choices × 17 pages × two widths) with the device in light mode and 60 with it in dark mode: the right picture each time, only that picture's full-size file loaded, and the dark themes keep their own colours on a dark-mode device (surface `#0c1512`, `#0b0e1b`, `#0b141f`, not pure black). A popover in Dark forest has the same surface as the workspace. The sidebar button reads "Dark forest is on. Change the appearance" and opens Settings → Appearance.
- `src/components/theme/themes.test.ts` (11 tests): the text scale, no text below 10 px, the stored-value fallbacks, the button label, the cascade against the device dark-mode block, 4.5:1 on every solid surface and over each artwork at its darkest or brightest 1%. Full suite on the combined tree: 2,008 pass, 0 fail; `tsc` clean.
- Two independent reviews ran; every confirmed finding is fixed in these commits.

**Merging next to `claude/pilot-fixes-l01-l05`**: whichever lands second meets one conflicting line in `AssistantClient.tsx`, the owner message's time. Keep the pilot fix's `formatChatTime(turn.owner.createdAt, timeZone)` (the L04 time-zone fix) with this branch's `text-[13px]`, and drop `toLocaleTimeString` and `suppressHydrationWarning`.

Not checked here: the Docker image itself (no daemon in this environment), and pages outside the 18 above at the new size (campaign editors, record pages, the tables grid).

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
