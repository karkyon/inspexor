# syntax=docker/dockerfile:1
# Cloud Run向け軽量イメージ。ビルドコンテキストはリポジトリルートを指定すること。
#   docker build -f apps/worker/Dockerfile -t <image> .
FROM node:22-slim AS base
RUN corepack enable
WORKDIR /repo

FROM base AS deps
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml* ./
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/application/package.json packages/application/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/ui/package.json packages/ui/package.json
COPY packages/config/package.json packages/config/package.json
RUN pnpm install --frozen-lockfile || pnpm install

FROM deps AS build
COPY . .
RUN pnpm --filter @inspexor/worker... build

FROM node:22-slim AS runner
RUN corepack enable
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /repo /app
CMD ["node", "apps/worker/dist/index.js"]
