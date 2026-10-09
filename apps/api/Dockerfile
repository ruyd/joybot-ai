# JoyBot API image (linux/arm64 for Graviton; linux/amd64 also works). Build from the repo root:
#   docker build -f apps/api/Dockerfile -t joybot/api:dev .
FROM node:22-bookworm-slim AS build
RUN npm install -g pnpm@12.10.1
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/db/package.json packages/db/
COPY packages/access/package.json packages/access/
COPY apps/api/package.json apps/api/
COPY apps/worker/package.json apps/worker/
COPY cloudformation/functions/package.json cloudformation/functions/
RUN pnpm install --frozen-lockfile --filter "@joybot/api..."
COPY packages/db packages/db
COPY packages/access packages/access
COPY apps/api apps/api
RUN pnpm --filter "@joybot/api..." build
# Self-contained production bundle: apps/api + workspace dependencies + prod node_modules.
RUN pnpm --filter @joybot/api deploy --prod /out

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    NODE_EXTRA_CA_CERTS=/opt/rds/global-bundle.pem \
    PORT=3000
# Amazon RDS CA bundle, so TLS to Aurora is verified (DB_SSL=true).
ADD --chmod=0644 https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /opt/rds/global-bundle.pem
RUN chmod 0755 /opt/rds
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
