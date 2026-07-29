FROM node:22-bookworm AS deps

# Install required packages
RUN apt-get update && apt-get install -y openssl

WORKDIR /app

# Copy only the files needed for installing dependencies
COPY .yarn ./.yarn
COPY yarn.lock package.json .yarnrc.yml tsconfig.json lage.config.js ./
COPY packages/api/package.json packages/api/package.json
COPY packages/ci-actions/package.json packages/ci-actions/package.json
COPY packages/cli/package.json packages/cli/package.json
COPY packages/component-library/package.json packages/component-library/package.json
COPY packages/crdt/package.json packages/crdt/package.json
COPY packages/desktop-client/package.json packages/desktop-client/package.json
COPY packages/desktop-electron/package.json packages/desktop-electron/package.json
COPY packages/docs/package.json packages/docs/package.json
COPY packages/eslint-plugin-actual/package.json packages/eslint-plugin-actual/package.json
COPY packages/loot-core/package.json packages/loot-core/package.json
COPY packages/mobile-client/package.json packages/mobile-client/package.json
COPY packages/sync-server/package.json packages/sync-server/package.json
COPY packages/plugins-service/package.json packages/plugins-service/package.json
COPY packages/vite-plugin-peggy/package.json packages/vite-plugin-peggy/package.json

COPY ./bin/package-browser ./bin/package-browser

RUN yarn install

FROM deps AS builder

WORKDIR /app

COPY packages/ ./packages/

# Increase memory limit for the build process to 8GB
ENV NODE_OPTIONS=--max_old_space_size=8192

# The real .git is excluded from the build context (a throwaway repo is seeded
# below for lage), so the deployed build's commit hash must be passed in:
#   docker build --build-arg COMMIT_HASH=$(git rev-parse --short HEAD) ...
ARG COMMIT_HASH=
ENV ACTUAL_COMMIT_HASH=$COMMIT_HASH

# lage's task hasher invokes `git ls-tree HEAD` during initialization, so it
# needs a git repo even when individual targets disable caching. .dockerignore
# omits the real .git, so seed a throwaway repo with a single commit here.
RUN git -c init.defaultBranch=master init -q \
    && git -c user.email=build@docker -c user.name=docker-build add -A \
    && git -c user.email=build@docker -c user.name=docker-build commit -qm build

RUN yarn build:server

# Focus the workspaces in production mode (including @actual-app/web you just built)
RUN yarn workspaces focus @actual-app/sync-server --production

# Remove symbolic links for @actual-app/web and @actual-app/sync-server
RUN rm -rf ./node_modules/@actual-app/web ./node_modules/@actual-app/sync-server

# Copy in the @actual-app/web artifacts manually, so we don't need the entire packages folder
COPY ./packages/desktop-client/package.json ./node_modules/@actual-app/web/package.json
RUN cp -r ./packages/desktop-client/build ./node_modules/@actual-app/web/build

# Headless client for scheduled bank syncing (bin/auto-bank-sync.mjs explains
# why this has to be a client rather than a job inside the sync server). Built
# from the same commit as the server image so the two can never disagree about
# which bank providers exist. Branches from `deps` rather than `builder`
# because it needs only the api package, not the whole web client.
FROM deps AS autosync-builder

WORKDIR /app

COPY packages/ ./packages/

# lage's task hasher needs a repo here too, for the same reason as `builder`.
RUN git -c init.defaultBranch=master init -q \
    && git -c user.email=build@docker -c user.name=docker-build add -A \
    && git -c user.email=build@docker -c user.name=docker-build commit -qm build

RUN yarn build:api

RUN yarn workspaces focus @actual-app/api --production

FROM node:22-bookworm-slim AS autosync

RUN apt-get update && apt-get install -y tini && apt-get clean -y && rm -rf /var/lib/apt/lists/*

WORKDIR /app
ENV NODE_ENV=production
ENV ACTUAL_DATA_DIR=/data

# node_modules/@actual-app/* are workspace symlinks into packages/, so the
# targets have to come along for the import to resolve.
COPY --from=autosync-builder /app/node_modules ./node_modules
COPY --from=autosync-builder /app/packages/api ./packages/api
COPY --from=autosync-builder /app/packages/loot-core ./packages/loot-core
COPY --from=autosync-builder /app/packages/crdt ./packages/crdt
COPY bin/auto-bank-sync.mjs ./auto-bank-sync.mjs

# The budget is cached here between runs so each sync only fetches the delta.
RUN mkdir -p /data && chown -R node:node /data
USER node
VOLUME /data

ENTRYPOINT ["/usr/bin/tini", "-g", "--"]
CMD ["node", "auto-bank-sync.mjs"]

FROM node:22-bookworm-slim AS prod

# Minimal runtime dependencies. xvfb provides a virtual X display: Camoufox
# (the anti-detect Firefox used by the bank scrapers) runs a real headful
# browser inside a virtual display it manages itself, so it needs the Xvfb
# binary present even though there is no physical display.
RUN apt-get update && apt-get install -y tini xvfb && apt-get clean -y && rm -rf /var/lib/apt/lists/*

# Create a non-root user
ARG USERNAME=actual
ARG USER_UID=1001
ARG USER_GID=$USER_UID
RUN groupadd --gid $USER_GID $USERNAME \
    && useradd --uid $USER_UID --gid $USER_GID -m $USERNAME \
    && mkdir /data && chown -R ${USERNAME}:${USERNAME} /data

WORKDIR /app
ENV NODE_ENV=production

# Pull in only the necessary artifacts (built node_modules, server files, etc.)
COPY --from=builder /app/node_modules /app/node_modules
COPY --from=builder /app/packages/sync-server/package.json ./
COPY --from=builder /app/packages/sync-server/build ./build

# Camoufox (anti-detect Firefox) for the bank integrations (app-amex,
# app-cartayou). The browser binary is fetched to a fixed world-readable path
# (the container may run as an arbitrary uid, so it can't live in a user home),
# and CAMOUFOX_INSTALL_DIR points camoufox-js there at runtime too. The Firefox
# OS libraries are installed via Playwright's vetted dependency list. Postinstall
# scripts are disabled workspace-wide (.yarnrc.yml enableScripts: false), so the
# fetch must be an explicit build step.
ENV CAMOUFOX_INSTALL_DIR=/opt/camoufox
RUN npx -y playwright@1.53.1 install-deps firefox \
    && npx camoufox-js fetch \
    && chmod -R a+rX /opt/camoufox \
    && apt-get clean -y && rm -rf /var/lib/apt/lists/*

ENTRYPOINT ["/usr/bin/tini", "-g", "--"]
EXPOSE 5006
CMD ["node", "build/app.js"]
