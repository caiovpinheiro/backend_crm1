# CI/CD — GitHub Actions + GHCR + Easypanel

Este repo builda a imagem Docker no GitHub Actions (com cache persistente),
publica em `ghcr.io/mikyxx1234/backend_crm1` e dispara um webhook do
Easypanel para redeploy. Deploy fim-a-fim: **~30-60 segundos** (vs
5-10 min do build direto no Easypanel).

Vantagem extra para o backend: envs sensíveis (`META_APP_SECRET`,
`DATABASE_URL`, `BACKEND_PUBLIC_URL`, etc.) continuam sendo lidas em
runtime pelo próprio container Easypanel — nada disso vaza no bundle
Docker.

## Como funciona

```
git push main / DEV_BRANCH
   |
   v
GitHub Actions
   1. Checkout
   2. docker buildx build (com cache-from/to: type=gha)
   3. docker push ghcr.io/mikyxx1234/backend_crm1:<tag>
   4. curl POST <EASYPANEL_WEBHOOK>
   |
   v
Easypanel
   docker pull ghcr.io/mikyxx1234/backend_crm1:<tag>
   docker restart <container>
```

Tags:
- **push main** → `:latest` + `:<sha>`
- **push DEV_BRANCH** → `:dev` + `:<sha>`

## Setup inicial (fazer 1x)

### 1) GitHub — Secrets

**Repository secrets** (Settings → Secrets and variables → Actions → Secrets):

| Name                     | Valor                                                    |
| ------------------------ | -------------------------------------------------------- |
| `EASYPANEL_WEBHOOK_PROD` | URL do webhook do serviço backend em prod (ver abaixo)   |
| `EASYPANEL_WEBHOOK_DEV`  | URL do webhook do serviço backend em dev (ver abaixo)    |

Não precisa de variables (o backend lê tudo em runtime).

### 2) GHCR — visibility

Depois do primeiro push, `https://github.com/Mikyxx1234?tab=packages`
mostra `backend_crm1`. Recomendado deixar **Private** (contém código do
backend). No Easypanel, adicione um GitHub PAT com `read:packages` em
**Registries** e associe ao serviço.

### 3) Easypanel — mudar source pra Docker Image

Em cada ambiente (prod e dev), no serviço `backend`:

1. **App** → **General** → **Source**: mudar de `Git` para **Docker Image**.
2. **Image**:
   - Prod: `ghcr.io/mikyxx1234/backend_crm1:latest`
   - Dev:  `ghcr.io/mikyxx1234/backend_crm1:dev`
3. **Registry**: selecionar a credencial GHCR (privado).
4. Salvar.

### 4) Easypanel — Deploy Hook

**Deployments** → **Deploy Hook** → **Enable** → copie a URL para
`EASYPANEL_WEBHOOK_PROD` (ou `_DEV`).

### 5) Envs em runtime (não mudam)

As envs `DATABASE_URL`, `REDIS_URL`, `META_APP_SECRET`,
`META_WEBHOOK_VERIFY_TOKEN`, `BACKEND_PUBLIC_URL`, `NEXTAUTH_SECRET` etc.
continuam configuradas em **App → Environment** dentro do Easypanel.
Trocar de Git pra Docker Image **não afeta essas envs**.

Em produção DigitalOcean, `DATABASE_URL` / `REDIS_URL` (e replica, se
houver) devem usar o hostname **`private-*`** (VPC) com TLS
(`sslmode=require` / `rediss://`). Hostname sem `private-` ou IP público
sai pela internet — só para acesso externo ocasional, nunca a partir dos
droplets. Exemplo (placeholders):
`private-crm1-pg-nyc3-do-user-XXXX.b.db.ondigitalocean.com:25060`,
`private-crm1-valkey-nyc3-do-user-XXXX.b.db.ondigitalocean.com:25061`.

### 6) Prisma migrate

Se o `docker-entrypoint.sh` já roda `prisma migrate deploy` no start
(ver `backend_crm1/docker-entrypoint.sh`), migrations ainda são aplicadas
a cada deploy — nada muda.

## Rollback rápido

1. GitHub → **Packages** → `backend_crm1` → **Versions**.
2. Copiar SHA da versão anterior.
3. Easypanel → Image → `ghcr.io/mikyxx1234/backend_crm1:<sha>` → **Deploy**.

## Deploy manual

Actions → **Build & Deploy** → **Run workflow** → escolhe branch.
