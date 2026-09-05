# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS builder
WORKDIR /app
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY prisma ./prisma
# Preferir `npm ci` (lockfile). Retry + backoff: postinstall do `ffmpeg-static`
# baixa binário do GitHub Releases e intermitentemente responde 504 (#1120/#1121).
# `--legacy-peer-deps`: conflito conhecido entre `@hookform/resolvers@5.x`
# (peerOptional valibot@^1) e `valibot@0.39` (fixado via @typeschema/valibot).
RUN --mount=type=cache,target=/root/.npm \
    ( npm ci --no-audit --no-fund --legacy-peer-deps \
   || (echo "[npm ci] falhou — retry 1/5 em 20s..." && sleep 20 && npm ci --no-audit --no-fund --legacy-peer-deps) \
   || (echo "[npm ci] falhou — retry 2/5 em 40s..." && sleep 40 && npm ci --no-audit --no-fund --legacy-peer-deps) \
   || (echo "[npm ci] falhou — retry 3/5 em 60s..." && sleep 60 && npm ci --no-audit --no-fund --legacy-peer-deps) \
   || (echo "[npm ci] falhou — fallback npm install em 30s..." && sleep 30 && npm install --no-audit --no-fund --legacy-peer-deps) \
   || (echo "[npm install] falhou — retry final em 90s..." && sleep 90 && npm install --no-audit --no-fund --legacy-peer-deps) )

COPY . .
# Pasta `public` pode não existir no clone (vazia não vai pro Git); o runner precisa dela.
RUN mkdir -p public
ENV NEXT_TELEMETRY_DISABLED=1
RUN npx prisma generate
# Cache do .next/cache (webpack incremental) -- corta 50-70% do build em
# rebuilds. Requer BuildKit (padrao no docker/build-push-action).
RUN --mount=type=cache,target=/app/.next/cache \
    npm run build
# Workers BullMQ: compilar TS → JS standalone (CJS) com esbuild. Não usamos
# `tsx` em prod porque o `.next/standalone` (único node_modules copiado pro
# runner) não inclui o `tsx` — ele só está no node_modules de dev/build.
# Ver scripts/build-workers.mjs para os entry points compilados.
RUN npm run build:workers

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
# User `nextjs` sem HOME quebra `npx`/npm cache; Prisma CLI usa HOME em runtime.
ENV HOME=/tmp
ENV NPM_CONFIG_CACHE=/tmp/.npm

RUN apt-get update -y && apt-get install -y --no-install-recommends \
      openssl ca-certificates gosu ffmpeg \
    && rm -rf /var/lib/apt/lists/*
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
# Runtime: engines + client (standalone já traz parte do @prisma; isto completa).
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
# Workers compilados (campaign-worker.js, campaigns-worker.js, leads-worker.js,
# distribution-worker.js, …). Executados com `node dist/workers/<name>.js`
# conforme APP_MODE no docker-entrypoint.sh.
COPY --from=builder /app/dist/workers ./dist/workers
# Scripts de manutencao/seed rodados manualmente no console do container
# (ex.: `node scripts/seed-consultores-eduit.mjs`). Nao entram no runtime
# normal; usam o @prisma/client e bcryptjs ja presentes no runner.
COPY --from=builder /app/scripts ./scripts
# CLI: não copiar só `node_modules/prisma` — `@prisma/config` exige `effect`, `c12`, … hoistados.
ARG PRISMA_VERSION=6.19.3
RUN mkdir -p /opt/prisma-cli \
  && cd /opt/prisma-cli \
  && npm install prisma@${PRISMA_VERSION} --omit=dev --no-audit --no-fund \
  && chown -R nextjs:nodejs /opt/prisma-cli

COPY docker-entrypoint.sh /app/docker-entrypoint.sh
RUN chmod +x /app/docker-entrypoint.sh \
  && mkdir -p /tmp/.npm \
  && chown -R nextjs:nodejs /tmp

# PR storage-fix: pre-criar /app/storage com ownership nextjs ANTES do
# volume ser montado. Em volumes Docker novos, isso herda a ownership.
# Em volumes existentes (criados antes deste fix), o entrypoint corrige
# em runtime via `gosu` (ver docker-entrypoint.sh).
RUN mkdir -p /app/storage \
  && chown -R nextjs:nodejs /app/storage \
  && chmod -R 0775 /app/storage

# IMPORTANTE: não setamos `USER nextjs` aqui. O entrypoint começa como
# root para conseguir corrigir a ownership de `/app/storage` (o volume
# do EasyPanel pode ter sido criado como root). Depois ele faz drop pra
# nextjs via `gosu` antes de executar `node server.js`.
EXPOSE 3000
ENTRYPOINT ["/app/docker-entrypoint.sh"]
