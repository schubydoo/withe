# syntax=docker/dockerfile:1

# Alpine, decided in tad.md Section 6.1.1 and confirmed by measurement here.
# better-sqlite3 13 ships its own musl prebuilds, so nothing is compiled and no
# build toolchain exists to keep out of the runner. See Section 6.1.
#
# Pinned by digest, not by the moving tag: `node:24-alpine` changes underneath
# a rebuild, and an image nobody can reproduce is an image nobody can bisect.
# The digest is the multi-architecture index, so it resolves on amd64 and
# arm64 alike. Renovate keeps it current once it runs against this repository
# (tad.md SEC-16) — it reads the tag beside the digest to know what to bump.
FROM node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43 AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts is what keeps a compiler out of this image. npm runs
# node-gyp for any package carrying a binding.gyp, and better-sqlite3 carries
# one — while also shipping the musl binary it would have built. Skipping the
# scripts uses the prebuilt binary, and no install script from any dependency
# runs during the build.
RUN npm ci --ignore-scripts

FROM node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43 AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build
# The supervisor, worker and TLS proxy are not in the application graph, so
# standalone output does not carry what only they import. Bundled, not copied:
# the whole node_modules would cost about 200 MB.
RUN npm run bundle:server

FROM node:24-alpine@sha256:d32cdf619f63fe0471182d08996dd516c6275bb5fd31ae06e55a570bd9e1ad43 AS runner
WORKDIR /app
ENV NODE_ENV=production
# tini reaps the zombies a supervisor with children would otherwise leave.
# libstdc++ is the runtime dependency of the SQLite addon: without it the
# import fails, and a successful build says nothing about that. sqlite is the
# CLI the README's documented backup uses — `.backup` takes a consistent copy
# of a live WAL database, which `cp` cannot.
RUN apk add --no-cache tini libstdc++ sqlite

# Before USER, and not left to VOLUME. Docker creates an unprepared mount point
# as root:root, so uid 1000 gets EACCES on the first run of a clean host, which
# is exactly what F-07's 60-second criterion measures.
RUN mkdir -p /data && chown node:node /data

COPY --from=builder --chown=node:node /app/.next/standalone ./
# Standalone excludes the static assets — Next expects a CDN to serve them —
# and a missing copy renders every page unstyled while the HTML looks correct.
COPY --from=builder --chown=node:node /app/.next/static ./.next/static
COPY --from=builder --chown=node:node /app/dist ./dist
COPY --from=builder --chown=node:node /app/drizzle ./drizzle

USER node
VOLUME /data
EXPOSE 3000

# The worker and TLS proxy defaults name source files, which the image does not
# carry. The web default — `node server.js` from /app — is already right.
ENV WITHE_DB_PATH=/data/withe.db \
    WITHE_CONFIG=/data/withe.yaml \
    WITHE_WORKER_CMD="node /app/dist/worker.js" \
    WITHE_TLS_CMD="node /app/dist/tls-proxy.js"

HEALTHCHECK --interval=60s --timeout=5s --start-period=30s --retries=3 \
  CMD ["node", "dist/healthcheck.js"]

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/supervisor.js"]
