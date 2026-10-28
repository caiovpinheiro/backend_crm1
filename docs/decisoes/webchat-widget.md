# Plano: Webchat (chat no site do cliente → inbox)

Status: **aprovado — em execução (Opus)** — 2026-10-17
Domínio: `bwipo.com` (`TENANT_BASE_DOMAIN` default em `src/lib/tenant-url.ts`;
`crm.eduit.com.br` não existe mais — ignorar `docs/tenant-subdomain.md` nesse ponto).
Contexto: pedido do usuário — "um chat para ser plugado na URL do cliente; a
troca de conversas entra no inbox como o WhatsApp, mas fica colocada na
página da org".

> Este documento descreve **o que** fazer e **por quê**. **Backend fases 0+1
> implementadas** (2026-10-17, sem commit) — o contrato real está em §3.4.1.
> Migration `20261017190000_webchat_channel` (SQL novo: o operador roda o
> `migrate deploy`).

---

## 1. Objetivo

Um widget de chat que a org instala no próprio site (snippet `<script>`) ou
usa como página hospedada (`/webchat/{chave}`). Cada visitante que escreve
vira **Contact + Conversation + Message** exatamente como um inbound de
WhatsApp/Instagram — cai no `/inbox`, passa por distribuição, automações,
agentes de IA, push e SSE sem nenhum tratamento especial. O agente responde
pelo composer normal e a resposta aparece no widget em tempo real.

## 2. O que já existe (reuso, não reescrever)

| Peça | Onde | Situação |
|------|------|----------|
| `ChannelType.WEBCHAT` | `prisma/schema.prisma:3688` | Já no enum; aceito em `POST /api/channels` e no onboarding |
| Label/ícone "Webchat" | FE `connection-label.ts`, `channel-card.tsx`, `create-channel-dialog.tsx` (card "Widget no site") | Já renderiza; o dialog hoje cai em `provider=META_CLOUD_API` (errado) |
| Pipeline inbound não-WhatsApp | `src/lib/meta-webhook/messaging-handler.ts` (`processEvent` → `upsertContact` → `ensureOpenDealForContact` → `findOrCreateConversation` → `createMessageDedup` → `touchInbound` → `publishNewMessage` → `notifyInboundMessage` → `fireTrigger` → `onInboundMessageForAi`) | **Modelo a copiar.** O webchat é um terceiro "platform" com a mesma sequência |
| Identidade por canal no contato | `Contact.messengerPsid` / `instagramIgsid` + `@@unique([organizationId, …])` | Mesmo padrão: `webchatVisitorId` |
| Branch de envio por canal | `api/conversations/[id]/messages/route.ts:1611` (`platformFromConversationChannel`) e `sendTextToConversation` (`outbound-messaging.ts:270`, hoje rejeita `channel !== "whatsapp"`) | Adicionar ramo `webchat` |
| Realtime agente | `sseBus` + `publishNewMessage`/`publishTypingEvent` (`source: "contact"`) | Sem mudança para o lado do agente |
| Rate limit | `RATE_LIMIT_PROFILES` (`lib/rate-limit.ts`) | Novos perfis `webchat.*` |
| CORS | `browser-api-cors.ts` — negar por padrão, apex + `{slug}.{base}` liberados | **Não abrir CORS para origens arbitrárias** (ver §3.4) |
| CSP | `security-headers.ts` — `frame-ancestors 'self'` | Exceção só na rota do iframe do widget |
| Canal → funil | `Channel.defaultPipelineId` | Funciona de graça para o webchat |
| Permissão por canal (ver/enviar) | `authz/scope-grants-shared.ts` | Funciona de graça |

## 3. Decisões de arquitetura

### 3.1 Canal

- Novo `ChannelProvider.WEBCHAT` (o enum hoje só tem provedores Meta/Baileys).
  `type=WEBCHAT, provider=WEBCHAT, status=CONNECTED` na criação (não há
  handshake externo). `channel` string da conversa = `"webchat"` (mesmo
  padrão minúsculo de `"whatsapp"`, `"instagram"`).
