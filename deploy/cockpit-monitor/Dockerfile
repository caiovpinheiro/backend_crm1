FROM nginx:1.27-alpine

# openssl: gera o hash apr1 do basic auth no entrypoint (COCKPIT_BASIC_AUTH_*).
RUN apk add --no-cache openssl

COPY docker-entrypoint.sh /docker-entrypoint.sh
COPY index.html /usr/share/nginx/html/index.html
# Lista de abas consumida pelo CRM antes de montar o iframe (lazy loading).
COPY nav.json /usr/share/nginx/html/nav.json

RUN chmod +x /docker-entrypoint.sh

EXPOSE 80
ENTRYPOINT ["/docker-entrypoint.sh"]
