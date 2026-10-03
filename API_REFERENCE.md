# API Reference — CRM EduIT (backend_crm1)

Referência completa das **318 funções HTTP** expostas em `src/app/api/**/route.ts`,
organizada por domínio para uso direto em integrações (n8n, Zapier, Make, scripts).

> Documento gerado a partir de uma varredura dos arquivos `route.ts`. Para
> detalhes de implementação consulte o código-fonte do endpoint correspondente
> (caminho indicado em cada seção). Nada do código foi alterado.

---

## 1. Visão geral

- **Stack:** Next.js 15 App Router. Cada rota mora em
  `src/app/api/<path>/route.ts` e exporta funções nomeadas `GET`, `POST`,
  `PUT`, `PATCH`, `DELETE`, `HEAD`.
- **Base URL local:** `http://localhost:3000`
- **Base URL produção:** definida em `NEXTAUTH_URL` (ex.
  `https://banco-backend-crm.6tqx2r.easypanel.host`). Veja `AGENT.md` para
  ambientes ativos.
- **Content-Type padrão:** `application/json; charset=utf-8` (tanto em request
  quanto em response). Endpoints que aceitam upload usam `multipart/form-data`
  e estão marcados como **(multipart)**.
- **Multi-tenant:** todas as rotas, exceto webhooks/health/signup/login, são
  *escopadas por `organizationId`*. O ID é resolvido automaticamente pelo
  token/sessão; você nunca precisa enviá-lo no body.
- **Idiomas das mensagens de erro:** português. Sempre vêm no campo `message`.

---

## 2. Autenticação

O backend aceita **dois mecanismos**; a maioria das rotas funciona com qualquer
um dos dois. O middleware (`src/middleware.ts`) bloqueia chamadas a `/api/*`
que não venham com nenhum dos dois (exceto allowlist em §3).

### 2.1. Bearer Token (recomendado para n8n)

1. Faça login na interface web e vá em **Configurações → Tokens de API**.
2. Crie um token via `POST /api/settings/api-tokens` (ver §10.2). O response
   traz o `token` em texto puro — copie e guarde, ele não aparece de novo.
3. Use em **todas** as requisições subsequentes:

```http
Authorization: Bearer eduit_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
Content-Type: application/json
```

> O token gerado tem **sempre** o prefixo `eduit_` seguido de 48 caracteres
> hexadecimais (ver `src/services/api-tokens.ts`). Documentação antiga
> mencionando `crm_` é vestígio e foi removida.

- Rate-limit: **400 req/min por token** (ver `withRateLimitHeaders` em
  `src/lib/api-auth.ts`). Em caso de excesso retorna `429`.
- O token herda **organização e papel** (`ADMIN`/`MANAGER`/`MEMBER`) do usuário
  que o criou. Permissões aplicadas via RLS + AuthZ.

### 2.2. Sessão NextAuth (browser)

Cookie de sessão emitido pelo fluxo `POST /api/auth/callback/credentials`
(NextAuth, gerado dinamicamente pela rota catch-all `[...nextauth]`).
Em produção HTTPS o cookie é `__Secure-authjs.session-token`. Para n8n é
mais simples usar Bearer (§2.1).

### 2.3. Rotas públicas (sem auth)

- `POST /api/signup` — criação self-service de organização.
- `POST /api/invites/accept` — aceitar convite por token.
- `POST /api/auth/register` — desligado (retorna 410 — uso é `/api/signup`).
- `GET /api/health`, `HEAD /api/health`, `GET /health` — healthcheck.
- `GET /api/config/public` — feature flags públicas.
- `GET /api/push/vapid-public` — chave pública VAPID para Web Push.
- `POST /api/webhooks/meta`, `POST /api/webhooks/meta/[orgSlug]` — entrada
  da Meta Cloud API (validado por `X-Hub-Signature-256`).
- `POST /api/webhooks/stripe` — entrada do Stripe (validado por `Stripe-Signature`).
- `GET /api/cron/sync-meta-pricing` — autenticado via `?secret=` ou header
  cron específico (não usar Bearer/sessão).

### 2.4. Códigos HTTP

| Código | Significado típico |
|--------|--------------------|
| 200 / 201 | Sucesso (201 quando cria recurso) |
| 204 | Sucesso sem body (delete em alguns endpoints) |
| 400 | Body inválido / parâmetro obrigatório ausente |
| 401 | Sem token / sessão expirada / token inválido |
| 403 | Sem permissão (papel ou scope grant) |
| 404 | Recurso não encontrado / fora da org |
| 409 | Conflito de unicidade (P2002) |
| 410 | Endpoint desativado / migrado |
| 429 | Rate-limit excedido |
| 500 | Erro interno (log no servidor) |
| 502 | Falha externa (Meta WhatsApp, etc.) |
| 503 | Dependência indisponível (DB, Redis, Meta sem credenciais) |

### 2.5. Paginação

Padrão para qualquer GET de listagem:

- Query: `?page=1&perPage=20` (limites variam; ver cada endpoint).
- Response:
  ```json
  {
    "items": [...],
    "total": 123,
    "page": 1,
    "perPage": 20
  }
  ```

### 2.6. Filtros multi-tenant

Você **não** precisa enviar `organizationId`. A Prisma Extension
(`src/lib/prisma-extension-rls.ts`) injeta `WHERE organizationId = <ctx>` em
todas as queries da request. O ctx é resolvido do Bearer/sessão.

---

## 3. Tempo real (SSE)

### `GET /api/sse/messages`

- **Auth:** sessão (cookie). Bearer também aceito.
- **Response:** stream `text/event-stream`. Eventos:
  - `new_message` — uma nova mensagem chegou ou foi enviada.
  - `conversation_updated` — status, owner ou contadores mudaram.
  - `agent_status` — agente entrou/saiu (HUMAN).
  - `typing` — outro agente está digitando.
- Reconecte sempre via header `Last-Event-ID` para evitar perdas. Heartbeats
  vêm como comentário SSE a cada 30s.

> Para n8n, prefira chamar `GET /api/conversations` por polling a cada 15-30s
> em vez de manter SSE aberto — webhooks de chegada de mensagem podem vir
> direto da Meta via `/api/webhooks/meta` (você configura no Business Manager).

---

## 4. Autenticação, Identidade & Usuários

### 4.1. Auth (NextAuth dinâmico)

| Método | Path | Auth | Descrição |
|--------|------|------|-----------|
| ALL | `/api/auth/[...nextauth]` | público / sessão | Gerenciado pelo NextAuth. Inclui `signin`, `callback`, `session`, `csrf`, `signout`. Não chame diretamente em integrações; use `/api/signup` + Bearer. |
| POST | `/api/auth/register` | público | **Desativado** (410). Use `POST /api/signup`. |

#### Fluxo n8n recomendado para chamar APIs

1. Crie a conta via `POST /api/signup` (uma vez).
2. Faça login web e gere um Bearer via `POST /api/settings/api-tokens`.
3. Use o Bearer em todas as chamadas n8n.

### 4.2. MFA

| Método | Path | Body | Descrição |
|--------|------|------|-----------|
| GET | `/api/auth/mfa/status` | — | Retorna `{ enabled, type }` para o user atual. |
| POST | `/api/auth/mfa/setup` | — | Gera segredo TOTP. Response: `{ secret, qrDataUrl, otpauthUrl }`. |
| POST | `/api/auth/mfa/verify` | `{ token: string }` | Verifica código 6 dígitos e ativa MFA. |
| POST | `/api/auth/mfa/disable` | `{ token, password? }` | Desativa MFA. |
| POST | `/api/auth/mfa/backup-codes` | `{ token }` | Regenera 10 backup codes (one-shot). |

### 4.3. Signup & Onboarding

| Método | Path | Body / Query | Descrição |
|--------|------|--------------|-----------|
| POST | `/api/signup` | `{ organizationName, slug, adminName, adminEmail, password }` | Cria `Organization` + user ADMIN em transação. Rate-limit: 3/IP/10min, 3/email/h, 5/slug/h. |
| POST | `/api/invites/accept` | `{ token, name, password }` | Membro aceita convite. Cria user e vincula à org. |
| PATCH | `/api/onboarding/organization` | `{ name?, slug?, ... }` | Atualiza dados da org no wizard. |
| PATCH | `/api/onboarding/branding` | `{ logoUrl?, primaryColor?, ... }` | Branding da org. |
| POST | `/api/onboarding/channel` | `{ name, type, provider, config }` | Cria primeiro canal WhatsApp do wizard. |
| POST | `/api/onboarding/pipeline` | `{ name, stages: [...] }` | Cria pipeline + estágios iniciais. |
| POST | `/api/onboarding/invites` | `{ invites: [{ email, role }] }` | Envia convites de membros. |
| POST | `/api/onboarding/complete` | — | Marca onboarding como concluído. |

### 4.4. Profile (usuário corrente)

| Método | Path | Auth | Body | Descrição |
|--------|------|------|------|-----------|
| GET | `/api/profile` | Bearer/sessão | — | Dados completos do user logado (incluindo MFA, role, org). |
| PUT | `/api/profile` | Bearer/sessão | `{ name?, email?, password?, currentPassword? }` | Atualiza perfil. Senha exige `currentPassword`. |
| POST | `/api/profile/avatar` | Bearer/sessão | **multipart**: `file` | Upload de avatar. Retorna `{ avatarUrl }`. |

### 4.5. Me / Data privacy (LGPD)

| Método | Path | Body | Descrição |
|--------|------|------|-----------|
| POST | `/api/me/data-export` | — | Inicia export de dados (assíncrono). Retorna `{ id, status }`. |
| GET | `/api/me/data-export` | — | Lista exports anteriores. |
| GET | `/api/me/data-export/[id]` | — | Status + URL do export específico. |
| POST | `/api/me/data-erase` | `{ confirm: "ERASE", password }` | Pede apagamento da conta (LGPD). Soft-delete + queue de hard-delete. |