- `Channel.config` (JSON, não precisa de encriptação — nada é segredo):

  ```ts
  type WebchatChannelConfig = {
    publicKey: string;            // "wc_" + 24 chars — vai no snippet
    allowedOrigins: string[];     // ["https://www.cliente.com.br"]
    identification: "none" | "name" | "name_email" | "name_phone";
    greeting: string;             // "Olá! Como podemos ajudar?"
    offlineMessage: string;       // "Estamos fora do horário…"
    theme: { primary: string; position: "right" | "left"; avatarUrl?: string; title: string };
    businessHours?: { tz: string; week: Record<"mon"|…, [string, string][]> };
    collectTranscriptEmail: boolean;
  };
  ```

  Índice: lookup por `publicKey` acontece a cada chamada pública →
  coluna própria `Channel.publicKey String? @unique` em vez de buscar no JSON.

### 3.2 Identidade do visitante

- `Contact.webchatVisitorId String?` + `@@unique([organizationId, webchatVisitorId])`
  (padrão PSID/IGSID). Um visitante = um contato.
- **Formulário opcional** (`identification` do canal): o visitante pode
  começar a conversar anônimo ("Visitante a1b2c3") e identificar-se depois —
  o widget oferece "Informe seu nome/e-mail/telefone" a qualquer momento, e o
  agente pode pedir. Endpoint `POST /session/identify`.
