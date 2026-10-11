# syntax=docker/dockerfile:1
# worker（帳票 PDF・outbox 配送。WORKER_MODE=http で POST /run）。Cloud Run 用。ビルドコンテキストはリポジトリルート。
#   docker build -f apps/worker/Dockerfile -t <image> .
# PDF 化は Playwright の headless Chromium（開発と同じ版）。日本語フォントは同梱の Noto Sans JP（@fontsource）を使う。
FROM node:22-slim
RUN corepack enable && corepack prepare pnpm@9.15.0 --activate
WORKDIR /repo
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/domain/package.json packages/domain/package.json
COPY packages/application/package.json packages/application/package.json
COPY packages/docstore/package.json packages/docstore/package.json
COPY packages/contracts/package.json packages/contracts/package.json
COPY packages/ui/package.json packages/ui/package.json
COPY packages/config/package.json packages/config/package.json
RUN pnpm install --frozen-lockfile --filter "@inspexor/worker..."
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN cd apps/worker && ./node_modules/.bin/playwright-core install --with-deps --only-shell chromium && rm -rf /var/lib/apt/lists/*
COPY tsconfig.base.json ./
COPY packages packages
COPY apps/worker apps/worker
WORKDIR /repo/apps/worker
ENV NODE_ENV=production WORKER_MODE=http PORT=8080
USER node
EXPOSE 8080
CMD ["node", "--import", "tsx", "src/index.ts"]