### 4.6. Usuários (admin da org)

| Método | Path | Auth | Body / Query | Descrição |
|--------|------|------|--------------|-----------|
| GET | `/api/users` | sessão | — | Lista users HUMAN da org. Inclui `agentStatus`. |
| POST | `/api/users` | ADMIN | `{ name, email, password, role: "ADMIN"\|"MANAGER"\|"MEMBER" }` | Cria user na própria org. Conflito de email → 409. |
| PUT | `/api/users/[id]` | ADMIN | `{ name?, email?, role?, password?, active? }` | Edita user. |
| DELETE | `/api/users/[id]` | ADMIN | — | Soft-delete user. |

### 4.7. Agentes (operadores de inbox)

| Método | Path | Body / Query | Descrição |
|--------|------|--------------|-----------|
| GET | `/api/agents/status` | — | Status do agente corrente: `ONLINE`/`OFFLINE`/`AWAY`. |
| POST | `/api/agents/me/ping` | — | Heartbeat (5-15s). Mantém status ONLINE. |
| GET | `/api/agents/[id]/status` | — | Status de outro agente (mesma org). |
| PUT | `/api/agents/[id]/status` | `{ status, availableForVoiceCalls? }` | Atualiza status. |
| GET | `/api/agents/[id]/schedule` | — | Horários de trabalho do agente. |
| PUT | `/api/agents/[id]/schedule` | `{ schedule: [{ dayOfWeek, startTime, endTime }] }` | Define horários. |
| GET | `/api/agents/schedules` | — | Schedules de toda a equipe (admin/manager). |
| GET | `/api/agents/inbound-voice` | — | Agentes disponíveis para receber chamada de voz inbound. |
| GET | `/api/monitor/agents` | — | Visão geral de monitoramento: status + estatísticas em tempo real. |
| GET | `/api/inbox/agent-capacity` | — | Capacidade atual de cada agente (conversas abertas / máx). |

---

## 5. Inbox — Conversas, Mensagens, Templates

### 5.1. Conversations

| Método | Path | Auth | Query / Body | Descrição |
|--------|------|------|--------------|-----------|
| GET | `/api/conversations` | Bearer/sessão | `?counts=1` ou `?tab=entrada\|esperando\|respondidas\|automacao\|finalizados\|erro\|todos&status=OPEN\|RESOLVED\|PENDING\|SNOOZED&channel=whatsapp&contactId=&ownerId=&stageId=&tagIds=a,b&search=&sortBy=lastMessageAt\|updatedAt\|createdAt\|unreadCount&sortOrder=asc\|desc&cursor=&perPage=30` | Lista conversas filtradas. Com `counts=1` retorna apenas contadores por aba. Ordem padrão (`sortBy=lastMessageAt`): última mensagem de chat, entrada ou saída (nota, rascunho da IA, ligação WhatsApp e evento não contam) — `COALESCE(lastMessageAt, updatedAt) DESC, id DESC`; ler, atribuir ou encerrar não muda a posição; conversa sem a coluna preenchida usa `updatedAt`. Paginação por cursor (keyset): a resposta traz `nextCursor` (opaco, v2) e `hasMore`; mande-o de volta em `cursor`, com o mesmo `sortBy`, para a página seguinte — sem OFFSET, não repete nem pula item. Cursor v1 aceito por uma versão (inclusive o de `updatedAt` na ordem padrão). `total`: número real do filtro quando conhecido (lista esgotada sem cursor, ou badge em cache), senão `null` — nunca estimado. `page`: número da página sem `cursor`; com `cursor`, `null`. `page=N` continua aceito (legado, usa OFFSET). Cursor ilegível ou de outro `sortBy` → 400. |
| POST | `/api/conversations/create` | sessão | `{ contactId, channelId?, message?, skipSend? }` | Cria conversa WhatsApp com um contato. `skipSend=true` apenas reserva a conversa sem mandar mensagem. |
| GET | `/api/conversations/[id]` | Bearer/sessão | — | Detalhe de uma conversa (contato, canal, owner, status, tags). |
| POST | `/api/conversations/bulk` | sessão | `{ ids: string[], action: "resolve"\|"reopen"\|"assign"\|"unassign"\|"snooze"\|"unsnooze", payload? }` | Operação em massa nas conversas. |
| POST | `/api/conversations/[id]/read` | Bearer/sessão | — | Marca conversa como lida pelo agente atual. |
| POST | `/api/conversations/[id]/typing` | sessão | `{ typing: boolean }` | Emite indicador "digitando…" via SSE/Meta. |
| POST | `/api/conversations/[id]/actions` | sessão | `{ action: "assign"\|"resolve"\|"reopen"\|"snooze"\|"move_stage"\|"tag"\|... , payload }` | Ações em uma conversa (ver código para enum completo). |
| POST | `/api/conversations/[id]/forward` | sessão | `{ toConversationIds: string[], messageId? }` | Encaminha conversa(s)/mensagem(ns). |
| GET | `/api/conversations/[id]/scheduled-calls` | sessão | — | Lista chamadas WhatsApp agendadas para a conversa. |
| POST | `/api/conversations/[id]/scheduled-calls` | sessão | `{ scheduledAt, agentId? }` | Agenda chamada de voz. |
| GET | `/api/conversations/[id]/calling-context` | sessão | — | Estado completo da janela 24h, permissões de chamada, último contato. |
| GET | `/api/conversations/[id]/whatsapp-calls` | sessão | — | Histórico de chamadas WhatsApp. |
| POST | `/api/conversations/[id]/whatsapp-calls` | sessão | `{ action: "initiate"\|"end"\|... , payload }` | Inicia/finaliza chamada WhatsApp. |
| GET | `/api/conversations/[id]/whatsapp-calls/recent` | sessão | `?limit=5` | Chamadas mais recentes (default 5). |
| POST | `/api/conversations/[id]/whatsapp-calls/recording` | sessão | `{ callId, recordingUrl }` | Anexa URL de gravação. |
| POST | `/api/conversations/[id]/call-permission` | sessão | `{ to, templateName?, languageCode? }` | Envia template de pedido de permissão de chamada (não usa Flow). |
| PATCH | `/api/conversations/[id]/call-permission` | sessão | `{ status: "granted"\|"denied"\|... }` | Atualiza status da permissão. |
| GET | `/api/conversations/[id]/session-debug` | sessão | — | Diagnóstico: última inbound, janela 24h, lock state. |
| POST | `/api/conversations/[id]/attachments` | sessão | **multipart**: `file` + `caption?` | Envia anexo (imagem, vídeo, documento, áudio). |
| POST | `/api/conversations/[id]/template` | sessão | `{ templateName, languageCode?, components?, bodyPreview?, templateGraphId?, flowToken?, flowActionData? }` | Envia template Meta (com ou sem Flow). Default `languageCode=pt_BR`. |
| GET | `/api/conversations/[id]/tags` | sessão | — | Tags atribuídas à conversa. |
| POST | `/api/conversations/[id]/tags` | sessão | `{ tagId }` ou `{ tagIds: [] }` | Adiciona tag(s). |
| DELETE | `/api/conversations/[id]/tags` | sessão | `?tagId=...` | Remove tag. |
| PUT | `/api/conversations/[id]/pin-note` | sessão | `{ noteId: string \| null }` | Fixa/desfixa nota privada no topo. |

### 5.2. Messages

| Método | Path | Auth | Query / Body | Descrição |
|--------|------|------|--------------|-----------|
| GET | `/api/conversations/[id]/messages` | Bearer/sessão | `?limit=50&before=ISO_DATE` | Histórico paginado por cursor `before` (createdAt). Default `limit=50`, max `100`. |
| POST | `/api/conversations/[id]/messages` | Bearer/sessão | `{ content, messageType?, private?, replyToId? }` | Envia mensagem outbound. `private=true` ou `messageType="note"` salva como nota interna. Rate-limit: 600/min/org. |
| POST | `/api/messages/[id]/reactions` | sessão | `{ emoji: string, action: "add"\|"remove" }` | Reage/desfaz reação a uma mensagem. |

#### Exemplo n8n — enviar texto

```http
POST {{baseUrl}}/api/conversations/{{conversationId}}/messages
Authorization: Bearer {{token}}
Content-Type: application/json

{
  "content": "Olá! Seu pedido foi aprovado.",
  "messageType": "text"
}
```

Resposta `201`:
```json
{
  "message": {
    "id": "wamid.HBgN...",
    "content": "Olá! Seu pedido foi aprovado.",
    "createdAt": "2026-05-26T15:42:11.000Z",
    "direction": "out",
    "messageType": "text",
    "senderName": "Caio"
  }
}
```

### 5.3. Scheduled Messages

| Método | Path | Query / Body | Descrição |
|--------|------|--------------|-----------|
| GET | `/api/scheduled-messages` | `?conversationId=...` | Lista agendamentos PENDING da conversa. |
| POST | `/api/scheduled-messages` | `{ conversationId, content, scheduledAt: ISO, media?: { url, type?, name? }, fallbackTemplate?: { name, params?, language? } }` | Cria agendamento. |
| DELETE | `/api/scheduled-messages/[id]` | — | Cancela agendamento (status PENDING). |

### 5.4. Quick Replies & Templates locais

