# ======================================================================
# The PALTAS API image.
#
# Render builds this from source rather than pulling a pre-built image from
# GHCR. That is deliberate and it is a lesson already paid for: a private
# GHCR image needs an explicit access grant for the deployment platform, and
# when it is missing the failure is an opaque "could not pull image".
# Building from source has no such class of problem.
# ======================================================================

FROM node:22-slim AS base
WORKDIR /app

# openssl is what Prisma's query engine links against. Without it the image
# builds fine and then fails at runtime, which is the worst kind of missing
# dependency.
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Dependencies first, so a change to source code does not reinstall them.
COPY package.json package-lock.json* ./

# --omit=dev, and `prisma` is deliberately a RUNTIME dependency rather than a
# dev one: the start command runs `prisma migrate deploy`, so the CLI has to
# be in this image. It does currently arrive anyway as a transitive dependency
# of @prisma/client — which is exactly why it is declared explicitly. A
# runtime need met by somebody else's dependency tree is a deploy that breaks
# on a patch bump, at container start, with "prisma: not found".
RUN npm ci --omit=dev

# The Prisma client is generated at BUILD time — it needs only the schema,
# not a reachable database.
COPY prisma ./prisma
RUN npx prisma generate

# ----------------------------------------------------------------------
# THE ONE CONTRACT FILE THE SERVER READS AT RUNTIME.
#
# src/domain/market.js does readFileSync on contract/market-config.js at
# IMPORT time, so without this line the container does not start at all:
# importing src/routes/market.js throws ENOENT and the process dies before it
# ever listens. The deploy then fails and Render keeps the previous build —
# which looks exactly like "the push did nothing".
#
# Copied by name rather than as the whole directory, so the runtime dependency
# is visible here and the image does not carry backend.md and the other
# documentation. test/deploy.test.js checks this list against every file the
# server actually reads.
# ----------------------------------------------------------------------
COPY contract/market-config.js ./contract/market-config.js

COPY src ./src

# ======================================================================
# MIGRATIONS DO NOT RUN HERE.
#
# `prisma migrate deploy` is in the START command (see package.json), never
# in the build. On Render the database is reachable at runtime and not at
# build time, and running migrations at build is exactly how this project
# met Prisma's P1001 the first time. The rule is worth more than the comment:
# in any containerised deployment, migrate on start.
# ======================================================================

ENV NODE_ENV=production
# Render sets PORT; this is only the fallback.
ENV PORT=8080
EXPOSE 8080

# Not root. If something in this process is ever exploited, it should not
# also own the filesystem.
USER node

CMD ["npm", "start"]
