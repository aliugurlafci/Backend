# syntax=docker/dockerfile:1

# The backend runs its TypeScript directly through `tsx` — `npm run build` is a
# type-check, not a bundle — so there is no compiled artifact to copy between
# stages. The split below exists to keep dev dependencies (tsx's toolchain,
# eslint, the type packages) out of the image that ships.
#
# BUILD CONTEXT: the repository ROOT, not this directory.
#
#     docker build -f Backend/Dockerfile .
#
# `@aula/contracts` is a `file:../packages/contracts` dependency, so npm needs
# that directory to exist at install time. Building from `Backend/` alone leaves
# the symlink pointing at nothing and the install fails — loudly, which is the
# right outcome, but the fix is here rather than in the manifest: the package is
# genuinely part of the same unit of deployment.

# ---- dependencies -----------------------------------------------------------
FROM node:22-alpine AS deps
WORKDIR /app
# Manifests first so this layer is reused whenever the lockfile is unchanged,
# which is most builds. The contracts package comes along because npm resolves
# the `file:` dependency during `npm ci`, not afterwards.
COPY Backend/package.json Backend/package-lock.json ./
COPY packages/contracts /packages/contracts
RUN npm ci --omit=dev

# ---- verify -----------------------------------------------------------------
# Typecheck and test with the full dependency set. A failure here fails the
# build, so an image cannot be produced from a tree that does not compile.
FROM node:22-alpine AS verify
WORKDIR /app
COPY Backend/package.json Backend/package-lock.json ./
COPY packages/contracts /packages/contracts
RUN npm ci
COPY Backend/tsconfig.json Backend/eslint.config.mjs ./
COPY Backend/src ./src
COPY Backend/tests ./tests
COPY Backend/scripts ./scripts
RUN npm run typecheck && npm run lint && npm test

# ---- runtime ----------------------------------------------------------------
FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Run unprivileged. The `node` user ships with the base image.
RUN chown node:node /app
USER node

# The contracts sources travel with the image: `node_modules/@aula/contracts` is
# a symlink out of /app, and the runtime reads the TypeScript through tsx, so the
# target has to be present in the final stage too — not only where it was
# installed.
COPY --from=deps --chown=node:node /packages/contracts /packages/contracts
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node Backend/package.json Backend/tsconfig.json ./
COPY --chown=node:node Backend/src ./src
COPY --chown=node:node Backend/scripts ./scripts

# Depends on the verify stage so `docker build` cannot skip it.
COPY --from=verify /app/package.json /tmp/verified.json

EXPOSE 4000

# Liveness comes from the app's own readiness probe, which round-trips the
# database — an instance that cannot reach its pool is not healthy, and that
# distinction is the point of the endpoint.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/api/v1/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Migrations are NOT run on boot: production refuses to start with
# AULA_AUTO_MIGRATE enabled, because applying generated DDL on every container
# start is a deploy step wearing a startup flag. Run `npm run migrate` as its own
# step in the deployment.
CMD ["npm", "run", "start"]