- **Nunca liga nem funde em contato existente** (decisão 2026-10-28,
  revisão de segurança). O visitante é anônimo: digitar o e-mail/telefone de
  alguém não prova que ele é essa pessoa. A versão anterior ligava a sessão
  ao contato existente (o widget passava a mostrar o histórico webchat dele
  em `GET /messages`), fundia contatos em identifies encadeados e um e-mail
  desconhecido sobrescrevia o contato reivindicado.
  1. O visitante fica no contato que **nasceu no webchat**
     (`Contact.webchatVisitorId === session.id`; criado na hora se ainda não
     existe). Só esse contato recebe nome/e-mail/telefone.
  2. E-mail/telefone (com/sem o 9) que já pertence a outro contato da org →
     **nota interna** na conversa do visitante (`messageType: "note"`,
     `isPrivate: true`, autor "Webchat"): "Visitante do webchat informou o
     e-mail X, que pertence ao contato Nome (#número) — possível duplicado.
     Nada foi unido automaticamente; funda manualmente se for a mesma
     pessoa." Sem ticket ainda (pré-chat), a nota entra quando o ticket
     nascer. Uma nota por texto/ticket. O widget nunca lê nota privada.
  3. A resposta ao widget só traz dados do próprio visitante (sem
     `matchedBy`, sem id/nome do outro contato). `merged` é sempre `false`
     (mantido para o widget antigo).
  4. O inbox recebe `contact_updated` + `conversation_updated` → o card troca
     "Visitante a1b2c3" pelo nome real sem refresh.
- **Conversas unificadas na janela de chat**: hoje o histórico (`history=1`
  em `api/conversations/[id]/messages`) filtra por `channel: conv.channel`.
  Para webchat o histórico passa a ser **do contato, em todos os canais**
  (WhatsApp, Instagram, webchat), com o selo do canal em cada bloco — assim o
  agente vê, na mesma janela, o que o lead já falou no WhatsApp.
- Nova tabela `WebchatSession` (tenant-scoped):

  ```prisma
  model WebchatSession {
    id             String   @id @default(cuid())   // = visitorId
    organizationId String
    channelId      String
    contactId      String
    tokenHash      String   @unique                 // sha256 do JWT emitido
    expiresAt      DateTime
    lastSeenAt     DateTime
    firstUrl       String?
    lastUrl        String?
    referrer       String?
    utm            Json?
    userAgent      String?
    ipHash         String?                           // LGPD: nunca IP cru
    createdAt      DateTime @default(now())
    @@index([organizationId, channelId, lastSeenAt])
    @@index([contactId])
    @@map("webchat_sessions")
  }
  ```

  UTMs/referrer da primeira visita copiados para os campos já existentes do
  `Contact` (`utmReferrer`, `referrer`, `gclid`, `fbclid`, `adUtm*`) —
  o painel de origem de lead passa a enxergar o site.

- Token: JWT HS256 (`WEBCHAT_JWT_SECRET`, fallback derivado de `AUTH_SECRET`),
  claims `{ org, ch, vis, cid }`, validade 30 d, renovado a cada chamada.
  `WEBCHAT_JWT_SECRET` definido com menos de 32 caracteres loga erro no 1º
  uso (e segue no derivado). Ao girar, o token anterior vale por 60 s
  (`webchat_sessions.prevTokenHash` + `rotatedAt`): outra aba ou poll em voo
  não toma 401. Vida máxima da sessão: `WEBCHAT_SESSION_MAX_AGE_DAYS`
  (padrão 90, contada do `createdAt`); passou, o token não autentica e
  `POST /session` cria visitante novo em vez de renovar.
  Guardado em `localStorage` do **iframe** (origem nossa, não do site do
  cliente — o site não lê o token). Enviado em `Authorization: Bearer`.

### 3.3 Hospedagem do widget (como "fica na página da org")

Padrão Intercom/Crisp: **loader + iframe**.

1. `https://bwipo.com/webchat/embed.js` (≈2 KB, estático, cache longo):
   lê `data-key`, injeta o botão flutuante e um `<iframe src="https://bwipo.com/webchat/{publicKey}?host={origin}">`.
   Nada de CSS/JS nosso roda no DOM do cliente → sem conflito de estilo.
   Snippet entregue ao cliente:

   ```html
   <script async src="https://bwipo.com/webchat/embed.js" data-key="wc_xxxxxxxx"></script>
   ```
2. `/webchat/{publicKey}` é uma rota pública do **frontend** (`src/app/webchat/[publicKey]/page.tsx`,
   fora de `(app)`, sem auth, middleware libera o prefixo). Mesma página
   serve como **página hospedada** da org (link direto, QR, bio) quando
   aberta sem iframe — layout full-screen.
3. Segurança do embed:
   - A página do iframe só renderiza se `host` ∈ `allowedOrigins` do canal
     **e** `document.referrer` bate (handshake `postMessage` loader↔iframe
     confirma a origem do pai). `allowedOrigins` vazio = só a página hospedada.
   - Backend envia `Content-Security-Policy: frame-ancestors <allowedOrigins>`
     dinâmico só nessa rota (hoje é `'self'` global — exceção pontual em
     `security-headers.ts`).
   - As chamadas de API saem do iframe (origem = apex) → **CORS atual já
     cobre**; não abrimos origem arbitrária em `/api/*`.

### 3.4 API pública (`/api/public/webchat/*`)

Sem sessão de usuário; identificação por `publicKey` (canal) e Bearer (visitante).
Todas com `corsPathPolicy = tenant` (apex) e rate limit por IP + por visitante.

| Método | Rota | Função |
|--------|------|--------|
| `GET`  | `/config?key=` | tema, greeting, identification, online/offline (horário + presença de agentes com `canAccessChannel`) |
| `POST` | `/session` | cria/renova visitante → `{ token, visitorId, contactId, conversation? }`. Body: `{ key, visitorId?, name?, email?, phone?, page, referrer, utm }` |
| `POST` | `/session/identify` | `{ name?, email?, phone? }` → grava no contato do próprio visitante; dado de outro contato vira nota de possível duplicado (§3.2); devolve `{ contactId, merged: false, contact, token, expiresAt }` |
| `POST` | `/messages` | envia texto: `{ clientMessageId, content }` → pipeline inbound (§3.5). Idempotente por `externalId = "wc:" + visitorId + ":" + clientMessageId` |
| `GET`  | `/messages?after=` | histórico/polling (cursor por `createdAt,id`); marca entregues |
| `GET`  | `/stream` | SSE para o visitante (fase 4) — subscreve `sseBus` filtrando `conversationId` |
| `POST` | `/typing` | `publishTypingEvent({ source: "contact" })` |
| `POST` | `/read` | marca `out` como lidas → `publishMessageStatus` (check azul no inbox) |
| `POST` | `/attachments` | upload (fase 5) — reusa `uploads` + `media-byte-limits` |

Perfis de rate limit: `webchat.session` 10/min/IP, `webchat.message` 20/min/visitante
e 120/min/IP, `webchat.poll` 60/min/visitante. Conteúdo ≤ 4 000 chars.

#### 3.4.1 Contrato implementado (backend, fases 0+1) — **o FE segue isto**

Base: `/api/public/webchat`. Erro sempre `{ message, code }` (`code` ∈
`INVALID_KEY`, `CHANNEL_NOT_FOUND`, `ORIGIN_NOT_ALLOWED`, `TOKEN_MISSING`,
`TOKEN_INVALID`, `TOKEN_EXPIRED`, `INVALID_JSON`, `INVALID_BODY`,
`CONTENT_TOO_LONG`); 429 = `{ error: "rate_limit_exceeded", message, retryAfterSec }`
+ `Retry-After`. Rotas com Bearer: `Authorization: Bearer <token>`.

**Origem** (todas as rotas): `Origin` do browser tem de ser a página do widget
(apex `https://bwipo.com`/`www`, ou extras de `BROWSER_API_CORS_ORIGINS`) ou
estar em `allowedOrigins`; `Origin: null` → 403. `host` (origem da página do
cliente que embute o iframe — o `?host=` do loader) vai em `?host=` no `GET
/config` e em `body.host` no `POST /session`; tem de estar em `allowedOrigins`
(ou ser o próprio apex). `allowedOrigins` vazio = só a página hospedada. As
rotas com Bearer só checam `Origin` (o `host` foi validado ao abrir a sessão).

| Rota | Request | Response |
|------|---------|----------|
| `GET /config?key=wc_…&host=` | — | 200 `{ ...WebchatChannelConfig (achatado: publicKey, allowedOrigins, identification, greeting, offlineMessage, theme, businessHours?, collectTranscriptEmail), online: boolean, channel: { name } }` — `allowedOrigins` é público de propósito (o FE monta `frame-ancestors`). `theme` vem **resolvido**: `{ primary: string, avatarUrl: string \| null, position, title }` (herança abaixo) |
| `POST /session` | `{ key, name?, email?, phone?, page?, referrer?, utm?: { utm_source…, gclid, fbclid }, host? }` + Bearer opcional (renova) | 200 `{ token, expiresAt, visitorId, contactId: string \| null, conversation: { id, number, status } \| null, contact: { name, email, phone, identified } \| null, renewed: boolean, merged?: boolean }` |
| `POST /session/identify` | Bearer + `{ name?, email?, phone? }` (≥ 1) | 200 `{ contactId, merged: false, contact: { name, email, phone, identified }, token, expiresAt }` — só dados do próprio visitante; **trocar o token salvo** (o anterior vale 60 s) |
| `POST /messages` | Bearer + `{ clientMessageId: /[A-Za-z0-9_-]{1,64}/, content ≤ 4000 }` | 201 nova / 200 repetida `{ message: VisitorMessageDto, conversationId, contactId, duplicate: boolean }` |
| `GET /messages?after=<cursor ou id da última msg>` | Bearer | 200 `{ messages: VisitorMessageDto[], cursor: string \| null, hasMore: boolean, agentTyping: boolean, agentReadAt: string \| null }` |
| `POST /typing` | Bearer + `{ typing?: boolean }` (ausente = true; `false` não publica) | 200 `{ ok: true, published: boolean }` |
| `POST /read` | Bearer + `{ upToMessageId? }` (opcional; sem ele, todas) | 200 `{ ok: true, updated: number }` |

```ts
type VisitorMessageDto = {
  id: string;                    // id interno (use em upToMessageId)
  clientMessageId: string | null; // só nas "in" (o id que o widget mandou)
  direction: "in" | "out";
  content: string;
  messageType: string;           // "text" na v1
  mediaUrl: string | null;
  createdAt: string;             // ISO
  senderName: string | null;     // nome do agente nas "out"
  authorType: "human" | "bot" | "system";
  status: string | null;         // "out": sent | delivered | read | failed; "in": null
};
```

`agentTyping` = agente com o composer ativo no ticket aberto (a rota de
typing do agente marca uma chave de 6 s quando a conversa é webchat).
`agentReadAt` = `Conversation.lastReadAt` do ticket aberto (última vez que um
agente abriu a conversa no inbox) — o widget marca "lido" nas `in` com
`createdAt <= agentReadAt`. `typing` e `read` respondem **200 JSON**, não 204.

`GET /messages`: sem `after` = últimas 50 em ordem cronológica (`hasMore` =
há mais antigas; a v1 não pagina para trás); com `after` = as seguintes ao
cursor, asc, até 50 (`hasMore` = tem mais para buscar já). Sem novidade, o
`cursor` volta igual ao `after`. Só mensagens de chat dos tickets **webchat**
do visitante neste canal (nada de nota interna, rascunho, evento nem histórico
de outros canais). As `out` devolvidas passam de `sent` → `delivered`.

Rate limit real: `webchat.session` 10/min/IP só para visitante **novo**
(renovação com Bearer autêntico gasta `webchat.poll` do visitante);
`webchat.message` 20/min/visitante + `webchat.message.ip` 120/min/IP no `POST
/messages` (o identify gasta `webchat.message` do visitante); `webchat.poll`
60/min/visitante em `GET /messages`, `typing`, `read`, renovação;
`webchat.config` 120/min/IP no `GET /config` (perfil a mais).

**Desvios do plano (decididos na implementação):**

1. **Abrir o chat não cria contato.** `WebchatSession.contactId` é
   **nullable**: o contato nasce na 1ª mensagem (`Visitante xxxxxx`) ou no
   identify/pré-chat (com os dados). Evita um contato por page view (e
   gatilho `contact_created` à toa). `POST /session` devolve `contactId: null`
   nesse caso.
2. **Token renovado no `POST /session`, não em toda chamada** (o widget
   chama `/session` a cada carga de página). Vencido mas autêntico (último
   emitido para a sessão) também renova. `visitorId` sozinho **não** retoma a
   sessão (sem prova de posse seria sequestro de conversa) — o campo é
   aceito e ignorado. `identify` sempre devolve token novo.
3. **Identify com pré-chat**: `POST /session` com `name/email/phone` já
   identifica (mesma regra do `/session/identify`): sempre no contato do
   próprio visitante, nunca ligado a um existente (§3.2, revisão
   2026-10-28).
   **Rate limit:** visitante novo sempre gasta do balde de criação por IP
   (`webchat.session`, IPv6 agrupado por /64); o balde do visitante só vale
   quando a renovação é de fato possível (token autêntico E aceito pela
   sessão). Corpo das rotas públicas limitado a 32 KB (413).
   **Título do deal:** depois do identify (com nome) ou do merge manual, os deals
   ABERTOS do contato que ainda têm exatamente o título gerado para o
   anônimo (`defaultDealTitleForContact("Visitante xxxxxx")` = "Negócio
   Visitante xxxxxx") passam para `defaultDealTitleForContact(nome real)`.
   Título editado pelo operador (qualquer outro texto) não muda.
   `mergeContacts` (inclusive o merge manual do operador) reponta as
   `webchat_sessions` do contato removido — o visitante não perde a sessão.
4. **`online`** = horário comercial (se configurado) **e** existe humano da
   org com presença fresca (`system_usage_sessions`). Não filtra por
   permissão de canal (v1). Cache 30 s.
5. **Canal**: `type=WEBCHAT` força `provider=WEBCHAT` em `POST /api/channels`
   e `POST /api/onboarding/channel` (o dialog antigo mandava
   `META_CLOUD_API`). Nasce `CONNECTED` com `publicKey` (coluna) espelhada em
   `config.publicKey`. `PUT /api/channels/:id` (e alias `PATCH`) aceita
   `config` **parcial** — validado e mesclado sobre o gravado; `publicKey`
   nunca muda por aí; config inválido → 400 `{ message }`. Tipo/provedor de
   webchat não troca. `GET /api/channels` devolve a linha inteira
   (`publicKey`, `config`).
   **Marca da org (herança do tema):** `config.theme.primary` e
   `config.theme.avatarUrl` são **opcionais** no config gravado — ausentes =
   herdar. Canal novo nasce **sem** `primary`/`avatarUrl`. No `GET
   /api/public/webchat/config` o tema efetivo é `primary` ← canal ou
   `Organization.primaryColor` (cor inválida/vazia → `#2563EB`) e `avatarUrl`
   ← canal ou `Organization.logoUrl` (ou `null`). Para o painel, **só em
   canais WEBCHAT**, `GET /api/channels`, `POST /api/channels` e a resposta do
   `PUT`/`PATCH /api/channels/:id` incluem `webchatDefaults: { primary:
   string, avatarUrl: string | null }` (a marca da org); `config.theme` vem
   como gravado (sem `primary` = herdando). `PUT` com `theme.primary: null`
   e/ou `theme.avatarUrl: null` volta a herdar. A troca da marca da org
   reflete no widget em até 60 s (cache do canal).
6. **Outbound** (`POST /api/conversations/:id/messages`, conversa
   `channel="webchat"`): grava `out` com `sendStatus="sent"`, sem API
   externa; ignora override de canal do composer. Resposta igual aos outros
   canais + `message.channel: "webchat"`.
7. **Histórico unificado** (`GET …/messages?history=1` em conversa webchat):
   tickets anteriores do contato em **todos** os canais (encerrados de
   qualquer canal + ativos de outros canais). Cada mensagem e cada
   `ticket-separator` (campo e JSON do `content`) trazem `channel`
   (`"whatsapp"`, `"instagram"`, `"webchat"`…). As mensagens do ticket atual
   também trazem `channel: "webchat"`. O delta (`after=` cursor de timeline)
   não traz `channel` — assumir o da conversa.
8. Validação do `WebchatChannelConfig` (PUT/POST): `allowedOrigins` = origens
   `https://host[:porta]` sem caminho (máx. 20, normalizadas);
   `identification` ∈ `none|name|name_email|name_phone`; `theme.primary`
   `#RGB|#RRGGBB` **ou `null`/ausente (herda a org)**; `theme.position`
   `right|left`; `theme.title` ≤ 80; `theme.avatarUrl` https **ou
   `null`/ausente (herda o logo da org)**; `greeting`/`offlineMessage` ≤ 500;
   `businessHours` = `{ tz (IANA, default America/Sao_Paulo), week: { sun…sat: [["08:00","18:00"]] } }`
   ou `null` para remover; `collectTranscriptEmail` booleano.

**Validação ponta a ponta (2026-10-17, BE :3001 + FE :3010, sem Redis)** —
contrato acima confirmado; ajustes e observações:

9. **CSP do iframe (FE)**: o cache de 60 s de `allowedOrigins` no middleware
   (`webchat-frame-policy.ts`) agora rebusca quando o `?host=` não está na
   lista em cache (no máx. 1×/5 s por chave). Antes, a origem recém-liberada
   no painel ficava bloqueada por até 60 s.
10. **Tempo real sem Redis**: `sseBus` virou singleton em `globalThis`
    (rotas são bundles diferentes). Sem isso, no modo sem Redis nenhum
    `publish` (webchat, mensagens do agente, status, typing) chegava a
    `GET /api/sse/messages` — inbox sem tempo real e sweepers agendados 1×
    por bundle. Com Redis (produção) o comportamento não muda.
11. **Dev local**: com `TENANT_BASE_DOMAIN=localhost` toda origem
    `http://localhost:*`/`*.localhost` é classificada como apex — vale como
    página hospedada no `Origin` **e** no `host`. Para testar
    `ORIGIN_NOT_ALLOWED` localmente use outro hostname (ex.:
    `http://127.0.0.1:8788`). Em produção o apex é só `bwipo.com`/`www`.
12. **`online`** depende de `system_usage_sessions`: banco criado com
    `prisma db push` não tem os índices únicos parciais das migrations
    (`system_usage_sessions_open_per_user_uq`,
    `conversations_active_contact_channel_*`…) → a batida de presença falha
    (`ON CONFLICT` sem índice) e o widget fica sempre "Fora do horário".
    Use `migrate deploy` (ou crie esses índices) em ambientes de teste.
13. Identify com o nome pré-preenchido "Visitante xxxxxx" + e-mail de
    contato existente: o nome do existente é preservado (ok). O deal
    automático do anônimo é movido com o título antigo ("Negócio Visitante
    xxxxxx") — não é renomeado.

### 3.5 Inbound (visitante → inbox)

Novo `src/lib/webchat/inbound.ts`, cópia disciplinada de
`messaging-handler.processEvent` com `platform = "webchat"`:

1. `upsertContact` por `webchatVisitorId` (nome do pré-chat ou `"Visitante " + id.slice(-6)`, `source: "Webchat"`, `lifecycleStage: LEAD`).
2. `fireTrigger("contact_created", { source: "Webchat", channel: "Webchat" })` se novo.
3. `ensureOpenDealForContact({ source: "auto_webchat", channelId })` → respeita `Channel.defaultPipelineId`.
4. `findOrCreateConversation(contactId, "webchat", channelId)` — mesma função,
   mesma `activeConversationOnAccountWhere`; `maybeDistributeNewInboundTicket`.
5. `createMessageDedup` → `Message { direction: "in", messageType: "text", externalId }`.
6. `touchInbound` + `publishNewMessage` + `notifyInboundMessage` + `fireTrigger("message_received")`.
   **Sem `onInboundMessageForAi`** (revisão 2026-10-28): o agente de IA só
   envia pela Meta e, no webchat, caía no cliente global do .env e mandava
   WhatsApp para o telefone que o visitante digitou. O ticket segue para
   atendimento humano até existir entrega de IA pelo widget.

Resultado: inbox, distribuição inteligente, automações, IA v2, push e
painéis enxergam o webchat sem código novo.

### 3.6 Outbound (agente → visitante)

- `api/conversations/[id]/messages/route.ts`: ramo `conv.channel === "webchat"`
  → grava `Message { direction: "out", sendStatus: "sent" }`, `publishOutboundNewMessage`,
  side-effects normais (`afterOutboundSideEffects`). Sem API externa: a
  entrega é o próprio banco + stream do visitante. `delivered` quando o
  widget busca, `read` quando reporta.
- **Nada de uma conversa webchat sai pela Meta/WhatsApp** (revisão
  2026-10-28): `metaClientFromConfig` devolve cliente vazio para config de
  canal webchat (nunca o singleton do .env); `sendWhatsAppText/Media`
  recusam; anexo, modelo, encaminhamento e aprovação de rascunho de IA
  respondem 422 `WEBCHAT_UNSUPPORTED`; `sendAgentMessage`/`sendAgentMedia`
  pulam; passos de WhatsApp de automação cujo canal/conversa é webchat
  falham com `MetaSendFailureError` (ramo "Falha ao enviar") sem abrir
  ticket de WhatsApp. Só o texto do composer chega ao visitante.
- `sendTextToConversation` (usado por automações/IA/integrações): trocar o
  guard `channel !== "whatsapp"` por um `switch` de canal — hoje **IA e
  automações não conseguiriam responder webchat**. Instagram tem o mesmo
  gap; resolver os dois juntos.
- `automation-executor.ts` tem `where: { channel: "whatsapp" }` hardcoded em
  ~8 pontos (ex.: linhas 447, 494, 536, 5249). Auditar e trocar por
  "canais de chat" onde fizer sentido (fase 5).

### 3.7 O que **não** se aplica ao webchat (gating no FE)

Janela de 24 h (`channel-session.ts`), templates Meta, botões/listas
interativas, Flows, ligações WhatsApp, consentimento de chamada, grupos.
O composer do inbox deve esconder isso quando `conv.channel === "webchat"`
(hoje a lógica é por `channelProvider`; `WEBCHAT` cai naturalmente fora, mas
precisa de teste).

## 4. Frontend CRM

1. **Criar canal** (`create-channel-dialog.tsx`): `WEBCHAT` → `provider: "WEBCHAT"`,
   sem telefone/QR; cria e abre o painel de configuração.
2. **Painel do canal Webchat** (novo `components/channels/webchat-config-panel.tsx`,
   ao lado de `meta-config-panel.tsx`): snippet para copiar, link da página
   hospedada, `allowedOrigins`, aparência (cor, posição, título, avatar),
   saudação, identificação exigida, horário, mensagem offline, preview ao vivo
   (o próprio iframe em modo preview).
3. **Inbox**: ícone/label já existem; conferir card (prévia, filtro por canal
   `?channel=N`), cabeçalho (mostrar página de origem/UTM no painel do contato),
   composer sem features WhatsApp (§3.7), indicador "visitante digitando"
   (já existe para `source: "contact"`), status "visitante online/offline"
   (`lastSeenAt` da sessão via `conversation_updated`).
4. **Página do visitante** `src/app/webchat/[publicKey]/page.tsx` + `embed.js`
   em `public/webchat/` (versionado: `embed.js?v=1`).

## 5. Widget (UI do visitante)

Estados: bolha fechada (badge de não lidas) → painel aberto → pré-chat
(se `identification ≠ none`) → chat → offline (formulário "deixe contato").
Recursos v1: texto, histórico persistente entre páginas/abas (`localStorage`
do iframe), typing nos dois sentidos, recibos (enviado/lido), som opcional,
mobile full-screen, tema via `config`. Sem dependência do design system do
CRM (bundle ≈ 40 KB, Preact ou React isolado).

## 6. Fases

| Fase | Entrega | Estimativa |
|------|---------|-----------|
| 0 | Schema: `ChannelProvider.WEBCHAT`, `Channel.publicKey`, `Contact.webchatVisitorId`, `WebchatSession`; migration + testes de isolamento | 1 d |
| 1 | `/api/public/webchat/{config,session,messages}` + `lib/webchat/inbound.ts` + ramo outbound na rota de mensagens; polling 3 s | 3–4 d |
| 2 | Página `/webchat/[publicKey]` + `embed.js` + CSP/middleware; snippet funcionando num site de teste | 4–5 d |
| 3 | CRM: dialog + painel de configuração do canal + ajustes do inbox/composer | 3 d |
| 4 | SSE do visitante, typing, recibos de leitura, presença online | 2–3 d |
| 5 | Anexos, horário comercial/offline + e-mail de transcrição, Turnstile anti-bot, retenção LGPD (`db-retention`) | 3–4 d |
| — | **Fora de escopo por ora** (decisão 2026-10-17): IA/automações respondendo webchat (`sendTextToConversation` multi-canal, `automation-executor` com `channel: "whatsapp"` hardcoded). O inbound continua disparando gatilhos; o turno de IA não é aberto para webchat (revisão 2026-10-28) e todo envio automático por WhatsApp de conversa webchat é bloqueado. | — |

Fase 1 já entrega o requisito central (conversa no inbox). Fases 1→3 são
sequenciais; 4 e 5 são independentes entre si.

Execução: backend (fases 0+1) e frontend (fases 2+3) em sessões Opus
paralelas, este documento é o contrato entre as duas. Nada é commitado sem
pedido explícito.

## 7. Testes

- Unit: inbound idempotente (`clientMessageId` repetido), merge de contato por
  e-mail, origem fora de `allowedOrigins` → 403, JWT expirado → 401, rate limit.
- Integração: visitante envia → `Conversation.channel = "webchat"` + SSE
  `new_message` para o agente; agente responde → aparece no `GET /messages`.
- `scripts/test-tenant-isolation.ts`: incluir `webchat_sessions`.
- E2E manual: snippet em página estática local (`http://cliente.localhost`)
  com `allowedOrigins` configurado.

## 8. Decisões tomadas (2026-10-17)

1. **Domínio** — tudo em `bwipo.com`: `https://bwipo.com/webchat/embed.js`,
   página do iframe/hospedada `https://bwipo.com/webchat/{publicKey}`, API em
   `/api/public/webchat/*` via o mesmo apex (CORS atual cobre).
2. **Identificação** — formulário **opcional** (configurável por canal).
   Com ou sem formulário, ao identificar-se o visitante é cruzado com contato
   existente (e-mail/telefone) — **revisto em 2026-10-28: não funde mais**,
   só deixa nota de possível duplicado para o agente fundir manualmente.
   O histórico unificado (`history=1`) respeita o escopo de canais do
   agente (§3.2).
3. **IA/automações** — **não** por enquanto (fora de escopo, ver §6).