| Método | Path | Body | Descrição |
|--------|------|------|-----------|
| GET | `/api/quick-replies` | — | Lista respostas rápidas da org. |
| POST | `/api/quick-replies` | `{ title, content, category? }` ou `{ orderedIds: [] }` | Cria ou reordena respostas rápidas. |
| PUT | `/api/quick-replies/[id]` | `{ title?, content?, category? }` | Atualiza. |
| DELETE | `/api/quick-replies/[id]` | — | Remove. |
| GET | `/api/templates` | — | Lista templates **internos** (snippets, não-Meta). |
| POST | `/api/templates` | `{ name, content, variables? }` | Cria template. |
| GET | `/api/templates/[id]` | — | Detalhe. |
| PUT | `/api/templates/[id]` | mesmos campos | Atualiza. |
| DELETE | `/api/templates/[id]` | — | Remove. |

### 5.5. Inbox stats

| Método | Path | Descrição |
|--------|------|-----------|
| GET | `/api/inbox/daily-stats` | Stats do dia (atendidas, em espera, tempo médio resposta). |

---

## 6. Contatos & Empresas

### 6.1. Contacts

| Método | Path | Query / Body | Descrição |
|--------|------|--------------|-----------|
| GET | `/api/contacts` | `?search=&email=&phone=&lifecycleStage=&companyId=&tagIds=a,b&page=&perPage=&sortBy=name\|email\|createdAt\|updatedAt\|leadScore\|lifecycleStage&sortOrder=asc\|desc&customFieldFilters=[{"name","operator":"eq\|contains\|filled","value"}]` | Lista paginada. |
| POST | `/api/contacts` | `{ name, email?, phone?, avatarUrl?, leadScore?, lifecycleStage?, source?, companyId?, assignedToId? }` | Cria contato. Email único na org. |

#### Verificar se já existe (lead lookup)

Para responder **"esse lead/contato existe?"** use os filtros exatos
`?email=` e/ou `?phone=` — diferente do `search` (contains em vários campos)
o match é 1:1 e retorna `total=0` quando não existe.

| Param | Tipo de match | Observação |
|-------|---------------|------------|
| `email` | `equals` case-insensitive | Comparado em lowercase. |
| `phone` | `equals` no valor cru **OU** `endsWith` nos dígitos | Tolerante a formatação (`+5511...` vs `(11) 9...`). Mande só dígitos quando puder. |

```http
GET {{baseUrl}}/api/contacts?email=maria@example.com&perPage=1
Authorization: Bearer {{token}}
```

```http
GET {{baseUrl}}/api/contacts?phone=5511999998888&perPage=1
Authorization: Bearer {{token}}
```

```http
GET {{baseUrl}}/api/contacts?lifecycleStage=LEAD&email=maria@example.com
Authorization: Bearer {{token}}
```

Resposta segue o mesmo shape paginado: `total=0` → não existe; `total>=1` →
existe (e os dados já vêm em `items[0]`, sem precisar de segundo GET).

> **Valores válidos de `lifecycleStage` (sempre MAIÚSCULOS):**
> `SUBSCRIBER`, `LEAD`, `MQL`, `SQL`, `OPPORTUNITY`, `CUSTOMER`, `EVANGELIST`, `OTHER`.
| GET | `/api/contacts/[id]` | — | Detalhe do contato. |
| PUT | `/api/contacts/[id]` | mesmos campos opcionais + informação rastreada | Atualiza. UTM/click IDs e Meta (`adCtwaClid`, `adHeadline`, `adResolvedId`, `adSourceId`) são opcionais; ausente, null ou `""` não apagam. |
| DELETE | `/api/contacts/[id]` | — | Remove (soft-delete + dissocia conversas/deals). |
| POST | `/api/contacts/import` | **multipart**: `file` (CSV) + `mappings?` | Importação em lote. Retorna `{ created, updated, errors }`. |
| POST | `/api/contacts/merge` | `{ primaryId, mergeIds: string[] }` | Funde contatos no `primaryId`. |
| GET | `/api/contacts/[id]/timeline` | — | Linha do tempo: eventos, mensagens, deals, atividades. |
| GET | `/api/contacts/[id]/notes` | — | Notas do contato. |
| POST | `/api/contacts/[id]/notes` | `{ body }` | Cria nota. |
| GET | `/api/contacts/[id]/custom-fields` | — | Custom fields do contato. **Aceita Bearer.** |
| PUT | `/api/contacts/[id]/custom-fields` | `{ values: [{ fieldId, value }] }` | Upsert dos custom fields. **Aceita Bearer.** Use `GET /api/custom-fields?entity=contact` para descobrir os `fieldId`s. Itens com `value=""` removem o valor. |
| POST | `/api/contacts/[id]/tags` | `{ tagId }` ou `{ tagIds: [] }` | Adiciona tag(s). |
| DELETE | `/api/contacts/[id]/tags` | `?tagId=...` | Remove tag. |

#### Exemplo n8n — criar contato

```http
POST {{baseUrl}}/api/contacts
Authorization: Bearer {{token}}
Content-Type: application/json

{
  "name": "Maria Silva",
  "email": "maria@example.com",
  "phone": "+5511999998888",
  "lifecycleStage": "LEAD",
  "source": "n8n-webhook"
}
```

#### `POST /api/leads` — entrada **atômica** de lead (recomendado para n8n)

Em uma única chamada faz lead-or-create do contato + cria deal no estágio
escolhido + grava custom fields de contato e de deal. **Idempotente** por
telefone (preferido) ou email — chamar duas vezes não duplica contato.

| Método | Path | Auth | Body |
|--------|------|------|------|
| POST | `/api/leads` | Bearer | ver schema abaixo |

```jsonc
{
  // Bloco contato (obrigatório). Lookup procura primeiro por phone, depois email.
  "contact": {
    "name": "Maria Silva",           // obrigatório APENAS quando vai criar
    "email": "maria@example.com",    // qualquer um destes dois
    "phone": "+5511999998888",       // serve como chave de idempotência
    "lifecycleStage": "LEAD",        // SUBSCRIBER|LEAD|MQL|SQL|OPPORTUNITY|CUSTOMER|EVANGELIST|OTHER
    "source": "n8n-form-anuncio-x",
    "leadScore": 30,
    "assignedToId": null,
    "customFields": [
      { "name": "curso_interesse", "value": "Engenharia de Dados" },
      { "fieldId": "ckxxx...", "value": "Plus" }   // pode usar fieldId direto
    ],
    // Informação rastreada — todos opcionais. Ausente, null ou "" não apaga.
    // Com options.fillEmptyContactFieldsOnly, valor já salvo no contato permanece.
    "adUtmSource": "facebook",     // utm_source
    "adUtmMedium": "cpc",          // utm_medium
    "adUtmCampaign": "black",      // utm_campaign
    "adUtmContent": "v1",          // utm_content
    "adUtmTerm": "lead",           // utm_term
    "utmId": "99",                 // utm_id
    "utmReferrer": "https://lp",   // utm_referrer
    "referrer": "https://lp",
    "gclid": "G.1",
    "fbclid": "F.2",
    "googleClientId": "GA1.1",     // gclientid
    "ttadId": "tt1",               // ttad_id
    "ttadName": "criativo",        // ttad_name
    "adCtwaClid": "Af...",         // ctwa_clid
    "adHeadline": "Terapia",       // ad_headline
    "adResolvedId": "12025...",    // ad_id
    "adSourceId": "12025..."       // ad_source_id
  },

  // Bloco deal (opcional). Quando presente, cria deal sempre — mesmo se o
  // contato for reusado. Para evitar duplicar deal, faça antes:
  //   GET /api/deals?contactPhone=...&status=OPEN&pipelineId=...
  "deal": {
    "stageId": "cmoftx9ot000fmq01uf55fr9k",        // obrigatório
    "title": "Lead Engenharia de Dados — Maria",   // opcional; default "Lead - <contact.name>"
    "value": 1500.00,
    "ownerId": null,
    "customFields": [
      { "name": "origem_canal", "value": "instagram" }
    ]
  }
}
```

Resposta:

```jsonc
{
  "contact": { /* contato completo */ },
  "contactCreated": true,           // false quando o contato já existia
  "deal": { /* deal criado, ou null se o bloco deal não veio */ },
  "dealCreated": true,
  // Presente apenas quando algum customField passado por `name` não foi
  // encontrado. Os demais campos foram gravados normalmente.
  "missingCustomFields": { "contact": ["xxxxx"], "deal": [] }
}
```

Códigos:

- `200 OK` quando contato e deal foram **reusados** (raro — quando só atualiza campos).
- `201 Created` quando criou contato ou deal.
- `400` para qualquer validação (lifecycleStage inválido, stageId fora da org, etc.).
- `403` falta `contact:create` ou `deal:create`, ou stage fora do escopo do usuário.
- `409` violação de unicidade (raro — concorrência criando o mesmo email).

### 6.2. Companies

| Método | Path | Query / Body | Descrição |
|--------|------|--------------|-----------|
| GET | `/api/companies` | `?search=&page=&perPage=` | Lista paginada. |
| POST | `/api/companies` | `{ name, domain?, industry?, size?, phone?, address?, notes? }` | Cria empresa. |
| GET | `/api/companies/[id]` | — | Detalhe. |
| PUT | `/api/companies/[id]` | mesmos campos | Atualiza. |
| DELETE | `/api/companies/[id]` | — | Remove. |

### 6.3. Tags

| Método | Path | Query / Body | Descrição |
|--------|------|--------------|-----------|
| GET | `/api/tags` | `?counts=1` | Lista tags. Com `counts=1` adiciona `dealCount` e `contactCount`. |
| POST | `/api/tags` | `{ name, color? }` | Cria tag (ADMIN/MANAGER). |
| PUT | `/api/tags/[id]` | `{ name?, color? }` | Atualiza. |
| DELETE | `/api/tags/[id]` | — | Remove. |

### 6.4. Segments

