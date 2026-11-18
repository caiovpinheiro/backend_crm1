# MCP — Assistentes de IA (ChatGPT, Claude, Cursor)

Integração **somente leitura** do CRM via [Model Context Protocol](https://modelcontextprotocol.io).
O usuário conecta o assistente com o próprio login do CRM (OAuth 2.1 + PKCE) e o
assistente só enxerga o que o usuário já enxerga na UI.

## Arquitetura

```
ChatGPT / Claude / Cursor
        │  HTTPS (Streamable HTTP, stateless, JSON)
        ▼
mcp.bwipo.com  ── APP_MODE=mcp (mesma imagem, processo isolado, pool próprio)
  /mcp                                   → ferramentas (Bearer bwmcp_at_…)
  /.well-known/oauth-protected-resource  → RFC 9728
  /.well-known/oauth-authorization-server→ RFC 8414 (+ openid-configuration)
  /oauth/register                        → DCR (RFC 7591)
  /oauth/authorize                       → valida e redireciona p/ consentimento
  /oauth/token                           → authorization_code (PKCE S256) / refresh_token
  /oauth/revoke                          → RFC 7009
        │ 302
        ▼
app (frontend)  /oauth/consent  ── login normal do CRM + "Permitir acesso"
        │ cookie de sessão
        ▼
api (APP_MODE=api)  /api/settings/mcp/consent  → emite o authorization code
                    /api/settings/mcp/*         → tela /settings/mcp
```

- **Processo isolado**: `APP_MODE=mcp` só responde `/mcp`, `/oauth/*`, `/.well-known/*`
  e `/api/health`; o resto devolve 404. A API principal (`api`/`api-public`) devolve 404
  para as rotas MCP em produção (`src/lib/mcp/config.ts`).
- **Stateless**: um `McpServer` por requisição; escala horizontalmente sem sticky session.
- **Tokens próprios**: `bwmcp_at_` (1 h), `bwmcp_rt_` (30 d, rotação a cada uso; reuso de
  refresh antigo revoga a família), `bwmcp_code_` (5 min, uso único). Só o SHA-256 vai ao
  banco. Tokens de API `eduit_…` **não** valem no `/mcp`.

### Autorização de cada chamada

Uma ferramenta só roda se **todos** valerem, conferidos a cada requisição (sem cache):

1. token válido, não expirado, conexão não revogada;
2. usuário ainda na mesma organização, organização `ACTIVE`;
3. MCP ligado na organização e usuário elegível (`mcp:connect`/`mcp:manage` ou
   "todos os usuários podem conectar");
4. escopo concedido na conexão ∩ escopos liberados pela organização;
5. permissão RBAC atual do usuário (`can()`);
6. mesmos filtros de visibilidade da rota de sessão equivalente (dono/equipe/pool,
   deny de funil/etapa por papel, funis por usuário, canais, filas da inbox).

O contexto Prisma roda com `isSuperAdmin: false` — nem super-admin atravessa organizações.

| Ferramenta | Escopo | Permissão | Reaproveita |
|---|---|---|---|
| `list_leads` | `leads:read` | `deal:view` | `getDeals` + filtros de `GET /api/deals` |
| `get_lead` | `leads:read` | `deal:view` | `getDealById` + checagens de `GET /api/deals/[id]` |
| `list_conversations` | `conversations:read` | `conversation:view` | `getConversations` + filtros de `GET /api/conversations` |
| `get_conversation_messages` | `messages:read` | `conversation:view` | `userHasConversationAccess` + escopo de canal |
| `get_sales_metrics` | `metrics:read` | `report:view` | `getDashboard` |
| `get_team_performance` | `team:read` | `report:view` + papel gestor/admin | `getDashboard.byOwner` |
| `get_campaign_results` | `campaigns:read` | `campaign:view` | `getCampaigns` / `getCampaignStats` |
| `get_pipeline_metrics` | `metrics:read` | `report:view` + `pipeline:view` | `getDashboard.funnel` |

Restrições extras (mais estritas que a UI): métricas de quem não vê todos os negócios saem
só com os próprios; histórico do lead não traz eventos de mensagem; notas internas
(`isPrivate`) nunca saem; telefone/e-mail mascarados salvo opção da organização; campos
personalizados não saem. Páginas: máx. 50 itens.

### Proteções

- Rate limit (Redis): `mcp.tool` 60/min por conexão (`MCP_RATE_LIMIT_RPM`), `mcp.org`
  600/min por organização, `mcp.oauth` 60/min por IP, `mcp.register` 20/h por IP.
- Auditoria em `mcp_audit_logs`: ferramenta, filtros saneados (texto livre vira
  "[texto: N caracteres]"), status, contagem, duração. Nunca tokens nem conteúdo.
  Consentimento/revogação também vão para `audit_logs`.
- `redirect_uri`: https, http só em loopback (CLIs), esquema privado de app
  (`cursor://…`); sem fragmento/credenciais. PKCE S256 obrigatório.
- Logs: nenhum token, código ou conteúdo de mensagem é logado.

## Banco

Migration `prisma/migrations/20261118120000_mcp_integration` (idempotente, só tabelas novas):
`mcp_oauth_clients`, `mcp_connections`, `mcp_tokens`, `mcp_audit_logs`.
Configuração por organização em `organization_settings` (chave `mcp.config`).

Permissões novas no catálogo: `mcp:connect`, `mcp:manage` (ADMIN tem via `*`).

## Multi-tenant (`{slug}.bwipo.com`)

- **Uma URL de MCP para todas as organizações** (`MCP_PUBLIC_URL`). A organização vem do
  login de quem autoriza, nunca do host; a tela de consentimento mostra o nome da org.
- **`MCP_CONSENT_URL` deve apontar para o apex** (`https://bwipo.com/oauth/consent`), não para
  o subdomínio de uma org. O middleware do frontend leva quem está logado no apex para
  `{slug}.bwipo.com/oauth/consent?…` (mantém a query) e, sem sessão, o login carrega o
  `callbackUrl` até o subdomínio escolhido. Um subdomínio fixo mandaria usuários de outras
  orgs para `/login?error=tenant_mismatch`.
- Ambientes de host único (ex.: EasyPanel DEV `crm-dev-frontend…easypanel.host`) usam o
  próprio host do frontend.

## Variáveis de ambiente

| Variável | Onde | Default | Uso |
|---|---|---|---|
| `APP_MODE=mcp` | serviço mcp | — | sobe o processo MCP |
| `MCP_PUBLIC_URL` | **api e mcp** | origem do pedido | issuer OAuth e recurso (`<url>/mcp`). Obrigatória em produção. |
| `MCP_CONSENT_URL` | mcp | `<APP_URL>/oauth/consent` | tela de consentimento no frontend — em produção multi-tenant, o **apex** (`https://bwipo.com/oauth/consent`) |
| `MCP_ACCESS_TOKEN_TTL_SEC` | mcp | 3600 | validade do access token (300–86400) |
| `MCP_REFRESH_TOKEN_TTL_DAYS` | mcp | 30 | validade do refresh token (1–180) |
| `MCP_RATE_LIMIT_RPM` | mcp | 60 | chamadas por conexão/min (10–600) |
| `MCP_ALLOW_ON_MAIN_API` | api | — | `1` serve MCP na API principal (só diagnóstico) |

As demais (`DATABASE_URL`, `REDIS_URL`, `AUTH_SECRET`/`NEXTAUTH_SECRET`, `TRUSTED_PROXY_HOPS`…)
são as mesmas da API. `DATABASE_POOL_MAX` pode ser menor (ex.: 5).

## Deploy no EasyPanel

1. **Migration** (operador, no diretório do backend, depois do código no servidor):
   `node /opt/prisma-cli/node_modules/prisma/build/index.js migrate deploy --schema=prisma/schema.prisma`
   (ou deixe o boot do serviço `api` aplicar, se `RUN_MIGRATIONS_ON_BOOT` estiver ligado).
2. **Serviço novo** `crm-mcp`: duplique o serviço `api-public` (mesma imagem/branch).
   - Ambiente: copie o da API e troque `APP_MODE=mcp`; adicione `MCP_PUBLIC_URL=https://mcp.<domínio>`
     e `MCP_CONSENT_URL=https://bwipo.com/oauth/consent` (apex — ver Multi-tenant).
   - Domínio: `mcp.<domínio>` → porta do container (3000), HTTPS ligado.
   - Health check: `/api/health` (o `scripts/healthcheck.mjs` já reconhece `mcp`).
   - Sem volume e sem worker. Pode ter réplicas (stateless).
3. **Serviço `api`**: adicione `MCP_PUBLIC_URL` (mesmo valor) — usado no consentimento.
4. **Frontend**: nenhum env novo; publique a versão com `/settings/mcp` e `/oauth/consent`.
5. No CRM: **Configurações › Assistentes de IA (MCP)** → ligar a integração.
6. Teste: `curl https://mcp.<domínio>/.well-known/oauth-protected-resource/mcp` e
   `curl -X POST https://mcp.<domínio>/mcp` (espera 401 com `WWW-Authenticate`).

Rollback: desligar na tela (bloqueia na hora) ou parar o serviço `crm-mcp`. As tabelas
novas não afetam o restante do CRM.

## Conectar

- **ChatGPT**: Configurações › Apps e conectores › Configurações avançadas › Modo de
  desenvolvedor › Criar → URL `https://mcp.<domínio>/mcp`, autenticação OAuth.
- **Claude**: Configurações › Conectores › Adicionar conector personalizado → URL.
- **Cursor**: `mcp.json` → `{"mcpServers":{"bwipo-crm":{"url":"https://mcp.<domínio>/mcp"}}}`.
- **MCP Inspector** (teste): `npx @modelcontextprotocol/inspector` → Streamable HTTP → URL.

## Testes

- `src/lib/mcp/mcp.integration.test.ts` (Postgres local; `DATABASE_URL` remota = skip):
  OAuth completo, 8 ferramentas com dados controlados, escopos, RBAC, isolamento entre
  organizações, revogação, auditoria.
- `src/lib/mcp/oauth-unit.test.ts`, `src/lib/mcp/middleware-mcp.test.ts`.

```bash
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/crm_test REDIS_URL=redis://127.0.0.1:6379 \
  npx vitest run src/lib/mcp
```
