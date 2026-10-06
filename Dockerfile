# syntax=docker/dockerfile:1

FROM node:22-bookworm-slim AS builder
WORKDIR /app
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY prisma ./prisma
# SheetJS versionado no repo (`xlsx` = file:vendor/xlsx-0.20.3.tgz): o
# `npm ci` precisa do tarball antes do `COPY . .`.
COPY vendor ./vendor
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
# Só o que o `migrate deploy` do entrypoint usa: schema + migrations. Seeds e
# SQL avulso (prisma/scripts, prisma/manual) ficam fora da imagem.
COPY --from=builder /app/prisma/schema.prisma ./prisma/schema.prisma
COPY --from=builder /app/prisma/migrations ./prisma/migrations
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
# Runtime: engines + client (standalone já traz parte do @prisma; isto completa).
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma
# Leitura de PDF dos materiais: o rastreio do standalone não segue o import
# dinâmico do worker do pdf.js; copia os pacotes inteiros.
COPY --from=builder /app/node_modules/pdf-parse ./node_modules/pdf-parse
COPY --from=builder /app/node_modules/pdfjs-dist ./node_modules/pdfjs-dist
# Workers compilados (campaign-worker.js, …, baileys/index.js).
# Executados com `node dist/workers/<name>.js` conforme APP_MODE.
COPY --from=builder /app/dist/workers ./dist/workers
# Da pasta scripts/ só entra o que roda na imagem: o HEALTHCHECK, os
# wrappers `ops-*.mjs` (chamam a API local com o CRON_SECRET do container,
# sem credencial própria) e os backfills `backfill-*.mjs` (completam colunas
# novas depois de uma migration; usam o DATABASE_URL do container:
# `node scripts/backfill-<nome>.mjs`). Seeds, diagnósticos e scripts
# destrutivos não vão para produção — rode-os de um checkout com DATABASE_URL.
# O .dockerignore já tira o resto do contexto de build.
COPY --from=builder /app/scripts/healthcheck.mjs /app/scripts/ops-*.mjs /app/scripts/backfill-*.mjs ./scripts/
# `pg` inteiro para os backfills (`import { Client } from "pg"`). O standalone
# só traz o que o servidor carrega por `require` (`pg/lib/*`); o `import`
# resolve pelo `exports` do pacote para `pg/esm/index.mjs`, que o rastreio não
# copia — sem isto o backfill morre em ERR_MODULE_NOT_FOUND. Copia o pacote e
# as dependências de runtime (lockfile: pg 8.x; `pg-types` traz o seu
# `postgres-array` aninhado). `pg-cloudflare` (opcional) só carrega no runtime
# da Cloudflare; `pg-native` não é instalado. Mesmas versões do standalone: só
# completa os arquivos que o rastreio deixou de fora.
RUN --mount=type=bind,from=builder,source=/app/node_modules,target=/tmp/nm \
    mkdir -p /app/node_modules \
 && for p in pg pg-connection-string pg-pool pg-protocol pg-types pgpass \
             pg-int8 postgres-array postgres-bytea postgres-date postgres-interval \
             split2 xtend; do \
      rm -rf "/app/node_modules/$p" && cp -a "/tmp/nm/$p" /app/node_modules/ || exit 1; \
    done
# Falha o build se um backfill não conseguir carregar o `pg` (ex.: o pg ganhou
# dependência nova e a lista acima ficou velha). `pgpass` é carregado só na
# conexão sem senha; importá-lo aqui puxa o `split2`.
RUN cd /app/scripts \
 && node --input-type=module -e 'import { Client } from "pg"; import "pgpass"; if (typeof Client !== "function") process.exit(1);'
# CLI: não copiar só `node_modules/prisma` — `@prisma/config` exige `effect`, `c12`, … hoistados.
ARG PRISMA_VERSION=6.19.3
RUN mkdir -p /opt/prisma-cli \
  && cd /opt/prisma-cli \
  && npm install prisma@${PRISMA_VERSION} --omit=dev --no-audit --no-fund \
  && chown -R nextjs:nodejs /opt/prisma-cli \
  # Disponibiliza `prisma` e `npx prisma` dentro do container manualmente.
  && mkdir -p /app/node_modules \
  && ln -s /opt/prisma-cli/node_modules/.bin/prisma /usr/local/bin/prisma \
  && ln -s /opt/prisma-cli/node_modules/prisma /app/node_modules/prisma

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

# SHA do commit que gerou a imagem (build arg do workflow Build & Deploy).
# Fica no FIM do estágio de propósito: o valor muda a cada build e, aqui,
# só invalida estas camadas minúsculas — npm ci / next build seguem em cache.
#   - ENV GIT_SHA: lido pelo detalhe protegido de /api/health;
#   - /app/BUILD_SHA: o entrypoint loga no boot e usa para corrigir um
#     GIT_SHA fixo herdado do painel (env de runtime vence ENV da imagem);
#   - label OCI: `docker inspect` mostra o commit sem subir o container.
# Build local sem o arg: "unknown".
ARG GIT_SHA=unknown
ENV GIT_SHA=${GIT_SHA}
LABEL org.opencontainers.image.revision="${GIT_SHA}"
RUN printf '%s' "${GIT_SHA}" > /app/BUILD_SHA

# IMPORTANTE: não setamos `USER nextjs` aqui. O entrypoint começa como
# root para conseguir corrigir a ownership de `/app/storage` (o volume
# do EasyPanel pode ter sido criado como root). Depois ele faz drop pra
# nextjs via `gosu` antes de executar `node server.js`.
EXPOSE 3000
# Mesma imagem para API e workers: o script decide pelo APP_MODE (API faz
# GET /api/health; worker sai 0 — não tem HTTP). start-period de 300 s porque
# a API roda `migrate deploy` no boot. Sem curl na imagem: usa o fetch do node.
# Em compose com `healthcheck:` próprio, o do serviço substitui este.
HEALTHCHECK --interval=30s --timeout=5s --start-period=300s --retries=3 \
  CMD ["node", "/app/scripts/healthcheck.mjs"]
ENTRYPOINT ["/app/docker-entrypoint.sh"]
