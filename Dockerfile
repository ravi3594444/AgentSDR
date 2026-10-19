# Stage 1: Install dependencies
FROM oven/bun:1-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
# SheetJS (xlsx) is installed from this vendored tarball, not the npm registry; see vendor/README.md.
COPY vendor ./vendor
RUN bun install --frozen-lockfile

# Stage 2: Build the Next.js app
# Build Next.js under Node with Webpack to reduce compilation memory on
# small VMs; Turbopack exceeded 7 GB even under Node in a measured build.
# Bun still installs the packages and builds the call recorder.
FROM oven/bun:1-alpine AS builder
WORKDIR /app
RUN apk add --no-cache nodejs
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# The TypeScript worker can hit Node's default ~2 GB heap even when the VM
# has free RAM. NODE_OPTIONS also reaches that child process. This bounds
# each Node heap, not the whole build; leave room for native build memory.
ARG NEXT_BUILD_HEAP_MB=4096
RUN bun run package:recorder && \
    NODE_OPTIONS="--max-old-space-size=${NEXT_BUILD_HEAP_MB}" node node_modules/next/dist/bin/next build --webpack

# Stage 3: Lean production image
FROM oven/bun:1-alpine AS runner
WORKDIR /app

LABEL org.opencontainers.image.title="AgentSDR" \
      org.opencontainers.image.description="Open-source AI sales development platform" \
      org.opencontainers.image.source="https://github.com/Kandid-ai/AgentSDR" \
      org.opencontainers.image.licenses="MIT"

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# The scheduled jobs run inside the app. curl stays for an external cron that
# calls their endpoints from inside this container (Dokploy Schedule Jobs,
# `docker exec ... curl ...`).
RUN apk add --no-cache curl

RUN addgroup -S -g 1001 nodejs && adduser -S -u 1001 -G nodejs nextjs

COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
# Fresh-install schema and its setup script (`bun scripts/db/setup.ts
# --if-empty`, run by the entrypoint before the app starts), and the
# migrations an existing install runs in the container when upgrading (the
# scheduler's, web research's, the assistant's, the optional features'). All use Bun's built-in PostgreSQL client, so
# they need no packages.
COPY --from=builder --chown=nextjs:nodejs /app/db ./db
COPY --from=builder --chown=nextjs:nodejs /app/scripts/db/setup.ts ./scripts/db/setup.ts
COPY --from=builder --chown=nextjs:nodejs /app/scripts/create-scheduled-job-runs.ts ./scripts/create-scheduled-job-runs.ts
COPY --from=builder --chown=nextjs:nodejs /app/scripts/create-lead-research.ts ./scripts/create-lead-research.ts
COPY --from=builder --chown=nextjs:nodejs /app/scripts/add-mailbox-provider.ts ./scripts/add-mailbox-provider.ts
COPY --from=builder --chown=nextjs:nodejs /app/scripts/create-assistant-tables.ts ./scripts/create-assistant-tables.ts
COPY --from=builder --chown=nextjs:nodejs /app/scripts/add-assistant-automation.ts ./scripts/add-assistant-automation.ts
COPY --from=builder --chown=nextjs:nodejs /app/scripts/add-handoff.ts ./scripts/add-handoff.ts
COPY --from=builder --chown=nextjs:nodejs /app/scripts/add-instagram-intake-discovery.ts ./scripts/add-instagram-intake-discovery.ts
COPY --from=builder --chown=nextjs:nodejs /app/scripts/add-instagram-outreach.ts ./scripts/add-instagram-outreach.ts
COPY --from=builder --chown=nextjs:nodejs /app/scripts/add-wrong-number.ts ./scripts/add-wrong-number.ts
COPY --from=builder --chown=nextjs:nodejs /app/scripts/add-assistant-job-reports.ts ./scripts/add-assistant-job-reports.ts
COPY --from=builder --chown=nextjs:nodejs /app/scripts/add-tinyfish.ts ./scripts/add-tinyfish.ts
COPY --from=builder --chown=nextjs:nodejs /app/scripts/add-research-sources.ts ./scripts/add-research-sources.ts
COPY --from=builder --chown=nextjs:nodejs /app/scripts/add-browser-sessions.ts ./scripts/add-browser-sessions.ts
COPY --from=builder --chown=nextjs:nodejs /app/scripts/add-activity.ts ./scripts/add-activity.ts
COPY --from=builder --chown=nextjs:nodejs /app/scripts/add-objectives.ts ./scripts/add-objectives.ts

# Entrypoint: maps APP_URL, builds DATABASE_URL for the bundled database,
# refuses placeholder secrets on a public address and creates the schema in an
# empty database (see docker/entrypoint.sh).
COPY docker/entrypoint.sh /usr/local/bin/agentsdr-entrypoint
RUN chmod 755 /usr/local/bin/agentsdr-entrypoint

# The commit this image was built from. docker/deploy.sh passes it and checks
# the running container against it. Declared last so a new value does not
# invalidate the layers above.
ARG GIT_SHA=unknown
LABEL org.opencontainers.image.revision="${GIT_SHA}"
ENV AGENTSDR_REVISION="${GIT_SHA}"

USER nextjs
EXPOSE 3000

ENTRYPOINT ["agentsdr-entrypoint"]
CMD ["bun", "server.js"]
