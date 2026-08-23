# One image, one Railway service. Web and workers are the same binary; ROLES picks
# which of them this container runs.
FROM oven/bun:1.3.14-slim AS base
WORKDIR /app

# Dependencies first, so a code-only change does not reinstall the world.
FROM base AS deps
COPY package.json bun.lock* bunfig.toml ./
COPY apps/web/package.json apps/web/
COPY apps/worker/package.json apps/worker/
COPY packages/auth/package.json packages/auth/
COPY packages/config/package.json packages/config/
COPY packages/db/package.json packages/db/
COPY packages/notify/package.json packages/notify/
COPY packages/playlists/package.json packages/playlists/
COPY packages/queue/package.json packages/queue/
COPY packages/catalog/package.json packages/catalog/
COPY packages/payments/package.json packages/payments/
RUN bun install --frozen-lockfile || bun install

FROM base AS runtime
ENV NODE_ENV=production
# Copy the whole deps stage, not just /app/node_modules. Bun's isolated linker puts
# each workspace's dependencies in ITS OWN node_modules (apps/web/node_modules,
# packages/*/node_modules) rather than hoisting them to the root, so copying only
# the root directory leaves every workspace import unresolvable at build time.
# Listing the nested directories individually is not an option either: a package
# with no dependencies has no node_modules at all and the COPY would fail.
COPY --from=deps /app /app
# .dockerignore excludes node_modules, so this overlays source without clobbering
# anything installed above.
COPY . .
RUN bun apps/web/build-client.js

# Railway injects PORT; the app reads it. Never hardcode a port here or the edge
# proxy forwards to a closed socket and every request 404s on a healthy container.
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s \
  CMD bun -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["bun", "apps/web/src/main.js"]
