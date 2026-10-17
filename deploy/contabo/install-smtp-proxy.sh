#!/usr/bin/env bash
# Instala o proxy SOCKS5 de saída SMTP (microsocks) no servidor da Contabo.
# Rodar como root NO SERVIDOR (não no droplet):
#
#   bash install-smtp-proxy.sh <IP_DO_DROPLET> <USUARIO> <SENHA> [PORTA=1080]
#
# O que faz:
#   - instala o pacote `microsocks` (Debian/Ubuntu);
#   - cria o serviço systemd `crm-smtp-socks` com AUTH usuário/senha;
#   - libera a porta no ufw SOMENTE para o IP do droplet (IPv4 público, não
#     o Reserved IP — o Reserved IP é só de entrada).
#
# Depois, no droplet (deploy/digitalocean/.env):
#   SMTP_PROXY_URL=socks5://USUARIO:SENHA@<IP_DESTE_SERVIDOR>:PORTA
#   docker compose up -d api worker-automation
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
  echo "!! rode como root" >&2
  exit 1
fi
if [ $# -lt 3 ]; then
  echo "uso: $0 <IP_DO_DROPLET> <USUARIO> <SENHA> [PORTA=1080]" >&2
  exit 1
fi

DROPLET_IP="$1"
PROXY_USER="$2"
PROXY_PASS="$3"
PROXY_PORT="${4:-1080}"

case "$PROXY_PORT" in 25|465|587)
  echo "!! use uma porta fora de 25/465/587 (a DigitalOcean dropa essas de saída)" >&2
  exit 1
esac

echo "==> instalando microsocks"
apt-get update -qq
apt-get install -y -qq microsocks ufw >/dev/null

BIN="$(command -v microsocks)"

# Credenciais ficam só no arquivo de ambiente do serviço (root, 0600), não
# na linha de comando visível no `ps`.
install -d -m 0750 /etc/crm-smtp-socks
cat > /etc/crm-smtp-socks/env <<EOF
PROXY_PORT=${PROXY_PORT}
PROXY_USER=${PROXY_USER}
PROXY_PASS=${PROXY_PASS}
EOF
chmod 0600 /etc/crm-smtp-socks/env

echo "==> criando serviço systemd crm-smtp-socks"
cat > /etc/systemd/system/crm-smtp-socks.service <<EOF
[Unit]
Description=CRM SMTP egress proxy (microsocks, SOCKS5 com AUTH)
After=network-online.target
Wants=network-online.target

[Service]
EnvironmentFile=/etc/crm-smtp-socks/env
# -1: sem "auth once" por IP — cada conexão precisa autenticar.
ExecStart=${BIN} -1 -p \${PROXY_PORT} -u \${PROXY_USER} -P \${PROXY_PASS}
Restart=always
RestartSec=2
DynamicUser=yes
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --now crm-smtp-socks
sleep 1
systemctl --no-pager --lines=5 status crm-smtp-socks || true

echo "==> firewall: porta ${PROXY_PORT} só para ${DROPLET_IP}"
ufw allow OpenSSH >/dev/null
ufw allow from "${DROPLET_IP}" to any port "${PROXY_PORT}" proto tcp comment 'crm smtp socks' >/dev/null
ufw --force enable >/dev/null
ufw status | grep -E "${PROXY_PORT}|OpenSSH" || true

cat <<EOF

==> pronto.
No droplet, em deploy/digitalocean/.env:
  SMTP_PROXY_URL=socks5://${PROXY_USER}:<SENHA>@$(hostname -I | awk '{print $1}'):${PROXY_PORT}
(se a senha tiver caracteres como @ : / # %, codifique em URL — ex.: @ vira %40)
e então:
  docker compose up -d api worker-automation

Teste do droplet (espera "220 ... ESMTP"):
  curl -sv --socks5-hostname ${PROXY_USER}:<SENHA>@$(hostname -I | awk '{print $1}'):${PROXY_PORT} telnet://smtp.gmail.com:465 </dev/null 2>&1 | head -5
EOF