| Método | Path | Body | Descrição |
|--------|------|------|-----------|
| GET | `/api/segments` | — | Lista segmentos da org. |
| POST | `/api/segments` | `{ name, filters: {...} }` | Cria segmento dinâmico. |
| GET | `/api/segments/[id]` | — | Detalhe + condições. |
| PUT | `/api/segments/[id]` | `{ name?, filters? }` | Atualiza. |
| DELETE | `/api/segments/[id]` | — | Remove. |
| GET | `/api/segments/[id]/preview` | `?page=&perPage=` | Preview dos contatos que casam com o filtro. |

---

## 7. Funil — Deals, Pipelines, Stages, Activities

### 7.1. Deals

| Método | Path | Query / Body | Descrição |
|--------|------|--------------|-----------|
| GET | `/api/deals` | `?pipelineId=&stageId=&status=OPEN\|WON\|LOST&ownerId=&contactId=&contactEmail=&contactPhone=&search=&page=&perPage=` | Lista negócios. |

#### Verificar se um contato já tem deal (sem dois round-trips)

`?contactEmail=` e `?contactPhone=` filtram pelo email/telefone do contato
dono do deal (match exato, mesma regra do §6.1). `?contactId=` se você já
tem o ID resolvido. Combine com `?status=OPEN&pipelineId=` para checar
deals **abertos** em um pipeline específico.

```http
GET {{baseUrl}}/api/deals?contactEmail=maria@example.com&status=OPEN&perPage=5
Authorization: Bearer {{token}}
```

```http
GET {{baseUrl}}/api/deals?contactPhone=5511999998888&pipelineId=ckxxx&perPage=1
Authorization: Bearer {{token}}
```

Resposta paginada: `total=0` → contato sem deal nesse recorte; `total>=1` →
existe (e `items[]` já traz os deals com `contact`, `stage`, `owner`).
| POST | `/api/deals` | `{ title, stageId, value?, status?, expectedClose?, contactId?, ownerId?, position?, lostReason? }` | Cria deal. Dispara `deal_created` trigger. |
| GET | `/api/deals/[id]` | — | Detalhe completo. |
| PUT | `/api/deals/[id]` | mesmos campos | Atualiza. |
| DELETE | `/api/deals/[id]` | — | Remove. |
| POST | `/api/deals/[id]/move` | `{ stageId, position }` | Move entre estágios. Dispara `stage_changed`. |
| PUT | `/api/deals/[id]/status` | `{ status: "WON"\|"LOST"\|"OPEN", lostReason? }` | Marca ganho/perdido/reabre. Dispara `deal_won`/`deal_lost`. |
| GET | `/api/deals/[id]/timeline` | — | Eventos do deal. |
| GET | `/api/deals/[id]/products` | — | Itens (produtos) do deal. |
| POST | `/api/deals/[id]/products` | `{ productId, quantity?, unitPrice? }` | Adiciona produto. |
| PUT | `/api/deals/[id]/products/[itemId]` | `{ quantity?, unitPrice? }` | Atualiza item. |
| DELETE | `/api/deals/[id]/products/[itemId]` | — | Remove item. |
| GET | `/api/deals/[id]/custom-fields` | — | Custom fields do deal. **Aceita Bearer.** |
| PUT | `/api/deals/[id]/custom-fields` | `{ values: [{ fieldId, value }] }` | Upsert dos custom fields. **Aceita Bearer.** Mesmo formato dos contatos; use `GET /api/custom-fields?entity=deal`. Mudanças geram evento `CUSTOM_FIELD_UPDATED` na timeline. |
| POST | `/api/deals/[id]/tags` | `{ tagId }` ou `{ tagIds: [] }` | Adiciona tag(s). |
| DELETE | `/api/deals/[id]/tags` | `?tagId=...` | Remove tag. |
| POST | `/api/deals/import` | **multipart**: `file` (CSV) | Importação em lote. |
| POST | `/api/deals/bulk` | `{ dealIds: [], action: "move_stage"\|"change_owner"\|"mark_won"\|"mark_lost"\|"delete", payload, async?: boolean }` | Operação em massa. `move_stage` vira async (BullMQ) se `async=true` ou >50 deals. Retorna `{ bulkOperationId }` quando async. |
| POST | `/api/deals/bulk/custom-fields` | `{ dealIds: [], values: {...} }` | Atualização em massa de custom fields (sempre async). |

### 7.2. Pipelines & Stages

| Método | Path | Body | Descrição |
|--------|------|------|-----------|
| GET | `/api/pipelines` | — | Lista pipelines da org. |
| POST | `/api/pipelines` | `{ name }` | Cria pipeline. |
| GET | `/api/pipelines/[id]` | — | Detalhe + stages. |
| PUT | `/api/pipelines/[id]` | `{ name? }` | Atualiza. |
| DELETE | `/api/pipelines/[id]` | — | Remove (somente se vazio). |
| GET | `/api/pipelines/[id]/board` | `?status=&perStage=` | View Kanban com deals agrupados por stage. |
| POST | `/api/pipelines/[id]/board` | `{ action, payload }` | Operações no board (reorder, bulk move). |
| POST | `/api/pipelines/[id]/board/columns` | `{ status?, filters?, sort?, direction?, columns: [{ stageId, cursor, limit? }] }` | "Carregar mais" por cursor: devolve só os próximos cards de cada etapa pedida — `{ columns: [{ stageId, deals, totalCount, hasMore, nextCursor }] }`. `cursor` é o `nextCursor` que a etapa traz no board (ou na página anterior); `status`/`filters`/`sort` devem ser os do board. Não recarrega o board nem usa o cache dele. |
| POST | `/api/pipelines/[id]/stages` | `{ name, color?, position?, isWon?, isLost? }` | Cria stage. |
| PUT | `/api/pipelines/[id]/stages` | `{ stages: [{ id, position }] }` | Reordena stages. |
| PUT | `/api/pipelines/[id]/stages/[stageId]` | `{ name?, color?, isWon?, isLost? }` | Edita stage. |
| DELETE | `/api/pipelines/[id]/stages/[stageId]` | — | Remove stage (sem deals). |
| GET | `/api/stages` | `?pipelineId=` | Lista todos os stages (filtrável por pipeline). |
| GET | `/api/kanban/filter-options` | — | Catálogo de opções p/ filtros do kanban (owners, tags, etc.). |

### 7.3. Activities (Tarefas)

| Método | Path | Query / Body | Descrição |
|--------|------|--------------|-----------|
| GET | `/api/activities` | `?dealId=&contactId=&userId=&type=&completed=true\|false&page=&perPage=` | Lista atividades. |
| POST | `/api/activities` | `{ type, title, description?, scheduledAt?, completedAt?, completed?, contactId?, dealId? }` | Cria atividade. Tipos válidos em `services/activities.ts`. |
| GET | `/api/activities/[id]` | — | Detalhe. |
| PUT | `/api/activities/[id]` | mesmos campos | Atualiza. |
| DELETE | `/api/activities/[id]` | — | Remove. |
| POST | `/api/activities/[id]/toggle` | — | Inverte `completed`. |
| GET | `/api/activities/my` | `?completed=true\|false` | Atividades do user logado. |
| GET | `/api/activities/overdue-count` | — | Contador de tarefas atrasadas (badge). |

### 7.4. Products

| Método | Path | Query / Body | Descrição |
|--------|------|--------------|-----------|
| GET | `/api/products` | `?search=&active=true\|false&type=&page=&perPage=` | Lista produtos. |
| POST | `/api/products` | `{ name, price?, type?, description?, sku?, active? }` | Cria produto. |
| GET | `/api/products/[id]` | — | Detalhe. |
| PUT | `/api/products/[id]` | mesmos campos | Atualiza. |
| DELETE | `/api/products/[id]` | — | Remove. |
| GET | `/api/products/[id]/custom-fields` | — | Custom fields. |
| PUT | `/api/products/[id]/custom-fields` | `{ values: {...} }` | Atualiza. |

### 7.5. Notes

| Método | Path | Body | Descrição |
|--------|------|------|-----------|
| PUT | `/api/notes/[id]` | `{ body }` | Edita nota (mesma org). |
| DELETE | `/api/notes/[id]` | — | Remove nota. |

> Para criar notas, use `POST /api/contacts/[id]/notes`.

### 7.6. Custom Fields (definições)

| Método | Path | Query / Body | Descrição |
|--------|------|--------------|-----------|
| GET | `/api/custom-fields` | `?entity=contact\|deal\|product\|company` | Lista definições. |
| POST | `/api/custom-fields` | `{ entity, name, type: "text"\|"number"\|"date"\|"boolean"\|"select", options?, required? }` | Cria definição. |
| GET | `/api/custom-fields/[id]` | — | Detalhe. |
| PUT | `/api/custom-fields/[id]` | mesmos campos | Atualiza. |
| DELETE | `/api/custom-fields/[id]` | — | Remove. |
| GET | `/api/field-layout` | `?context=&forUser=true\|false` | Layout dos campos por contexto. |
| PUT | `/api/field-layout` | `{ context, fields: [...] }` | Atualiza layout. |

### 7.7. Distribution (rodízio)

| Método | Path | Body | Descrição |
|--------|------|------|-----------|
| GET | `/api/distribution` | — | Lista regras de distribuição. |
| POST | `/api/distribution` | `{ name, type, config }` | Cria regra. |
| PATCH | `/api/distribution/[id]` | mesmos campos | Atualiza. |
| DELETE | `/api/distribution/[id]` | — | Remove. |

---

## 8. Campanhas & Disparos em Massa

### 8.1. Campaigns

