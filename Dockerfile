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

# ======================================================================
# STAGE ONE: COMPILE.
#
# This stage has the dev dependencies — TypeScript among them — and exists
# only to turn src/ into dist/. Nothing from it ships except that directory.
#
# It is a separate stage rather than a `npm ci` followed by a prune because
# the runtime image must never have contained the toolchain at all: a layer
# is forever, and "we deleted it afterwards" is not true of a container image.
# ======================================================================
FROM base AS builder

COPY package.json package-lock.json* ./
# Everything, including devDependencies. This is the one place in the build
# where that is correct.
RUN npm ci

# The Prisma client is generated from the schema alone and needs no database.
# It is generated HERE as well as in the runtime stage because the compiler
# reads its types.
COPY prisma ./prisma
RUN npx prisma generate

COPY tsconfig.json ./
COPY src ./src

# tsc, with the strictness in tsconfig.json. A type error fails the build,
# which is the whole point of having one.
RUN npm run build

# ======================================================================
# STAGE TWO: RUN.
#
# Production dependencies and compiled output. No TypeScript, no source,
# no test suite.
# ======================================================================
FROM base AS runtime

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
# THE PATH IS RESOLVED RELATIVE TO THE MODULE — HERE/../../contract — so it
# only stays correct while dist/ mirrors src/ at the same depth. tsconfig.json
# pins `rootDir: src` for that reason, and test/build.test.js asserts it.
#
# Copied by name rather than as the whole directory, so the runtime dependency
# is visible here and the image does not carry backend.md and the other
# documentation. test/deploy.test.js checks this list against every file the
# server actually reads.
# ----------------------------------------------------------------------
COPY contract/market-config.js ./contract/market-config.js

# The compiled service. `src` never enters this image.
COPY --from=builder /app/dist ./dist

# ======================================================================
# MIGRATIONS DO NOT RUN HERE.
#
# `prisma migrate deploy` is in the START command (see package.json), never
# in the build. On Render the database is reachable at runtime and not at
# build time, and running migrations at build is exactly how this project
# met Prisma's P1001 the first time. The rule is worth more than the comment:
# in any containerised deployment, migrate on start.
# ======================================================================

# ======================================================================
# WHICH BUILD THIS IS.
#
# /health reports a commit so that "did my push deploy" has an answer that
# is not somebody's memory. It read RENDER_GIT_COMMIT alone, which the
# platform injects at RUNTIME — true for its native runtimes, and not
# something a Dockerfile should depend on the platform to do.
#
# Baked in at BUILD time instead, so the image knows what it is wherever it
# runs: locally, in CI, or on a platform that names the variable something
# else. The runtime value is still read as a fallback, so nothing that works
# today stops working.
#
#   docker build --build-arg GIT_COMMIT=$(git rev-parse HEAD) .
#
# Unset is not a failure. An image built by hand has no commit and says so,
# which is better than claiming one.
# ======================================================================
ARG GIT_COMMIT=""
ENV BUILD_COMMIT=$GIT_COMMIT

ENV NODE_ENV=production
# Render sets PORT; this is only the fallback.
ENV PORT=8080
EXPOSE 8080

# Not root. If something in this process is ever exploited, it should not
# also own the filesystem.
USER node

CMD ["npm", "start"]
