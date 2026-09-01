#!/bin/sh
set -e
cd /app

STORAGE_DIR="${STORAGE_ROOT:-/app/storage}"

# Fase 1 — root: conserta ownership de /app/storage e re-executa como
# nextjs via gosu. Isso resolve o caso em que o EasyPanel cria o volume
# (Docker named volume) como root-owned. Sem isso, o processo nextjs
# (UID 1001) recebe EACCES ao gravar mídia inbound do WhatsApp e o
# saveFile() falha silenciosamente.
#
# Re-execução: gosu troca o euid pra nextjs:nodejs e volta a executar
# este mesmo script. Na segunda passada o `id -u` já não é 0 e o bloco
# abaixo é pulado.
if [ "$(id -u)" = "0" ]; then
  echo "[entrypoint] root: ajustando ownership de $STORAGE_DIR (uid=1001 nextjs)"
  mkdir -p "$STORAGE_DIR" 2>/dev/null || true
  chown -R nextjs:nodejs "$STORAGE_DIR" 2>/dev/null || \
    echo "[entrypoint] !! aviso: chown $STORAGE_DIR falhou (sistema readonly?)"
  chmod -R u+rwX,g+rwX "$STORAGE_DIR" 2>/dev/null || true
  exec gosu nextjs:nodejs "$0" "$@"
fi

echo "[entrypoint] iniciando backend CRM ($(date -u +'%Y-%m-%dT%H:%M:%SZ')) — user=$(id -un) uid=$(id -u)"

# Carrega /app/.env se o Easypanel/usuário tiver montado o arquivo.
#
# Por que precisamos disso?
#   O Easypanel oferece um toggle "Create .env file" que, quando ligado,
#   CRIA um arquivo /app/.env com as variáveis declaradas no painel
#   "Environment Variables" — MAS não injeta essas variáveis como
#   process.env do container. O Next.js standalone (server.js) carrega
#   esse .env internamente via @next/env (loadEnvConfig), por isso o
#   `APP_MODE=api` funciona mesmo sem essa linha.
#
#   Os workers compilados com esbuild (`node dist/workers/<name>.js`)
#   NÃO carregam o .env — process.env.DATABASE_URL fica undefined, pg
#   cai no default `localhost:5432` e o worker quebra com
#   "Can't reach database server at 127.0.0.1:5432" a cada job.
#
#   Sourcing aqui (set -a + .) garante que TODAS as linhas KEY=value
#   do .env virem env vars do shell, e o `exec node ...` herda. É
#   idempotente: se o Next.js já leu o .env, não atrapalha (process.env
#   apenas tem os mesmos valores). Em ambientes onde o Easypanel injeta
#   tudo como runtime env (toggle desligado), o .env não existe e o
#   bloco é pulado.
if [ -f /app/.env ]; then
  echo "[entrypoint] sourcing /app/.env (env vars do Easypanel via arquivo)"
  set -a
  # shellcheck disable=SC1091
  . /app/.env
  set +a
fi

# Smoke test: confirma que $STORAGE_DIR está gravável depois do drop.
if touch "$STORAGE_DIR/.write-test" 2>/dev/null; then
  rm -f "$STORAGE_DIR/.write-test"
  echo "[entrypoint] storage OK — gravável em $STORAGE_DIR"
else
  echo "[entrypoint] !! ERRO: $STORAGE_DIR NÃO É GRAVÁVEL pelo user $(id -un)."
  echo "[entrypoint] !! Mídia inbound do WhatsApp vai falhar silenciosamente."
  echo "[entrypoint] !! Verifique se gosu chown rodou na fase root acima."
fi

APP_MODE="${APP_MODE:-api}"
echo "[entrypoint] APP_MODE=${APP_MODE}"

