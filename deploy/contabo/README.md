# Proxy de saída SMTP (Contabo)

A DigitalOcean dropa as portas 25/465/587 de saída do droplet, então o SMTP
das caixas conectadas (teste de conexão, responder, regras, automação
`send_email`) dá timeout. O backend resolve isso com `SMTP_PROXY_URL`
(`src/services/email-smtp.ts`): a conexão "direta" da conta passa por um
proxy SOCKS5 num servidor onde essas portas abrem. O proxy só repassa TCP —
TLS e AUTH continuam fim-a-fim entre o CRM e o SMTP do cliente (SPF/DKIM
intactos, qualquer provedor, sem config por org).

Transacional (Mailjet, HTTPS), IMAP (993) e o relay `SMTP_RELAY_*` não
passam pelo proxy.

> O `crm-smtp-proxy` que rodava na porta 2525 da Contabo era um smarthost
> SMTP (AUTH em claro, SPF quebrado, aberto para qualquer IP) — **não** serve
> como `SMTP_PROXY_URL`. Pode ser desligado depois que o SOCKS estiver no ar.

## 1. No servidor da Contabo (root)

```bash
bash install-smtp-proxy.sh <IPV4_PUBLICO_DO_DROPLET> <usuario> <senha> 1080
```

Instala `microsocks`, cria o serviço `crm-smtp-socks` (systemd, com AUTH) e
libera a porta no ufw só para o IP do droplet. Use o IPv4 público do
droplet, não o Reserved IP (ele é só de entrada).

## 2. No droplet

Em `deploy/digitalocean/.env` (compartilhado pela `api` e pelo
`worker-automation`):

```
SMTP_PROXY_URL=socks5://usuario:senha@<IP_DA_CONTABO>:1080
```

Caracteres `@ : / # %` na senha precisam de URL-encoding (`@` → `%40`).
Depois:

```bash
docker compose up -d api worker-automation
```

A imagem `latest` do GHCR já traz o suporte (PR #215, `main`); basta
recriar os dois serviços para lerem a env nova. No log da `api` deve
aparecer `SMTP das contas conectadas sai via proxy SOCKS`.

## 3. Teste

Do droplet, antes de mexer no CRM:

```bash
curl -sv --socks5-hostname usuario:senha@<IP_DA_CONTABO>:1080 telnet://smtp.gmail.com:465 </dev/null 2>&1 | head -5
```

Depois, no CRM: **Configurações → E-mail → Conectar conta** deve responder em
~1 s (em vez de 15 s de timeout). Contas conectadas enquanto o paliativo do
frontend apontava para `185.215.164.198:2525` ficaram gravadas com esse
destino e precisam ser **desconectadas e conectadas de novo**.
