#!/usr/bin/env bash
# Preparação do droplet. Idempotente: pode rodar de novo sem estragar nada.
#
# NÃO sobe a stack, NÃO roda migrations e NÃO move dado nenhum. O objetivo é
# deixar a máquina pronta para um `docker compose up` posterior, feito à mão.
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive
export NEEDRESTART_MODE=a

log() { echo "[prepare] $*"; }

# --- 1. Baseline do sistema ---------------------------------------------
log "atualizando pacotes..."
apt-get update -qq
apt-get upgrade -y -qq
apt-get install -y -qq ca-certificates curl gnupg git ufw fail2ban unattended-upgrades

log "fuso horário -> America/Sao_Paulo"
timedatectl set-timezone America/Sao_Paulo

# Atualizações de segurança automáticas. Sem reboot automático: um restart
# no meio de uma campanha derrubaria sessões de WhatsApp.
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'EOF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
EOF
sed -i 's|^//\s*Unattended-Upgrade::Automatic-Reboot ".*";|Unattended-Upgrade::Automatic-Reboot "false";|' \
  /etc/apt/apt.conf.d/50unattended-upgrades || true

# --- 2. Swap -------------------------------------------------------------
# 7,8 GB de RAM para 7 containers. O swap é rede de segurança contra um pico
# de memória virar OOM kill num worker, não memória de trabalho: por isso
# swappiness baixo.
if ! swapon --show | grep -q '/swapfile'; then
  log "criando swapfile de 4G..."
  fallocate -l 4G /swapfile
  chmod 600 /swapfile
  mkswap -q /swapfile
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
else
  log "swap já configurado, pulando."
fi
sysctl -qw vm.swappiness=10
grep -q '^vm.swappiness' /etc/sysctl.d/99-crm.conf 2>/dev/null || \
  echo 'vm.swappiness=10' >> /etc/sysctl.d/99-crm.conf

# --- 3. Usuário de deploy ------------------------------------------------
if ! id deploy >/dev/null 2>&1; then
  log "criando usuário deploy..."
  useradd -m -s /bin/bash deploy
else
  log "usuário deploy já existe."
fi
install -d -m 700 -o deploy -g deploy /home/deploy/.ssh
if [ -f /root/.ssh/authorized_keys ]; then
  cp /root/.ssh/authorized_keys /home/deploy/.ssh/authorized_keys
  chown deploy:deploy /home/deploy/.ssh/authorized_keys
  chmod 600 /home/deploy/.ssh/authorized_keys
fi
echo 'deploy ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/90-deploy
chmod 440 /etc/sudoers.d/90-deploy

# --- 4. Docker -----------------------------------------------------------
if ! command -v docker >/dev/null 2>&1; then
  log "instalando Docker Engine..."
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${VERSION_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
else
  log "Docker já instalado."
fi

# Rotação de log no daemon: o compose já limita por serviço, isto protege
# qualquer container avulso rodado à mão.
cat > /etc/docker/daemon.json <<'EOF'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "20m", "max-file": "5" }
}
EOF
systemctl restart docker
systemctl enable --now docker
usermod -aG docker deploy

# --- 5. Firewall ---------------------------------------------------------
# SSH liberado ANTES do enable, senão a sessão atual cai.
log "configurando ufw..."
ufw allow OpenSSH >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw allow 443/udp >/dev/null
ufw --force enable >/dev/null
systemctl enable --now fail2ban

# --- 6. Estrutura da aplicação -------------------------------------------
install -d -o deploy -g deploy /opt/crm
install -d -o deploy -g deploy /opt/crm/caddy

log "concluído."
echo
echo "=== RESUMO ==="
docker --version
docker compose version
echo "swap: $(swapon --show=NAME,SIZE --noheadings | tr '\n' ' ')"
echo "tz:   $(timedatectl show -p Timezone --value)"
echo "ufw:  $(ufw status | head -1)"