| Método | Path | Query / Body | Descrição |
|--------|------|--------------|-----------|
| GET | `/api/campaigns` | `?status=&type=&page=&perPage=` | Lista campanhas. |
| POST | `/api/campaigns` | `{ name, type: "TEMPLATE"\|"TEXT"\|"AUTOMATION", channelId, segmentId?, filters?, templateName?, templateLanguage?, templateComponents?, textContent?, automationId?, sendRate?, scheduledAt? }` | Cria campanha (rascunho). |
| GET | `/api/campaigns/[id]` | — | Detalhe + progresso. |
| PUT | `/api/campaigns/[id]` | mesmos campos | Atualiza enquanto DRAFT. |
| DELETE | `/api/campaigns/[id]` | — | Remove (DRAFT/COMPLETED). |
| POST | `/api/campaigns/[id]/launch` | — | Dispara a campanha (enfileira jobs no BullMQ). |
| POST | `/api/campaigns/[id]/pause` | — | Pausa. |
| POST | `/api/campaigns/[id]/resume` | — | Retoma. |
| POST | `/api/campaigns/[id]/cancel` | — | Cancela definitivamente. |
| GET | `/api/campaigns/[id]/recipients` | `?status=&page=&perPage=` | Lista destinatários e status individual. |
| GET | `/api/campaigns/[id]/stats` | — | Estatísticas (enviadas, entregues, lidas, erros). |
| POST | `/api/campaigns/preview` | `{ segmentId?, filters?, templateName?, templateLanguage?, templateComponents?, textContent? }` | Estima audiência + 1-2 amostras renderizadas, sem enviar. |

### 8.2. Campaign Builder (rascunhos visuais)

| Método | Path | Query / Body | Descrição |
|--------|------|--------------|-----------|
| GET | `/api/campaign-builder/drafts` | `?id=` | Lista ou retorna draft. |
| POST | `/api/campaign-builder/drafts` | `{ steps: [...], meta }` | Cria draft. |
| PATCH | `/api/campaign-builder/drafts` | `{ id, ...patch }` | Atualiza draft. |
| POST | `/api/campaign-builder/drafts/[id]/preview` | `{ contactId? }` | Renderiza preview do draft contra contato sample. |
| POST | `/api/campaign-builder/drafts/[id]/launch` | — | Materializa draft em `Campaign` e dispara. |

---

## 9. Automações & Agentes de IA

### 9.1. Automations (no-code flow)

| Método | Path | Query / Body | Descrição |
|--------|------|--------------|-----------|
| GET | `/api/automations` | `?active=true\|false&search=&page=&perPage=` | Lista automações. |
| POST | `/api/automations` | `{ name, description?, triggerType, triggerConfig, active?, steps: [{ id?, type, config }] }` | Cria automação. **Importante:** preserve `step.id` em round-trips para não quebrar referências internas (`gotoStepId`, `nextStepId`, etc.). |
| GET | `/api/automations/[id]` | — | Detalhe + steps. |
| PUT | `/api/automations/[id]` | mesmos campos | Atualiza (mantém `id` dos steps). |
| DELETE | `/api/automations/[id]` | — | Remove. |
| POST | `/api/automations/[id]/toggle` | — | Inverte `active`. |
| GET | `/api/automations/[id]/audit` | — | Log de mudanças de configuração. |
| GET | `/api/automations/[id]/logs` | `?page=&perPage=&stepId=` | Execuções históricas. |
| GET | `/api/automations/[id]/stats` | — | Métricas (execuções, sucessos, falhas). |
| GET | `/api/automations/audit` | `?includeInactive=true\|false` | Auditoria global de automações da org. |
| GET | `/api/automations/diagnose` | — | Diagnóstico geral (steps malformados, refs órfãs). |
| GET | `/api/automations/diagnostic` | — | (alias) idem acima. |
| POST | `/api/automations/diagnostic` | `{ automationId, payload }` | Diagnóstico dirigido a uma automação. |
| POST | `/api/automations/ai-assistant` | `{ goal: string, currentSteps?: [] }` | Pede ao assistente IA para sugerir steps. |
| POST | `/api/automations/test-fire` | `{ triggerType, payload }` | Simula trigger e mostra steps que executariam. |
| POST | `/api/automations/import-kommo` | **multipart**: `file` (JSON Kommo) | Importa automações exportadas do Kommo. |

#### Exemplo n8n — disparar automação por API

A forma mais comum é fazer a automação ouvir um trigger nativo (`message_received`, `deal_created`, `webhook_received`, etc.) e o n8n só dispara o evento via outra rota do CRM (ex: criar deal). Para forçar execução direta de uma automação específica de fora, use `POST /api/automations/test-fire` (cuidado: é dispatch real, não dry-run).

### 9.2. AI Agents (atendentes-IA)

| Método | Path | Body | Descrição |
|--------|------|------|-----------|
| GET | `/api/ai-agents` | — | Lista agentes IA da org. |
| POST | `/api/ai-agents` | `{ name, persona, instructions, model?, temperature?, tools?, active? }` | Cria agente. |
| GET | `/api/ai-agents/[id]` | — | Detalhe completo. |
| PUT | `/api/ai-agents/[id]` | mesmos campos | Atualiza. |
| DELETE | `/api/ai-agents/[id]` | — | Remove. |
| POST | `/api/ai-agents/[id]/toggle-active` | — | Liga/desliga agente. |
| POST | `/api/ai-agents/[id]/test` | `{ messages: [{ role, content }] }` | Conversa de teste sem afetar inbox. |
| GET | `/api/ai-agents/[id]/stats` | `?days=7` | Métricas (1-30 dias). |
| GET | `/api/ai-agents/[id]/knowledge` | — | Lista documentos da base de conhecimento. |
| POST | `/api/ai-agents/[id]/knowledge` | **multipart**: `file` (PDF/DOCX/TXT) ou `{ url, title }` | Adiciona documento à base. |
| DELETE | `/api/ai-agents/[id]/knowledge/[docId]` | — | Remove documento. |
| POST | `/api/ai-agents/drafts/[messageId]/approve` | — | Aprova rascunho da IA (envia resposta). |
| POST | `/api/ai-agents/drafts/[messageId]/discard` | — | Descarta rascunho. |
| GET | `/api/ai-agents/product-fields` | — | Campos disponíveis para a IA preencher em produtos. |

---

## 10. Canais & WhatsApp

### 10.1. Channels

| Método | Path | Body | Descrição |
|--------|------|------|-----------|
| GET | `/api/channels` | — | Lista canais (WhatsApp/Instagram/Facebook/Email/Webchat). |
| POST | `/api/channels` | `{ name, type: "WHATSAPP"\|"INSTAGRAM"\|"FACEBOOK"\|"EMAIL"\|"WEBCHAT", provider: "META_CLOUD_API"\|"BAILEYS_MD", config: {...}, phoneNumber? }` | Cria canal. Config Meta exige `accessToken`, `phoneNumberId`, `businessAccountId`. |
| GET | `/api/channels/[id]` | — | Detalhe. |
| PUT | `/api/channels/[id]` | mesmos campos | Atualiza. |
| DELETE | `/api/channels/[id]` | — | Remove. |
| GET | `/api/channels/[id]/status` | — | Status atual (CONNECTED/DISCONNECTED/PENDING/QR). |
| POST | `/api/channels/[id]/connect` | — | Inicia conexão (Baileys = pede QR; Meta = valida creds). |
| POST | `/api/channels/[id]/disconnect` | — | Desconecta (não remove). |
| GET | `/api/channels/[id]/qr` | `?prefilled_message=` | QR code Baileys (PNG). Em Meta retorna deeplink wa.me. |
| GET | `/api/channels/[id]/meta-health` | — | Health-check Meta Cloud: assinatura do WABA (`subscribed_apps`) + saúde do número. |
| POST | `/api/channels/embedded-signup` | `{ code, phoneNumberId, wabaId, name?, channelId?, appSecret? }` | Conclui Embedded Signup da Meta (OAuth). `channelId` reconecta canal existente; sem ele cria um novo. |

Resposta do `POST /api/channels/embedded-signup`:
```json
{
  "channel": { "id": "...", "provider": "META_CLOUD_API", "status": "CONNECTED" },
  "webhookSubscribed": true,
  "phoneRegistered": true,
  "displayPhone": "+55 11 99999-9999",
  "verifiedName": "Minha Empresa"
}
```
- `webhookSubscribed`: `true` se o app do CRM foi assinado ao WABA (webhooks entregues). Se `false`, a chamada retorna erro 400.
- `phoneRegistered`: `false` é não-fatal — o número pode precisar de registro/PIN manual no painel Meta para enviar mensagens.

Resposta do `GET /api/channels/[id]/meta-health`:
```json
{
  "channelId": "...",
  "status": "CONNECTED",
  "webhookSubscribed": true,
  "subscribedAppsError": null,
  "phone": { "display_phone_number": "...", "code_verification_status": "VERIFIED", "quality_rating": "GREEN" },
  "phoneError": null
}
```

### 10.2. API Tokens (criação para n8n)

| Método | Path | Body | Descrição |
|--------|------|------|-----------|
| GET | `/api/settings/api-tokens` | — | Lista tokens do user (sem o segredo). |
| POST | `/api/settings/api-tokens` | `{ name, expiresAt?: ISO }` | Cria token. **Response inclui `token` em texto puro — guarde, é a única vez que aparece.** |
| DELETE | `/api/settings/api-tokens/[id]` | — | Revoga. |

Response do POST:
```json
{
  "id": "tok_abc123",
  "token": "crm_RAW_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  "prefix": "crm_RAW_xxxx"
}
```

### 10.3. WhatsApp Flow Definitions (CRM Flows)

