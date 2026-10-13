# Owner setup: 22nd X AI Outreach

How to run this build, connect its providers and check it works. Scope: the
owner's own copy of AgentSDR ([ravi3594444/AgentSDR](https://github.com/ravi3594444/AgentSDR)),
Session 1 of [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md). The upstream
guides in `docs/` still apply; this page says what is specific to this build
and in which order to do things. Progress and evidence are in
[SESSION_STATUS.md](SESSION_STATUS.md).

Never paste secrets into this repository, this file or a chat. They go in the
server's `.env` (or `.env.local` from source) or in the app's own settings,
which store them encrypted.

## 0. Get the code onto `main`

Session 1 was developed on the branch `claude/new-session-g5hljn`, not on
`main`. `CLAUDE.md` says every push to `main` triggers a deployment, so merge
the branch into `main` when you are ready for that (on GitHub: open a pull
request from the branch and merge it, or merge locally and push).

## 1. Run it with Docker Compose (recommended)

Plain `docker compose up -d` runs the **published upstream image**, which has
none of this build's changes. Always add the build override.

Prerequisites: a Linux VM with Docker and Compose. A planning estimate for a
starter server is 2 vCPU, 8 GB RAM and 60 GB SSD. That is not a published
minimum, and no GPU is needed.

```bash
git clone https://github.com/ravi3594444/AgentSDR.git 22nd-x-ai-outreach
cd 22nd-x-ai-outreach

# Secrets for Compose, written once. Refuses to overwrite an existing .env.
umask 077
if [ -e .env ]; then echo "An .env already exists; keep it." >&2; else
  { printf '%s\n' 'APP_URL=http://localhost:3000' 'AUTH_SIGNUP=invite-only'
    for n in BETTER_AUTH_SECRET INTEGRATION_CREDENTIALS_KEY UNSUBSCRIBE_SECRET POSTGRES_PASSWORD; do
      printf '%s=%s\n' "$n" "$(openssl rand -hex 32)"; done; } > .env
fi

docker compose -f docker-compose.yml -f docker-compose.build.yml up -d --build
docker compose -f docker-compose.yml -f docker-compose.build.yml ps
docker compose -f docker-compose.yml -f docker-compose.build.yml logs --tail=80 app
```

Then open `http://localhost:3000`. On an empty database the app creates its
schema itself, and `/setup` creates the first owner and workspace. After
setup it lands on **Getting started**.

Rules that matter:

- **Back up `INTEGRATION_CREDENTIALS_KEY`** together with the database (the
  `db-data` volume). Without it every saved integration must be reconnected.
  `docker compose down -v` deletes the database volume; plain `down` does not.
- **Run one app container.** It runs the senders and schedulers in-process.
  Do not add a second replica or an external cron calling the same ticks.
- **Do not set `DEMO_MODE`** on this database, and do not seed demo data into it.
- **To rebuild after pulling changes:** run the same `up -d --build` command.
  `bun run db:setup` is for empty databases only and is never an upgrade.

### Going live (public HTTPS address)

Unipile webhooks and Gmail push notifications cannot reach `localhost`.

1. Point a domain at the server and put a reverse proxy (Caddy, nginx,
   Traefik) in front of port 3000 that terminates TLS.
2. In `.env`, set `APP_URL=https://your-domain` (no trailing slash).
3. Recreate the app container:
   `docker compose -f docker-compose.yml -f docker-compose.build.yml up -d`.
4. In the app, open **Settings → LinkedIn → Connection** and **save the
   Unipile connection again**. Webhook registration is skipped on a local
   address, and saving at the public address registers them.

Details: `docs/self-hosting/production.mdx`.

### Invitation email (Resend)

Before inviting anyone, set `RESEND_API_KEY` and `AUTH_EMAIL_FROM` in `.env`
(for example `22nd X AI Outreach <auth@your-verified-domain>`) and recreate the
app container. Without them, invitation, verification and password-reset
emails are only written to the app log. Creating the first owner needs none of
this. Guide: `docs/integrations/resend.mdx`.

## 2. Alternative: run from source

Needs Bun, Node.js 20.9+ and PostgreSQL 16+.

```bash
bun install --frozen-lockfile
createdb agentsdr_dev                 # with your existing PostgreSQL role
cp .env.example .env.local            # then edit: DATABASE_URL, DATABASE_SSL=disable for a local DB,
                                      # BETTER_AUTH_URL, BETTER_AUTH_SECRET, INTEGRATION_CREDENTIALS_KEY,
                                      # UNSUBSCRIBE_SECRET (openssl rand -hex 32 for each secret)
bun run db:setup                      # empty database only
bun run dev                           # UI work; does NOT run the production senders
```

To exercise real sending from source, use `bun run build` then `bun run start`.
`next start` prints a warning about `output: standalone`, but it serves the app.
The source route reads `BETTER_AUTH_URL`; Compose reads `APP_URL`.

## 3. Connect providers (follow Getting started)

**Getting started** (the sidebar entry beside Settings) shows each step's
state from what is saved. **Connected** means that the saved credentials passed
their live check and an account is linked. It is not proof that a message was
delivered.

