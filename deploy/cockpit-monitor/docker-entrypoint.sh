#!/bin/sh
set -eu

# Variáveis do serviço (EasyPanel):
#   COCKPIT_ACCESS_SECRET        obrigatório. Mesmo valor do backend. Fica SÓ
#                                no nginx.conf (header injetado no proxy); nunca
#                                vai para o navegador. Caracteres aceitos:
#                                A-Z a-z 0-9 . _ ~ + / = - (ex.: openssl rand -hex 32).
#   BACKEND_PROD_URL             obrigatório (ou COCKPIT_API_BASE).
#   FRONTEND_PROD_URL            opcional (links da aba Sistema).
#   COCKPIT_BASIC_AUTH_USER      login do painel standalone (basic auth do nginx).
#   COCKPIT_BASIC_AUTH_PASSWORD  senha desse login (mín. 12 caracteres).
#                                Sem as duas, o painel standalone e o proxy
#                                respondem 503 (o modo embed segue funcionando).
#                                Só uma das duas, ou valor inválido: o container
#                                não sobe.
#   COCKPIT_PARENT_ORIGINS       opcional — modo embed (iframe no CRM).
#   COCKPIT_ALLOWED_API_BASES    opcional — modo embed.
#   PORT                         porta do nginx (default 80).

ACCESS_SECRET="${COCKPIT_ACCESS_SECRET:-}"
BACKEND_PROD_URL="${BACKEND_PROD_URL:-${COCKPIT_API_BASE:-}}"
FRONTEND_PROD_URL="${FRONTEND_PROD_URL:-}"
BASIC_USER="${COCKPIT_BASIC_AUTH_USER:-}"
BASIC_PASS="${COCKPIT_BASIC_AUTH_PASSWORD:-}"
# Porta em que o Nginx escuta. Default 80; ajuste (ex.: 8000) para casar com
# o mapeamento de domínio do EasyPanel sem precisar mexer no domínio.
LISTEN_PORT="${PORT:-80}"
HTPASSWD_FILE=/etc/nginx/cockpit.htpasswd

if [ -z "$ACCESS_SECRET" ]; then
  echo "ERRO: defina COCKPIT_ACCESS_SECRET no EasyPanel." >&2
  exit 1
fi
# O segredo vai entre aspas no nginx.conf: `$`, aspas, `;`, espaço etc.
# quebrariam a config (ou virariam variável do nginx). Charset fechado.
case "$ACCESS_SECRET" in
  *[!A-Za-z0-9._~+/=-]*)
    echo "ERRO: COCKPIT_ACCESS_SECRET tem caracteres não aceitos. Use só A-Z a-z 0-9 . _ ~ + / = - (ex.: openssl rand -hex 32)." >&2
    exit 1
    ;;
esac
if [ "${#ACCESS_SECRET}" -lt 32 ]; then
  echo "AVISO: COCKPIT_ACCESS_SECRET tem menos de 32 caracteres — gere um novo com openssl rand -hex 32." >&2
fi
if [ -z "$BACKEND_PROD_URL" ]; then
  echo "ERRO: defina BACKEND_PROD_URL ou COCKPIT_API_BASE." >&2
  exit 1
fi

# ── Login do painel standalone (basic auth) ──────────────────────────────
if [ -n "$BASIC_USER" ] || [ -n "$BASIC_PASS" ]; then
  if [ -z "$BASIC_USER" ] || [ -z "$BASIC_PASS" ]; then
    echo "ERRO: defina COCKPIT_BASIC_AUTH_USER e COCKPIT_BASIC_AUTH_PASSWORD juntos." >&2
    exit 1
  fi
  case "$BASIC_USER" in
    *[!A-Za-z0-9._@-]*)
      echo "ERRO: COCKPIT_BASIC_AUTH_USER aceita só A-Z a-z 0-9 . _ @ -." >&2
      exit 1
      ;;
  esac
  if [ "${#BASIC_PASS}" -lt 12 ]; then
    echo "ERRO: COCKPIT_BASIC_AUTH_PASSWORD precisa de pelo menos 12 caracteres." >&2
    exit 1
  fi
  # Hash apr1 (MD5 com salt, formato htpasswd). A senha entra pelo stdin,
  # não pela linha de comando.
  BASIC_HASH="$(printf '%s\n' "$BASIC_PASS" | openssl passwd -apr1 -stdin)"
  umask 027
  printf '%s:%s\n' "$BASIC_USER" "$BASIC_HASH" > "$HTPASSWD_FILE"
  chown root:nginx "$HTPASSWD_FILE"
  chmod 640 "$HTPASSWD_FILE"
  umask 022
  BASIC_AUTH_ON=1
