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

# SHA do commit da imagem. O Dockerfile grava /app/BUILD_SHA a partir do
# build arg GIT_SHA (workflow Build & Deploy). Um GIT_SHA fixo no painel
# (ou no /app/.env) vence o ENV da imagem e ficava igual em todos os
# serviços, de todos os deploys — aqui o valor da IMAGEM prevalece e sai no
# log de boot de cada serviço (API e workers).
# (Bloco entre os marcadores é exercitado por src/lib/docker-entrypoint.test.ts.)
# >>> build-sha
BUILD_SHA_FILE="${BUILD_SHA_FILE:-/app/BUILD_SHA}"
if [ -s "$BUILD_SHA_FILE" ]; then
  IMAGE_GIT_SHA="$(tr -d '[:space:]' < "$BUILD_SHA_FILE")"
  if [ -n "$IMAGE_GIT_SHA" ] && [ "$IMAGE_GIT_SHA" != "unknown" ]; then
    if [ -n "${GIT_SHA}" ] && [ "${GIT_SHA}" != "unknown" ] && [ "${GIT_SHA}" != "$IMAGE_GIT_SHA" ]; then
      echo "[entrypoint] aviso: GIT_SHA do ambiente (${GIT_SHA}) difere do da imagem — usando o da imagem. Remova a variável fixa do painel."
    fi
    GIT_SHA="$IMAGE_GIT_SHA"
    export GIT_SHA
  fi
fi
echo "[entrypoint] build: GIT_SHA=${GIT_SHA:-unknown}"
# <<< build-sha

# Gate de criptografia. A chave de provedor de IA por agente é gravada em
# AES-256-GCM com chave derivada de ENCRYPTION_KEY → NEXTAUTH_SECRET →
# AUTH_SECRET (src/lib/secret-crypto.ts).
#
# Um processo sem nenhuma dessas variáveis sobe normal e só falha quando
# tenta LER um segredo — e o auth tag inválido produz um erro genérico que
# aponta pro lugar errado ("re-cadastre a chave"). Foi o que aconteceu com
# o worker da IA em DEV: a API tinha NEXTAUTH_SECRET, o worker não, e todo
# run morria em "chave OpenAI não pôde ser lida".
#
# Logar aqui torna o env var faltando visível no deploy, mas este guard
# NÃO derruba o boot. O segredo cobre apenas os blobs de
# secret-crypto.ts (chave de provedor de IA por agente). Sem ele o inbox
# continua funcionando: token de canal Meta e MFA vêm de crypto/secrets.ts,
# que usa KEYRING_SECRET — variável separada e presente nos workers.
#
# Já derrubamos DEV duas vezes tratando isso como fatal. Na segunda, o
# EasyPanel redeployou os serviços a partir do spec dele e apagou o
# NEXTAUTH_SECRET adicionado à mão via `docker service update --env-add`;
# worker-whatsapp, worker-meta-webhook e worker-automation ficaram 0/1 e o
# inbox parou de receber e enviar (meta-webhook-events e meta-outbound sem
# consumidor). Degradar uma feature de IA vale um aviso, não uma parada.
#
# Para tratar como fatal (ex.: ambiente onde a IA é obrigatória):
# REQUIRE_ENCRYPTION_KEY=1.
case "$APP_MODE" in
  api|api-public|worker-automation|worker-whatsapp|worker-meta-webhook)
    CRYPTO_USED=1 ;;
  *)
    CRYPTO_USED= ;;
esac