| Método | Path | Body | Descrição |
|--------|------|------|-----------|
| GET | `/api/whatsapp-flow-definitions` | — | Lista flows definidos no CRM. |
| POST | `/api/whatsapp-flow-definitions` | `{ name, screens: [...], fieldKeys: [...] }` | Cria flow definition. |
| GET | `/api/whatsapp-flow-definitions/[id]` | — | Detalhe. |
| PUT | `/api/whatsapp-flow-definitions/[id]` | mesmos campos | Atualiza. |
| DELETE | `/api/whatsapp-flow-definitions/[id]` | — | Remove. |
| POST | `/api/whatsapp-flow-definitions/[id]/publish` | — | Publica flow na Meta (vira live). |
| POST | `/api/whatsapp-flow-definitions/[id]/sync-from-meta` | — | Sincroniza estado do flow com a Meta. |
| POST | `/api/whatsapp-flow-definitions/import` | `{ metaFlowId, channelId }` | Importa flow existente na Meta. |
| GET | `/api/whatsapp-flow-definitions/meta-flows` | — | Lista flows na Meta API (para importar). |
| GET | `/api/whatsapp-flow-definitions/lead-mapping-fields` | — | Campos de Deal/Contact disponíveis para mapeamento Flow→CRM. |

### 10.4. WhatsApp Template Configs

| Método | Path | Body | Descrição |
|--------|------|------|-----------|
| GET | `/api/whatsapp-template-configs` | — | Lista configs locais que linkam templates Meta a flows/automações. |
| PUT | `/api/whatsapp-template-configs` | `{ id?, metaTemplateName, channelId, flowId?, category?, ... }` | Cria/atualiza config (upsert). |
| GET | `/api/whatsapp-template-configs/agent-enabled` | — | Configs habilitadas para uso por agentes IA. |

### 10.5. Meta WhatsApp passthrough

| Método | Path | Query / Body | Descrição |
|--------|------|--------------|-----------|
| GET | `/api/meta/whatsapp/message-templates` | `?after=&limit=` | Lista templates Meta da WABA do canal padrão. Paginação cursor. |
| POST | `/api/meta/whatsapp/message-templates` | `{ name, language, category, components: [...] }` | Cria template na Meta (submetido para approval). |
| DELETE | `/api/meta/whatsapp/message-templates/[id]` | — | Remove template na Meta. |
| GET | `/api/meta/whatsapp/call-permission-templates` | — | Templates de pedido de permissão de chamada (categoria PRE_APPROVED). |
| GET | `/api/whatsapp/health` | `?force=true` | Health-check Meta WhatsApp da org (token válido? phoneNumberId existe?). Cache 60s, ignorado se `force`. |

### 10.6. Webhooks de entrada (Meta & Stripe)

| Método | Path | Auth | Descrição |
|--------|------|------|-----------|
| GET | `/api/webhooks/meta` | `?hub.verify_token=&hub.challenge=` | Verificação Meta (responde challenge). |
| POST | `/api/webhooks/meta` | header `X-Hub-Signature-256` | Recebe mensagens inbound/status/flow responses (global). |
| GET | `/api/webhooks/meta/[orgSlug]` | idem | Verificação por org (multi-tenant). |
| POST | `/api/webhooks/meta/[orgSlug]` | idem | Recebe payload por org. URL configurada por canal/org. |
| POST | `/api/webhooks/stripe` | header `Stripe-Signature` | Webhook Stripe (billing, subscriptions). |

> **Estes endpoints não são para chamar do n8n.** Eles recebem dados de
> sistemas externos. Para *enviar* eventos do CRM para n8n, configure um nó
> Webhook no n8n e aponte uma Automation com step `webhook` para ele.

---

## 11. Analytics, Reports & Dashboard

### 11.1. Analytics

| Método | Path | Query | Descrição |
|--------|------|-------|-----------|
| GET | `/api/analytics/dashboard` | `?from=ISO&to=ISO` | Indicadores principais do período. |
| GET | `/api/analytics/dashboard/compare` | `?from=&to=&compFrom=&compTo=` | Indicadores + comparativo período anterior. |
| GET | `/api/analytics/active-time` | `?from=&to=` | Tempo ativo dos agentes. |
| GET | `/api/analytics/forecast` | `?pipelineId=` | Forecast de receita por pipeline. |
| GET | `/api/analytics/funnel` | `?pipelineId=` | Conversão por estágio. |
| GET | `/api/analytics/inbox` | `?from=&to=` | Métricas de inbox (tempo resposta, SLA). |
| GET | `/api/analytics/losses` | `?from=&to=` | Top motivos de perda. |
| GET | `/api/analytics/revenue` | `?from=&to=&groupBy=day\|week\|month` | Receita ao longo do tempo. |
| GET | `/api/analytics/sources` | `?from=&to=` | Distribuição por fonte (lead source). |
| GET | `/api/analytics/stage-ranking` | `?pipelineId=&from=&to=` | Ranking de estágios por velocidade. |
| GET | `/api/analytics/team` | `?from=&to=` | Performance por agente. |

### 11.2. Reports

| Método | Path | Query / Body | Descrição |
|--------|------|--------------|-----------|
| GET | `/api/reports/messaging` | `?from=&to=` | Relatório de mensagens enviadas/recebidas. |
| POST | `/api/reports/messaging/sync` | — | Força recálculo do relatório de mensagens (admin). |
| GET | `/api/reports/phone-changes` | `?from=&to=&limit=` | Auditoria de mudanças de telefone em contatos. |

### 11.3. Dashboard layout

| Método | Path | Body | Descrição |
|--------|------|------|-----------|
| GET | `/api/dashboard/layout` | — | Layout customizado do user. |
| PUT | `/api/dashboard/layout` | `{ widgets: [...] }` | Salva layout. |
| DELETE | `/api/dashboard/layout` | — | Reseta para default. |
| GET | `/api/mobile-layout` | — | Layout mobile. |
| PUT | `/api/mobile-layout` | `{ tabs: [...] }` | Salva layout mobile. |

### 11.4. Metrics & monitor

| Método | Path | Descrição |
|--------|------|-----------|
| GET | `/api/metrics` | Métricas Prometheus (texto plano). Bearer admin. |
| GET | `/api/monitor/agents` | Snapshot em tempo real de status de agentes. |

### 11.5. Bulk Operations (acompanhamento)

| Método | Path | Descrição |
|--------|------|-----------|
| GET | `/api/bulk-operations/[id]` | Status de uma operação em massa (polling). Retorna `{ id, status, total, processed, succeeded, failed, progressPercent, errors[] }`. |

---

## 12. Settings (org & user)

### 12.1. Org / global

| Método | Path | Query / Body | Descrição |
|--------|------|--------------|-----------|
| GET | `/api/organization` | — | Detalhe da org corrente. |
| GET | `/api/settings/org` | `?key=&prefix=` | Lê settings por chave ou prefixo. |
| PUT | `/api/settings/org` | `{ key, value }` | Salva setting. |
| DELETE | `/api/settings/org` | `?key=` | Remove setting. |
| GET | `/api/settings/system` | `?key=` | Settings de sistema (admin). |
| PUT | `/api/settings/system` | `{ key, value }` | Salva. |
| GET | `/api/settings/permissions` | — | Matriz de permissões da org. |
| PUT | `/api/settings/permissions` | `{ role, permissions: {...} }` | Atualiza. |
| GET | `/api/settings/visibility` | — | Regras de visibilidade (quem vê deals/conversas de quem). |
| PUT | `/api/settings/visibility` | `{ rules: [...] }` | Atualiza. |
| GET | `/api/settings/self-assign` | — | Política de self-assign. |
| PUT | `/api/settings/self-assign` | `{ enabled, requireApproval? }` | Atualiza. |
| GET | `/api/settings/loss-reasons` | — | Catálogo de motivos de perda. |
| POST | `/api/settings/loss-reasons` | `{ name, code? }` | Cria. |
| PUT | `/api/settings/loss-reasons/[id]` | `{ name?, code? }` | Atualiza. |
| DELETE | `/api/settings/loss-reasons/[id]` | — | Remove. |
| GET | `/api/settings/ai` | — | Config global de IA da org. |
| PUT | `/api/settings/ai` | `{ provider, apiKey?, defaultModel?, ... }` | Salva config. |
| DELETE | `/api/settings/ai` | — | Reseta config. |
| POST | `/api/settings/ai/test` | — | Testa conexão com provider IA. |

### 12.2. Saved Filters

| Método | Path | Query / Body | Descrição |
|--------|------|--------------|-----------|
| GET | `/api/saved-filters` | `?entityType=deal\|contact\|conversation` | Lista filtros salvos do user. |
| POST | `/api/saved-filters` | `{ name, entityType, filters, shared? }` | Cria. |
| GET | `/api/saved-filters/[id]` | — | Detalhe. |
| PUT | `/api/saved-filters/[id]` | mesmos campos | Atualiza. |
| DELETE | `/api/saved-filters/[id]` | — | Remove. |
| POST | `/api/saved-filters/[id]/duplicate` | — | Duplica. |

---

## 13. Mídia, Uploads & Storage

| Método | Path | Auth | Descrição |
|--------|------|------|-----------|
| POST | `/api/uploads/automation-media` | sessão | **multipart**: `file`. Upload de mídia para automações (carrossel, header). Retorna `{ url }`. |
| GET | `/api/uploads/[...path]` | sessão | Lê arquivo de upload (proxied). |
| GET | `/api/storage/[...path]` | sessão | Lê arquivo do storage (Meta-cached, signed URLs). |
| GET | `/api/media/proxy` | sessão | `?url=` — proxy autenticado para mídia Meta (com refresh de URL expirada). |
| GET | `/api/media/audio-mp3` | sessão | `?url=&name=` — converte mídia áudio (ogg/opus do WhatsApp) para MP3 e retorna stream. |
| POST | `/api/transcribe` | sessão | `{ url }` — transcreve o áudio (Groq Whisper). Retorna `{ transcript }`. |

