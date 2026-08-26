#!/usr/bin/env bash
# Gera a CA local e o certificado do mock da Graph, e acrescenta a CA ao
# bundle que os containers do backend já confiam via NODE_EXTRA_CA_CERTS.
#
# Idempotente: só regera se os arquivos não existirem, e só concatena a CA
# no bundle se ela ainda não estiver lá.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CERTS="$DIR/certs"
BUNDLE="$DIR/../certs/do-ca.crt"

mkdir -p "$CERTS"

if [ ! -f "$CERTS/mock-ca.crt" ]; then
  echo "[prepare-mock] gerando CA local..."
  openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
    -keyout "$CERTS/mock-ca.key" -out "$CERTS/mock-ca.crt" \
    -subj "/CN=Stress Test Local CA" 2>/dev/null
fi

if [ ! -f "$CERTS/mock.crt" ]; then
  echo "[prepare-mock] emitindo certificado para os hosts da Meta..."
  cat > "$CERTS/san.cnf" <<'EOF'
[req]
distinguished_name = dn
[dn]
[ext]
subjectAltName = @alt
basicConstraints = CA:FALSE
keyUsage = digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
[alt]
DNS.1 = graph.facebook.com
DNS.2 = *.facebook.com
DNS.3 = graph.instagram.com
DNS.4 = *.instagram.com
DNS.5 = lookaside.fbsbx.com
DNS.6 = *.fbsbx.com
DNS.7 = mock-graph
DNS.8 = localhost
EOF
  openssl req -newkey rsa:2048 -nodes \
    -keyout "$CERTS/mock.key" -out "$CERTS/mock.csr" \
    -subj "/CN=graph.facebook.com" 2>/dev/null
  openssl x509 -req -in "$CERTS/mock.csr" \
    -CA "$CERTS/mock-ca.crt" -CAkey "$CERTS/mock-ca.key" -CAcreateserial \
    -out "$CERTS/mock.crt" -days 3650 \
    -extfile "$CERTS/san.cnf" -extensions ext 2>/dev/null
  rm -f "$CERTS/mock.csr"
fi

chmod 644 "$CERTS"/*.crt "$CERTS"/*.key

if [ ! -f "$BUNDLE" ]; then
  echo "[prepare-mock] ERRO: bundle $BUNDLE não existe. Rode o setup da DigitalOcean primeiro." >&2
  exit 1
fi

if ! grep -qF "$(sed -n '2p' "$CERTS/mock-ca.crt")" "$BUNDLE"; then
  echo "[prepare-mock] acrescentando a CA local ao bundle do NODE_EXTRA_CA_CERTS..."
  cp "$BUNDLE" "$BUNDLE.bak.$(date +%s)"
  printf '\n' >> "$BUNDLE"
  cat "$CERTS/mock-ca.crt" >> "$BUNDLE"
else
  echo "[prepare-mock] CA local já presente no bundle."
fi

echo "[prepare-mock] pronto."
openssl x509 -in "$CERTS/mock.crt" -noout -subject -ext subjectAltName