if [ -z "${ENCRYPTION_KEY}" ] && [ -z "${NEXTAUTH_SECRET}" ] && [ -z "${AUTH_SECRET}" ]; then
  if [ -z "${CRYPTO_USED}" ]; then
    echo "[entrypoint] aviso: sem segredo de criptografia (não usado em ${APP_MODE})."
  elif [ -n "${REQUIRE_ENCRYPTION_KEY}" ]; then
    echo "[entrypoint] !! ERRO FATAL: nenhum segredo de criptografia definido"
    echo "[entrypoint] !! e REQUIRE_ENCRYPTION_KEY=1. Abortando."
    exit 1
  else
    echo "[entrypoint] !! AVISO: nenhum segredo de criptografia definido em ${APP_MODE}."
    echo "[entrypoint] !! Chaves de API de IA gravadas por outro serviço não poderão"
    echo "[entrypoint] !! ser lidas ('chave OpenAI não pôde ser lida'). Inbox e canais"
    echo "[entrypoint] !! Meta seguem normais (usam KEYRING_SECRET)."
    echo "[entrypoint] !! Corrija replicando NEXTAUTH_SECRET (mesmo valor da API) neste"
    echo "[entrypoint] !! serviço — pelo painel, não por 'docker service update', que o"
    echo "[entrypoint] !! próximo redeploy apaga."
    echo "[entrypoint] !! Cuidado: ENCRYPTION_KEY também é lido por crypto/secrets.ts,"
    echo "[entrypoint] !! que exige base64 de 32 bytes. Só use ENCRYPTION_KEY se"
    echo "[entrypoint] !! KEYRING_SECRET estiver setado ou o valor for 'openssl rand -base64 32'."
  fi
else
  # Fingerprint (não reversível) do segredo em uso. Serviços que logam fp
  # diferente não conseguem ler os segredos um do outro.
  echo "[entrypoint] cripto: $(node -e 'const c=require("node:crypto");const s=(process.env.ENCRYPTION_KEY||process.env.NEXTAUTH_SECRET||process.env.AUTH_SECRET).trim();const v=process.env.ENCRYPTION_KEY?"ENCRYPTION_KEY":process.env.NEXTAUTH_SECRET?"NEXTAUTH_SECRET":"AUTH_SECRET";console.log(v+" fp="+c.createHash("sha256").update(s).digest("hex").slice(0,12))')"

  # ENCRYPTION_KEY é alias de KEYRING_SECRET em src/lib/crypto/secrets.ts,
  # que exige 32 bytes em base64. Um valor arbitrário aqui derruba canais
  # Meta / MFA sem relação aparente com o que foi mudado.
  if [ -n "${ENCRYPTION_KEY}" ] && [ -z "${KEYRING_SECRET}" ]; then
    if [ "$(printf %s "${ENCRYPTION_KEY}" | base64 -d 2>/dev/null | wc -c)" != "32" ]; then
      echo "[entrypoint] !! aviso: ENCRYPTION_KEY não decodifica em 32 bytes e KEYRING_SECRET"
      echo "[entrypoint] !! está vazio — tokens de canal e MFA vão falhar. Defina KEYRING_SECRET."
    fi
  fi
fi

# Migrations Prisma: rodam APENAS em APP_MODE=api. Workers no mesmo deploy
# (worker-whatsapp, worker-leads) sobem em paralelo à API e podem ter race
# condition se também tentarem aplicar migrations — basta um serviço aplicar.
# Por isso o branch abaixo é restrito a APP_MODE=api.
#
# RUN_MIGRATIONS_ON_BOOT (default ligado): desligue (0/false/no/off) quando a
# API tiver mais de uma réplica ou quando o operador aplicar as migrations à
# mão / por job antes do deploy. Com ela desligada nenhum processo migra no
# boot. O `migrate deploy` do Prisma já serializa execuções concorrentes com
# lock consultivo (pg_advisory_lock(72707369), timeout de 10 s → erro P1002),
# então duas réplicas não aplicam a mesma migration — mas a que perde o lock
# não sobe (exit 1) e fica reiniciando até a outra terminar.
#
# Falha do `migrate deploy` = boot abortado (exit 1), com o nome da migration
# no log. Não há reexecução automática: o fallback antigo rodava TODAS as
# migrations de novo com `db execute`, ignorando erros (UPDATE de tabela
# inteira, recriação de índice). Recuperação de migration marcada como falha
# (P3009/P3018) é manual — ver mensagem abaixo e docs/deploy-seguro.md.
#
# SKIP_PRISMA_MIGRATE: só pula quando o VALOR é afirmativo (1/true/yes/on).
# Antes o teste era `[ -n ... ]` (variável existe?), então SKIP_PRISMA_MIGRATE=0
# ou =false também pulava — em produção isso já deixou migration sem aplicar.
# Vazio, ausente, 0, false, no, off ou qualquer outro valor → roda o migrate.
# (Bloco entre os marcadores é exercitado por src/lib/docker-entrypoint.test.ts.)
# >>> skip-prisma-migrate
should_skip_prisma_migrate() {
  case "${SKIP_PRISMA_MIGRATE:-0}" in
    1|true|TRUE|True|yes|YES|Yes|on|ON|On) return 0 ;;
    *) return 1 ;;
  esac
}
# <<< skip-prisma-migrate
# >>> boot-migrations
# RUN_MIGRATIONS_ON_BOOT: só DESLIGA com valor negativo explícito. Ausente,
# vazio ou qualquer outro valor → liga (comportamento histórico da API).
should_run_migrations_on_boot() {
  case "${RUN_MIGRATIONS_ON_BOOT:-1}" in
    0|false|FALSE|False|no|NO|No|off|OFF|Off) return 1 ;;
    *) return 0 ;;
  esac
}

