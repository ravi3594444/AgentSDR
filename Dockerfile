# Stage 1: Install dependencies
FROM oven/bun:1-alpine AS deps
WORKDIR /app
COPY package.json bun.lock ./
# SheetJS (xlsx) is installed from this vendored tarball, not the npm registry; see vendor/README.md.
COPY vendor ./vendor
RUN bun install --frozen-lockfile

# Stage 2: Build the Next.js app
FROM oven/bun:1-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN bun run build

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
# scheduler's migration for installs upgrading to it. Both use Bun's built-in
# PostgreSQL client, so they need no packages.
COPY --from=builder --chown=nextjs:nodejs /app/db ./db
COPY --from=builder --chown=nextjs:nodejs /app/scripts/db/setup.ts ./scripts/db/setup.ts
COPY --from=builder --chown=nextjs:nodejs /app/scripts/create-scheduled-job-runs.ts ./scripts/create-scheduled-job-runs.ts

# Entrypoint: maps APP_URL, builds DATABASE_URL for the bundled database,
# refuses placeholder secrets on a public address and creates the schema in an
# empty database (see docker/entrypoint.sh).
COPY docker/entrypoint.sh /usr/local/bin/agentsdr-entrypoint
RUN chmod 755 /usr/local/bin/agentsdr-entrypoint

USER nextjs
EXPOSE 3000

ENTRYPOINT ["agentsdr-entrypoint"]
CMD ["bun", "server.js"]
