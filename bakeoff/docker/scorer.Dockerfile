# syntax=docker/dockerfile:1.20
# ---------------------------------------------------------------------------
# scorer.Dockerfile — the SEALED SCORING CONTAINER.
#
# doc 03 section 7.4: the held-out acceptance suite "executes in a clean
# container with no network and no access to the build agent's workspace
# history". This image is that container. Its integrity is the experiment: if it
# can be influenced by the builder, every number the bake-off produces measures
# persuasion rather than work.
#
# WHAT GOES IN (and nothing else):
#   /artifact                a STAGED COPY of the build artefact, read-write
#   /scorer/suite            the frozen acceptance suite, READ-ONLY
#   /scorer/input/plan.json  the sealed plan, READ-ONLY
#   /scorer/out              machine-readable output, read-write
#   /scorer/screenshots      masked captures, read-write
#
# The artefact sits OUTSIDE /scorer on purpose: /scorer carries a node_modules
# symlink so the read-only frozen suite can resolve the scorer's own pinned
# Playwright, and the artefact must not resolve into that. See the RUN that
# creates it, at the bottom of this file.
#
# WHAT NEVER GOES IN: the network, the build workspace's git history, the
# builder's logs, the builder's self-report, any conversation transcript, the
# configuration id, any model or effort or cost, and any credential. The host
# gate (src/scorer.ts) strips the first four during staging and refuses to write
# a plan containing the rest; `assertSealedInvocation` refuses to dispatch a
# `docker run` that would forward a host environment variable.
#
# BASE IMAGE PINNED BY DIGEST, NOT BY TAG. A tag is a moving pointer: rebuilding
# from `:v1.62.0-noble` three weeks apart can yield different bytes, which
# silently varies held-constant variable 3 (sandbox image + network policy,
# doc 03 section 7.3) across configurations and invalidates every comparison in
# the bake-off. The digest below is the OCI index digest resolved on 2026-07-27:
#
#   docker buildx imagetools inspect mcr.microsoft.com/playwright:v1.62.0-noble
#     index        sha256:baed2032d533817f3dbe6425de795788430ba345e819a1201337009ba17c9d07
#     linux/amd64  sha256:02bbb2155cd7109e3e9c741941097ed1608cf8b6fa44ee2595896da2bdc1f471
#     linux/arm64  sha256:5361940f845a5077926d54746122f7b68a121cc2aa27df6241087b774203fc44
#
# The index digest is used so the same Dockerfile builds on either architecture.
# Pass --platform explicitly and KEEP IT CONSTANT for a whole campaign; see
# docker/README.md, "Why the platform must not vary".
#
# THE TEST RUNTIME IS THE IMAGE'S, NOT THE ARTEFACT'S. The frozen suite executes
# with the Playwright installed here and the configuration baked in here. It
# never loads the artefact's node_modules and never loads an artefact-supplied
# runner config. That single choice is what makes the reporter-tampering exploit
# in doc 02 section 5.6 inert rather than merely detected: a builder that patched
# a reporter patched something this container does not execute.
#
# NO `apt-get` ANYWHERE IN THIS FILE. An unpinned apt transaction is the single
# largest reproducibility hole in a container build; the base image already
# carries Node 24, Chromium, Firefox and WebKit with every OS dependency
# installed, so nothing needs adding.
# ---------------------------------------------------------------------------

ARG BASE_IMAGE=mcr.microsoft.com/playwright:v1.62.0-noble@sha256:baed2032d533817f3dbe6425de795788430ba345e819a1201337009ba17c9d07

# ---------------------------------------------------------------------------
# Stage 1 — compile the harness.
#
# Uses the SAME package-lock.json as the host harness, so the Playwright version
# in this image and the @playwright/test types the host compiles against are one
# pin, not two that can drift.
# ---------------------------------------------------------------------------
FROM ${BASE_IMAGE} AS build

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    npm_config_fund=false \
    npm_config_audit=false \
    npm_config_update_notifier=false

WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig.json ./
COPY src ./src
RUN node_modules/.bin/tsc -p tsconfig.json

# ---------------------------------------------------------------------------
# Stage 2 — production dependencies only.
#
# --ignore-scripts is deliberate as well as fast: it prevents any dependency's
# postinstall from running during the image build, including Playwright's
# browser download, which would fetch a second copy of browsers the base image
# already provides at /ms-playwright.
# ---------------------------------------------------------------------------
FROM ${BASE_IMAGE} AS runtime-deps

ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    npm_config_fund=false \
    npm_config_audit=false \
    npm_config_update_notifier=false

WORKDIR /opt/bakeoff-scorer
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

# ---------------------------------------------------------------------------
# Stage 3 — the scorer itself.
# ---------------------------------------------------------------------------
FROM ${BASE_IMAGE} AS runtime

LABEL org.opencontainers.image.title="bakeoff-scorer" \
      org.opencontainers.image.description="Sealed held-out acceptance gate for the model bake-off. Runs with --network=none." \
      org.opencontainers.image.base.name="mcr.microsoft.com/playwright:v1.62.0-noble" \
      org.opencontainers.image.base.digest="sha256:baed2032d533817f3dbe6425de795788430ba345e819a1201337009ba17c9d07" \
      org.opencontainers.image.licenses="UNLICENSED"

# PLAYWRIGHT_BROWSERS_PATH is already /ms-playwright in the base image; it is
# repeated here so that a future base-image change cannot silently relocate the
# browsers and trigger a download attempt inside a container with no network.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    NODE_ENV=production \
    HOME=/tmp \
    XDG_CACHE_HOME=/tmp/.cache \
    npm_config_cache=/tmp/.npm \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8 \
    CI=1

WORKDIR /opt/bakeoff-scorer

COPY --from=runtime-deps /opt/bakeoff-scorer/node_modules ./node_modules
COPY --from=build /build/dist ./dist
COPY package.json ./package.json
COPY docker/playwright.config.mjs ./playwright.config.mjs
# The node:test half of the frozen suite runs under THIS reporter, by absolute
# path, for the same reason the Playwright config above lives here: a runner
# configuration the artefact can supply is a runner configuration the artefact
# can lie through (doc 02 section 5.6). See docker/node-test-reporter.mjs.
COPY docker/node-test-reporter.mjs ./node-test-reporter.mjs

# Mount points are created up front and made world-writable so the image works
# both with the image's own `pwuser` and with `--user "$(id -u):$(id -g)"`,
# which is what a Linux host needs for the screenshot bind mount to land with
# the operator's ownership. The root filesystem is mounted READ-ONLY at run
# time, so these directories are writable only where a bind mount or the tmpfs
# covers them.
#
# THE SYMLINK IS NOT A CONVENIENCE. The frozen suite is mounted READ-ONLY, so it
# cannot be given a `node_modules` of its own, and Node resolves bare specifiers
# by walking parent directories. Without `/scorer/node_modules`, every frozen
# test fails at `import { test } from "@playwright/test"` — which presents as an
# empty suite rather than as an error, and an empty suite that "found no tests"
# is the most dangerous possible failure for a gate. Because the link resolves to
# the same realpath the runner loaded, Node deduplicates it and the suite gets
# the runner's own fixtures rather than a second copy.
#
# The artefact is mounted at /artifact, OUTSIDE this subtree, so artefact code
# never resolves the scorer's dependencies.
RUN mkdir -p /artifact /scorer/suite /scorer/input /scorer/out /scorer/screenshots \
 && chmod -R 0777 /artifact /scorer \
 && ln -s /opt/bakeoff-scorer/node_modules /scorer/node_modules

# Non-root by default. `pwuser` ships with the Playwright base image.
USER pwuser

# A health check would need a network listener; this is a batch container, so it
# has none by design. Its liveness signal is /scorer/out/result.json, which the
# entrypoint always writes — including when it aborts.
HEALTHCHECK NONE

ENTRYPOINT ["node", "/opt/bakeoff-scorer/dist/scorer-container.js"]