---

## 14. Push Notifications

| Método | Path | Body | Descrição |
|--------|------|------|-----------|
| GET | `/api/push/vapid-public` | — | Chave pública VAPID (para client subscribe). **Público.** |
| POST | `/api/push/subscribe` | `{ endpoint, keys: { p256dh, auth }, userAgent? }` | Salva subscription Web Push. |
| POST | `/api/push/unsubscribe` | `{ endpoint }` | Remove subscription. |

---

## 15. Admin (super-admin global)

> Requer `User.isSuperAdmin = true`. Bloqueado pelo middleware com 403 caso
> contrário. Cuidado: opera **cross-org**.

| Método | Path | Body / Query | Descrição |
|--------|------|--------------|-----------|
| GET | `/api/admin/billing` | — | Snapshot global de billing (todos os planos, MRR). |
| GET | `/api/admin/db-stats` | — | Estatísticas do banco (tabelas, conexões). |
| GET | `/api/admin/organizations` | `?search=&status=` | Lista todas as orgs do servidor. |
| GET | `/api/admin/organizations/[id]` | — | Detalhe da org. |
| PATCH | `/api/admin/organizations/[id]` | `{ name?, slug?, status?, plan? }` | Edita org. |
| GET | `/api/admin/organizations/[id]/feature-flags` | `?key=` | Feature flags da org. |
| PUT | `/api/admin/organizations/[id]/feature-flags` | `{ key, value }` | Define flag. |
| DELETE | `/api/admin/organizations/[id]/feature-flags` | `?key=` | Remove flag. |
| POST | `/api/admin/organizations/[id]/invite` | `{ email, role }` | Convida user para a org. |
| DELETE | `/api/admin/organizations/[id]/users/[userId]` | — | Remove user da org (não apaga o user). |

---

## 16. Health, Cron & Config Public

| Método | Path | Auth | Descrição |
|--------|------|------|-----------|
| GET | `/api/health` | público | `{ status: "ok" \| "degraded" }`, 200 ou 503. Com `X-Health-Token`/`Authorization: Bearer` igual a `HEALTH_TOKEN`, ou sessão de super-admin: acrescenta `db`, `redis` (`ok`, `latencyMs`/`error`), `uptimeSec`, `timestamp`. Sem CORS. |
| HEAD | `/api/health` | público | Só o status HTTP (200/503). |
| GET | `/health` | público | Página HTML com o estado agregado; cartões de Postgres/Redis/uptime só com `HEALTH_TOKEN` ou super-admin. |
| GET | `/api/internal/cors-origin` | interno | Loopback do middleware (CORS de subdomínio de organização). Sem a chave interna responde 404. |
| GET | `/api/config/public` | público | Feature flags públicos + branding (logo, cores). Não exige auth. |
| GET | `/api/cron/sync-meta-pricing` | `?secret=` ou header CRON | Job diário: sincroniza pricing Meta para todas as orgs. |
| GET | `/api/metrics` | bearer admin | Prometheus metrics. |

---

## 17. Apêndice — Esquema de erros

Todos os endpoints retornam erros no mesmo formato:

```json
{ "message": "Texto em português", "code": "OPCIONAL" }
```

Códigos conhecidos:
- `P2002` → 409 conflito de unicidade (ex.: email duplicado).
- `P2003` → 400 referência inválida (FK).
- `P2025` → 404 registro não encontrado.
- `INVALID_TITLE` / `INVALID_NAME` → 400.
- `CROSS_PIPELINE` → 400 (mover deal entre pipelines diferentes).
- `NOT_FOUND` / `STAGE_NOT_FOUND` → 404.

Para rate-limit (`429`), os headers `X-RateLimit-Limit`, `X-RateLimit-Remaining`
e `X-RateLimit-Reset` indicam quando tentar de novo.

---

## 18. Apêndice — Mapa completo de endpoints (318 funções)

Lista bruta `method | path` para conferência rápida. Asterisco `*` indica
endpoints que aceitam Bearer Token; os demais usam sessão NextAuth.

