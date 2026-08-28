# O binário oficial do Caddy não traz provedores de DNS. O certificado
# wildcard de *.crm.eduit.com.br exige desafio DNS-01, então o plugin da
# DigitalOcean precisa ser compilado junto.
FROM caddy:2-builder AS builder
RUN xcaddy build --with github.com/caddy-dns/digitalocean

FROM caddy:2
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
