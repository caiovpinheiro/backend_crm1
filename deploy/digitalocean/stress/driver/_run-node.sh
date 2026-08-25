#!/bin/bash
# Wrapper: roda um script .mjs do driver dentro da rede do stack com PG/Redis.
# Uso: bash /opt/crm/stress/driver/_run-node.sh <script.mjs> [args...]
set -e
cd /opt/crm
RAW=$(grep -E '^DATABASE_URL=' .env | cut -d= -f2-)
PG=$(printf '%s' "$RAW" | sed 's/[&?]sslcert=[^&]*//g; s/[?&]$//')
REDIS=$(grep -E '^REDIS_URL=' .env | cut -d= -f2-)
SCRIPT="$1"; shift
docker run --rm --network crm1_default \
  -v /opt/crm/stress/driver:/w -w /w \
  -v /opt/crm/certs:/certs:ro \
  -e NODE_EXTRA_CA_CERTS=/certs/do-ca.crt \
  -e PG_URL="$PG" -e REDIS_URL="$REDIS" \
  -e RUN_ID="${RUN_ID:-sa0}" \
  node:22-bookworm-slim node "$SCRIPT" "$@"