PRISMA_CLI="${PRISMA_CLI:-node /opt/prisma-cli/node_modules/prisma/build/index.js}"

# Uma única execução do `migrate deploy`, com a saída ao vivo no log. Falhou →
# imprime a(s) migration(s) citadas pelo Prisma e o caminho de recuperação, e
# devolve 1. Nunca reaplica SQL por fora do Prisma.
run_boot_migrate_deploy() {
  _mig_log="${TMPDIR:-/tmp}/prisma-migrate-deploy.$$.log"
  _mig_rc_file="${_mig_log}.rc"
  echo "[entrypoint] prisma migrate deploy..."
  # O `|| _mig_rc=$?` isenta a falha do `set -e` dentro do pipeline.
  { _mig_rc=0; $PRISMA_CLI migrate deploy --schema=prisma/schema.prisma 2>&1 || _mig_rc=$?; echo "$_mig_rc" > "$_mig_rc_file"; } | tee "$_mig_log"
  _mig_rc="$(cat "$_mig_rc_file" 2>/dev/null || echo 1)"
  if [ "$_mig_rc" = "0" ]; then
    rm -f "$_mig_log" "$_mig_rc_file"
    return 0
  fi
  # P3018 → "Migration name: <nome>"; P3009 → "The `<nome>` migration started at … failed".
  _mig_failed="$(sed -n -E \
      -e 's/.*Migration name: ([0-9A-Za-z_]+).*/\1/p' \
      -e 's/.*The `([0-9A-Za-z_]+)` migration started at.*/\1/p' \
      "$_mig_log" 2>/dev/null | sort -u | tr '\n' ' ')"
  rm -f "$_mig_log" "$_mig_rc_file"
  echo "[entrypoint] !! ERRO FATAL: prisma migrate deploy falhou (exit ${_mig_rc}) — abortando boot."
  if [ -n "$_mig_failed" ]; then
    echo "[entrypoint] !! migration com falha: ${_mig_failed}"
  else
    echo "[entrypoint] !! migration não identificada na saída acima (P1001 banco fora, P1002 lock"
    echo "[entrypoint] !! ocupado por outra réplica, timeout de conexão...). Nada foi reaplicado."
  fi
  echo "[entrypoint] !! Nada é reexecutado automaticamente. Recuperação (manual, no diretório do backend):"
  echo "[entrypoint] !!   1. veja o erro acima e o estado da migration: ... migrate status --schema=prisma/schema.prisma"
  echo "[entrypoint] !!   2. corrija o banco (SQL que faltou, ou desfaça o parcial) e marque o desfecho:"
  echo "[entrypoint] !!      ... migrate resolve --applied <nome>      (o SQL já está no banco)"
  echo "[entrypoint] !!      ... migrate resolve --rolled-back <nome>  (desfeito; o próximo deploy reaplica)"
  echo "[entrypoint] !!   3. reinicie o serviço. (\"...\" = node /opt/prisma-cli/node_modules/prisma/build/index.js)"
  echo "[entrypoint] !! Subir sem migrar, sob sua responsabilidade: RUN_MIGRATIONS_ON_BOOT=0."
  return 1
}

