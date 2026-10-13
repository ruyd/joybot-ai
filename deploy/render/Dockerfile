# JoyBot API + worker in one image, for a single Render web service (free plan: no background
# workers). Not used by AWS, which runs apps/api/Dockerfile and apps/worker/Dockerfile separately.
# Build from the repo root:
#   docker build -f deploy/render/Dockerfile -t joybot/render:dev .
FROM node:22-bookworm-slim AS build
RUN npm install -g pnpm@12.10.1
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/db/package.json packages/db/
COPY packages/access/package.json packages/access/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY cloudformation/functions/package.json cloudformation/functions/
RUN pnpm install --frozen-lockfile --filter "@joybot/api..." --filter "@joybot/worker..."
COPY packages/db packages/db
COPY packages/access packages/access
COPY apps/api apps/api
COPY apps/worker apps/worker
RUN pnpm --filter "@joybot/api..." --filter "@joybot/worker..." build
# Self-contained production bundles for each app.
RUN pnpm --filter @joybot/api deploy --prod /out/api && pnpm --filter @joybot/worker deploy --prod /out/worker

FROM node:22-bookworm-slim
# The database CA comes from the environment (DB_SSL=true + DB_SSL_CA), not the image.
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out ./
COPY --chown=node:node deploy/render/start.mjs ./start.mjs
USER node
EXPOSE 10000
CMD ["node", "start.mjs"]