```
GET     /api/activities*
POST    /api/activities*
GET     /api/activities/my
GET     /api/activities/overdue-count
GET     /api/activities/[id]*
PUT     /api/activities/[id]*
DELETE  /api/activities/[id]*
POST    /api/activities/[id]/toggle
GET     /api/admin/billing
GET     /api/admin/db-stats
GET     /api/admin/organizations
GET     /api/admin/organizations/[id]
PATCH   /api/admin/organizations/[id]
GET     /api/admin/organizations/[id]/feature-flags
PUT     /api/admin/organizations/[id]/feature-flags
DELETE  /api/admin/organizations/[id]/feature-flags
POST    /api/admin/organizations/[id]/invite
DELETE  /api/admin/organizations/[id]/users/[userId]
GET     /api/agents/inbound-voice
POST    /api/agents/me/ping
GET     /api/agents/schedules
GET     /api/agents/status
GET     /api/agents/[id]/schedule
PUT     /api/agents/[id]/schedule
GET     /api/agents/[id]/status
PUT     /api/agents/[id]/status
GET     /api/ai-agents
POST    /api/ai-agents
POST    /api/ai-agents/drafts/[messageId]/approve
POST    /api/ai-agents/drafts/[messageId]/discard
GET     /api/ai-agents/product-fields
GET     /api/ai-agents/[id]
PUT     /api/ai-agents/[id]
DELETE  /api/ai-agents/[id]
GET     /api/ai-agents/[id]/knowledge
POST    /api/ai-agents/[id]/knowledge
DELETE  /api/ai-agents/[id]/knowledge/[docId]
GET     /api/ai-agents/[id]/stats
POST    /api/ai-agents/[id]/test
POST    /api/ai-agents/[id]/toggle-active
GET     /api/analytics/active-time
GET     /api/analytics/dashboard
GET     /api/analytics/dashboard/compare
GET     /api/analytics/forecast
GET     /api/analytics/funnel
GET     /api/analytics/inbox
GET     /api/analytics/losses
GET     /api/analytics/revenue
GET     /api/analytics/sources
GET     /api/analytics/stage-ranking
GET     /api/analytics/team
ALL     /api/auth/[...nextauth]                (NextAuth dinâmico)
POST    /api/auth/mfa/backup-codes
POST    /api/auth/mfa/disable
POST    /api/auth/mfa/setup
GET     /api/auth/mfa/status
POST    /api/auth/mfa/verify
POST    /api/auth/register                     (410 Gone)
GET     /api/automations
POST    /api/automations
POST    /api/automations/ai-assistant
GET     /api/automations/audit
GET     /api/automations/diagnose
GET     /api/automations/diagnostic
POST    /api/automations/diagnostic
POST    /api/automations/import-kommo
POST    /api/automations/test-fire
GET     /api/automations/[id]
PUT     /api/automations/[id]
DELETE  /api/automations/[id]
GET     /api/automations/[id]/audit
GET     /api/automations/[id]/logs
GET     /api/automations/[id]/stats
POST    /api/automations/[id]/toggle
GET     /api/bulk-operations/[id]
GET     /api/campaign-builder/drafts
POST    /api/campaign-builder/drafts
PATCH   /api/campaign-builder/drafts
POST    /api/campaign-builder/drafts/[id]/launch
POST    /api/campaign-builder/drafts/[id]/preview
GET     /api/campaigns
POST    /api/campaigns
POST    /api/campaigns/preview
GET     /api/campaigns/[id]
PUT     /api/campaigns/[id]
DELETE  /api/campaigns/[id]
POST    /api/campaigns/[id]/cancel
POST    /api/campaigns/[id]/launch
POST    /api/campaigns/[id]/pause
GET     /api/campaigns/[id]/recipients
POST    /api/campaigns/[id]/resume
GET     /api/campaigns/[id]/stats
GET     /api/channels
POST    /api/channels
POST    /api/channels/embedded-signup
GET     /api/channels/[id]
PUT     /api/channels/[id]
DELETE  /api/channels/[id]
POST    /api/channels/[id]/connect
POST    /api/channels/[id]/disconnect
GET     /api/channels/[id]/qr
GET     /api/channels/[id]/status
GET     /api/channels/[id]/meta-health
GET     /api/companies*
POST    /api/companies*
GET     /api/companies/[id]
PUT     /api/companies/[id]
DELETE  /api/companies/[id]
GET     /api/config/public                     (público)
GET     /api/contacts*
POST    /api/contacts*
POST    /api/leads*                            (lead atômico — contato + deal + custom fields)
POST    /api/contacts/import
POST    /api/contacts/merge
GET     /api/contacts/[id]*
PUT     /api/contacts/[id]*
DELETE  /api/contacts/[id]*
GET     /api/contacts/[id]/custom-fields
PUT     /api/contacts/[id]/custom-fields
GET     /api/contacts/[id]/notes
POST    /api/contacts/[id]/notes
POST    /api/contacts/[id]/tags
DELETE  /api/contacts/[id]/tags
GET     /api/contacts/[id]/timeline
GET     /api/conversations*
POST    /api/conversations/bulk
POST    /api/conversations/create
GET     /api/conversations/[id]*
POST    /api/conversations/[id]/actions
POST    /api/conversations/[id]/attachments
POST    /api/conversations/[id]/call-permission
PATCH   /api/conversations/[id]/call-permission
GET     /api/conversations/[id]/calling-context
POST    /api/conversations/[id]/forward
GET     /api/conversations/[id]/messages*
POST    /api/conversations/[id]/messages*
PUT     /api/conversations/[id]/pin-note
POST    /api/conversations/[id]/read
GET     /api/conversations/[id]/scheduled-calls
POST    /api/conversations/[id]/scheduled-calls
GET     /api/conversations/[id]/session-debug
POST    /api/conversations/[id]/tags
DELETE  /api/conversations/[id]/tags
POST    /api/conversations/[id]/template
POST    /api/conversations/[id]/typing
GET     /api/conversations/[id]/whatsapp-calls
POST    /api/conversations/[id]/whatsapp-calls
GET     /api/conversations/[id]/whatsapp-calls/recent
POST    /api/conversations/[id]/whatsapp-calls/recording
GET     /api/cron/sync-meta-pricing            (secret query)
GET     /api/custom-fields
POST    /api/custom-fields
GET     /api/custom-fields/[id]
PUT     /api/custom-fields/[id]
DELETE  /api/custom-fields/[id]
GET     /api/dashboard/layout
PUT     /api/dashboard/layout
DELETE  /api/dashboard/layout
GET     /api/deals*
POST    /api/deals*
POST    /api/deals/bulk
POST    /api/deals/bulk/custom-fields
POST    /api/deals/import
GET     /api/deals/[id]*
PUT     /api/deals/[id]*
DELETE  /api/deals/[id]*
GET     /api/deals/[id]/custom-fields
PUT     /api/deals/[id]/custom-fields
POST    /api/deals/[id]/move
GET     /api/deals/[id]/products
POST    /api/deals/[id]/products
PUT     /api/deals/[id]/products/[itemId]
DELETE  /api/deals/[id]/products/[itemId]
PUT     /api/deals/[id]/status
POST    /api/deals/[id]/tags
DELETE  /api/deals/[id]/tags
GET     /api/deals/[id]/timeline
GET     /api/distribution
POST    /api/distribution
PATCH   /api/distribution/[id]
DELETE  /api/distribution/[id]
GET     /api/field-layout
PUT     /api/field-layout
GET     /api/health                            (público)
HEAD    /api/health                            (público)
GET     /api/inbox/agent-capacity
GET     /api/inbox/daily-stats
POST    /api/invites/accept                    (público)
GET     /api/kanban/filter-options
POST    /api/me/data-erase
POST    /api/me/data-export
GET     /api/me/data-export
GET     /api/me/data-export/[id]
GET     /api/media/audio-mp3
GET     /api/media/proxy
POST    /api/messages/[id]/reactions
GET     /api/meta/whatsapp/call-permission-templates
GET     /api/meta/whatsapp/message-templates
POST    /api/meta/whatsapp/message-templates
DELETE  /api/meta/whatsapp/message-templates/[id]
GET     /api/metrics                           (bearer admin)
GET     /api/mobile-layout
PUT     /api/mobile-layout
GET     /api/monitor/agents
PUT     /api/notes/[id]
DELETE  /api/notes/[id]
PATCH   /api/onboarding/branding
POST    /api/onboarding/channel
POST    /api/onboarding/complete
POST    /api/onboarding/invites
PATCH   /api/onboarding/organization
POST    /api/onboarding/pipeline
GET     /api/organization
GET     /api/pipelines*
POST    /api/pipelines*
GET     /api/pipelines/[id]
PUT     /api/pipelines/[id]
DELETE  /api/pipelines/[id]
GET     /api/pipelines/[id]/board
POST    /api/pipelines/[id]/board
POST    /api/pipelines/[id]/board/columns
POST    /api/pipelines/[id]/stages
PUT     /api/pipelines/[id]/stages
PUT     /api/pipelines/[id]/stages/[stageId]
DELETE  /api/pipelines/[id]/stages/[stageId]
GET     /api/products
POST    /api/products
GET     /api/products/[id]
PUT     /api/products/[id]
DELETE  /api/products/[id]
GET     /api/products/[id]/custom-fields
PUT     /api/products/[id]/custom-fields
GET     /api/profile
PUT     /api/profile
POST    /api/profile/avatar
POST    /api/push/subscribe
POST    /api/push/unsubscribe
GET     /api/push/vapid-public                 (público)
GET     /api/quick-replies
POST    /api/quick-replies
PUT     /api/quick-replies/[id]
DELETE  /api/quick-replies/[id]
GET     /api/reports/messaging
POST    /api/reports/messaging/sync
GET     /api/reports/phone-changes
GET     /api/saved-filters
POST    /api/saved-filters
GET     /api/saved-filters/[id]
PUT     /api/saved-filters/[id]
DELETE  /api/saved-filters/[id]
POST    /api/saved-filters/[id]/duplicate
GET     /api/scheduled-messages
POST    /api/scheduled-messages
DELETE  /api/scheduled-messages/[id]
GET     /api/segments
POST    /api/segments
GET     /api/segments/[id]
PUT     /api/segments/[id]
DELETE  /api/segments/[id]
GET     /api/segments/[id]/preview
GET     /api/settings/ai
PUT     /api/settings/ai
DELETE  /api/settings/ai
POST    /api/settings/ai/test
GET     /api/settings/api-tokens
POST    /api/settings/api-tokens
DELETE  /api/settings/api-tokens/[id]
GET     /api/settings/loss-reasons
POST    /api/settings/loss-reasons
PUT     /api/settings/loss-reasons/[id]
DELETE  /api/settings/loss-reasons/[id]
GET     /api/settings/org
PUT     /api/settings/org
DELETE  /api/settings/org
GET     /api/settings/permissions
PUT     /api/settings/permissions
GET     /api/settings/self-assign
PUT     /api/settings/self-assign
GET     /api/settings/system
PUT     /api/settings/system
GET     /api/settings/visibility
PUT     /api/settings/visibility
POST    /api/signup                            (público)
GET     /api/sse/messages                      (stream SSE)
GET     /api/stages
GET     /api/storage/[...path]
GET     /api/tags*
POST    /api/tags*
PUT     /api/tags/[id]
DELETE  /api/tags/[id]
GET     /api/templates
POST    /api/templates
GET     /api/templates/[id]
PUT     /api/templates/[id]
DELETE  /api/templates/[id]
POST    /api/transcribe
POST    /api/uploads/automation-media
GET     /api/uploads/[...path]
GET     /api/users
POST    /api/users
PUT     /api/users/[id]
DELETE  /api/users/[id]
GET     /api/webhooks/meta                     (público, verify)
POST    /api/webhooks/meta                     (público, HMAC)
GET     /api/webhooks/meta/[orgSlug]           (público, verify)
POST    /api/webhooks/meta/[orgSlug]           (público, HMAC)
POST    /api/webhooks/stripe                   (público, HMAC)
GET     /api/whatsapp/health
GET     /api/whatsapp-flow-definitions
POST    /api/whatsapp-flow-definitions
POST    /api/whatsapp-flow-definitions/import
GET     /api/whatsapp-flow-definitions/lead-mapping-fields
GET     /api/whatsapp-flow-definitions/meta-flows
GET     /api/whatsapp-flow-definitions/[id]
PUT     /api/whatsapp-flow-definitions/[id]
DELETE  /api/whatsapp-flow-definitions/[id]
POST    /api/whatsapp-flow-definitions/[id]/publish
POST    /api/whatsapp-flow-definitions/[id]/sync-from-meta
GET     /api/whatsapp-template-configs
PUT     /api/whatsapp-template-configs
GET     /api/whatsapp-template-configs/agent-enabled
GET     /health                                (público; idem /api/health)
```

---

## 19. Apêndice — Cheat sheet n8n

### Configurar Credential
Tipo: **Header Auth**
- Name: `Authorization`
- Value: `Bearer crm_xxxxxxxxxxxxx`

### Nó "HTTP Request" padrão

| Campo | Valor |
|-------|-------|
| Method | conforme tabela acima |
| URL | `{{ $env.CRM_BASE_URL }}/api/contacts` (etc.) |
| Authentication | Header Auth (a credential acima) |
| Send Headers | `Content-Type: application/json` |
| Body Content Type | JSON |
| Body Parameters | Conforme schema do endpoint |

### Fluxos exemplo

1. **Webhook → criar contato + deal (lead-or-create)**
   - **Recomendado:** `POST /api/leads` resolve tudo em **uma chamada** (idempotente
     por phone/email, cria deal no `stageId` escolhido e grava custom fields).
     Ver §6.1 → "`POST /api/leads`".
   - Fluxo manual (legado, mais round-trips):
     - `GET /api/contacts?phone={{phone}}&perPage=1` → reusa `items[0].id` se `total>=1`, senão `POST /api/contacts`.
     - `GET /api/deals?contactPhone={{phone}}&status=OPEN&pipelineId=...` para checar duplicidade.
     - Se não houver deal aberto: `POST /api/deals` com `{title, stageId, contactId}`.
     - Custom fields: `PUT /api/contacts/[id]/custom-fields` e `PUT /api/deals/[id]/custom-fields`.

2. **CRM dispara evento → n8n**
   - Em `/api/automations` criar automação com trigger `deal_won`.
   - Step do tipo `webhook` apontando para URL do n8n.
   - Cada deal ganho gera POST no n8n.

3. **n8n agenda follow-up no CRM**
   - `POST /api/scheduled-messages` com `{conversationId, content, scheduledAt}`.

4. **n8n responde mensagens via template Meta**
   - `POST /api/conversations/[id]/template` com `{templateName, languageCode, components}`.

5. **Sincronizar contatos para outro sistema**
   - Loop em `GET /api/contacts?page=N` até `items` ficar vazio.

---

> **Próximos passos:** este documento cobre todos os 318 endpoints. Se precisar
> de aprofundamento em algum (response body completo, exemplos extras de Flow,
> mapeamento de erros específicos), abra o `route.ts` correspondente — o
> caminho de cada rota está na primeira coluna da tabela.
