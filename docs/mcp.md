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
| `list_conversations` | `conversations:read` | `conversation:view` | consulta própria com a visibilidade de `GET /api/conversations` (não colapsa tickets) |
| `get_conversation_messages` | `messages:read` (+ `audio:read` p/ transcrição) | `conversation:view` | `userHasConversationAccess` + escopo de canal |
| `get_conversation_events` | `events:read` | `conversation:view` | `activity_events` + `distribution_pending` |
| `get_queue_status` | `queue:read` | `conversation:view` + `report:view` + gestor/admin | `groupBy` com as regras do "Agora" do painel |
| `get_sales_metrics` | `metrics:read` | `report:view` | `getDashboard` |
| `get_team_performance` | `team:read` | `report:view` + papel gestor/admin | `getPainelTeam` + `getPainelService(attendants)` + `getDashboard.byOwner` |
| `get_campaign_results` | `campaigns:read` | `campaign:view` | `getCampaigns` / `getCampaignStats` |
| `get_pipeline_metrics` | `metrics:read` | `report:view` + `pipeline:view` | `getDashboard.funnel` |

**Operador x gestor/admin.** Admin e gestor (papel legado `ADMIN`/`MANAGER`, ou admin pelo
authz) recebem o que já veem no CRM. Qualquer outro usuário (operador) recebe pelo MCP só o
que é dele, mesmo que a org libere ao papel "ver todos" ou o pool sem responsável:
negócios em que é o responsável (`ownerId`); conversas atribuídas a ele ou de contatos
desses negócios (sem filas sem dono); métricas de vendas/funil só dos negócios dele;
equipe e campanhas bloqueadas. As respostas trazem `scope: "own" | "visible"`. O papel é
lido a cada chamada (`isMcpOwnScopeOnly`, `src/lib/mcp/scopes.ts`).

Restrições extras (mais estritas que a UI): métricas de quem não vê todos os negócios saem
só com os próprios; histórico do lead não traz eventos de mensagem; notas internas
(`isPrivate`) nunca saem; telefone/e-mail mascarados salvo opção da organização; campos
personalizados não saem. Páginas: máx. 50 itens.

### Escopos

| Escopo | Libera | Padrão da org |
|---|---|---|
| `leads:read` | `list_leads`, `get_lead` | ligado |
| `conversations:read` | `list_conversations` | ligado |
| `messages:read` | `get_conversation_messages` | ligado |
| `metrics:read` | `get_sales_metrics`, `get_pipeline_metrics` | ligado |
| `team:read` | `get_team_performance` | ligado |
| `campaigns:read` | `get_campaign_results` | ligado |
| `events:read` | `get_conversation_events` | **desligado** |
| `queue:read` | `get_queue_status` | **desligado** |
| `custom_fields:read` | campos personalizados em `list_leads`/`get_lead` (só os da lista da org) | **desligado** |
| `audio:read` | transcrição de áudio em `get_conversation_messages` | **desligado** |
| `tracking:read` | rastreio (UTM/campanha/anúncio) em `list_leads`/`get_lead`, filtros de rastreio e `byCampaign`/`byAd` em `get_sales_metrics` — **só admin e gestor** | **desligado** |

Escopo desligado: a ferramenta responde erro ("Esta conexão não tem a permissão…"); nos
recursos opcionais o campo simplesmente não sai (`customFields` ausente, áudio como
`[áudio]`). Ligar um escopo novo na org **não** amplia conexões já autorizadas: o usuário
reconecta o assistente para consentir o recurso novo.

### Ferramentas de atendimento

- **`list_conversations`** — uma linha por conversa (não agrupa tickets do contato).
  Filtros: `status`, `channel`, `channelId`, `departmentId` (`none` = sem departamento),
  `assignedToId` (`me`, `none` ou id), `tabulationId`, `contactId`, `search`,
  `createdFrom/To`, `updatedFrom/To`, `closedFrom/To` (`YYYY-MM-DD` = dia inteiro em
  Brasília, ou ISO-8601). Ordem `sort` = `createdAt` (padrão) | `updatedAt` | `closedAt`,
  `order` = `desc` | `asc`. Cursor keyset (campo de ordem + id): repita com `nextCursor`
  até `hasMore=false` — sem perder nem repetir linha, inclusive com datas iguais. Cada
  item traz departamento, atendente (humano/IA), datas, `tabulation { id, path }` e
  `closedBy { type, name, at }`.
- **`closedBy.type`** (do último `CONVERSATION_CLOSED`): `pessoa`, `ia`, `automacao`,
  `massa` (humano + `meta.source = bulk-sync`), `inatividade` (`idle_inbound`), `sistema`,
  `integracao`. IA e fechamento em massa passam pelo mesmo `resolveConversationsInline`;
  só o `actorType` os separa.
- **`get_conversation_messages`** — `at` (data/hora), `senderType` = `contato` |
  `atendente` | `agente_ia` | `automacao` (inclui campanha) | `sistema`, `senderName`.
  Áudio: transcrição de `ai_simple_media_texts` (só existe para áudio que a IA processou),
  com `audio:read`; sem ela, `[áudio]`. O cabeçalho da conversa traz tabulação e quem
  encerrou.
- **`get_conversation_events`** — cronológico, cursor, filtro `categories`:
  `abertura`, `reabertura`, `status`, `retorno_agendado`, `atribuicao`, `retomada_ia`,
  `devolucao_humano` (troca de responsável em que um lado é usuário do tipo IA — não há
  evento próprio), `distribuicao`, `distribuicao_falhou`, `transferencia_departamento`,
  `entrada_fila`/`saida_fila` (`distribution_pending`), `encerramento` (com `closedBy` e
  tabulação) e `tabulacao`. Só campos explícitos — nunca o `meta` cru.