else
  echo "AVISO: COCKPIT_BASIC_AUTH_USER/PASSWORD ausentes — painel standalone e proxy respondem 503. O modo embed segue funcionando." >&2
  rm -f "$HTPASSWD_FILE"
  BASIC_AUTH_ON=
fi
unset BASIC_PASS BASIC_HASH COCKPIT_BASIC_AUTH_PASSWORD

strip_trail() { echo "$1" | sed 's:/*$::'; }
host_from() { echo "$1" | sed -E 's~https?://~~; s~/.*~~'; }

BACKEND_PROD_URL="$(strip_trail "$BACKEND_PROD_URL")"
FRONTEND_PROD_URL="$(strip_trail "$FRONTEND_PROD_URL")"
API_BASE="$BACKEND_PROD_URL"

BP_HOST="$(host_from "$BACKEND_PROD_URL")"

# ── Modo embedded (iframe dentro do CRM) ─────────────────────────────────
# Ambas as envs são OPCIONAIS. Sem COCKPIT_PARENT_ORIGINS o serviço se comporta
# exatamente como antes (standalone, sem frame-ancestors) e o modo embedded
# fica desligado — o index.html mostra um aviso em vez de aceitar handshake de
# uma origem que não pode validar.
PARENT_ORIGINS_CSV="${COCKPIT_PARENT_ORIGINS:-}"
ALLOWED_API_BASES_CSV="${COCKPIT_ALLOWED_API_BASES:-}"

# Quebra CSV em linhas, remove espaços/barras finais e descarta qualquer
# entrada fora do formato de origem. Isso é o que impede um valor malformado
# de env de virar injeção no config.js (JS) ou no nginx.conf.
sanitize_origins() {
  echo "$1" \
    | tr ',' '\n' \
    | sed 's/^[[:space:]]*//; s/[[:space:]]*$//; s:/*$::' \
    | grep -E '^https?://(\*\.)?[A-Za-z0-9._-]+(:[0-9]+)?$' || true
}

FRAME_ANCESTORS=""
JS_PARENT_ORIGINS=""
CORS_MAP_ENTRIES=""
for origin in $(sanitize_origins "$PARENT_ORIGINS_CSV"); do
  # `frame-ancestors` aceita curinga de subdomínio nativamente.
  FRAME_ANCESTORS="$FRAME_ANCESTORS $origin"
  JS_PARENT_ORIGINS="$JS_PARENT_ORIGINS\"$origin\","
  case "$origin" in
    *://\*.*)
      # nginx `map` não faz curinga: vira regex com os pontos escapados.
      scheme="$(echo "$origin" | sed -E 's~^(https?)://.*~\1~')"
      suffix="$(echo "$origin" | sed -E 's~^https?://\*\.~~' | sed 's/\./\\./g')"
      CORS_MAP_ENTRIES="$CORS_MAP_ENTRIES
  \"~^${scheme}://[A-Za-z0-9-]+\\.${suffix}\$\" \$http_origin;"
      ;;
    *)
      CORS_MAP_ENTRIES="$CORS_MAP_ENTRIES
  \"${origin}\" \"${origin}\";"
      ;;
  esac
done

JS_API_BASES=""
for base in $(sanitize_origins "$ALLOWED_API_BASES_CSV"); do
  JS_API_BASES="$JS_API_BASES\"$base\","
done

JS_PARENT_ORIGINS="$(echo "$JS_PARENT_ORIGINS" | sed 's/,$//')"
JS_API_BASES="$(echo "$JS_API_BASES" | sed 's/,$//')"

# `add_header` em um location substitui os herdados, então o CSP precisa ser
# repetido em cada location que serve o documento HTML.
CSP_HEADER=""
if [ -n "$FRAME_ANCESTORS" ]; then
  CSP_HEADER="add_header Content-Security-Policy \"frame-ancestors 'self'${FRAME_ANCESTORS}\" always;"