# Decide e executa. 0 = seguir o boot (migrou ou pulou); 1 = abortar.
boot_migrations() {
  if [ "$APP_MODE" != "api" ]; then
    echo "[entrypoint] APP_MODE=${APP_MODE} — pulando migrations (somente API roda migrate)."
    return 0
  fi
  if should_skip_prisma_migrate; then
    echo "[entrypoint] SKIP_PRISMA_MIGRATE=${SKIP_PRISMA_MIGRATE} — pulando migrate deploy."
    return 0
  fi
  if ! should_run_migrations_on_boot; then
    echo "[entrypoint] RUN_MIGRATIONS_ON_BOOT=${RUN_MIGRATIONS_ON_BOOT} — migrations NÃO rodam no boot (aplicação manual ou job)."
    return 0
  fi
  if [ -z "${DATABASE_URL}" ]; then
    echo "[entrypoint] DATABASE_URL vazio — pulando migrate deploy."
    return 0
  fi
  run_boot_migrate_deploy
}
# <<< boot-migrations
if ! boot_migrations; then
  exit 1
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
# - worker-baileys      → WhatsApp QR (não-Meta): baileys-control + baileys-outbound
#
# Workers são compilados via esbuild (npm run build:workers) e copiados para
# /app/dist/workers no Dockerfile runner stage. Executar com `node` direto.

# HEALTHCHECK (scripts/healthcheck.mjs) roda via `docker exec` e não herda o
# que veio do /app/.env — grava o modo e a porta efetivos para ele.
printf 'APP_MODE=%s\nPORT=%s\n' "$APP_MODE" "${PORT:-3000}" \
  > "${HEALTHCHECK_STATE_FILE:-/tmp/healthcheck.env}" 2>/dev/null || \
  echo "[entrypoint] aviso: não gravei o estado do healthcheck"

case "$APP_MODE" in
  worker-*)
    echo "[entrypoint] worker sem HTTP — EasyPanel: desligar Tempo de inatividade zero (senão SIGTERM em ~2–4s)."
    ;;
esac

# Servidor Next (api / api-public). Bloco exercitado por docker-entrypoint.test.ts.
# - NEXT_MANUAL_SIG_HANDLE: o handler de SIGTERM do Next fecha o listener e
#   espera as requisições sem teto — um stream SSE prende o processo até o
#   SIGKILL. Com a variável, quem trata o sinal é src/lib/api-shutdown.ts
#   (instalado em instrumentation.ts): health 503, SSE com retry e jitter,
#   requisições em curso até 25 s. API_GRACEFUL_SHUTDOWN=0 volta ao do Next.
# - KEEP_ALIVE_TIMEOUT (lido pelo server.js do Next): keep-alive do Node maior
#   que o idle do proxy até o backend (Traefik: 90 s), senão o Node fecha a
#   conexão ociosa no meio de um POST reaproveitado → 502 esporádico.
# >>> next-server-env
if [ "$APP_MODE" = "api" ] || [ "$APP_MODE" = "api-public" ]; then
  if [ "${API_GRACEFUL_SHUTDOWN:-1}" != "0" ]; then
    export NEXT_MANUAL_SIG_HANDLE="${NEXT_MANUAL_SIG_HANDLE:-true}"
  fi
  export KEEP_ALIVE_TIMEOUT="${KEEP_ALIVE_TIMEOUT:-95000}"
  echo "[entrypoint] http: KEEP_ALIVE_TIMEOUT=${KEEP_ALIVE_TIMEOUT} NEXT_MANUAL_SIG_HANDLE=${NEXT_MANUAL_SIG_HANDLE:-}"
fi
# <<< next-server-env
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
  worker-baileys)
    echo "[entrypoint] starting Baileys worker (WhatsApp QR — baileys-control + baileys-outbound)..."
    exec node dist/workers/baileys/index.js
    ;;
  *)
    echo "[entrypoint] !! ERRO: APP_MODE='${APP_MODE}' não reconhecido."
    echo "[entrypoint] !! Valores válidos: api | api-public | worker-whatsapp | worker-campaigns | worker-leads | worker-distribution | worker-etl | worker-automation | worker-meta-webhook | worker-baileys"
    exit 1
    ;;
esac