# Migrations Prisma: rodam APENAS em APP_MODE=api. Workers no mesmo deploy
# (worker-whatsapp, worker-leads) sobem em paralelo à API e podem ter race
# condition se também tentarem aplicar migrations — basta um serviço aplicar.
# Por isso o branch abaixo é restrito a APP_MODE=api.
if [ "$APP_MODE" = "api" ]; then
  if [ -n "${SKIP_PRISMA_MIGRATE}" ]; then
    echo "[entrypoint] SKIP_PRISMA_MIGRATE set — pulando migrate deploy."
  elif [ -z "${DATABASE_URL}" ]; then
    echo "[entrypoint] DATABASE_URL vazio — pulando migrate deploy."
  else
    echo "[entrypoint] prisma migrate deploy..."
    if ! node /opt/prisma-cli/node_modules/prisma/build/index.js \
          migrate deploy --schema=prisma/schema.prisma; then
      echo "[entrypoint] migrate deploy falhou — tentando aplicar migrations
              manualmente via 'db execute' nos arquivos .sql..."
      # Fallback defensivo: aplica cada migration.sql na ordem. Idempotente
      # porque os scripts usam IF NOT EXISTS / DO blocks.
      for f in prisma/migrations/*/migration.sql; do
        echo "[entrypoint]   aplicando $f"
        node /opt/prisma-cli/node_modules/prisma/build/index.js \
          db execute --schema=prisma/schema.prisma --file "$f" || \
          echo "[entrypoint]   (warning) falha aplicando $f, prosseguindo"
      done

      # Gate final: reexecuta migrate deploy como verificação. Se AINDA
      # falhar, o schema está fora de sincronia com o Prisma Client e subir
      # o app resultaria em 500 silencioso em runtime (P2022 "column does
      # not exist") — foi a causa do incidente de 23/07 (modelos internos).
      # Abortar aqui torna o problema VISÍVEL no deploy, em vez de vazar
      # pro usuário. Para casos excepcionais, use SKIP_PRISMA_MIGRATE.
      echo "[entrypoint] revalidando migrations (gate de boot)..."
      if ! node /opt/prisma-cli/node_modules/prisma/build/index.js \
            migrate deploy --schema=prisma/schema.prisma; then
        echo "[entrypoint] !! ERRO FATAL: migrations não aplicadas — abortando boot."
        echo "[entrypoint] !! O schema do banco está atrás do código. Aplique as"
        echo "[entrypoint] !! migrations pendentes e reinicie (ou SKIP_PRISMA_MIGRATE=1"
        echo "[entrypoint] !! para forçar boot sob sua responsabilidade)."
        exit 1
      fi
    fi
  fi
else
  echo "[entrypoint] APP_MODE=${APP_MODE} — pulando migrations (somente API roda migrate)."
fi

# Roteamento APP_MODE → processo a iniciar.
#
# - api                 → Next.js (sessão do operador). Único que aplica migrate.
# - api-public          → Next.js irmão (Bearer / n8n). Mesma imagem, sem
#                         migrate e sem sweepers (sse-bus só sobe em APP_MODE=api).
#                         Isola event loop + pool Prisma da inbox. EasyPanel:
#                         clone do serviço API, APP_MODE=api-public. No compose
#                         DO, o Caddy manda `Authorization: Bearer` pra cá.
# - worker-whatsapp     → inbox Meta: meta-attach + meta-outbound + sweepers
#                         de sessão/presença/agendadas/IA/push (campaign-worker.ts)
# - worker-campaigns    → disparo de campanha CRM: campaign-dispatch, rodízio
#                         Postgres (ou campaign-send se CAMPAIGN_SEND_ROUND_ROBIN=0)
#                         e sweeps de campanha travada / recipients stale
# - worker-leads        → worker BullMQ que consome leads-bulk
#                         (operações em massa de Deals com BulkOperation tracking)
# - worker-distribution → worker BullMQ que consome distribution-drain
#                         (processPending da fila de espera da Distribuição)
# - worker-etl          → worker BullMQ que consome import-etl
# - worker-automation   → worker BullMQ que consome automation-jobs (Salesbot/automações)
#
# Workers são compilados via esbuild (npm run build:workers) e copiados para
# /app/dist/workers no Dockerfile runner stage. Executar com `node` direto.
case "$APP_MODE" in
  worker-*)
    echo "[entrypoint] worker sem HTTP — EasyPanel: desligar Tempo de inatividade zero (senão SIGTERM em ~2–4s)."
    ;;
esac
case "$APP_MODE" in
  api)
    echo "[entrypoint] starting Next.js standalone server..."
    exec node server.js
    ;;
  api-public)
    echo "[entrypoint] starting Next.js public API (Bearer/n8n, sem migrate)..."
    exec node server.js
    ;;
  worker-whatsapp)
    echo "[entrypoint] starting WhatsApp inbox worker (meta-attach + meta-outbound)..."
    exec node dist/workers/campaign-worker.js
    ;;
  worker-campaigns)
    echo "[entrypoint] starting campaigns worker (dispatch + rodízio)..."
    exec node dist/workers/campaigns-worker.js
    ;;
  worker-leads)
    echo "[entrypoint] starting Leads worker..."
    exec node dist/workers/leads-worker.js
    ;;
  worker-distribution)
    echo "[entrypoint] starting Distribution drain worker..."
    exec node dist/workers/distribution-worker.js
    ;;
  worker-etl)
    echo "[entrypoint] starting ETL worker (import-etl)..."
    exec node dist/workers/etl-worker.js
    ;;
  worker-automation)
    echo "[entrypoint] starting Automations worker (automation-jobs)..."
    exec node dist/workers/automation-worker.js
    ;;
  worker-meta-webhook)
    echo "[entrypoint] starting Meta Webhook worker (meta-webhook-events)..."
    exec node dist/workers/meta-webhook-worker.js
    ;;
  *)
    echo "[entrypoint] !! ERRO: APP_MODE='${APP_MODE}' não reconhecido."
    echo "[entrypoint] !! Valores válidos: api | api-public | worker-whatsapp | worker-campaigns | worker-leads | worker-distribution | worker-etl | worker-automation | worker-meta-webhook"
    exit 1
    ;;
esac