fi

# Documento HTML: o painel standalone exige login; `?embedded=1` não (o
# iframe do CRM não usa o proxy com o segredo — só o Bearer curto que o CRM
# manda por postMessage direto para a API).
# Proxy da API: sempre exige login e é o único lugar onde o segredo existe.
if [ -n "$BASIC_AUTH_ON" ]; then
  DOC_GATE="auth_basic \$cockpit_doc_auth;
    auth_basic_user_file ${HTPASSWD_FILE};"
  PROXY_GATE="auth_basic \"Cockpit\";
    auth_basic_user_file ${HTPASSWD_FILE};
    limit_except GET { deny all; }
    proxy_ssl_server_name on;
    proxy_set_header Host ${BP_HOST};
    proxy_set_header X-Cockpit-Access \"${ACCESS_SECRET}\";
    proxy_set_header Authorization \"\";
    proxy_set_header Cookie \"\";
    proxy_set_header Origin \"\";
    proxy_connect_timeout 5s;
    proxy_read_timeout 30s;
    add_header Cache-Control \"no-store\" always;"
else
  DOC_GATE="default_type text/plain;
    if (\$cockpit_doc_standalone) {
      return 503 \"Cockpit sem login configurado (COCKPIT_BASIC_AUTH_USER / COCKPIT_BASIC_AUTH_PASSWORD).\";
    }"
  PROXY_GATE="return 503;"
fi

cat > /etc/nginx/conf.d/default.conf <<NGINX
# Origem permitida a ler /nav.json. Vazio => nenhum header CORS é emitido
# (nginx omite add_header com valor vazio). Nunca usamos "*".
map \$http_origin \$cockpit_cors_origin {
  default "";${CORS_MAP_ENTRIES}
}

# Modo embed (?embedded=1) carrega o documento sem basic auth.
map \$arg_embedded \$cockpit_doc_auth {
  "1"     off;
  default "Cockpit";
}
map \$arg_embedded \$cockpit_doc_standalone {
  "1"     "";
  default "1";
}

server {
  listen ${LISTEN_PORT};
  server_name _;
  root /usr/share/nginx/html;
  index index.html;

  location = /proxy/prod/backend/health {
    proxy_pass ${BACKEND_PROD_URL}/api/health;
    proxy_ssl_server_name on;
    proxy_set_header Host ${BP_HOST};
    proxy_connect_timeout 5s;
    proxy_read_timeout 10s;
    add_header Cache-Control "no-store";
  }

  # Dados do cockpit (standalone): o header X-Cockpit-Access é posto aqui,
  # do lado do servidor. O navegador nunca vê o segredo.
  location = /proxy/prod/backend/agent-cockpit {
    ${PROXY_GATE}
    proxy_pass ${BACKEND_PROD_URL}/api/public/agent-cockpit;
  }

  location = /proxy/prod/backend/agent-cockpit/cases {
    ${PROXY_GATE}
    proxy_pass ${BACKEND_PROD_URL}/api/public/agent-cockpit/cases;
  }

  location / {
    ${DOC_GATE}
    try_files \$uri \$uri/ /index.html\$is_args\$args;
    ${CSP_HEADER}
  }

  location = /config.js {
    add_header Cache-Control "no-store";
  }

  location = /nav.json {
    default_type application/json;
    add_header Access-Control-Allow-Origin \$cockpit_cors_origin always;
    add_header Vary Origin always;
    add_header Cache-Control "no-store" always;
  }

  location = /index.html {
    ${DOC_GATE}
    add_header Cache-Control "no-store";
    ${CSP_HEADER}
  }
}
NGINX

# config.js é público (o embed precisa dele sem login): nada de segredo aqui.
cat > /usr/share/nginx/html/config.js <<EOF
window.COCKPIT_CONFIG = {
  apiBase: "${API_BASE}",
  allowedParentOrigins: [${JS_PARENT_ORIGINS}],
  allowedApiBases: [${JS_API_BASES}],
  urls: {
    backend: { prod: "${BACKEND_PROD_URL}" },
    frontend: { prod: "${FRONTEND_PROD_URL}" }
  }
};
EOF

unset ACCESS_SECRET COCKPIT_ACCESS_SECRET
exec nginx -g 'daemon off;'