| Step | Where | What you need | Guide |
| --- | --- | --- | --- |
| Email | Settings → Email → Connection, then Mailboxes | Google Workspace service account with domain-wide delegation. For replies to stop follow-ups you also need a **Gmail Pub/Sub topic** (saved on the same card) and a push subscription to `https://your-domain/api/outreach/webhooks/gmail-watch`. Personal Gmail is not supported in this release. | `docs/integrations/google-workspace.mdx`, `docs/integrations/gmail-reply-sync.mdx` |
| LinkedIn | Settings → LinkedIn → Connection, then Accounts | A Unipile workspace (API key and DSN). LinkedIn profiles link through Unipile's hosted sign-in. | `docs/integrations/unipile.mdx` |
| WhatsApp | Settings → WhatsApp → Integrations, then Numbers | The same Unipile connection. Link the number **in the Unipile dashboard** (scan the QR code there), then press **Sync from Unipile**. New numbers start no new chats for 24 h. | `docs/whatsapp/accounts.mdx` |
| AI | Settings → AI provider | An OpenRouter inference key and management key, at least one BYOK provider, a default model, and the shared-capacity confirmation. Drafts always wait for your review. | `docs/workspace/ai-provider.mdx`, `docs/integrations/openrouter.mdx` |
| Sending rules | Settings → Email / LinkedIn / WhatsApp → Sending rules | Owner or admin only. | `docs/workspace/sending-rules.mdx` |
| Phone default | Settings → Organization (General) → Default phone country | Set it if your lists have local numbers without `+`. Without it those numbers are dropped on import, not rejected. | `docs/workspace/organizations.mdx` |
| Recordings (optional) | Settings → WhatsApp → Integrations | Cloudflare R2 and the Call Recorder extension. | `docs/integrations/cloudflare-r2.mdx` |

After you save Unipile, its dashboard lists two webhooks named
**22nd X AI · …**. Upstream docs call them "AgentSDR · …"; only the label
changed, and they are still matched by URL.

**The Unipile trial is seven days.** Finish everything else (the local checks,
imports and campaign drafts) before starting it, then use the trial to verify
the LinkedIn/WhatsApp accounts you actually plan to run. After the trial,
connected-channel access needs a paid Unipile subscription.

## 4. Brand settings

Everything customer-facing reads `src/lib/brand.ts`:

- `name`, `shortName`, `wordmark` and `description`.
- `accessRequestEmail`: on an invite-only sign-in page, the address "Need
  access?" writes to. It is `null` by default, which shows the hint without a
  link. Upstream mailed the AgentSDR maintainer; this build never does.
- `monogram`: the letters on the app tile. `src/app/icon.svg` (the favicon) and
  `src/app/apple-icon.tsx` draw the same tile; change all three together.

To use a drawn logo instead of the text wordmark, replace the contents of
`AppIcon` and `Logo` in `src/components/brand/Logo.tsx` and the two icon files.
The wordmark font is Manrope, loaded through `next/font` like the other faces,
in `src/components/brand/font.ts`.

`LICENSE` and the upstream copyright stay as they are. This product is built on
AgentSDR (MIT). The Call Recorder Chrome extension is still named "AgentSDR Call
Recorder".

## 5. Manual checks for the owner (pending)

These need a person and a browser. `AGENTS.md` asks agents not to run browser
automation unless you request it. Record the results in `SESSION_STATUS.md`.

1. Create or sign in to the owner workspace, and check the branding on sign-in,
   setup, the sidebar (expanded and collapsed), the mobile header, the browser
   tab title and the favicon, in light and dark themes.
2. Follow Getting started and confirm each status matches what you configured.
3. Import a small CSV and an XLSX on Leads. Check accents, duplicate rows (the
   second import should only update), custom columns, and the row numbers in
   any errors.
4. Create a draft email campaign and check its steps, merge fields
   (`{{firstName}}`, custom columns) and the sending rules it will follow.
5. Configure one real channel and send a controlled test to yourself.
6. Reply to it and confirm the reply appears in Action required, and that the
   remaining follow-ups for that person stop.
7. Review and edit an AI draft, then send it yourself. Nothing is sent automatically.
8. Restart the app container and confirm that settings, leads and campaign
   state are still there.
9. Check Getting started, Leads import and the campaign pages at phone width
   (about 390 px).

## 6. Re-running the automated checks

```bash
bun install --frozen-lockfile
bun run typecheck && bun run lint && bun run test && bun run build

# Against a disposable LOCAL database only (each script refuses anything else):
bun run db:check
# Owner vs member permissions and the owner workflow (server running, any AUTH_SIGNUP):
INITIAL_OWNER_EMAIL=… INITIAL_OWNER_PASSWORD=… BASE_URL=http://localhost:3000 \
  bun run scripts/e2e/owner-controls.ts
# Tenant isolation: start `AUTH_SIGNUP=open bun run dev -- -p 3100` first. Under
# `bun run start` Better Auth's production rate limiter answers its rapid
# sign-ins with 429.
INITIAL_OWNER_EMAIL=… INITIAL_OWNER_PASSWORD=… BASE_URL=http://localhost:3100 \
  bun run --conditions=react-server scripts/e2e/tenancy-isolation.ts
```
