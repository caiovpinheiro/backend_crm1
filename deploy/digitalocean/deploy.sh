#!/usr/bin/env bash
# Deploy no droplet. Substitui o webhook do EasyPanel: puxa as imagens
# novas do GHCR e recria só os serviços que mudaram.
set -euo pipefail

cd "$(dirname "$0")"

if [ ! -f .env ]; then
  echo "!! .env não encontrado. Copie .env.example e preencha." >&2
  exit 1
fi

echo "==> pull"
docker compose pull --quiet frontend api worker-whatsapp worker-campaigns \
  worker-meta-webhook worker-automation worker-leads worker-distribution worker-etl

echo "==> up"
docker compose up -d --remove-orphans

echo "==> aguardando api ficar healthy"
for _ in $(seq 1 40); do
  status=$(docker inspect -f '{{.State.Health.Status}}' crm1-api-1 2>/dev/null || echo starting)
  [ "$status" = "healthy" ] && break
  sleep 5
done
if [ "${status:-}" != "healthy" ]; then
  echo "!! api não ficou healthy — verifique 'docker compose logs api'" >&2
  exit 1
fi

docker image prune -f >/dev/null
echo "==> ok"
docker compose ps