- **`get_queue_status`** — agora, por departamento: `waiting` (aguardando resposta:
  `OPEN`, sem retorno agendado, última mensagem do cliente, sem erro), `waitingUnassigned`,
  `oldestWaitMinutes` (pelo `lastInboundAt`) e `onlineAttendants` (`agent_statuses`
  `ONLINE` + `department_members`). Só contagens e nomes de departamento. Gestor com
  departamentos restritos (`AgentPermission.allowedDepartmentIds`) vê só os dele.
- **`get_team_performance`** — período (`period` ou `custom` com `startDate`/`endDate`,
  máx. 90 dias), `departmentIds`, `clock` (`business` padrão | `elapsed`). Por atendente:
  `attended`, `finished`, `firstResponseMedianMinutes`, `serviceMeanMinutes`,
  `serviceMedianMinutes`, `transferredOut`, `transferredIn`; mais `sellers` (vendas por
  vendedor). A 1ª resposta vem do painel de atendimento, que não filtra por departamento.
- **Campos personalizados** — `customFields: [{ field, entity, value }]` em
  `list_leads`/`get_lead` só com `custom_fields:read` **e** campo marcado na lista da org
  (`mcp.config.customFieldIds`, vazia por padrão). Respeita a máscara de campo por papel
  (`canViewFieldForUser`) e mascara campos do tipo telefone/e-mail conforme o toggle de PII.
- **Rastreio (`tracking:read`)** — a "Informação rastreada" do contato do negócio
  (`src/lib/mcp/tools-tracking.ts`). **Só admin e gestor**: operador nunca recebe o bloco
  nem pode usar os filtros, mesmo com o escopo ligado e sendo o responsável do negócio
  (filtro de rastreio do operador → erro). Em `list_leads`/`get_lead`:
  `tracking { utm { source, medium, campaign, content, term, id, referrer }, referrer,
  meta { headline, adId, sourceId, sourceType, adName, adsetId, adsetName, campaignId,
  campaignName }, tiktok { adId, adName } }` (vazios omitidos). **Nunca saem** os
  identificadores de clique por pessoa: `adCtwaClid`, `gclid`, `fbclid`, `googleClientId`.
  Filtros de `list_leads` (igualdade, sem diferenciar maiúsculas): `utmSource`,
  `utmMedium`, `utmCampaign`, `adId` (id resolvido ou de origem) e `adCampaign` (nome ou
  id da campanha Meta). `get_sales_metrics` passa a trazer `byCampaign` e `byAd` (máx. 30
  cada): negócios **criados no período** por campanha (nome Meta → `utm_campaign` →
  `(sem campanha)`) e por anúncio (nome Meta → título → `utm_content` → `(sem anúncio)`),
  com `deals`, `open`, `won`, `lost`, `wonValue`, `conversion` — mesmas travas de funil,
  etapa e dono do painel.

### Proteções

- Rate limit (Redis): `mcp.tool` 60/min por conexão (`MCP_RATE_LIMIT_RPM`), `mcp.org`
  600/min por organização, `mcp.oauth` 60/min por IP, `mcp.register` 20/h por IP.
- Auditoria em `mcp_audit_logs`: ferramenta, filtros saneados (texto livre vira
  "[texto: N caracteres]"), status, contagem, duração. Nunca tokens nem conteúdo.
  Consentimento/revogação também vão para `audit_logs`.
- `redirect_uri`: https, http só em loopback (CLIs), esquema privado de app
  (`cursor://…`); sem fragmento/credenciais. PKCE S256 obrigatório.
- Logs: nenhum token, código ou conteúdo de mensagem é logado.
- Conexão cai sozinha quando o usuário troca a senha / "sai de todos os dispositivos"
  (`User.sessionVersion` mudou desde o consentimento), é anonimizado (LGPD), sai da org
  ou a org é suspensa.
- Retenção: tokens expirados há mais de 1 dia e histórico além de
  `MCP_AUDIT_RETENTION_DAYS` são apagados em lotes pelo processo MCP (até 1x/hora).

## Banco

Migrations (idempotentes, só tabelas novas do MCP):
- `20261118120000_mcp_integration` — `mcp_oauth_clients`, `mcp_connections`, `mcp_tokens`, `mcp_audit_logs`;
- `20261119120000_mcp_hardening` — índice de retenção do histórico e `mcp_connections.userSessionVersion`.
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
| `MCP_AUDIT_RETENTION_DAYS` | mcp | 180 | histórico de consultas guardado (mín. 7) |
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
   - Redeploy automático: o webhook de deploy do serviço vai no secret do GitHub
     `WEBHOOK_DEPLOY_MCP` (produção, push na `main`) e `EASYPANEL_WEBHOOK_DEV_MCP` (dev,
     opcional). Sem o secret, faça o redeploy do `crm-mcp` à mão a cada versão.
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
- `src/lib/mcp/mcp-conversations.integration.test.ts` (Postgres local): filtros e cursor do
  `list_conversations`, tabulação e quem encerrou, remetente e transcrição, linha do tempo,
  fila, equipe, campos personalizados, escopos desligados e isolamento entre orgs.
- `src/lib/mcp/oauth-unit.test.ts`, `src/lib/mcp/middleware-mcp.test.ts`,
  `src/lib/mcp/tools-conversations.test.ts`.

```bash
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/crm_test REDIS_URL=redis://127.0.0.1:6379 \
  npx vitest run src/lib/mcp
```
