# Decisões Estruturais — CRM EduIT (Backend)

Registro de decisões técnicas que afetam estrutura do projeto. Cada entrada
documenta **por que** algo foi feito, não **o que**.

---

### 2026-09-03 — Resumable Upload de header IMAGE com App Access Token

**Decisão.** `uploadResumableHandle` (criação de template IMAGE/VIDEO/DOCUMENT) usa App Access Token (`CRM_META_APP_ID|META_APP_SECRET`) e body JSON em `POST /{app-id}/uploads`, não o token do canal.

**Contexto.** Cadastro de template TEXT funcionava; IMAGE falhava com Meta 100/33 `Object with ID '…'` — o ID era o App (ou parecia Phone Number ID). Token do canal gerencia a WABA mas muitas vezes não tem o App como asset na borda `/uploads`.

**Alternativas descartadas.** Continuar com token do canal (quebrado). Usar WABA ID em `/uploads` (Meta rejeita 100/33).

**Impacto.** `client.ts` `uploadResumableHandle`. Exige `META_APP_SECRET` no deploy da API. Campanha: `headerMediaType` no payload + `strictFlowEnrich: false` no prepare.

---

### 2026-09-03 — Variáveis de template em campanha via custom fields

**Decisão.** `Campaign.templateComponents` aceita wrapper `{ version: 1, components, headerMediaUrl }` com tokens `{{dealCustomFields.x}}`. O worker resolve por destinatário (negócio OPEN + CFs) e injeta header IMAGE/VIDEO/DOCUMENT. Array legado (sem tokens) permanece estático para todos.

**Contexto.** Blast com imagem e `{{1}}` por pessoa; hoje o mesmo payload ia para todos e IMAGE sem header quebrava (132012). Automações já interpolavam; campanha não.

**Alternativas descartadas.** Coluna nova `templateHeaderMediaUrl` (desnecessário: JSON já existe). Resolver no create (valores mudam até o envio). Sempre exigir mapeamento (templates sem vars não precisam da UI).

**Impacto.** `campaign-template-variables.ts`, `template-header-media.ts`, `campaigns-worker`. Front: mapper só quando há header mídia ou placeholders no corpo.

---

### 2026-09-02 — MANUAL execute inline (não na fila do worker)

**Decisão.** `triggerSource=MANUAL` (Transferir / Distribuir p/ departamento) volta a rodar `executeDistribution` no processo da API. A fila `distribution-execute` fica para redistribute/stuck-inbound.

**Contexto.** Depois de mover o execute para o worker (2026-09-02 14:58 BRT), zero logs MANUAL. O worker em produção só mostra `distribution-drain` (`capacity_released` + COOLDOWN). IA/SYSTEM continuaram porque já chamam o motor direto. Consultor via toast de falha; o departamento do Transfer até gravava, o dono não.

**Alternativas descartadas.** Esperar o worker consumir `distribution-execute` (imagem/fila). Tratar 202 como sucesso (o job nunca rodava).

**Impacto.** `runDistributionExecuteOrInline`. Drain continua no worker.

---

### 2026-09-02 — Transferência de departamento com reassign

**Decisão.** Transferir só para departamento (`explicitAgent: false`) chama `executeDistribution` com `reassign: true`. Job ainda na fila (`queued`) conta como sucesso na API de transfer e no kebab.

**Contexto.** O worker `distribution-execute` passou a responder 202. Sem `reassign`, o motor devolvia `ASSIGNED` e mantinha o dono. O front lia `{ queued: true }` sem `success` e mostrava "Não foi possível distribuir."

**Alternativas descartadas.** Sempre `reassign` (apagaria o agente escolhido no mesmo transfer). Tratar 202 como erro e pedir retry.

**Impacto.** `src/lib/transfer-distribution.ts`, `conversations/[id]/actions`. Front: `outcome-toast.ts`. Já em `main` e `DEV_BRANCH`.

---

### 2026-09-02 — Demandas com vários responsáveis

**Decisão.** Tabela `demand_item_assignees` (N:N). `DemandItem.assigneeId` continua sendo o primeiro da lista. GET `/api/demands/boards` e GET `/api/demands/users` devolvem humanos da org. Create/PATCH aceitam `assigneeIds[]`.

**Contexto.** O form de solicitação precisa listar a equipe e atribuir a uma ou mais pessoas.

**Alternativas descartadas.** Só `assigneeId` (não cobre vários). Array JSON no item (sem FK). Reusar GET `/api/users` (já existe, mas a tela de demandas precisa da lista no próprio fluxo).

**Impacto.** `src/services/demands.ts`, rotas de demands, migration `20260902160000_demand_item_assignees`. Front: usar `users` + `assigneeIds`.

---

### 2026-09-01 — Mailjet via HTTPS, não SMTP

**Decisão.** Envio transacional passa a `POST https://api.mailjet.com/v3.1/send` (443, IPv4). Continua usando `SMTP_USER`/`SMTP_PASS` (API key + secret do Mailjet) e `SMTP_FROM_*`. `SMTP_HOST`/`SMTP_PORT` deixam de ser usados.

**Contexto.** No container da API, `in-v3.mailjet.com:587` dá TIMEOUT; `api.mailjet.com:443` conecta. O VPS bloqueia SMTP de saída.

**Alternativas descartadas.** Insistir em Nodemailer/587 (não sai). Pedir abertura de SMTP no host (mais lento, e 465/25 costumam estar fechados também). Nova env `MAILJET_*` (desnecessário: as keys SMTP do Mailjet já são as da API).

**Impacto.** `src/lib/mail/transport.ts`. Deploy precisa de **rebuild**. Nodemailer fica no package.json, sem uso neste fluxo.

---

### 2026-09-01 — SMTP lido em runtime (sem inlining do Next)

**Decisão.** Mail e `secrets` env-provider passam a ler env via `globalThis.process.env[name]`. Nomes SMTP são montados com `join` pra o webpack não substituir `process.env.SMTP_HOST` por `undefined` no `next build`.

**Contexto.** EasyPanel tinha as vars no painel; o log da API era `SMTP_HOST ausente`. O `Ready in 360ms` foi restart da imagem antiga, buildada sem SMTP — o Next tinha congelado vazio no bundle (mesmo padrão do `NEXTAUTH_URL` em 2026-05-14).

**Alternativas descartadas.** Listar SMTP em `next.config env` (pior: congela no build). Exigir rebuild só com a var no build-arg.

**Impacto.** `src/lib/runtime-env.ts`, `env-provider.ts`, `mail/transport.ts`. Deploy precisa de **rebuild** da imagem, não só restart.

---

### 2026-09-01 — E-mail transacional, convite hashed, verificação no signup

**Decisão.** Nodemailer + SMTP (Mailjet) para convite, reset de senha, verificação de posse no signup do primeiro ADMIN e welcome após aceite. `OrganizationInvite.token` ficou nullable; novos convites gravam só `tokenHash`. Reenvio revoga o token anterior (`revokedAt` + `expiresAt=now`) e emite outro — `acceptedAt` só no aceite real. Usuários já existentes recebem `emailVerifiedAt = createdAt` na migration e não são forçados a verificar.

**Contexto.** O plano de e-mail transacional foi aprovado com três ajustes: prova de posse no signup (não só welcome), convites sem plaintext, e resend sem marcar aceite.

**Alternativas descartadas.** Welcome sem código no signup. Invalidar convite anterior com `acceptedAt`. Trocar NextAuth Credentials.

**Impacto.** Schema (`emailVerifiedAt`, `PasswordResetToken`, `EmailVerificationToken`, invite hash/revoke/pending role/CRM). APIs públicas de forgot/reset/verify e `/api/invites/validate`. Equipe passa a convidar por e-mail; `POST /api/users` com senha permanece.

---

### 2026-08-31 — tenant-lookup devolve lista de orgs

**Decisão.** `POST /api/auth/tenant-lookup` passa a usar `findMany` e devolver `orgs[]` + `displayName`. 1 org ACTIVE ainda manda `slug` (clientes antigos e users atuais iguais). 2+ orgs mandam a lista sem `slug`. Super-admin sem org e 404 genérico não mudam. `User.email` continua `@unique` — nenhum login existente quebra.

**Contexto.** Preparar o seletor visual no apex sem soltar a unicidade global (authorize e criação de user ainda assumem um e-mail).

**Alternativas descartadas.** Trocar a unique agora (quebraria `findUnique({ email })` em dezenas de pontos). Membership.

**Impacto.** Só esta rota. Front novo ignora `orgs` vazio e segue `slug`.

---

### 2026-08-31 — Bearer só em api-public + 240 rpm/org

**Decisão.** Token `eduit_…` válido em produção só é aceito quando `APP_MODE=api-public`. Na API privada (`APP_MODE=api`) devolve 401 `bearer_requires_public_api` apontando `API_PUBLIC_BASE_URL` (default `https://integrations.bwipo.com`). Teto Bearer por org: 240 req/min (`TOKEN_ORG_RATE_LIMIT_RPM`), bucket Redis `org:{id}:rpm:token`. Sessão/inbox inalteradas (`api.session` 600/user; `ORG_RATE_LIMIT_RPM` 400 não vale para Bearer).

**Contexto.** Integrações (n8n e tokens de org) saturavam o event loop da inbox. O host `integrations.bwipo.com` já isolou o processo; faltava recusar Bearer no host antigo e baixar o teto de 400 → 240 por org (soma de todos os tokens).

**Alternativas descartadas.** Recusar qualquer header Bearer na API privada (quebraria fallback sessão + token inválido do cockpit). Baixar `ORG_RATE_LIMIT_RPM` global (apertaria perfis que não são n8n). URL por subdomínio de org (a org já vem do token).

**Escape.** `ALLOW_BEARER_ON_PRIVATE_API=1` e `NODE_ENV !== production` continuam aceitando Bearer (dev local / rollback).

**Impacto.** `authenticateApiRequest`, lane token do org RPM, perfil `api.token`. Meta/webhooks/cron/sessão não passam por esse caminho.

---

### 2026-08-27 — Aba "Agente IA" na Inbox

**Decisão.** Nova categoria `agente_ia` em `INBOX_CATEGORY_TABS`: conversa OPEN, sem erro, com responsável `User.type = AI`. As abas Entrada, Aguardando, Respondidas e Automação passaram a exigir assignee HUMANO (ou nenhum) — o assignee IA saiu delas. Permission `inbox:tab:agente_ia` (migration `20260827180000`) com fallback de rollout para `inbox:tab:entrada` / `inbox:tab:automacao` em `canSeeInboxTab` e `withInboxQueueVisibility`.

**Contexto.** Os leads em atendimento pela IA ficavam espalhados: com inbound caíam em Entrada, sem inbound em Automação. Não havia como ver a fila da IA nem separar o que já é responsabilidade de um consultor.

**Handoff.** O lead sai da aba nos dois desfechos: consultor elegível → Entrada com dono; fila cheia / ninguém elegível → `DistributionPending` e Entrada sem dono. `executeDistribution` (reassign) agora também limpa `Contact.assignedToId` e `Deal.ownerId` quando a conversa já chegou sem responsável mas o dono ainda é o usuário IA — caminho do `executeAcademicDepartmentHandoff`, que zera a conversa antes de chamar o motor. Sem isso o lead ia para a espera com a IA como dono no pipeline e o sync devolvia o card para a aba. Os limites de fila dos consultores não mudaram e não se aplicam à IA.

**Alternativas descartadas.** Filtrar só no frontend (badges e paginação viriam errados; `todos`/permissões são server-side). Reaproveitar a aba Automação (mistura robô de campanha com atendimento da IA). Gate por `includeUnassigned` na fila da IA (lá o responsável existe, não é pool livre).

**Cockpit.** `totals.attendingNow` deixou de ser a soma dos `AIAgentConfig` e passou a contar o mesmo predicado da aba (um `User type = AI` com a config apagada continua na aba e deixaria o KPI menor que o badge). O `hasError: false` entrou no groupBy por agente e na lista de casos `attending_now`, que já usava `u.type = 'AI'`. KPI, modal e badge da aba agora batem.

**Impacto.** `services/conversations.ts`, `lib/visibility.ts`, `lib/authz/{permissions,presets,scope-grants-shared}.ts`, `services/distribution/cockpit.ts`, `services/ai/cockpit-academic-cases.ts`, rotas `conversations` e `conversations/bulk`.

**Ordem de deploy.** Frontend primeiro. `route.ts` não rejeita `tab` desconhecida — `validTabs.has()` cai para `undefined` e a query volta sem filtro de aba. Logo frontend novo + backend velho só mostra a aba nova com a lista de "Todas": feio, nada some. O inverso é o que quebra — backend novo + frontend velho tira as conversas da IA de Entrada/Aguardando/Respondidas/Automação sem ter aba para recebê-las, e elas só aparecem em "Todas".

---

### 2026-08-27 — Bearer em GET /api/deals/:id/timeline

**Decisão.** `GET /api/deals/:id/timeline` passa a aceitar Bearer (`authenticateApiRequest` + `runWithApiUserContext`), além da sessão. Exige `deal:view`. O n8n lê a mesma timeline do painel do negócio.

**Contexto.** A rota só tinha `withOrgContext` (sessão NextAuth). O node de action Timeline > Get Events precisa do token de API.

**Alternativas descartadas.** Endpoint novo só para n8n (duplicaria o contrato `{ id, type, meta, createdAt, user }`). Polling de webhooks.

**Impacto.** 1 rota. Sessão do CRM inalterada (`authenticateApiRequest` faz fallback para `auth()`).

---

### 2026-08-27 — Reset de senha pelo admin destrava o login

**Decisão.** (1) `PATCH /api/users/[id]` com `password` chama `clearLoginLockout(email)` — apaga as falhas das janelas soft (15min) e hard (24h) em `login_attempts`. (2) Outcome `locked` deixou de contar como falha nos thresholds do lockout.

**Contexto.** Usuário com 10+ falhas/24h entrava em hard-lock e o admin não conseguia liberar nem trocando a senha: `checkLockout` roda antes da checagem de senha, então o usuário nunca chegava ao sucesso (que limpa só a janela de 15min), e cada tentativa bloqueada gravava outcome `locked` — que contava como falha e renovava a janela de 24h indefinidamente.

**Alternativas descartadas.** Botão "Desbloquear" sem troca de senha (escopo maior de UI; o fluxo que o admin já tenta é o reset). Manter `locked` contando (preserva o bug). Limpar só a janela soft (não destrava o hard-lock).

**Impacto.** `src/lib/auth/lockout.ts`, `src/app/api/users/[id]/route.ts`. Hard-lock agora expira 24h após a última falha real (não se auto-renova). Sem mudança de frontend.

### 2026-08-26 — Webhooks de integração (n8n Trigger)

**Modelo usado.** Cursor Grok 4.6.

**Decisão.** Tabela `integration_webhooks` + CRUD Bearer (`GET/POST /api/integration-webhooks`, `GET/DELETE /api/integration-webhooks/:id`). `fireTrigger` despacha POST fire-and-forget para as URLs da org que escutam o evento (ou `*`), inclusive quando não há automação interna. `assignDealOwner` passa a disparar `agent_changed` (bulk, distribuição, automação). Troca de responsável do contato dispara `contact_owner_changed` (não reusa `agent_changed`).

**Contexto.** O n8n precisava de um Trigger por evento (primeiro: troca de responsável). O CRM só tinha automações internas — sem inscrição de webhook de saída.

**Alternativas descartadas.** Polling no n8n (atraso + carga). Reusar `agent_changed` no contato (dispararia automações de deal). Endpoint só de `agent_changed` (outros eventos já passam por `fireTrigger`).

**Impacto.** Nova tabela tenant-scoped. Permissões `deal:view` (listar) e `deal:edit` (criar/apagar). Payload: `{ event, occurredAt, organizationId, contactId, dealId, data }`. Header `X-Eduit-Signature: sha256=…` quando há secret.

---

### 2026-08-25 — Encerrar conversa limpa responsável do deal/contato

**Decisão.** Quando a conversa é encerrada SEM "manter atendente" (`conversation.keepAgentOnEnd` off), `updateConversationStatusInDb` agora também: loga `ASSIGNEE_CHANGED` (chat + timeline, "X removida da conversa") e chama `clearContactOwnershipOnClose` — zera `ownerId` dos deals ABERTOS do contato e `assignedToId` do contato, com `OWNER_CHANGED`/`CONTACT_OWNER_CHANGED` nos logs. Guardas: só limpa quem era o responsável removido, e só se nenhuma outra conversa aberta do contato ainda está com ele. O bulk-resolve (worker leads) faz o mesmo por par (contato, atendente).

**Contexto.** Operador removia a atendente ao encerrar, mas o deal seguia com ela no kanban (ex.: Beatriz no deal do Marcelo Pinheiro) e nada aparecia na timeline/chat — o clear só mexia na conversa.

**Alternativas descartadas.** Limpar sempre (sem respeitar keepAgentOnEnd) — quebraria orgs que mantêm o atendente de propósito. Disparar trigger `agent_changed` — efeito colateral fora do pedido. Mexer no `halt-inbound-burst` — lá o assignee é a IA, não humano; a guarda por `clearedUserId` já no-oparia.

**Impacto.** `services/conversations.ts`, `services/deals.ts`, `jobs/leads/bulk-resolve-conversations.job.ts`. Sem mudança de frontend — os tipos de evento já renderizam.

### 2026-08-25 — Bulk move_stage resolve o recorte do board (até 5000)

**Decisão.** `POST /api/deals/bulk` (`move_stage`) aceita o mesmo `scope` da edição de campos (`pipelineId` + status + filtros + stageId opcional). O servidor chama `resolveBoardDealIds` (teto 5000) e enfileira no worker `leads-bulk`. Sem `scope`, o comportamento antigo (IDs explícitos, sync se ≤50) permanece.

**Contexto.** Kanban/lista só carregam ~200 cards por coluna. Mover usava só os IDs visíveis; editar campos já expandia o filtro no servidor. Cruzeiro EAD precisava mover 1000+ leads de uma tag.

**Alternativas descartadas.** Subir `perStage` do board (payload de 540KB já saturava Redis). Mover síncrono de 1000+ (timeout HTTP / pool). Worker novo (já existe `bulk-move-stage`).

**Impacto.** `src/app/api/deals/bulk/route.ts`. Worker inalterado (chunks de 50).

### 2026-08-25 — Cache Redis: circuit breaker + gzip + singleflight

**Decisão.** No cliente de cache (`src/lib/cache/index.ts`): circuit breaker (5 timeouts → 15s sem Redis), `enableOfflineQueue: false`, reconnect no `Command timed out`, `commandTimeout` 2s (era 500ms), gzip de payload ≥8KB, singleflight in-memory no `wrap()`, chave do board hasheada. Não separar Redis de cache vs BullMQ neste passo.

**Contexto.** Produção (`crm-eduit`) inundou warn `[cache] get falhou — fallback memoria` / `Command timed out` em `authz:user:*`, `org_settings_prefix:*`, `inbox_tab_counts:*`. Inbox/kanban travavam. Redis em si estava saudável (~4ms PING interno, 6MB, 295 ops/s). O board cacheava JSON de ~540KB numa conexão ioredis única; `commandTimeout: 500` conta espera na fila, então GETs minúsculos de authz/settings timeoutavam juntos. Timeout do ioredis não cancela o comando no servidor e envenena o pipeline. Sem singleflight local, o fallback disparava N `computeTabCounts` / `computeBoardData` e esgotava o pool Postgres (SELECT 1 chegou a 456ms).

**Alternativas descartadas.** Redis dedicado só para cache (ops extra, não ataca o timeout na conexão da API). Remover cache do board (devolve o stampede de ~13s no Postgres). Subir só o timeout sem circuit/reconnect (pipeline envenenado continua).

**Impacto.** `src/lib/cache/index.ts`, `src/lib/cache/keys.ts`. Após o deploy, reiniciar o container da API se o singleton ioredis já estiver preso.

### 2026-08-25 — Flow JSON 7.3 para publicar na Meta

**Modelo usado.** Cursor Grok 4.6.

**Decisão.** Novos publishes usam Flow JSON `7.3` (versão recomendada). `5.0` está frozen desde set/2025 e a Meta devolve 139002/4233046 («versões não disponíveis para publicação»).

---

### 2026-08-25 — Publish de WhatsApp Flow: Form wrapper + slug reservado

**Modelo usado.** Cursor Grok 4.6.

**Decisão.** O Flow JSON v5 passa a embrulhar os inputs num `Form` `name=form` (Footer fora), porque `${form.campo}` sem Form é rejeitado pela Meta (`INVALID_ON_CLICK_ACTION_PAYLOAD`). Chaves reservadas (`none`, `form`, …) são substituídas pelo rótulo. Create+publish na Graph usa 1 tentativa / 45s para não estourar o proxy com HTML 502 e toast «Erro ao publicar.». Nome duplicado na WABA tenta de novo com o shortId.

**Alternativas descartadas.** Dois passos create-then-publish (mais API, mesmo JSON inválido falha igual).

---

### 2026-08-25 — Botão de Flow no node Botões WhatsApp

**Modelo usado.** Cursor Grok 4.6.

**Decisão.** Cada opção de `send_whatsapp_interactive` pode ser `kind: action`
(reply, como hoje) ou `kind: flow` (escolhe um `WhatsappFlowDefinition`
publicado). O 1º envio continua botões/lista por quantidade. No clique do
botão Flow o executor envia `interactive.type=flow` na janela 24h, pausa com
`variables.__awaitingFlow` + `flow_token`, e o `nfm_reply` retoma a aresta
daquele botão. O mapeamento do formulário no lead permanece no webhook.

**Alternativas descartadas.** Lista nativa aninhada (não reproduz a tela iFood);
gerar/publicar Flow a partir das opções do node (rejeição da Meta); injetar
lista dinâmica por contato nesta versão (sem cadastro de endereços).

**Impacto.** `MetaWhatsAppClient.sendInteractiveFlow`, `automation-context`
(`decideInteractiveMenuInbound`), editor inline do canvas.

---

### 2026-08-26 — Encaminhar formulário WhatsApp Flow (slash + node)

**Modelo usado.** Cursor Grok 4.6.

**Decisão.** Duas formas de enviar um Flow publicado na janela 24h (`interactive.type=flow`): atalho `/` no composer e o node `send_whatsapp_flow` no grupo Mensagens. GET `/api/whatsapp-flow-definitions/published` é aberto a qualquer membro da org (o GET raiz continua ADMIN/MANAGER). O node pausa até `nfm_reply`; texto livre não avança. Fora da janela 24h o caminho continua sendo template com botão FLOW.

**Alternativas descartadas.** Recolocar Ação/Flow no node Botões (já revertido). Exigir ADMIN para listar publicados (agente não conseguiria usar o `/`).

**Impacto.** `outbound-messaging.sendFlowToConversation`, `POST /api/conversations/:id/flow`, executor `send_whatsapp_flow`, `decideFlowStepInbound`.

---

### 2026-08-26 — Node Botões WhatsApp volta a ser só reply

**Modelo usado.** Cursor Grok 4.6.

**Decisão.** Removido `kind: action|flow` do node `send_whatsapp_interactive`. A mistura iFood (Flow + resposta rápida na mesma bolha) já existe em template aprovado (`FLOW` + `QUICK_REPLY`). Na janela 24h a Meta não mistura `interactive.type=button` com `type=flow`; o clique gerava uma segunda bolha `[Flow: …]`.

**Alternativas descartadas.** Manter o seletor no canvas (UX enganosa). Colocar o menu inteiro dentro do Flow (a opção simples também abriria a ficha nativa).

---

### 2026-08-25 — Clique de botão retoma automação mesmo com humano atendendo

**Modelo usado.** Cursor Grok 4.6.

**Decisão.** `processIncomingMessage` só cancela contextos pausados quando há humano atendendo E o inbound é texto livre. Clique de botão/lista (`interactiveId`) e `nfm_reply` (`flowReply`) retomam o passo pausado — senão o disparo manual pela conversa (sempre com assignee humano / hasHumanReply) morre no primeiro clique.

**Alternativas descartadas.** Remover o guard inteiro (salesbot voltaria a falar em cima do consultor). Ignorar só `hasHumanReply` (conversa atribuída a humano ainda quebraria o teste).

---

### 2026-08-20 — Roster acadêmico não cria departamentos em outros tenants

**Decisão.** `ensureAcademicDepartmentRoster` só cria/sincroniza Acolhimento,
Retenção e Atendimento - SAC se a org atual tiver pelo menos um e-mail do
roster Cruzeiro. O 1º atendimento só chama o roster depois de confirmar pipe
acadêmico.

**Contexto.** DnaWork via Acolhimento / Atendimento - SAC / Retenção em
activities e settings/tabulations. O 1º atendimento está ligado por default
(`ai.firstAttendanceEnabled` ausente = true) e chamava o roster **antes** do
filtro de funil acadêmico — `ensureDeptMap` criava os 3 departamentos na org
errada.

**Alternativas descartadas.** Gate por slug/env (frágil entre ambientes);
apagar automaticamente os departamentos órfãos (destrutivo se alguém criou
nome igual de propósito).

**Impacto.** DnaWork (e qualquer tenant sem os e-mails Cruzeiro) deixa de
ganhar esses departamentos. Os 3 já gravados na org precisam ser apagados
na UI de departamentos se não tiverem conversas.

### 2026-08-20 — FCM nativo no APK (Spark, só Messaging)

**Modelo usado.** Cursor Grok 4.6.

**Decisão.** Coexistir FCM com Web Push VAPID. Token do APK em
`WebPushSubscription` com endpoint `fcm:<token>`. Envio HTTP v1 com
service account em env (`FCM_SERVICE_ACCOUNT_JSON` ou PATH). Alertas de
tarefa disparam no claim; sweeper a cada 60s só para quem tem token FCM,
para o CRM fechado ainda receber. Sem Auth/Analytics/Firestore.

**Alternativas descartadas.** firebase-admin (SDK pesado); só Web Push no
APK (não entrega com o app morto); worker BullMQ novo (20 usuários, tick
na API basta).

**Impacto.** `src/lib/fcm.ts`, subscribe/unsubscribe, `sendPushToUser`,
`activity-alert-push-sweeper`, migration `20260820140000_web_push_fcm_transport`.

### 2026-08-20 — Manter sweeper de aviso FCM (não job no cadastro)

**Modelo usado.** Cursor Grok 4.6.

**Decisão.** Permanecer com o tick de ~60s em `activity-alert-push-sweeper`.
Disparar no cadastro da tarefa não cobre “15 min antes” nem “na hora”.
`setTimeout` no processo piora memória e some no restart. Fila delayed
(BullMQ) só faria sentido com volume bem maior ou exigência de pontualidade
no segundo.

**Alternativas descartadas.** Chamar o sweeper só no create; timer in-process
por atividade; job delayed por horário.

**Impacto.** Nenhum código. Intervalo ajustável por `ACTIVITY_ALERT_PUSH_INTERVAL_MS`.

---

### 2026-08-19 — Alertas globais de Activity (polling autenticado)

**Modelo usado.** Cursor Grok 4.5 (execução sob spec Opus).

**Decisão.**
1. Avisos de agendamento para qualquer Activity incompleta com
   `scheduledAt` (não só TASK): pré-aviso 15 min (só se o usuário
   consultar na janela; offline não recupera) e vencimento (recupera no
   próximo login enquanto incompleta).
2. Destinatários = `activity.userId` e/ou membros atuais em
   `DepartmentMember`. ADMIN/MANAGER não recebem automaticamente.
3. Persistência por usuário em `ActivityAlertState` (unique
   activityId+userId); dismiss/click definitivo; snooze 10 min;
   reagendar reseta; GET entrega no máx. 1 alerta e marca shown
   atomicamente (dedupe cross-refresh/dispositivo).
4. Entrega via **polling autenticado** nas rotas
   `GET/POST /api/activities/alerts` — sem SSE, worker ou Web Push neste
   escopo.

**Alternativas descartadas.**
- SSE / Web Push / worker de push: fora do escopo; frontend faz polling.
- Alertar só type TASK: produto pediu qualquer Activity com horário.
- Incluir gestores por papel: vazaria avisos de tarefas alheias.

**Impacto.** Schema/migration `20260819130000_activity_alert_states`;
service `activity-alerts`; rotas `/api/activities/alerts`.

---

### 2026-08-19 — Activity: criador ≠ responsável + comentários assinados

**Modelo usado.** Cursor Grok 4.5 (execução seguindo spec Opus).

**Decisão.**
1. `Activity.createdById` (nullable) separa criador do responsável
   (`userId` / `departmentId`). Novos POSTs autenticados preenchem
   `createdById`; backfill de legados usa `userId` quando presente.
2. Comentários de tarefa usam models dedicados `ActivityComment` +
   `ActivityCommentRevision` (append-only: CREATED|UPDATED|DELETED).
   Soft-delete via `deletedAt`; conteúdo permanece no banco; lista
   normal oculta `content` de deletados; endpoint de revisions/histórico
   expõe conteúdo para auditoria.
3. Autor do comentário vem só da autenticação. Quem vê a Activity pode
   listar/criar; editar/excluir só o próprio autor (nem ADMIN edita
   nota de terceiro). ADMIN pode consultar histórico.
4. Comentário, revision e `ActivityEvent` são gravados na mesma transação:
   a mutação só confirma quando toda a trilha de auditoria persistir.

**Alternativas descartadas.**
- Reutilizar `Note`: acopla nota de deal/contato a thread de tarefa;
  sem soft-delete/revision nativos.
- Modelar histórico só com `ActivityEvent`: feed é particionado e
  tipado para timeline; não garante append-only por comentário nem
  `before/after` estruturado; hard de filtrar auditoria de um commentId.
- Hard-delete de comentário: perderia trilha forense.

**Impacto.** Schema/migration `20260819124500_activity_created_by_and_comments`;
services `activities` + `activity-comments`; rotas
`/api/activities/[id]/comments` (+ `[commentId]` e `revisions`).

---

### 2026-08-15 — Instagram Direct manual (App da org, org por org)

**Modelo usado.** Cursor Grok 4.6.

**Decisão.** Conexão Instagram igual ao WhatsApp Cloud que já opera em
produção: cada org cria o próprio App Meta, cola token + App Secret, e o
CRM gera callback `/api/webhooks/meta/<webhookId>`. Não depende de App
Review do `CRM_eduit`.

**Contexto.** OAuth no App da EduIT conectava o canal, mas a Meta não
entrega webhook `messages` em app Business com permissão Standard. O
WhatsApp das orgs já era BYO app (manual-cloud + botão Webhook), não
Embedded Signup.

**Alternativas descartadas.**
- Esperar review do `CRM_eduit`: semanas; bloqueia o teste DNAWork.
- Interruptor Live do painel antigo: app Business não tem modo.

**Impacto.** `POST /api/channels/instagram/manual`; webhook-info aceita
`type=INSTAGRAM`; handler WhatsApp resolve webhookId de canal IG e
encaminha `object=instagram`.

---

### 2026-08-14 — Step `check_agent_status` (Disponível / Offline)

**Modelo usado.** Cursor Grok 4.6.

**Decisão.** Novo passo de automação binário, espelhando `business_hours`:
saída `nextStepId` = responsável ONLINE; saída `elseStepId` = offline.
Consulta só `conversation.assignedToId` (sem fallback no dono do negócio).
Disponível = `AgentStatus.status === "ONLINE"` (toggle da Equipe). AWAY,
OFFLINE, sem registro ou sem responsável → Offline.

**Contexto.** Operador precisa ramificar o fluxo para transferir a conversa
a um user online quando o dono atual está indisponível. Sem este nó, a
única opção era `execute_distribution` (atribui) ou `condition` genérica
(sem acesso ao toggle de presença).

**Alternativas descartadas.**
- Reusar `condition` com campo novo: mistura presença com regras de lead.
- Checar heartbeat/aba aberta (`SystemUsageSession`): conceito diferente
  do toggle "Disponível" da Equipe.
- `isAgentAvailable` (ONLINE + expediente): expediente já é o nó de
  horário comercial; o operador pediu só o toggle.

**Impacto.** BE: workflow, executor, auditor, layout, copilot, labels.
FE: palette, canvas, node dedicado com handles `true`/`false`.

---

### 2026-08-11 — Step `delay` longo vira espera persistida (não `setTimeout`)

**Modelo usado.** Cursor Kimi K3.

**Problema.** O step `delay` rodava `setTimeout(ms)` inline no worker. Um
delay de **7 dias** ("Follow-up de envio de vaga", dna_work) segurava 1 dos
5 slots de concorrência do `worker-automations` por dias. Com 5 jobs assim,
o processo ficava vivo mas incapaz de processar qualquer outra automação —
**todas** pararam (ENTRADA sem receptivo, ~120 leads parados em horas).
A espera também morria a cada restart/deploy.

**Decisão.** Delay acima de `AUTOMATION_DELAY_INLINE_MAX_MS` (default 30s)
**persiste** a espera: contexto RUNNING + `timeoutAt` (mesma infra de
`wait_for_reply`), e o `sweepExpiredTimeouts` (30s) retoma no `nextStepId`.
Delay curto (≤30s, ex.: "digitando…") segue inline.

**Implementação.**
- `automation-context.ts`: `shouldPersistDelay`/`DELAY_INLINE_MAX_MS`;
  branch `delay` em `processTimeout` (expirar = seguir `nextStepId`);
  `closeStrandedContext` preserva delay com `timeoutAt`.
- `automation-executor.ts`: `case "delay"` usa `pauseAwaitingReply` quando
  `shouldPersistDelay`.
- `delay` NÃO entra em `PAUSING_STEP_TYPES` (mensagem do cliente não pode
  avançar a espera) — tratado explicitamente nos 3 pontos.
- Scripts `cleanup-stranded-contexts` / `diag-automation-zombies`: `delay`
  adicionado à lista pausante (espera legítima, não zumbi).
- Fix piggyback: `normalized` fora de escopo em `processIncomingMessage`
  (erro TS pré-existente) → `messageContent`.

**Alternativas descartadas.**
- BullMQ delayed job: mais moving parts; a infra de timeout já existia.
- `delay` em `PAUSING_STEP_TYPES`: faria mensagem do cliente avançar a
  espera (errado).

**Impacto.**
- Delay longo não trava mais o worker e sobrevive a restart.
- Durante a espera o contato aparece na aba "Automação" (contexto RUNNING) —
  esperado; reentrada na mesma automação é bloqueada enquanto aguarda.
- Teste: `automation-branch-routing.test.ts` (5 casos novos).

---

### 2026-08-11 — Contact.number atômico + reuso em P2002 de BSUID

**Modelo usado.** Cursor Composer.

**Problema.** `nextContactNumber` = MAX+1 sem lock → P2002 em
`(organizationId, number)` sob webhook paralelo (DNAWork). Retry cego
também falhava em P2002 de `whatsapp_bsuid`.

**Decisão.** `pg_advisory_xact_lock` + MAX+1 + INSERT na **mesma**
transaction (`insertContactWithNextNumber` / `createContact`). Em
colisão de BSUID, `findFirst` e reusa o contato (não retenta número).

**Arquivos.** `services/contacts.ts`; meta webhook handler/messaging;
baileys message-handler.

---

### 2026-08-11 — Busca inbox/board: 1 JOIN em contacts (não N self-joins)

**Modelo usado.** Cursor Composer.

**Problema.** `buildConversationSearchWhere` e o OR de search em
`kanban-filters` emitiam vários `{ contact: { campo } }` no mesmo OR —
Prisma gera 1 LEFT JOIN por ramo → self-joins j0..jN no mesmo `contacts`.
COUNT/listagem da inbox e board filtrado pagavam isso no pg_stat.

**Decisão.** Agrupar predicados de contato sob `contact: { OR: [...] }`
(e `assignedTo` idem). Já era o padrão em `deals.ts` (jul/26). Semântica
igual; API pública inalterada. Coluna `search_text` desnormalizada fica
como ADR (`docs/decisoes/search-text-denormalized.md`) — não neste PR
(risco de backfill/triggers sob carga).

**Arquivos.** `services/conversations.ts`; `services/kanban-filters.ts`.

---

### 2026-08-11 — Hard cap sendRate + backpressure no campaign-worker

**Modelo usado.** Cursor Composer.

**Problema.** Campanha com `sendRate=80` (msgs/s) + concurrency BullMQ 10
saturava Postgres compartilhado (4 vCPU) e API; inbox/board 5–17s.

**Decisão.** (1) Cap server-side em `CAMPAIGN_SEND_RATE_MAX` (default **30**
msgs/s) com default de criação `CAMPAIGN_SEND_RATE_DEFAULT` (**20**);
clamp na API/builder e no worker (campanhas antigas com 80 não disparam
acima do cap). (2) Concurrency de envio via `CAMPAIGN_SEND_CONCURRENCY`
(default **4**, antes 10). (3) Limiter BullMQ também teto pelo max de
sendRate. Throttle Redis `campaign:meta:throttle:...` permanece.

**Arquivos.** `lib/campaign-send-rate.ts`; worker; services campaigns /
campaign-builder; schema zod; default Prisma.

---

### 2026-08-11 — Worker dedicado `worker-automation` para Salesbot/automações

**Modelo usado.** Cursor Grok 4.5.

**Decisão.** Automações pesadas saem do processo da API. Em produção a API
só chama `enqueueAutomationJob` (fila BullMQ `automation-jobs`); o consumo
fica em `APP_MODE=worker-automation` → `node dist/workers/automation-worker.js`.

**Contexto.** Já existiam `automation-worker.ts` (sem tenant context),
`automation-worker-inline.ts` (tenant-safe mas dead code) e a fila
`automation-jobs`, mas sem build/Docker/`APP_MODE`. Default era execução
inline na API. Fallback com Redis down em `AUTOMATION_WORKER_MODE=external`
também rodava inline e sobrecarregava a API.

**Implementação.**
- Worker canônico em `automation-worker.ts` (padrão leads/ETL + lookup
  `organizationId` via `prismaBase` + `withSystemContext`).
- Build em `build-workers.mjs`; branch no `docker-entrypoint.sh`.
- Sem Redis em modo `external`: erro controlado (sem fallback inline).
- `transfer_automation` passa a `enqueueAutomationJob` (não mais
  `setImmediate(runAutomationInline)`).

**Alternativas descartadas.**
- Segunda fila / segundo executor — duplicaria o sistema já existente.
- Rodar worker in-process na API — compete com HTTP e não isola falhas.

**Impacto.** EasyPanel: novo serviço com a mesma imagem e
`APP_MODE=worker-automation`; API com `AUTOMATION_WORKER_MODE=external`.

---

### 2026-08-10 — Retomada de Lista/botão com conversa já na IA

**Modelo usado.** Cursor Grok 4.5.

**Problema.** Gatilho manual envia Lista WhatsApp; contato clica; IA
responde saudação e o fluxo não avança. A conversa já tinha `assignedToId`
da IA; `processIncomingMessage` usava `suppressAutomation` e cancelava o
contexto pausado antes do match.

**Decisão.** Retomada só bloqueia com `humanAttending` (humano dono ou
`hasHumanReply`). Assignee só IA não mata contexto pausado.
`suppressAutomation` permanece nos triggers (não iniciar automação nova).
Match de opção também aceita fallback `row_N`/`btn_N` como no executor.

**Arquivos.** `services/automation-context.ts`; teste
`automation-branch-routing.test.ts`.

---

### 2026-08-10 — Fila noturna: não cancelar `distribution_pending` quando a IA reassumiu

**Modelo usado.** Cursor Grok 4.5.

**Problema.** Fora do expediente o motor grava `NO_ELIGIBLE_RESPONSIBLE`,
enfileira `distribution_pending` e a IA reassume o chat. No cron/drenagem,
`cancelStalePendingOrphans` tratava “OPEN com qualquer assignee” como órfã
e marcava a pendência `RESOLVED` (sem humano). Resultado: ~270 conversas
abertas na Automação com promessa de atendimento e **0** PENDING vivos;
343 pendências “falso-resolvidas” em 7 dias com a conversa ainda na IA.

**Decisão.** Pendência continua ativa se a conversa está OPEN e
`assignedTo` é null **ou** tipo `AI`. Só limpa se encerrada ou já com
humano. Ops: reenfileirar presos + `processPendingDistributionQueue`.

**Arquivos.** `services/distribution/pending.ts`
(`cancelStalePendingOrphans`); script ops
`scripts/ops-reenqueue-ai-overnight-handoffs.ts`.

### 2026-08-10 — Aula inaugural: IA volta a atender funis + link YouTube (calouros1008)

**Modelo usado.** Cursor Grok 4.5.

**Decisão (revisa o bloqueio de Acolhimento do mesmo dia).** A IA volta a
atender normalmente em qualquer funil/etapa (removido o gate
`isAcolhimentoFunnelContact` em first-attendance, inbox-handler,
debounce e assign API). Na janela operacional (default 10–11/ago/2026 BRT,
`INAUGURAL_LINK_DATES`):
- se o aluno pedir o link / clicar “Clique para receber o link” / mencionar
  problema na aula inaugural → a IA envia o YouTube oficial
  (`INAUGURAL_CLASS_YOUTUBE_URL`) com mensagem empática (intercept antes do LLM);
- **prioridade:** tags `calouros1008_1`…`_6` (case-insensitive) em contato
  ou deal — qualquer etapa; first-attendance assume mesmo fora do pipe
  acadêmico e mesmo com automação PAUSED aguardando botão.

**Arquivos.** `inaugural-class-link.ts`; `first-attendance.ts`;
`inbox-handler.ts`; `inbound-debounce.ts`; `actions/route.ts`; prompt.

### 2026-08-10 — Agente IA não atende alunos no Acolhimento (funil OU etapa)
**(REVERTIDA / revisada — ver entrada “Aula inaugural” acima.)**

**Modelo usado.** Cursor Grok 4.5.

**Decisão (histórica).** Se o contato tem deal OPEN cujo **pipeline ou stage** tem
`acolh` no nome (ex.: etapa `ACOLHIMENTO ACADÊMICO` em funil `ACADÊMICO`),
a IA **não assume** e **não responde**:
- `first-attendance`: skip + limpa assignee IA; exclui do pipe acadêmico
  (antes `/academ/` casava em “ACOLHIMENTO ACADÊMICO”);
- `scheduleAiReply` / `maybeReplyAsAIAgent`: block cedo;
- `POST …/conversations/:id/actions` assign → 409 se destino for User AI.

**Contexto.** Campanha com botão no Acolhimento; v1 só olhava o nome do
funil e a IA continuava atendendo quando só a **etapa** tinha “acolh”.

**Alternativas descartadas.** Só prompt; filtrar só por departamento.

### 2026-08-11 — Envio outbound bloqueia canal DISCONNECTED e template aceita `channelId`

**Modelo usado.** Claude Opus 4.7.

**Decisão.** (1) Todo envio (`sendText`, `sendInteractive{Buttons,List}`,
`sendTemplate`) rejeita com **409** e mensagem clara quando o canal resolvido
tem `status != CONNECTED`. (2) `sendTemplateToConversation` passa a resolver
canal via `resolveOutboundChannel` — mesma máquina dos textos — e aceita
`channelId` opcional no body de `POST /api/conversations/[id]/template` e
`POST /api/deals/[id]/messages`. (3) `getConversationLite.channelRef` seleciona
`status`; `LiteChannelRef` ganha `status`.

**Contexto.** Cruzeiro EaD (`cmrmbn2lh0uz2nm016beqgbwb`) teve o canal `CSV
Atendimento` (`cmrwauprp014nqh01zbe174ii`) desconectado pela Meta às
10/ago 14:08 BRT — 899 conversas OPEN ficaram apontando pra ele. Ao enviar
`iniciar_atendimento`, o `metaClientFromConfig` retornava configurado
(token/phoneId presentes), a Cloud API respondia com token invalidado e o
proxy do EasyPanel derrubava em 502 sem JSON. O parser genérico
`parseApiResponse` traduzia isso para "Servidor temporariamente
indisponível", mascarando a causa. `resolveOutboundChannel` já protegia o
caminho de override, mas o padrão (canal da própria conversa) e o
`sendTemplate` inteiro pulavam a validação de status.

**Alternativas descartadas.** (a) *Migrar as 899 conversas para o canal
`Acadêmico` automaticamente* — os números são diferentes (`883452561518366`
vs `1233457866520521`), o cliente contactou o número antigo e receber
resposta pelo novo confunde. (b) *Só reconectar o canal e ignorar código* —
não resolve o próximo canal que cair e mantém a UX ruim (mensagem genérica).

**Impacto.** Operador vê mensagem acionável (409 "Canal X está
desconectado…") e no `TemplateComposePanel` aparece seletor de canal +
banner de aviso quando o canal original não está na lista de CONNECTED —
consegue redirecionar o envio manualmente por outro WhatsApp da mesma org.

### 2026-08-10 — Agente acadêmico: atender primeiro; distribuir só se justificado
**(REVISADA em 2026-08-10 — ver entrada abaixo “honrar handoff da IA”.)**

**Modelo usado.** Cursor Grok 4.5.

**Decisão original (parcialmente revertida).** Handoff só concluía distribuição
quando o texto do aluno justificava OU baixa confiança; caso contrário tools
retornavam `deferred` e o inbox enviava a resposta sem redistribuir.

**Problema.** A IA prometia “vou te conectar” / chamava tool, o backend
adiava, e o aluno ficava com a IA (ex.: Ca #107152 — AVA sem matrícula).

### 2026-08-10 — Agente acadêmico: honrar handoff da IA (sem adiar distribuição)

**Modelo usado.** Cursor Grok 4.5.

**Decisão.** “Atender primeiro” = orientação de **quando** a IA deve
continuar respondendo (dúvida que ela ainda resolve). **Não** é bloqueio
de backend depois que ela já decidiu transferir.

Distribuição humana **executa** quando:
1. o aluno **pede** humano/consultor, OU
2. retenção / course-shopping, OU
3. **baixa confiança** (`[CONFIANCA:<0.4]`), OU
4. a IA chama `transfer_to_human` / `execute_distribution`, OU
5. a resposta da IA **promete** conexão (`textImpliesAcademicHandoff`).

Removido o retorno `deferred` nas tools e o gate
`handoff_deferred_answer_first` no `inbox-handler`.

**Contexto.** Casos em que a IA dizia que ia distribuir e o aluno
permanecia no Agente acadêmico.

**Arquivos.** `tools.ts`, `inbox-handler.ts`, `academic-atendimento-prompt.ts`.

**Alternativas descartadas.** Só reforçar prompt (já falhava); sticky owner
sempre (bloqueava handoff legítimo para Atendimento).

---

### 2026-08-07 — Baseline `_prisma_migrations` das course_config em prod

**Modelo usado.** Cursor Grok 4.5.

**Decisão.** Em `db_crm` (prod), as 5 migrations `20260806*_course_config_*`
foram **só registradas** em `_prisma_migrations` (checksum sha256 CRLF),
sem reaplicar DDL — colunas/`CourseLevel` já existiam no schema.

**Contexto.** Schema físico ok; tracking Prisma faltava (última migration
registrada era `20260803180000`). Evita `migrate deploy` futuro tentar
recriar o que já está aplicado.

**Alternativas descartadas.** Reaplicar SQL (desnecessário; já idempotente
mas sem ganho); ignorar o drift (risco em próximo deploy).

**Impacto.** Prod passa a conhecer as 5 migrations de curso. Ainda há gap
não tratado entre `20260803` e `20260806` (ex.: appearance/mobile layout /
department auto-close) — fora deste ajuste.

---

### 2026-08-07 — Node `send_whatsapp_list` (Lista / menu interativo)

**Modelo usado.** Cursor Grok 4.5.

**Decisão.** Novo passo `send_whatsapp_list` no executor: envia lista via
`MetaWhatsAppClient.sendInteractiveList` (até 10 rows), persiste outbound
`interactive`, aguarda delivery se houver `failureGotoStepId`, e pausa
como interactive. Matching de reply em `automation-context` aceita
`config.rows` (title/id/`gotoStepId`) além de `buttons`.

**Contexto.** Client Meta já tinha lista; faltava o step no fluxo.
Botões Meta limitam a 3 opções.

**Alternativas descartadas.** Estender `send_whatsapp_interactive`; webhook
genérico sem handles no canvas.

**Impacto.** `automation-workflow`, `automation-executor`,
`automation-context`, `automation-auditor`, `automations` (validate/summarize),
`automation-layout`.

---

### 2026-08-06 — CourseConfig: canal, desconto, nível, semestre, grau e pricingOptions

**Decisão.** Produto `kind=COURSE` passa a persistir em `CourseConfig`:
`channel`, `discountPercent`, `level` (GRADUATION|POSTGRADUATE), `semester`,
`grau` (texto) e `pricingOptions` (JSON com N linhas preço/canal/desconto).
`Product.price` + `channel`/`discountPercent` espelham a 1ª opção.
Valor com desconto é só UI.

**Descartado.** ProductOffer para canal texto; só UI sem persistência.

**Modelo:** Cursor Grok 4.5 / claude-sonnet-5-thinking-high.

---

### 2026-08-06 — Campanha auto-fecha conversa criada só pro disparo

**Decisão.** Em `src/workers/campaign-worker.ts:persistCampaignOutboundMessage`,
quando `ensureWhatsAppConversationForContact` retorna `status: "created"`
(conversa nasceu neste momento apenas para hospedar a mensagem da
campanha), o update pós-`message.create` inclui
`status: "RESOLVED", closedAt: NOW(), assignedToId: null`. Se o retorno é
`already_ok`/`backfilled_channel` (contato já tinha conversa OPEN por
atendimento em curso), mantemos o comportamento atual — a mensagem só
entra no chat existente.

**Contexto.** A campanha "adimplente rematricula 0608"
(`cmshq35do1ujdoy016inhpw74`, org Cruzeiro EaD) foi disparada para 2049
contatos e gerou **1660 conversas OPEN** onde o cliente nunca respondeu.
Todas com `hasHumanReply=false`, `lastMessageDirection=out` — perfil que
o critério de `tabToWhere("entrada")` em `services/conversations.ts`
casa direto. Resultado: inbox da equipe inundado com 1589 conversas sem
responsável + 71 já herdando o `contact.assignedToId` (Danubia recebeu
32, Wesley 19, Joyce 8…), sem que nenhum cliente tivesse escrito.

O modelo de ticket em `meta-webhook/handler.ts:findOrCreateConversation`
(L708-767) já cria nova conversa OPEN para inbound sobre contato só com
RESOLVED. Fechar a conversa recém-criada pela campanha aproveita esse
mesmo caminho: o histórico do disparo fica encapsulado no ticket
fechado, e a resposta do cliente instancia ticket novo — aí sim ele
aparece em "Entrada" e dispara a distribuição normal.

**Alternativas descartadas.**
- *Não criar conversa no disparo, gravar `Message` sem `conversationId`.*
  Quebra a UI do inbox (mensagem sem chat pai não renderiza) e a
  auditoria de campanha (deixa de conseguir listar mensagens enviadas do
  contato pelo ticket).
- *Reabrir a mesma conversa quando cliente responder (em vez de novo
  ticket).* Exigiria mudar `findOrCreateConversation` também — mais
  cirurgias em ponto crítico. E quebra o modelo de ticket já
  estabilizado (dna_work / Cruzeiro).
- *Marcar campo dedicado `campaignCreated=true` e ocultar da "Entrada"
  via filtro.* Introduz estado escondido; qualquer feature nova de aba
  precisa lembrar de considerar essa flag. RESOLVED é o estado canônico.

**Impacto.**
- Campanhas passam a NÃO inundar o inbox. Só aparece quando o cliente
  responde.
- Contatos já em atendimento (conversa OPEN existente) não sofrem
  alteração — a mensagem da campanha entra no chat atual como sempre.
- `campaign_recipients.sentAt`/`sentCount` seguem contando os envios;
  métricas do painel de campanhas não mudam.
- Histórico do disparo continua consultável pela lista de conversas
  RESOLVED do contato (aba "Finalizadas") e pelo relatório da campanha.
- Limpeza retroativa das 1660 conversas antigas via
  `_diag/close-campaign-orphan-convs.js` (dry-run + `--apply`) —
  preserva 148 conversas onde cliente respondeu + 15 com histórico
  inbound anterior ao disparo.

---

### 2026-08-05 — `reopenDeal` não move mais o deal (deixa no estágio atual)

**Decisão.** `reopenDeal` em `src/services/deals.ts` passa a **apenas trocar
o status** (`LOST`/`WON` → `OPEN`, com `closedAt=null` e `lostReason=null`)
e mantém o `stageId` do deal inalterado. Se o deal estiver num estágio
terminal (`isLost`/`isWon`), ele continua ali visualmente, agora com
`status=OPEN` — cabe ao operador definir o destino via automação ou
kanban.

**Contexto.** A implementação anterior, ao detectar estágio terminal,
buscava `stages WHERE isWon=false AND isLost=false ORDER BY position DESC
LIMIT 1` e movia o deal pra lá dentro da mesma transação. Isso empurrava
qualquer reopen de LOST direto pra etapa quase-final do funil (na Dna
Work, "Formalização feita", position 12). Como `reopenDeal` faz
`prisma.deal.update` sem passar por `updateDeal`, a movimentação NÃO
gerava `STAGE_CHANGED` em `deal_events` — timeline mentia, comportamento
opaco (incidente Dna Work 2026-08-05: 49 deals reabertos por
whatsapp-flow em 24h, dos quais 7+ caíram silenciosamente em
"Formalização feita").

**Alternativas descartadas.**
- *Mover pro último estágio operacional real do deal (via histórico).*
  Depende de `deal_events` completos, exige leitura extra na transação,
  ainda é decisão implícita — melhor deixar a automação decidir.
- *Mover pro primeiro estágio (position 0).* Semântica clara ("reabri,
  começa de novo") mas ignora o contexto do deal e força retrabalho no
  kanban de organizações que reabrem com frequência.

**Impacto.**
- Callers de `reopenDeal` (`whatsapp-flow-response.ts`,
  `/api/deals/:id/status`) continuam registrando `STATUS_CHANGED` na
  timeline — comportamento inalterado sob esse ângulo.
- Deal reaberto fica com `status=OPEN` e `stageId` de um estágio LOST/WON
  temporariamente. O board (`getDealBoard`) filtra por status, então o
  card volta a aparecer nas colunas OPEN normais; o kanban não confia em
  `isLost` do stage pra derivar status do card.
- Movimentação pra estágio destino passa a ser responsabilidade explícita
  de automação (trigger `message_received` com filtro por estágio) ou
  ação manual — ambos caminhos já emitem `STAGE_CHANGED` correto
  (`automation-executor.ts` L1124 e `/api/deals/[id]/route.ts`).

---

### 2026-08-04 — `/api/leads` idempotente: reaproveitar negócio aberto e não sobrescrever campo preenchido

**Problema.** `POST /api/leads` tratava toda chamada como fato novo: criava um
negócio a cada request e mandava todos os campos do contato para
`updateContact`. Integrações não se comportam assim. A mesma pessoa chega duas
vezes por motivos banais — item duplicado na lista de origem, retry do
workflow, dois ramos que terminam no mesmo node, reexecução manual. O resultado
aparece em produção como negócio repetido no kanban (Rosilene com 4 cartões no
mesmo pipeline) e, pior, como dado bom substituído por dado velho: a segunda
chamada trazia o telefone antigo do mesmo contato e sobrescrevia o que a
primeira tinha gravado certo. O usuário via o número errado no CRM e o número
certo na saída do n8n, sem explicação aparente.

**Decisão.** Duas travas opcionais no corpo da request, em `options`:

- `reuseOpenDeal` — antes de criar, procura negócio `OPEN` do contato no mesmo
  pipeline do stage informado e reaproveita o mais antigo. Campos
  personalizados continuam sendo aplicados no negócio reaproveitado; o que não
  acontece é a criação de um segundo cartão. A resposta ganhou `dealReused`
  para a origem saber o que houve.
- `fillEmptyContactFieldsOnly` — em contato já existente, só escreve nos campos
  hoje vazios. `leadScore` fica fora da regra de propósito: é numérico, `0` é
  valor legítimo e "vazio" não significa nada ali.

Ambas ficam desligadas na API (compatibilidade com quem já chama) e **ligadas
por padrão no node do n8n**, que é a origem onde o reprocessamento acontece.

**Alternativas descartadas.**

- *Chave de idempotência na request.* Correto em teoria, mas exige que a origem
  produza e mantenha a chave. O n8n reexecuta com o mesmo payload e chave nova;
  não resolveria o caso real.
- *Dedupe por janela de tempo.* Frágil: acerta a duplicata de 2 segundos e erra
  a de 10 minutos, ou bloqueia negócio legítimo de um cliente recorrente.
- *Bloquear no node, sem mexer na API.* Deixaria a API vulnerável a qualquer
  outra integração e não protegeria as chamadas já existentes.
- *Ligar por padrão na API.* Mudaria o comportamento de quem depende de criar
  vários negócios para o mesmo contato no mesmo pipeline.

**Impacto.** Reprocessar o mesmo lead deixou de ser destrutivo: o negócio é o
mesmo e o telefone já correto permanece. Quem quiser o comportamento antigo
manda `options` vazio ou os dois flags em `false`. No node
`Create Deal With Contact`, as opções aparecem como *Avoid Duplicate Deal* e
*Only Fill Empty Contact Fields*, ambas ligadas.

---

### 2026-08-04 — Telefone de contato: rejeitar na borda em vez de gravar o valor cru

**Problema.** `normalizeContactPhoneInput` fazia `return normalized ?? trimmed`
— quando `normalizePhone` falhava, o valor cru era gravado, sob a premissa de
"não descartar entrada do usuário". Integrações não são usuário: uma varredura
em produção achou 44 contatos com telefone impossível de discar, sendo 32 na
org Cruzeiro EaD. Amostras reais: `"+5585991940125, +558591940125"` (dois
números na mesma string, ~20 casos), `"+5511958101572languageSalesforce,
+5511958101572"`, `"Farmácia"`, `"Perícia Judicial E Extrajudicial"` e
`"5.52198E+12"` (notação científica vazada do Excel).

O dano não é cosmético. O envio de WhatsApp faz `phone.replace(/\D/g, "")`, e
o teste de sanidade é só `digits.length >= 8` — então `"+5585991940125,
+558591940125"` vira um número de 25 dígitos que a Meta rejeita. O campo
*parece* preenchido na UI e o contato fica inalcançável, sem erro em lugar
nenhum. Falhar silenciosamente aqui é o pior desfecho possível.

**Decisão.** Validar na borda e rejeitar com 400. `parseContactPhoneInput`
(em `lib/phone.ts`) devolve `{ ok, value }` ou `{ ok: false, reason }`, e é
chamada em `POST /api/leads`, `POST /api/contacts` e `PATCH /api/contacts/:id`.
A mensagem de erro nomeia os números reconhecidos ("contém mais de um número
(+A, +B). Envie apenas um.") para o operador corrigir a origem sem abrir
chamado — o node do n8n mostra esse texto direto.

Nada muda para quem já mandava certo: `+5511999998888`, `5511999998888`,
`11999998888` e `(11) 99999-8888` continuam todos válidos, pois `normalizePhone`
já aceitava com ou sem `+`, com ou sem DDI e com qualquer máscara.

**No service, descartar em vez de rejeitar.** `createContact`/`updateContact`
também recebem chamadas de caminhos internos (webhook Meta, importação, merge)
onde não há ninguém para corrigir na hora. Lançar exceção ali derrubaria
processamento de inbound por causa de um campo secundário. Então o service
grava `null` e emite `log.warn` — campo vazio é honesto, telefone falso não.

**Alternativas descartadas.** *Extrair o primeiro número válido na ingestão*:
recupera o dado, mas escolhe em silêncio entre dois números que podem ser de
pessoas diferentes (`"+5511973504595, +5511973504594"` é um caso real) e
esconde para sempre o defeito da origem. *Gravar null sem falhar*: some com o
dado sem avisar quem enviou. *Manter como está*: era o comportamento que
produziu os 44 registros.

**Backfill.** `scripts/fix-invalid-contact-phones.mjs` (dry-run por padrão,
`--apply` para gravar). Ali a extração automática *é* apropriada — são dados
históricos, sem remetente para avisar. Regra: número único reconhecível vence;
entre variantes do mesmo número prefere a forma **com** o 9º dígito, que é a
usada pela Meta (`"+551186636819, +5511986636819"` → `+5511986636819`); entre
números distintos mantém o primeiro; sem número reconhecível limpa o campo.
Rodado em 04/ago/26: 36 corrigidos, 8 limpos, 0 inválidos restantes. Backup dos
valores anteriores em JSON e um `CONTACT_FIELD_CHANGED` por contato, para o
rastro aparecer na timeline.

**Impacto operacional.** Origens que hoje mandam dois números por campo passam
a receber 400 em vez de gravar lixo. Isso é intencional e foi a escolha
explícita — mas significa que integrações com esse defeito param de ingerir até
serem ajustadas.

---

### 2026-08-03 — Espera do veredito da Meta antes de escolher o ramo do envio [DECISÃO — agente OPUS]

**Modelo usado.** GPT-5.6 Sol (orquestrador); implementação pelo Executor
(Cursor Grok 4.5).

**Problema.** A saída "Falha ao enviar" só reagia a rejeição **síncrona** da
Graph API. Metade dos erros é assíncrona: a Meta aceita, devolve wamid, e o
webhook reporta `failed` depois (cód. 131042, número bloqueado). Evidência em
DEV: mensagem gravada às 18:53:26.879 com `externalId`, log
`Template WhatsApp — OK` 12 ms depois e fluxo concluído pelo ramo de sucesso;
`sendStatus: failed` só quando o webhook chegou.

**Decisão.** Após persistir a mensagem, os cinco passos de envio Meta chamam
`awaitMetaDeliveryVerdict`, que consulta `messages.sendStatus` até
`AUTOMATION_META_DELIVERY_WAIT_MS` (padrão 15 s). Veredito `failed` lança
`MetaSendFailureError` e o `catch` que já existia leva ao
`failureGotoStepId`. A espera só roda quando `resolveFailureGotoStepId(cfg)`
retorna id — quem não conectou a saída não paga latência. Em template,
interactive e question a espera vem **antes** da pausa do fluxo: não faz
sentido aguardar clique num botão que não chegou.

**`sent` não encerra a espera.** `Message.sendStatus` tem
`@default("sent")` no schema e o webhook nem reescreve esse valor (mesma
prioridade na escala). Aceitar `sent` como confirmação faria a espera terminar
sempre no primeiro poll, anulando a correção. Só `delivered`/`read` confirmam.

**Sem persistência dupla.** O `throw` fica fora dos `try/catch` que chamam
`persistFailedAutomationOutbound`: a mensagem já existe no inbox e o webhook já
gravou `sendError` nela.

**Alternativas descartadas.**

- **(a) Gatilho novo `message_send_failed` com automação de reação separada.**
  Chegou a ser implementado e foi revertido: tira a decisão de dentro do
  desenho do fluxo, que é onde o operador espera vê-la.
- **(b) Retomar o contexto no ramo de erro quando o webhook chegar.** O ramo
  de sucesso já teria executado seus efeitos (mover estágio, tags, encerrar) e
  os dois coexistiriam no mesmo negócio.

---

### 2026-08-03 — Envio de mensagem por integração: endpoint agregado por deal

**Modelo usado.** Opus 5 (orquestrador).

**Decisão.** Integrações passam a enviar mensagem pelo negócio, via
`POST /api/deals/:id/messages` (Bearer OU sessão), com três modos:
`kind: "note" | "text" | "template"`. A rota resolve o contato do deal e a
conversa de WhatsApp usando `ensureWhatsAppConversationForContact` — a mesma
função que a automação já usa — reusando o ticket em aberto ou abrindo um
novo no canal Meta padrão da org.

A lógica de envio saiu dos handlers e virou `services/outbound-messaging.ts`
(`createInternalNoteOnConversation`, `sendTextToConversation`,
`sendTemplateToConversation`). `POST /api/conversations/:id/template` foi
reduzida a uma casca fina sobre o service, então UI e integração compartilham
exatamente as mesmas regras de escopo de canal, reabertura de ticket, SSE e
activity log.

Variáveis de template chegam como `[{ component, key, value }]` e o servidor
monta o `components` da Cloud API (`lib/meta-whatsapp/build-template-components.ts`),
decidindo entre parâmetros posicionais e nomeados por componente. Idioma e
corpo do template, quando omitidos, são resolvidos da Graph e o preview é
renderizado com as variáveis.

Cinco rotas GET passaram a aceitar Bearer para alimentar os dropdowns do node:
`whatsapp-template-configs/approved`, `templates`, `quick-replies`,
`whatsapp-flow-definitions` e `whatsapp-flow-definitions/:id`. Escrita em todas
elas continua exclusiva de sessão.

**Contexto.** O node do n8n precisava enviar mensagem a partir de um deal, mas
só `POST /api/conversations/:id/messages` aceitava token — e exige um
`conversationId` que a integração não tem. Criar a conversa dependia de
`POST /api/conversations/create`, restrito a sessão. Na prática, envio por
integração era impossível, o que estava documentado como limitação do node.

**Alternativas descartadas.**

- **(a) Só liberar Bearer nas rotas existentes e deixar o node orquestrar**
  (`GET /api/deals/:id` → `GET /api/conversations?contactId=` → criar conversa
  → enviar). Descartado: expõe ao token o caminho de `conversations/create`
  que envia mensagem e exige `channelId`, amplia a superfície Bearer de rotas
  desenhadas para UI e coloca a regra de "qual conversa usar" no cliente, onde
  ela divergiria da automação.
- **(b) Duplicar o handler de template numa rota nova.** Descartado: criaria
  duas verdades sobre o que acontece ao enviar (SSE, reabertura de ticket,
  cancelamento de agendamento, log), que divergiriam na primeira correção
  aplicada só de um lado.
- **(c) Aceitar `components` da Cloud API cru vindo do node.** Descartado: é a
  principal fonte de erro 132000/132012 e contraria o requisito de o node ser
  todo por seleção. O array cru segue aceito como escape hatch, mas não é o
  caminho normal.

**Impacto.** `POST /api/conversations/:id/messages` não foi tocada — Messenger,
Instagram, reply e Baileys continuam exclusivos dela. Texto por integração é
restrito a WhatsApp e falha com mensagem clara em outros canais. Nota interna
em contato sem telefone (ou org sem canal conectado) degrada para nota apenas
no negócio, com `warning` na resposta, em vez de falhar o passo do workflow.
Suíte: 226 testes passando; typecheck sem erros novos (45 pré-existentes antes
e depois).

---

### 2026-08-03 — Resolução de deal fechado em execução manual de automação [DECISÃO — agente OPUS]

**Modelo usado.** Opus (orquestrador).

**Decisão.** Execução manual de automação passa a resolver o negócio do
contato mesmo quando fechado (LOST/WON), com prioridade para o aberto.
Em `resolveRuntimeContext` (`automation-executor.ts`), sem `dealId`
explícito: primeiro o OPEN mais recente; se não houver **e**
`event === "manual"`, cai no mais recente de qualquer status. Gatilhos
automáticos mantêm o comportamento anterior (só OPEN).

**Alternativas descartadas.**

- **(a) Aplicar o fallback a todos os gatilhos.** Descartado: passos como
  `move_stage` moveriam negócios LOST e os reabririam.
- **(b) Fazer o frontend enviar `dealId` nos três pickers do inbox**
  (`slash-command-menu.tsx`, `agent-automation-picker-modal.tsx`,
  `automation-picker-list.tsx`). Descartado: exigiria plumbing do negócio
  através de composer e chat-window, com superfície de mudança muito
  maior para o mesmo resultado.

---

### 2026-08-03 — Fallback síncrono de falha nos envios Meta

**Modelos usados.** GPT-5.6 Sol (decisão principal) e Opus 4.7 isolado
(avaliação arquitetural).

**Decisão.** Passos que enviam conteúdo pela Meta passam a aceitar
`failureAction: "stop" | "goto"` e `failureGotoStepId`. Rejeições detectadas
durante a própria chamada de envio podem seguir a saída visual
**"Falha ao enviar"**; sem saída conectada, o comportamento anterior é
preservado e o fluxo para. O log do desvio é `FAILED_HANDLED`, separado de
sucesso e de falha não tratada.

Somente erros classificados como falha de envio entram no desvio (Graph API,
timeout da chamada, canal/destino indisponível e mídia/template recusado).
Erros internos inesperados, inclusive persistência depois de um envio aceito,
continuam abortando. Tentativas recusadas são persistidas no inbox com
`sendStatus = "failed"`, `sendError` e `conversation.hasError = true`.

**Alternativas descartadas.**

- Verificar `conversation.hasError` num node `condition`: há corrida com status
  assíncrono e o fallback fica separado do envio que falhou.
- Tratar já nesta entrega o webhook `status=failed`: a Meta pode aceitar o
  envio e rejeitá-lo depois que o contexto avançou; retomar com segurança exige
  correlação persistente Message/contexto/step e política de concorrência.
- Converter qualquer exceção do step em saída de falha: esconderia bugs de
  banco e implementação como se fossem restrições da Meta.

**Escopo futuro.** Falhas assíncronas do webhook e do stale-outbound sweeper
não retomam o fluxo nesta fase.

---

### 2026-07-30 — Produção rodava build anterior a 28/07; deploy da `main` é a correção [DECISÃO — agente OPUS]

**Decisão.** Não alterar configuração da automação "Aguardando Resposta"
(`cmrxn191x0uz7o101espk5e99`) para contornar as falhas do passo `assign_owner`.
A correção é **rebuild da `main` no EasyPanel**. O passo está configurado com
`{"target":"both","userId":""}` — limpar responsável de negócio e contato —, o
builder apresenta isso como operação válida ("Limpar responsável") e o executor
na `main` já trata `userId` vazio como `ownerId = null` desde `cc30581`
(28/07 13:07, "assign_owner both/clear").

**Contexto.** Produção devolvia `assign_owner: userId obrigatório` — 107 falhas
entre 15:45 e 17:27 de 30/07. Essa string **não existe mais no repositório**;
foi removida justamente em `cc30581`. Logo, o build em produção é anterior a
28/07 13:07. Como `finish_conversation` roda **antes** do `assign_owner` no
grafo do fluxo, as conversas eram encerradas normalmente; o que se perdia era a
limpeza do responsável e todo o ramo `condition → move_stage` seguinte, além de
deixar o contexto em `RUNNING`.

**Retratação de diagnóstico anterior.** A parada do gatilho `message_sent`
havia sido atribuída ao guard de `attendance-guards` (`7a58334`, 30/07 10:59).
`cc30581` é ancestral de `7a58334`: qualquer build com o guard teria também o
clear do `assign_owner`. Como produção não tem o segundo, não tem o primeiro —
o guard **não** causou a interrupção. O ajuste feito em `6e6b160` (guard não
suprime `message_sent`) continua válido como prevenção, mas não era a causa.

**Alternativas descartadas:**

- **Preencher um `userId` real no passo.** Para o sangramento imediato, mas
  contraria a intenção declarada do fluxo (limpar o responsável para o negócio
  voltar à distribuição).
- **Remover o nó `assign_owner` do fluxo.** Mesma objeção, e exigiria religar
  `finish_conversation → condition` à mão, com risco de errar as arestas.
- **Fechar as 41 conversas abertas de contatos com `assign_owner` FAILED.**
  Verificado que `finish_conversation` precede `assign_owner` no grafo — essas
  conversas foram encerradas e reabriram por mensagem nova do aluno.
  Encerrá-las de novo destruiria atendimento legítimo.

**Impacto / pendências.**

- `prisma/migrations` conferido contra `_prisma_migrations` do `db_crm`:
  **0 migrations pendentes** (146 no repo, 148 aplicadas — o delta é o drift
  histórico já documentado). Rebuild é seguro mantendo `SKIP_PRISMA_MIGRATE=1`.
- Limpeza aplicada em 30/07: 186 contextos órfãos → `COMPLETED`
  (91 "Aguardando Resposta" parados em `send_whatsapp_message`, 95
  "Encerramento" parados em `condition`), via
  `scripts/cleanup-stranded-contexts.mjs --apply`.
- O acúmulo de órfãos volta a cada falha de passo enquanto `closeStrandedContext`
  (`26c39dd`) não estiver em produção. O deploy encerra isso.

---

### 2026-08-03 — Retomada de automação respeita as arestas do canvas (`__hasExplicitEdges`)

**Decisão.** `src/services/automation-context.ts` — que retoma o fluxo
quando o cliente responde (`processIncomingMessage`) ou quando um passo
pausante estoura o prazo (`processTimeout`) — passa a aplicar a MESMA
guarda `__hasExplicitEdges` que `automation-executor.ts` já usava nos dois
loops de execução. Três helpers puros centralizam a regra:

- `hasExplicitEdges(config)` — step veio do editor de canvas.
- `linearFallbackStepId(steps, id)` — `steps[index + 1]`, mas devolve
  `null` quando o step tem arestas explícitas.
- `readStepRef(config, key)` — lê referência de step tratando `""` e
  `__none__` (marcador de fim-de-ramo do canvas) como ausentes.

Além disso, `timeoutGotoStepId` passa a ser respeitado SEMPRE em
`question`/`send_whatsapp_interactive`, independente de `timeoutAction`
(antes exigia `timeoutAction === "goto"`), alinhando com `wait_for_reply`.

**Contexto.** Caso Piettra Ferreira (Cruzeiro EaD, 2026-08-03), automação
`inicio - pipe` (`cmryg1axs08p1rt01teyxspc8`, `message_received`, 25 nós
ramificados). O cliente mandou UMA única mensagem e mesmo assim o bot
percorreu dois ramos que ninguém pediu:

- 16:28 — "Tenho outra dúvida" → step[0] "Olá" → step[2] interactive
  "Selecione…" (pausa `timeoutMs=900000`).
- 16:43 — Timeout. `timeoutGotoStepId` do step[2] aponta pra step[22]
  "Essa conversa foi encerrada…", mas `timeoutAction` estava ausente
  (default `"continue"`), então caiu no fallback linear
  `steps[position=3]` = step[3] "Assista ao vídeo" — o ramo
  "Acesso à Plataforma". Bot mandou vídeo + link do portal + novo menu.
- 16:58 — Novo timeout, mesmo bug: `steps[position=6]` = "Já já um
  consultor entrará em contato" (ramo "Falar com equipe"), seguido de
  step[7] `move_stage` — o lead foi movido sozinho pra "Em Atendimento".

Raiz: `automation.steps` é ordenado por `position`, que é ordem de
CRIAÇÃO no canvas e não do fluxo. Em automações lineares o `index + 1`
acidentalmente coincidia com o próximo passo; em fluxos ramificados
aponta pra qualquer coisa. O `automation-executor.ts` já se protegia
disso via `__hasExplicitEdges` (marcador que o canvas grava em todo step
com saídas desenhadas à mão), mas os pontos de RETOMADA não — e é por
onde passam todas as automações de atendimento com botões.

**Alternativas descartadas:**

- **Corrigir só o `processTimeout`.** Resolveria o incidente relatado mas
  deixaria vivos os outros três fallbacks lineares do mesmo arquivo
  (`wait_for_reply` sem `receivedGotoStepId`, botão não-casado sem
  `elseGotoStepId`, cascata de `wait_for_reply`), que reproduzem o bug em
  cenários vizinhos.
- **Remover o fallback linear de vez.** Quebra automações legadas
  (pré-canvas, sem `__hasExplicitEdges`) que dependem implicitamente
  dele. A guarda por marcador preserva 100% desses fluxos.
- **Backfill em produção setando `timeoutAction: "goto"` onde há
  `timeoutGotoStepId`.** Migration cara, difícil de garantir cobertura e
  sem proteção pra automações futuras ou importadas
  (`kommo-bot-parser`, `digisac-bot-parser`, seeds).
- **Consertar só o editor do frontend.** Não resolve o que já está em
  produção; o backend seguiria vulnerável a qualquer config antiga.

**Impacto.**

- Automações desenhadas no canvas nunca mais saltam pro ramo vizinho:
  sem aresta conectada, o ramo ENCERRA (com `log.warn` nomeando
  automação e step pra o operador conectar a saída faltante).
- Exceção deliberada — menu de botões sem `elseGotoStepId` conectado: o
  contexto fica PARADO no mesmo passo aguardando clique válido ou o
  timeout, em vez de encerrar. Fechar deixaria o cliente órfão no meio
  do atendimento.
- Botão VÁLIDO com aresta desconectada (`gotoStepId: ""`) herda a saída
  padrão do passo (`nextStepId`) antes de considerar `elseGotoStepId`.
  Encontrado na auditoria: "Follow-up de envio de vaga" (Dna Work) tem
  `"✅ Consegui um emprego"` e `"Localização muito longe"` sem aresta,
  enquanto todos os outros botões do mesmo menu convergem pro
  `nextStepId`. Tratar clique certo como resposta inválida seria pior
  que o bug original.
- `question` de resposta aberta passa a seguir `nextStepId` (a aresta
  única desenhada) antes de considerar a array.
- Automações legadas sem `__hasExplicitEdges` mantêm o comportamento
  linear anterior — zero quebra.
- Regressão travada em `src/services/__tests__/automation-branch-routing.test.ts`
  (20 casos, com recortes reais do INICIO-PIPE e do "Follow-up de envio
  de vaga").

**Pendência para o operador.** Auditoria de 2026-08-03 achou 19 passos
pausantes ATIVOS (nas duas orgs) com aresta faltando — todos marcados
como canvas, portanto afetados por esta mudança. Concentrados em:
`Bem vindo - Lead de Entrada`, `BV - Calouros`, `Encerramento`,
`Retenção`, `Teleatendimento - MSG` (Cruzeiro EaD) e
`Follow-up de envio de vaga`, `Pós Vaga Aceita`,
`receptivo_geral(junho2026)` (Dna Work). A maioria é aresta de timeout
não conectada — antes vazava pro ramo vizinho, agora encerra o ramo com
`log.warn`. Conectar essas saídas no editor é o que restaura a intenção
original de cada fluxo.

---

### 2026-07-30 — `getQueueCounts` conta apenas "Entrada + Aguardando" (vez do agente)

**Decisão.** A fila (`getQueueCounts` em `src/services/distribution/queue.ts`),
que alimenta o teto (`queueLimit`) e o balanceamento (`engine.selectResponsible`),
passa a contar **somente** conversas OPEN atribuídas ao agente onde é a vez
dele responder:

- `hasError = false`
- E (`hasHumanReply = false` **OR** `lastMessageDirection = "in"`)

Ou seja: "Entrada" (nenhuma resposta humana ainda) + "Aguardando" (cliente
respondeu por último). "Respondidas" (agente já mandou e aguarda cliente) e
"Erro" **saem** da fila.

**Contexto.** Caso Beatriz (Cruzeiro EaD, 2026-07-30): consultora com fila
mostrando 25 sendo que a aba "Entrada" tinha 1 e "Aguardando" 2. Breakdown das
25: 1 Entrada + 2 Aguardando + 15 Respondidas + 7 Erro. O usuário considera que
a fila deve refletir a carga **ativa** do consultor (o que ele precisa fazer
agora), não conversas que dependem do cliente voltar ou de correção de erro.

**Alternativas descartadas:**

- **Contar só "Entrada"** (`hasHumanReply=false`). Reabre o bug histórico
  documentado no cabeçalho de `queue.ts` ("50 leads pra 1 pessoa"): agente
  responde 1x → `hasHumanReply` vira `true` → fila zera → recebe novos leads
  → loop.
- **Contar TODAS OPEN (comportamento atual até 2026-07-30).** Definição
  máxima de carga, mas divergia radicalmente do que o operador vê no inbox e
  agentes com muitos "Respondidas" antigas ficavam permanentemente
  inelegíveis, mesmo estando disponíveis para atender.
- **Contar TODAS OPEN exceto `hasError=true`.** Reduziria pouco (fila 25 → 18
  no caso Beatriz), sem resolver a queixa principal (contar "Respondidas"
  como carga ativa).

**Contra-medida contra o bug "50 leads":** a inclusão de `lastMessageDirection
= "in"` garante que agente que respondeu e o cliente respondeu de volta continua
contando — só sai da fila quando **realmente terminou** o ciclo (agente
respondeu por último). A pilha de "Respondidas" só pode inflar se elas nunca
forem encerradas — isso é responsabilidade da automação "Aguardando Resposta"
(30min → encerra/move), que trata o ciclo de vida da conversa.

**Impacto.**

- Balanceamento (`selectResponsible`) e teto (`queueLimit`) passam a refletir a
  carga **ativa** do consultor. Agentes com muitas "Respondidas" acumuladas
  voltam a ser elegíveis para receber novos leads.
- Depende que a automação de encerramento por inatividade continue funcionando
  (senão a pilha de "Respondidas" cresce indefinidamente, sem efeito nenhum
  na distribuição — o que era exatamente o efeito colateral que a mudança
  original de 2026-07-XX tentou evitar). Ver incidente do 2026-07-30 sobre
  conversas presas em ATENDIMENTO.
- A definição de "fila" agora bate com o dashboard do agente (Entrada +
  Aguardando) — coerência UX.

---

### 2026-07-21 — Sync do schema de produção (`db_crm`) com a `DEV_BRANCH` antes do merge

**Decisão.** Alinhar o banco de produção ao schema da `DEV_BRANCH` via
`prisma migrate deploy` (não via cópia de tabelas / diff bruto), aplicando as
22 migrations pendentes no `db_crm`.

**Contexto.** Merge da `DEV_BRANCH` → `main` exigia o banco de prod já com as
tabelas/colunas novas para não quebrar o deploy (prod roda com
`SKIP_PRISMA_MIGRATE`, ou seja, **não** aplica migrations sozinho). Descobertas
importantes durante a análise:

- O servidor de prod (`banco-banco-crm`, `187.127.27.39:5432`, PostgreSQL 17.10)
  tem múltiplas databases. A **produção real é a `db_crm`** — não a `banco`
  (85 tabelas, beco sem saída) informada por engano nas credenciais.
- `db_crm` estava 22 migrations atrás (delta da `DEV_BRANCH`).
- App conecta como `postgres` (superuser, BYPASSRLS); role `app_runtime`
  **não existe** → nenhum GRANT necessário nas tabelas novas.
- `groups` tinha 0 linhas → o DROP das tabelas `group*` (migration
  `roles_absorb_groups`, descarte intencional) não perdeu dado.

**Alternativas descartadas:**

- **Aplicar o `migrate diff` bruto (schema atual → alvo).** Perigoso: gerava
  `ADD COLUMN ... NOT NULL` sem backfill (`conversations.number`), `DROP TABLE`
  dos backups `_bkp_*` e de tabelas drift (`contracts`, `price_tables`,
  `stock_movements`, `user_groups`) e `DROP COLUMN` de dados reais. O
  `migrate deploy` roda os arquivos de migration (com backfill, ordem correta)
  e **não** toca no drift.
- **Copiar tabelas do banco de dev (`crm`) para prod.** Quebraria o tracking do
  `_prisma_migrations` e causaria drift em deploys futuros.

**Impacto.** `db_crm` agora com "schema is up to date". Backup completo prévio
em `Desktop/db_crm_backup_20260721_070548.dump` (151,6 MB, `pg_restore`).
Tabelas drift (`contracts`, `price_tables`, `stock_movements`, `user_groups`,
colunas antigas de `products`/`deal_products`) foram **mantidas** — não são
tocadas pelas migrations; limpeza futura opcional se necessário.

---

### 2026-06-30 — Override de canal de envio: `channelId` opcional no POST de mensagens/anexos

**Decisão.** O envio outbound em `POST /api/conversations/:id/messages` e
`POST /api/conversations/:id/attachments` agora aceita `channelId?`
opcional. Quando ausente, comportamento legacy preservado (usa
`conv.channelId` / `conv.channelRef`). Quando presente, helper compartilhado
`src/lib/outbound-channel.ts::resolveOutboundChannel()` valida e devolve
o `channelRef` correto:

- canal pertence à mesma org da conversa
- `type === "WHATSAPP"` (override só para WhatsApp neste escopo)
- `status === "CONNECTED"` (não enfileira em canal off → evita pending eterno)
- `requireChannelScope(user, "send", channelId)` (scope-grants granulares)

**Contexto.** Orgs com múltiplos WhatsApps (ex.: DNAWork — funil A → número 1,
funil B → número 2) não conseguiam escolher por qual canal responder uma
conversa. O canal "atual" da conversa é sempre sobrescrito pelo último
inbound (lógica do webhook Meta/Baileys em `lib/meta-webhook/handler.ts` e
`workers/baileys/message-handler.ts`), e o composer ficava preso a esse canal.

**Comportamento do snapshot.** O override **não** altera `conversation.channelId`
— continua refletindo o último inbound. Apenas `message.channelId` é gravado
com o canal escolhido. Isso preserva o modelo de 1 conversa por contato
WhatsApp e ativa automaticamente os divisores de troca de conexão
(`ConnectionDivider`) já existentes no chat e no deal-chat-binding.

**Alternativas descartadas:**

- **1 conversa por canal (par único `contactId+channelId`).** Quebraria
  inbox (1 card por contato), deal binding, `conversations/create skipSend`,
  stakeholder notify e o helper `findOrCreateConversation` em Baileys/Meta.
  O schema já é desenhado para o oposto (comentário em `Message.channelId`).
- **Atualizar `conversation.channelId` no envio outbound.** "Rouba" o canal
  da conversa: agente responde por outro número e o webhook do contato
  original passaria a casar errado. Quebra a propriedade "canal atual = último
  inbound", que outras partes do código assumem.
- **Override também em `template/forward/IA-autônoma`.** Fora do escopo
  reportado e cada um tem regras próprias (template precisa estar aprovado
  no canal Meta de destino; IA autônoma tem o próprio agente vinculado ao
  canal). Próximos PRs decidem caso a caso.

**Impacto:** zero quebra de contrato. Clientes antigos (sem `channelId` no
body) continuam funcionando idênticos. Frontend novo (com seletor)
ativa o override apenas quando `selectedChannelId !== conversationChannelId`,
poupando round-trip de validação no caso comum.

**UI:** novo `useWhatsappChannels()` + `<ChannelSelector />` renderizado no
`Composer`. Aparece somente quando a org tem >1 canal WHATSAPP CONNECTED
(default invisível para orgs single-channel). Persistência da escolha em
`localStorage` por conversa (`eduit:inbox:selected-channel:<convId>`). Mesmo
hook `useSelectedOutboundChannel()` consumido pelo `_v2-client.tsx` do Inbox
e pelo `deal-chat-binding.tsx` do painel de Deal — comportamento idêntico
nas duas telas. Não fixou na agenda: o seletor é **opcional**; sem trocar,
canal usado é o atual da conversa (igual ao comportamento anterior).

---

### 2026-06-30 — Editor de pipeline: hidratar automações por estágio a partir do backend

**Decisão.** `frontend/src/app/(app)/settings/pipeline/client-page.tsx`
agora hidrata `stageAutomationsMap` lendo `GET /api/automations` e filtrando
por `triggerConfig.{pipelineId,stageId,toStageId,fromStageId}` — antes o
mapa começava `{}` e só era preenchido (em memória) ao clicar em "Adicionar
automação". Resultado: a tela mostrava sempre "Sem automações" em todas as
colunas, mesmo com automações ativas no `/automations`.

**Por que aqui (e não em uma query de stage).** O backend modela
Automação→Estágio dentro do JSON `Automation.triggerConfig` (sem FK no
schema). Mudar isso para FK exigiria migration + refactor de todos os
`fireTrigger`/`automation-executor.ts` que consomem `triggerConfig`.
Inviável no escopo do bugfix; filtragem client-side com `useEffect` faz o
trabalho.

**Limites conhecidos (follow-ups, não bloqueiam):**

- `perPage: 100` no `useAutomations` (máx aceito pelo backend em
  `app/api/automations/route.ts`). Orgs com >100 automações precisariam de
  paginação adicional no editor.
- O drawer "Adicionar automação" ainda persiste só em estado local — ao
  recarregar, automações novas adicionadas pelo drawer somem. Isso é
  separado do bug reportado (não aparecer as existentes) e fica como
  próximo follow-up. Já existe a lógica de persistência via
  `PUT /api/automations/:id` em `components/pipeline/funnel-automations.tsx`
  (código morto, não importado), que pode ser reaproveitada.

> **Atualização (mesmo dia):** o follow-up acima foi fechado pela próxima
> entrada deste AGENT.md ("Editor de pipeline: persistência das automações").

---

### 2026-06-30 — Editor de pipeline: persistência das automações (criar/mover/trocar trigger/desativar)

**Decisão.** `frontend/src/app/(app)/settings/pipeline/client-page.tsx`
agora persiste **todas** as ações sobre automações dentro do botão "Salvar
alterações". Antes da entrada anterior só hidratávamos a leitura; o write
(adicionar/copiar/editar/excluir) vivia somente em React state — usuário
mexia, nenhuma mudança batia em `hasChanges` e nada ia pro backend.

**Modelo de diff.** No `useEffect` de hidratação capturamos
`automationsBaselineRef` = `Map<realAutomationId, { stageId, trigger,
triggerType, triggerConfig }>` no mesmo passo em que populamos
`stageAutomationsMap`. Em `handleSaveAll`, comparamos baseline ↔ estado e
geramos uma lista de ops:

- **create** — card com `id` prefixado `local-auto-(add|copy)-${baseId}-${ts}`.
  Origem: drawer "Adicionar" ou menu "Copiar para outro estágio". Resolução:
  `GET /api/automations/:baseId` → `POST /api/automations` clonando
  `name`+`description`+`steps`, **com `triggerConfig` novo** apontando para
  o estágio destino. Original fica intacta em `/automations` (escolha de
  produto confirmada com o operador — "duplicate", não "move").
- **update** — `id` real do baseline com `stageId` ou `trigger` diferente.
  `PUT /api/automations/:id` só com `triggerType`+`triggerConfig`. Não
  toca em `steps` (evita race entre o editor de pipeline e o canvas de
  automação aberto em outra aba).
- **unbind** — `id` real do baseline ausente do mapa atual.
  `PUT /api/automations/:id` com `{ active: false }`. Mantém
  `triggerConfig`/`steps`/`name` intactos — automação fica em
  `/automations` desligada e pode ser religada lá. **Escolha do operador:**
  "só desvincular (recomendado), pode ser religada depois" — preferida
  sobre `DELETE` (irreversível, perde steps).

Para automações desativadas saírem do editor de pipeline (UX consistente
com a semântica de "Excluir"), `isAutomationForStage` ganhou um parâmetro
`active` e retorna `false` quando `active === false`. Filtra cedo, antes
de checar `triggerConfig` — `/automations` continua mostrando todas.

**Por que `baseAutomationId` no tipo `Automation`.** Quando o operador
copia uma cópia (clica "Copiar para X" num card que ainda é local), o
`auto.id` já é sintético e perdeu a referência do backend. Persistimos o
`baseAutomationId` no card desde o `handleCopyAutomation` /
`handleDrawerConfirm` para o `handleSaveAll` sempre saber qual
automação real ler com `GET /api/automations/:baseId` na hora de clonar.

**Mapeamento label → trigger.** Centralizado em `triggerFromLabel(label,
pipelineId, stageId)`. Cobre os 6 labels visíveis hoje
(`STAGE_TRIGGER_LABELS` e `BACKEND_TRIGGER_LABELS`) e devolve o par
`{ triggerType, triggerConfig }` aceito pelo backend (`deal_created`,
`stage_changed` com `toStageId`/`fromStageId`, `deal_won`, `deal_lost`,
`message_received`, `manual`). Label desconhecido aborta o save com toast
de erro — defensivo contra labels novos que não tenham mapping.

**Alternativas descartadas:**

1. **DELETE em vez de `active: false`** — atende o caso "limpeza geral"
   mas é destrutivo: perde steps customizados que o operador investiu.
   Operador escolheu unbind explicitamente, e isso reduz risco em
   produção (DNAWork tem automações com lógica de cobrança configurada
   nos steps — apagar por engano seria caro).
2. **PATCH `/api/automations/:id` em vez de PUT** — `replaceAutomation`
   no client SDK usa PUT (route handler declara só PUT). PATCH retorna
   405. Mantemos `fetch` direto com PUT, igual ao resto do
   `handleSaveAll`.
3. **Persistir step-a-step durante a edição (sem botão "Salvar")** —
   quebraria o pattern de batch já estabelecido para nome/cor/ordem dos
   estágios e exigiria invalidations granulares + tratamento de erro
   inline. Mantemos batch.
4. **FK direta `Automation.stageId`** — discutido na entrada anterior;
   continua inviável no escopo do bugfix.

**Limites conhecidos (não bloqueiam):**

- `steps` são clonados **sem `id`** no `create`, ou seja, o backend gera
  novos cuids. Quem usa referências cruzadas entre steps
  (`nextStepId`, `gotoStepId`, `branches[].nextStepId`) precisa reabrir
  a automação clonada e revalidar o grafo no canvas — fora do escopo
  deste fix; o `PUT /api/automations/:id` separado preserva ids quando
  enviados (ver comment em `app/api/automations/route.ts` linha 105).
- Se um card for movido pra um estágio recém-criado (`local-stage-...`),
  o `handleSaveAll` cria o estágio primeiro, popula `localToRealId`, e
  depois usa o ID real ao persistir o `triggerConfig` — coberto.

**Contexto.** Reporte do operador: "algumas movimentações de trigger,
exclusão, clonar, não aparece para salvar as alterações, como se ele
não tivesse lida nenhuma mudança". Causa raiz dupla: (a) `hasChanges`
não monitorava `stageAutomationsMap`, então o botão "Salvar alterações"
não habilitava nem aparecia; (b) `handleSaveAll` não tinha nenhum
caminho para persistir essas mudanças no backend. Ambos resolvidos
nesta entrada.

---

### 2026-06-30 — Webhook Meta: remover fallback de match por `profile.name`

**Decisão.** `src/lib/meta-webhook/handler.ts::resolveWebhookContact()`
não faz mais o terceiro fallback que casava contatos por `name` quando
BSUID / phone / fuzzy-phone falhassem (linhas ~457-463). A partir daqui,
`wa_id` (E.164) + BSUID (`user_id`/`from_user_id`) são os ÚNICOS
identificadores válidos do remetente; sem match exato/fuzzy nesses, o
handler cria contato novo (caminho `createIfMissing`).

**Sintoma reportado.** Operador da DNAWork: "mando mensagem para o cliente
e dá erro 'fora da janela de 24h', mas o cliente acabou de me responder
agora". Análise via wamid (cada `externalId` da Meta tem o número do
remetente embutido em base64 — ver `_diag/decode_wamids.py`) mostrou que
**a mensagem inbound recente NÃO veio do número gravado no contato**:
veio de outro WhatsApp cujo `profile.name` coincidia com o nome do
contato no CRM. O composer enviava corretamente para o phone do contato,
mas a Meta validava a janela contra esse phone — e ELE estava de fato
fora dos 24h.

**Escala do problema (30d, db_crm prod, antes do fix).**

| Métrica | Quantidade |
| --- | --- |
| Inbounds mal-roteadas | 1.801 |
| Conversas afetadas | 429 |
| Contatos com mistura de números | 429 |

Único tenant afetado: DNAWork. Causa: funil de recrutamento com volume
alto de leads de primeiro nome curto ("Mari", "Eduardo", "Kauã",
"Luciano"...) — colisões inevitáveis no `findFirst({ name })`.

**Por que o fallback existia.** O comentário original sugeria recuperar
contatos importados sem `phone` (ex.: planilhas, importação Kommo).
Trade-off mal calibrado: em qualquer org com >100 leads, a chance de
colisão de primeiro nome explode, e o `findFirst` retorna QUALQUER um
deles arbitrariamente (sem `orderBy`).

**Alternativas descartadas.**

1. **Restringir o match por nome a contatos sem `phone`** — mitiga, mas
   não elimina (assim que o primeiro número fica gravado, todos os
   homônimos subsequentes ainda colam). E adiciona estado oculto.
2. **Match por nome + similaridade de phone** — complexidade alta para
   ganho marginal; o caminho fuzzy-phone já existente
   (`endsWith(suffix.slice(-10))`) cobre os casos de formato inconsistente
   (DDI, +9 prefix BR etc.).
3. **Migration de saneamento (separar as 1.801 inbounds dos 429 contatos
   bagunçados)** — risco real de quebrar relatórios, deals e dashboards.
   Fica como follow-up planejado separado; aqui só estancamos o
   sangramento. As conversas atuais continuam mostrando mensagens de
   pessoas diferentes até alguém criar os contatos certos manualmente.

**Pós-deploy.** Inbounds de números desconhecidos com nome igual a
contato existente passam a virar contato novo (fluxo `createIfMissing`
abaixo na mesma função), com `lifecycleStage: LEAD` e `source` derivada
do canal. Comportamento esperado e correto para todos os tenants.

**Investigação rastreada em:**

- `_diag/decode_wamids.py` — extrai phone do `externalId` de cada
  mensagem da conversa investigada.
- `_diag/estimate_damage.py` — varre 30d de inbounds com wamid e
  contabiliza divergência entre `wamid_phone` e `contact.phone`.
- Diff: `src/lib/meta-webhook/handler.ts` linhas 457-463 → bloco de
  comentário substituindo o `findFirst({ name })`.

---

### 2026-06-30 — Promoção dev→prod: aplicar 8 migrations em `db_crm` manualmente

**Decisão.** Aplicadas 8 migrations pendentes em `db_crm` (Postgres 17.9,
187.127.27.39), mantendo `SKIP_PRISMA_MIGRATE=1` e registradas à mão em
`_prisma_migrations` — segue o mesmo padrão estabelecido na promoção de
2026-06-09 (entrada abaixo) e no script `scripts/dev/apply-dev-branch-migrations.mjs`.

**Migrations aplicadas (em ordem cronológica, idempotentes — todas usam
`CREATE TABLE IF NOT EXISTS` / `ALTER ... ADD COLUMN IF NOT EXISTS` / `DO`
blocks com `EXCEPTION WHEN duplicate_object`):**

1. `20260607134036_add_catalog_module` — vinha da branch
   `feature/sprint5-crm-deal-panel-improvements`, nunca chegou na
   `DEV_BRANCH`. Cria 6 tabelas (`price_tables`, `price_table_items`,
   `contracts`, `contract_items`, `stock_movements`, `discount_requests`)
   + 6 colunas em `products` + 5 colunas em `deal_products`.
2. `20260607180000_permissions_v2_extend_catalog` — órfã (sprint5).
   `UPDATE roles.permissions` (append) nos presets MANAGER/MEMBER.
3. `20260607180100_permissions_v2_add_user_groups` — órfã (sprint5).
   Cria `user_groups`, `user_group_members` + ADD COLUMN `roles.scope_config`.
4. `20260607180200_remove_role_scope_config` — órfã (sprint5).
   DROP COLUMN `roles.scope_config` (cancela a anterior, mesmo step
   conceitual).
5. `20260616110000_add_softphone_module` — `DEV_BRANCH`. 4 tabelas
   (`sip_extensions`, `calls`, `call_events`, `call_provider_configs`) +
   5 enums (`SipExtensionStatus`, `CallDirection`, `CallStatus`,
   `WebhookAuthMode`, `RecordingDelivery`).
6. `20260622120000_api4com_provisioning` — `DEV_BRANCH`. ADD COLUMNs em
   `sip_extensions`/`calls` + enum `TelephonyProvisioningStep`.
7. `20260624140000_add_calls_history_widget` — `DEV_BRANCH`. INSERT em
   `widgets` + backfill em `organization_widgets` (idempotente via
   `ON CONFLICT DO NOTHING`) + UPDATE `roles.permissions` adicionando
   `nav:calls` aos presets MANAGER/MEMBER.
8. `20260630120000_add_messages_channel_id` — **criada nessa promoção**.
   ADD COLUMN `messages.channelId` TEXT + FK para `channels(id)` ON DELETE
   SET NULL + índice `messages_channelId_idx`. Era `db push` órfão: o
   `schema.prisma` da `DEV_BRANCH` já declarava `Message.channelRef` mas
   nenhuma migration tinha sido commitada — sem essa migration o app
   quebraria em prod nas queries que resolvem o canal de origem da mensagem.

**Procedimento.** Backup completo antes (`pg_dump -Fc` → 31 MB +
`--schema-only` → 550 KB, ambos em `_db_audit/`). Aplicação via
`psql -1 -v ON_ERROR_STOP=1` (uma transação por arquivo). INSERT em
`_prisma_migrations` com `checksum = sha256(conteúdo CRLF)` — mesmo formato
das 99 entradas já existentes, geradas originalmente em Windows.

**Branch.** `chore/sync-orphan-migrations-from-sprint5` baseada em
`DEV_BRANCH`, traz 5 pastas `prisma/migrations/` (4 órfãs da sprint5 +
a nova do `channelId`) para o Git ficar consistente com o estado do banco.

**Verificação pós.** Snapshot novo de `db_crm` confronta zero deltas
estruturais com `crm` (DEV) — sobra só ruído esperado: 5 tabelas
`_bkp_dbcrm_*` legadas, coluna `ai_agent_knowledge_chunks.embedding`
(pgvector — DEV não tem a extensão), e ~80 índices renomeados pelo
Prisma. Dados em prod inalterados (contagens das tabelas existentes
batem antes/depois).

**Alternativas descartadas.**
- *Remover `SKIP_PRISMA_MIGRATE=1`*: cairia no fallback bruto do
  entrypoint por causa do drift histórico em `_prisma_migrations` (init
  duplicado + 3 variantes de `add_contact_ad_tracking`).
- *Esperar até reconciliar o `_prisma_migrations`*: bloquearia features
  prontas há semanas (catálogo, softphone, api4com). Reconciliação fica
  para o cutover definitivo.
- *Aplicar via `apply-dev-branch-migrations.mjs` existente*: ele tem
  `TARGETS` hardcoded apontando para as 12 da fase anterior. Para a
  próxima promoção, atualizar a lista naquele script é a forma canônica.

**Impacto / pendências.**
- Manter `SKIP_PRISMA_MIGRATE=1` no EasyPanel (prod compartilha o drift).
- Rebuild do app em prod traz o código novo da `DEV_BRANCH` que já
  encontra a estrutura toda criada.
- Instalar `pgvector` no Postgres do Easypanel do banco DEV (`crm`) ou
  recriá-lo de um dump anonimizado de prod — DEV está sem extensão
  `vector` e o módulo de IA não roda em local.
- Banco DEV tem 8 colunas com defaults/NOT NULL "relaxados" (`db push`
  acidental): `organization_subscriptions.id` perdeu `gen_random_uuid()`,
  `roles.permissions` virou NULL, etc. **Não propagou para prod** (porque
  o `schema.prisma` mantém os defaults), mas é cosmético no DEV.
- Tabelas `_bkp_dbcrm_*` em prod podem ser dropadas em janela à parte.

---

### 2026-06-26 — Aviso de ligação no chat + log/timeline (webhook de chamadas)

**Decisão.** No `processWebhookEvent` (`services/calls.ts`), no **primeiro**
evento terminal (guard por `existingCall.endedAt` pra idempotência):
1. **Log de atividade sempre** (`CALL_COMPLETED`/`CALL_MISSED`), escopo `DEAL`
   quando há negócio, senão `CONTACT`, com `conversationId` quando há conversa.
   `meta` agora inclui `initiatedBy` + `durationSec` (o que o event-config do
   frontend espera) além das chaves cruas — antes só logava com `dealId` e o
   `meta` não casava com a timeline.
2. **Aviso no chat**: cria uma `Message` `messageType: "sip_call"`
   (`direction` in/out, dedupe por `externalId = sip_call:<callId>`, SSE
   `new_message`) na **conversa mais recente do contato** — mesmo padrão das
   chamadas de WhatsApp.

**Contexto.** Ligações SIP/Api4com não deixavam rastro no chat e o log só
existia com `dealId`. O pedido foi mostrar a ligação na conversa (inbox e
pipeline), no log e na timeline.

**Alternativas descartadas.**
- *Criar conversa nova só pra hospedar o aviso*: rejeitado — sem conversa
  existente, fica só log + timeline (evita conversas vazias).
- *Disparar o aviso pelo sync de CDR*: rejeitado — backfill geraria spam de
  mensagens/log; o aviso é só pelo webhook (tempo real).

**Impacto.** Aditivo, sem migration (usa `Message`/`ActivityEvent`
existentes). Novo `messageType: "sip_call"` que o frontend renderiza.

---

### 2026-06-26 — Ação `send_product`, sync de ligações (Api4com CDR) e gatilhos de ligação

**Decisão.**
1. **Ação de automação `send_product`** (`lib/automation-workflow.ts` +
   `case` no `automation-executor.ts`). Faz lookup do `Product`, injeta
   variáveis `{{produto.nome|preco|sku|descricao|unidade}}` via `__variables`
   e **delega** ao `send_whatsapp_message` — reaproveita envio Meta,
   fallback de template, persistência e SSE. Texto vazio = resumo padrão.
2. **Sync/reconciliação de chamadas** em `services/call-sync-api4com.ts`
   (`GET /api/v1/calls` da Api4com), exposto em `POST /api/calls/sync`.
   Filtra por `metadata.gateway` (só chamadas deste CRM) e faz upsert
   idempotente por `(org, "api4com", providerCallId)`. **Não** dispara
   automações (evita "explodir" gatilhos em chamadas antigas no 1º sync).
3. **Persistência extra no upsert do webhook** (`services/calls.ts`):
   `dealId`, `extensionId` (via `crm_user_id` → SipExtension) e `metadata`.
4. **Gatilhos `call_received`/`call_made`** disparados via `fireTrigger` no
   evento terminal do webhook + `evaluateTrigger` (filtro answered/missed)
   em `services/automations.ts`.
5. **Shape de `GET /api/calls`** serializado para o `CallRecord` do
   frontend (`phone`/`recordUrl`/datas ISO) — antes vazava row cru do Prisma.

**Contexto.** O registro em `/calls` dependia só do webhook Api4com, que
falha silenciosamente quando o gateway diverge / `APP_URL` ausente. A doc
oficial expõe `GET /calls` (CDR completo), então o sync garante o histórico
independentemente do webhook. `send_product` evita uma 2ª implementação de
envio WhatsApp.

**Alternativas descartadas.**
- *Disparar automação de ligação a partir do sync*: rejeitado (firing em
  massa no backfill). Tempo real fica só no webhook.
- *Card de catálogo WhatsApp em send_product*: adiado (exige catálogo Meta).

**Impacto.** Aditivo; sem migration nova (campos `dealId`/`extensionId`/
`metadata` já existiam em `Call`). Worker de automação precisa do código
novo para `send_product`/gatilhos de ligação.

---

### 2026-06-25 — Permissões por canal: eixos `initiate`/`manage` + `deny` + grupos

**Contexto.** O scope-grants atual cobre só `channel.view` e `channel.send`
(modelo aditivo permissivo), e grupos existem apenas pra RBAC booleano
(`GroupPermission`) — não pra grants por instância de canal. As rotas
`/api/channels/[id]/*` não validam permissão alguma além de `auth()`,
qualquer usuário logado pode reconfigurar/desconectar canal. O plano de
Gestão de Canais (Fase 1) exige granularidade maior: distinguir "ver",
"responder em conversa existente", "iniciar nova conversa" e "administrar
o canal", além de poder **negar** acesso a um canal específico pra um
usuário mesmo que ele tenha grant via role.

**Decisão.**

1. **Estender `ScopeGrants.channel`** com 4 eixos + override `deny`:
   - `view` (já existia), `send` (já existia), `initiate` (NOVO),
     `manage` (NOVO), `deny` (NOVO).
   - Cada eixo aceita `{ users?, roles?, groups? }` — grupos passam a ser
     principal de 1ª classe no scope-grants (não só RBAC).
   - **`deny` é GLOBAL ao canal** (não por eixo): listar `chId` em
     `deny.users[uid]` nega `view`/`send`/`initiate`/`manage` daquele canal
     para aquele usuário. Decisão consciente: simplicidade > granularidade.
     Casos que exigem deny granular (raros) podem usar combinação de grants
     positivos limitados.

2. **Precedência (fixa no `canAccessChannelForUser`).**
   - ADMIN (enum legado) → bypass total (ignora deny inclusive).
   - `manage` global no canal (grant que cobre o canal sendo testado) →
     ignora deny do mesmo canal. **Anti-lockout**: quem administra o canal
     não pode ser bloqueado dele por accident.
   - Senão: deny vence grant (user/role/group). Sem deny, modelo
     permissivo aditivo OR entre users/roles/groups.

3. **Dependências entre eixos:**
   - `send` exige `view` (não dá pra enviar em canal que não vê).
   - `initiate` exige `view` (mesma lógica).
   - `manage` implica `view` + `send` + `initiate` (admin do canal pode tudo).

4. **Enforcement de `initiate` e `manage`** (Bloco B, próximo PR):
   - `initiate` em `POST /api/conversations/create` (qualquer caminho que
     cria conversa nova — incluindo `skipSend: true` se já tem outro
     critério). `send` continua exigido no caminho com mensagem inicial.
   - `manage` em rotas **operacionais** `/api/channels/[id]/*`:
     `PUT`, `DELETE`, `POST connect`, `POST disconnect`, `GET qr`.
     `GET status` e `GET [id]` continuam sob `view` (monitoramento e
     leitura de configuração não precisam de admin).
   - `skipSend: true` em `conversations/create` exige **`view`** do canal
     (não `initiate`). Decisão: abrir chat de visualização ≠ iniciar
     conversa nova com cliente.

**Alternativas descartadas.**

- `deny` por eixo (`deny.view`, `deny.send`, ...): mais granular, mas a
  UI fica com 8+ inputs por canal — confusão garantida. Casos reais
  resolvem com grants positivos.
- Tornar `manage` uma key RBAC (`channel:manage`) em vez de eixo
  scope-grants: misturaria os dois sistemas. Scope-grants já cobre grants
  por instância — `manage` segue o mesmo padrão pra consistência.
- Eliminar `view` e usar só `manage` implícito: quebra retro-
  compatibilidade brutal — todos os grants existentes seriam invalidados.

**Impacto.**

- **Backend:** `scope-grants-shared.ts` ganha 3 eixos e 1 override; novo
  `getUserGroupIds(userId)`; `canAccessChannelForUser` e
  `listAllowedChannelIdsForUser` ganham `action` estendida + `groupIds` +
  precedência deny. `parseScopeGrants` normaliza novos campos. Nenhuma
  migração SQL — JSON aditivo (campos novos são opcionais; orgs sem
  upgrade ficam funcionalmente idênticas).
- **Frontend:** cópia desincronizada de `scope-grants-shared.ts` precisa
  ser atualizada agora (já estava sem `roles` em channel). UI editor
  ganha controles pros 4 níveis + deny (Bloco D, PR separado).
- **Compat:** grants existentes (`channel.view` e `channel.send`) seguem
  funcionando idênticos. Quem não setar `initiate` / `manage` / `deny`
  cai no comportamento atual permissivo (nada quebra).
- **Auditoria:** entrega habilita Bloco E (logAudit em PUTs de grants
  emitindo `permission.granted` / `permission.revoked` no `AuditLog`).
- **Rollout:** 5 PRs sequenciais (A modelagem → B enforcement →
  C composer canReply → D UI editor → E grupos+auditoria). PRs B+ são
  estritamente aditivos em runtime — orgs continuam funcionando sem
  novos grants graças à precedência permissiva pré-existente.

---

### 2026-06-24 — Telefonia como widget (`calls_history`) — seed + gate

**Contexto.** A telefonia (rotas `/api/calls/*`, `/api/sip-extensions/*`,
`/api/call-provider-configs/*`) era uma feature sempre ativa. Frontend
decidiu convertê-la em widget plugável (mesmo padrão de
`smart_distribution`) — o backend precisa acompanhar com seed do
catálogo e instalação automática nas orgs existentes pra não quebrar
quem já usa.

**Decisão.** Migration `20260624140000_add_calls_history_widget` faz três
coisas em uma transação:

1. **Seed do widget no catálogo global** (`widgets`): slug
   `calls_history`, INTERNAL, ONLINE, categoria "Comunicação", ícone
   `phone`. `ON CONFLICT (slug) DO NOTHING` pra idempotência.
2. **Permissão `nav:calls`** anexada aos presets MANAGER e MEMBER via
   `UPDATE roles ... permissions || ARRAY['nav:calls']` (idempotente
   via `NOT 'nav:calls' = ANY(permissions)`). Sincroniza o catálogo de
   permissões em `lib/authz/permissions.ts` que ganhou
   `{ action: "calls", label: "Chamadas (histórico)" }` no resource `nav`.
3. **Backfill `organization_widgets`** — pra TODAS as orgs existentes
   insere `(orgId, calls_history, ACTIVE)`. Sem esse passo, todas as
   orgs em produção veriam a telefonia desaparecer no deploy (página,
   softphone flutuante e botão de ligar somem).

ID determinístico (`ow_<orgId>_calls_history`) garante que o backfill
sobrevive a re-aplicação parcial via `ON CONFLICT (organizationId, widgetSlug)`.

**Gate dedicado.** `assertCallsHistoryEnabled()` em
`services/organization-widgets.ts` espelha o
`assertSmartDistributionEnabled()` — disponível pra uso futuro nas rotas
`/api/calls/*` como defesa em profundidade quando o frontend não puder
mais ser confiado isoladamente. **NÃO foi aplicado ainda** nas rotas:
o webhook do Api4Com (`POST /api/calls/webhook/api4com`) entra sem
org-context da org do cliente (é assinado pelo provedor, não autenticado
por sessão), então gateá-lo agora bloquearia o ingresso de calls. Aplicar
seletivamente nas rotas autenticadas (`GET /api/calls`,
`POST /api/sip-extensions/me/connect-api4com`) é o próximo passo se/quando
o backend precisar reforçar o gate.

**Alternativa descartada.** Default `installed=false` + migration que só
ativa orgs com calls > 0 nos últimos 90 dias — mais "limpo" mas exigiria
suporte manual pra orgs com uso esporádico que ficariam fora do recorte.
`installed=true` por padrão + admin desinstala se quiser é mais
previsível.

**Impacto.**
- `prisma/migrations/20260624140000_add_calls_history_widget/migration.sql`
  (novo): seed catálogo + permissão + backfill installations.
- `src/services/organization-widgets.ts`: novo helper
  `assertCallsHistoryEnabled()`.
- `src/lib/sidebar-catalog.ts`: novo entry `calls` com
  `requiredWidgetSlug: "calls_history"` e `href: "/widgets/calls"`.
- `src/lib/authz/permissions.ts`: `nav:calls` no catálogo.
- `src/lib/authz/presets.ts`: MANAGER e MEMBER ganham `nav:calls`.

---

### 2026-06-24 — Motivos de perda: gate `allow_other` no service (defesa em profundidade)

**Contexto.** Demanda do cliente: poluição da lista de `Deal.lostReason`
em produção, vendedores usando o botão "Outro…" como saída livre. UI
do CRM ganhou toggle "Permitir motivo personalizado" para o admin
controlar (vide AGENT.md do frontend). Backend precisava complementar:
sem gate no service, qualquer cliente HTTP autenticado (DevTools,
integração externa, worker) poderia continuar mandando string livre.

**Decisão.** Nova helper `assertLostReasonAllowed(reason)` em
`services/deals.ts` lê `deals.loss_reason_allow_other` (default `true`)
via `getOrgSettingBool`. Quando `false`, valida que `reason` bate
EXATAMENTE com algum `LossReason.label` ativo da org corrente —
`prisma.lossReason.findFirst({ where: { label, isActive: true }})`.
Não casou → `throw new Error("INVALID_LOST_REASON")`, traduzido pra
HTTP 400 nos routes.

Chamadas inseridas em **3 pontos de entrada** que cobrem todos os caminhos
de gravação real de `lostReason`:
- `markDealLost(id, reason)` — usado por `PUT /api/deals/[id]/status`
  e por `POST /api/deals/bulk` action `mark_lost`.
- `moveDeal(dealId, stageId, position, { lostReason })` — usado por
  `PATCH /api/deals/[id]/move` quando o destino é estágio terminal LOST.
- Route `POST /api/deals/bulk` action `move_stage` — valida ANTES de
  decidir entre path síncrono e enfileirar `BulkMoveStagePayload`. Isso
  cobre o worker async `bulk-move-stage.job.ts` sem precisar duplicar
  a leitura de org settings dentro do worker (que roda fora de
  RequestContext).

**Modo permissivo defensivo.** Se a leitura da setting falhar (ex.: chamada
do service de cron job que não populou `RequestContext`), a helper loga
e CAI PRO DEFAULT permissivo (`allow_other = true`) em vez de bloquear
o update. O gate é uma melhoria de UX/qualidade de dados, não uma regra
de segurança crítica — bloquear updates legítimos em situação degradada
seria pior que aceitar um motivo livre.

**Alternativas descartadas.**
- *Validar dentro de `buildStatusSyncPatch`*: função é síncrona e parte
  de várias transações. Tornar async cascateava em 6+ call sites e
  exigia repassar `tx` por dentro da validação (não dá pra usar `prisma`
  global em transação ativa por causa do isolamento). Validar no caller
  ANTES de abrir a transação é mais barato e mais claro.
- *Validar só no Zod do route*: cada route teria que carregar a lista
  de motivos e replicar a regra. Centralizar no service garante que
  `automation-executor` (que também marca deals como perdido via
  automação) fica coberto sem mudança extra.
- *Cache em memória da lista de `LossReason`*: hot path? hoje cada
  marcação roda 1 SELECT por validação quando setting=false. Volume
  esperado é baixíssimo (humano clicando no kanban) — premature
  optimization. Se virar gargalo, adicionar `cache.wrap` na própria
  helper depois.

**Impacto.**
- Adicionado: `assertLostReasonAllowed` em `services/deals.ts` (export).
- Modificado: `markDealLost` (1 await no início), `moveDeal` (1 await
  pré-transação), `POST /api/deals/bulk` (2 try/catch translation).
- Comentário em `jobs/leads/bulk-move-stage.job.ts` documentando por que
  o worker não revalida.
- Mensagem de erro padrão: "Motivo da perda inválido. Selecione um dos
  motivos cadastrados em Configurações → Motivos de perda." (orienta o
  caminho de correção, evita ticket de suporte).

---

### 2026-06-23 — Api4com: setup de webhook no `connect-api4com` (user token + fallback manual)

**Contexto.** O fluxo manual `POST /api/sip-extensions/connect-api4com`
(usado pela UI "Conectar Api4Com" em Configurações → Softphone) só
salvava o ramal SIP no banco. Faltava (a) criar o `CallProviderConfig`
com `webhookToken` único pra org e (b) chamar `PATCH /integrations` na
Api4com pra configurar o `webhookUrl`. Sem isso, a Api4com nunca dispara
`channel-hangup` pro nosso `/api/webhooks/calls/api4com?token=...` →
`processWebhookEvent` nunca roda → `Call` nunca é criado → a tela
`/calls` fica vazia, mesmo a chamada tendo acontecido. Sintoma reportado:
"fiz a ligação, mas o histórico está em branco".

**Decisão.** Estender o próprio `connect-api4com` pra completar o setup
de webhook usando o user token (o mesmo token de login email/senha que
sai do `loginApi4Com`). Caminho de melhor UX possível dentro do fluxo
que o operador já está fazendo — sem env adicional, sem endpoint novo,
sem segunda tela. A função `upsertApi4ComWebhookWithUserToken` em
`services/telephony-providers/api4com.ts` faz o `PATCH /integrations`
direto na Api4com com o token do operador (em vez do
`API4COM_SERVICE_TOKEN` admin que o `Api4ComClient` usa).

Idempotência: `getOrCreateApi4ComProviderConfig` no
`call-provider-configs.ts` reutiliza o `CallProviderConfig` existente
da org (`findFirst({ providerKey: "api4com" })` org-scoped) — só o
primeiro operador que conecta cria, os demais herdam o mesmo
`webhookToken`.

Fallback explícito: se o `PATCH /integrations` falhar (403/permissão,
plano sem feature, etc.), o response inclui
`{ webhook: { configured: false, webhookUrl, reason } }` em vez de
mascarar como sucesso. A UI mostra a URL pronta pra colar no portal
Api4com → Integrações → Webhook. Operador resolve em 30s sem precisar
admin nem env nova. Pra ambientes sem `APP_URL`/`NEXT_PUBLIC_APP_URL`
setada, o fallback é forçado (sem domínio, a Api4com não tem pra onde
mandar).

**Alternativas descartadas.**
- *Forçar `API4COM_SERVICE_TOKEN` no env e usar o `Api4ComClient` admin*:
  duplica o fluxo de `enableTelephony` do `provisioning.ts`, que já é
  o "caminho automático completo" (provisiona user + ramal +
  integração) e é incompatível com quem já tem conta Api4com prévia
  (não quer re-provisionar). Além disso, exige token admin no `.env` —
  fricção operacional desnecessária.
- *Endpoint dedicado `POST /api/sip-extensions/setup-webhook`*: pra
  cobrir o caso de operadores que já estão conectados mas sem webhook,
  parece útil. Mas adiciona superfície de API e é trivialmente
  substituível por "desconectar e reconectar" via UI atual. Adicionar
  só se vier demanda real.
- *Configurar webhook em `getMyCredentials`*: side-effect num GET é
  anti-pattern. E o GET roda toda vez que a sessão recarrega — overhead
  desnecessário e race condition se vários operadores logarem ao mesmo
  tempo na mesma org.
- *Persistir `webhookConfigured: true` em `SipExtension.providerMeta`*:
  útil pra evitar refazer o `PATCH /integrations` toda reconexão, mas
  prematuro — `PATCH /integrations` é idempotente na Api4com (segunda
  chamada com mesmo `gateway` retorna 200 sem efeito colateral). Pode
  ser adicionado depois se o tempo da chamada começar a importar.

**Impacto.**
- Operadores existentes que já fizeram `connect-api4com` antes desta
  mudança continuam sem webhook configurado. Pra ativar histórico
  pra eles: re-conectar via UI. UI agora mostra explicitamente se
  o webhook está configurado ou se requer setup manual.
- Multi-tenant seguro: `getOrCreateApi4ComProviderConfig` usa
  `getOrgIdOrThrow()` via Prisma extension, garantindo que o
  `webhookToken` é único por org. Webhook de uma org NUNCA processa
  evento de outra (o `findConfigByWebhookToken` resolve org direto
  pelo token).
- Compatível com o fluxo `enableTelephony` (provisioning admin via
  `API4COM_SERVICE_TOKEN`): ambos chamam o mesmo `PATCH /integrations`
  com o mesmo formato. Se o admin já tinha rodado provisioning antes,
  o `getOrCreateApi4ComProviderConfig` reaproveita o config existente.
- Frontend `Api4ComConnectForm` ganhou bloco condicional de UI:
  verde "webhook configurado" ou caixa amarela com URL + botão copiar
  quando manual. Sem ambiguidade pra o operador.

---

### 2026-06-23 — Hotfix: migration `20260616110000_add_softphone_module` faltante

**Contexto.** Deploy do DEV_BRANCH quebrou a UI de Softphone com erro
`Tabela sip_extensions ausente. Aplique a migration
20260616110000_add_softphone_module e reinicie o backend.` O código (commit
572f06e — `feat(softphone)`) referencia essa migration na mensagem de erro
e a migration seguinte (`20260622120000_api4com_provisioning`) faz
`ALTER TABLE sip_extensions / calls` assumindo que ela existe, mas a
migration **não foi commitada no repo** — o mfpi provavelmente sincronizou
o schema local via `prisma db push` antes de gerar a migration de
`api4com_provisioning`. Como o DB de DEV roda com `SKIP_PRISMA_MIGRATE=1`,
nenhum deploy nunca aplicou esses CREATE TABLE.

**Decisão.** Gerar a migration faltante a partir do schema (`prisma/schema.prisma`
linhas 4015–4216), nomeada exatamente como o código de erro espera
(`20260616110000_add_softphone_module`), criando as 4 tabelas
(`sip_extensions`, `calls`, `call_events`, `call_provider_configs`) e os 5
enums (`SipExtensionStatus`, `CallDirection`, `CallStatus`,
`WebhookAuthMode`, `RecordingDelivery`). Não inclui as colunas/índices/FK
adicionadas pela `20260622120000_api4com_provisioning` (`telephony_enabled`,
`api4com_user_id`, `api4com_gateway`, `provisioning_step`,
`provisioning_error`, `provisioned_at`, `calls.deal_id`, `calls.metadata`,
FK `calls→deals`, índice `calls_organizationId_dealId_idx`, enum
`TelephonyProvisioningStep`) — a `20260622120000` segue sendo a fonte da
verdade pra esses ADDs. Toda a migration é idempotente (`IF NOT EXISTS` +
`DO $$ ... EXCEPTION WHEN duplicate_object`) seguindo o padrão da
`20260615120100_groups_kommo` (precedente do mesmo problema), pra rodar com
segurança em DBs onde o mfpi aplicou parcialmente via `db push`.

**Alternativas descartadas.**
- *Esperar mfpi commitar a migration original*: bloqueia teste da telefonia
  agora; conflito futuro com a versão dele é mais barato que ambiente
  travado.
- *`prisma db push` no banco de DEV*: corrige o sintoma mas não cria
  histórico em `_prisma_migrations` — próximo `prisma migrate deploy`
  ignoraria as tabelas existentes e quebraria de novo na próxima migration.
- *Aplicar SQL direto sem criar migration*: idem acima + zero
  rastreabilidade no repo.

**Impacto.**
- Próximo `prisma migrate deploy` aplica `20260616110000_add_softphone_module`
  + `20260622120000_api4com_provisioning` na ordem correta sem erros.
- DEV continua com `SKIP_PRISMA_MIGRATE=1` — operador roda
  `npx prisma migrate deploy` manualmente no container quando há migration
  nova (procedimento documentado em conversa de implementação).
- Quando o mfpi commitar a versão dele da migration, gera conflito de
  pasta com mesmo nome — resolver mantendo a versão que está no DB
  (provavelmente a nossa, já aplicada).

---

### 2026-06-22 — auto-deals v3: respeitar histórico do contato em inbounds passivos

**Contexto.** Operador reportou que automação com trigger `deal_created`
re-disparava cada vez que cliente com deal LOST voltava a mandar mensagem.
Causa raiz: `ensureOpenDealForContact` em `src/services/auto-deals.ts`
checava apenas `status = OPEN`; se contato tinha só LOST/WON, criava deal
novo e disparava `fireTrigger("deal_created")` — comportamento intencional
da v2 pra resolver "contatos órfãos" no Painel CRM do Inbox, mas
incompatível com o modelo declarativo de automações ("o controle deve
ser pelos gatilhos que eu configurei, não pelo backend").

**Decisão.** Novo default: `ensureOpenDealForContact` só auto-cria deal
quando o contato NUNCA teve deal algum. Se tem histórico (OPEN/WON/LOST),
delega a decisão pras automações configuradas pelo operador (trigger
`message_received` + filtro `dealStatus` + step `create_deal`). Opt-in
explícito via `reopenLostContacts: true` mantém comportamento v2 para
chamadores que precisam garantir destino pros dados (WhatsApp Flow
Response — formulário preenchido precisa de deal pra anexar campos; e
scripts de backfill manuais).

**Alternativas descartadas.**
- *Filtro `dealStatus` em `deal_created`*: paliativo — backend continuaria
  criando deal desnecessariamente, só não dispararia. Custo computacional
  e poluição da base de deals iguais ao bug original.
- *Setting por organização*: complexidade desproporcional pra uma regra
  que é claramente certa por default. Quem quiser reativação automática
  configura via automação (caminho declarativo) ou usa o opt-in nos
  callers específicos.
- *Reabrir deal LOST em vez de criar novo*: alteraria semântica histórica
  (deal LOST representa decisão deliberada do operador) e dispararia outro
  problema (qual evento emitir — `deal_reopened` não existe ainda).

**Impacto.**
- Callers de inbound passivo (`workers/baileys/message-handler.ts`,
  `lib/meta-webhook/handler.ts`) automaticamente herdam o novo default
  — nenhuma mudança no caller foi necessária além de atualizar comentários.
- Callers que precisam preservar o comportamento legado (`services/whatsapp-flow-response.ts`,
  scripts `backfill-deals-for-contacts.ts` e `backfill-inbox-deals.ts`)
  recebem `reopenLostContacts: true` com justificativa inline.
- Novo `EnsureOpenDealResult.reason: "contact_has_closed_deal"` — callers
  que tratavam `skipped` como genérico continuam funcionando (any-reason
  pattern); quem quiser logar por motivo específico pode discriminar.
- Operadores que dependiam de reativação automática precisam criar uma
  automação `message_received` (filtro `dealStatus=LOST` + step `create_deal`).
  Esse fluxo já é suportado pela infra existente — não exige mudança no
  worker de automações.

---

### 2026-06-22 — Api4com: Provisionamento + Singleton JsSIP + Revisão [DECISÃO — agente OPUS]

**Contexto.** Fases 2, 5 e 6 do plano de integração Api4com (`docs/PLAN-api4com.md`),
executadas em Opus conforme governança de modelos.

**Decisão 1 — Prisma migration `20260622120000_api4com_provisioning`.** Adicionados:
- Enum `TelephonyProvisioningStep` (8 estados da máquina de provisionamento).
- Campos em `SipExtension`: `telephonyEnabled`, `api4comUserId`, `api4comGateway`,
  `provisioningStep`, `provisioningError`, `provisionedAt`.
- Campos em `Call`: `dealId` (FK → `Deal`, onDelete SetNull), `metadata` (JSONB).
- Índice `(organizationId, dealId)` em `calls`.

**Decisão 2 — ProvisioningService máquina de estados.** Serviço stateless em
`services/api4com/provisioning.ts`. Cada passo persiste `provisioningStep` ANTES de
avançar (retomada segura após crash). 409 em POST /users = skip para CREATE_EXTENSION.
Toggle OFF: marca DISABLED + INACTIVE sem apagar ramal remoto.

**Decisão 3 — Singleton JsSIP em escopo de módulo.** Variáveis `moduleUA`,
`moduleSession`, etc. vivem no escopo do módulo (`use-softphone.ts`), NÃO em
`useRef` de componente. Motivo: remount não perde registro SIP. `beforeunload`
garante cleanup ao fechar aba. `disconnect()` explícito destrói o UA.

**Decisão 4 — Auto-answer por header SIP.** Além do `pendingDial` (heurística 1),
inspeciona `X-Api4comintegratedcall: true` na INVITE inbound (heurística 2). Permite
auto-answer mesmo em cenários de retry pelo PBX onde o dial REST não precede
diretamente a INVITE.

**Decisão 5 — Verificação cross-org na rota PATCH /users/:id/telephony.** Admin de
org A não pode provisionar user de org B. Verificação explícita com
`prisma.user.findFirst({ id, organizationId })` antes de chamar `enableTelephony`.

---

### 2026-06-16 — Módulo de Softphone (SIP/WebRTC) [DECISÃO — agente OPUS]

**Contexto.** Briefing pede softphone que registra ramal SIP e faz/recebe chamada
WebRTC **no navegador**, com histórico alimentado por webhook do provedor, gravações
disponíveis e UI no DS v2. Provedor é genérico (qualquer ramal SIP padrão). Spec
completo em `docs/superpowers/specs/2026-06-16-softphone-sip-webrtc-design.md`.

**Decisão 1 — Mídia/registro no client, backend só persiste.** O registro SIP e o
áudio rodam no navegador via **JsSIP** (escolhido sobre SIP.js por foco em
registrar ramal + chamada contra PBX). Backend NUNCA registra ramal nem processa
mídia: só guarda credenciais cifradas, entrega ao próprio dono e processa o webhook.

**Decisão 2 — Domínio próprio multi-tenant.** Models novos `sip_extensions`,
`calls`, `call_events`, `call_provider_configs` (cuid, camelCase + `@map`,
`organizationId` direto, em `RLS_PROTECTED_TABLES` e `SCOPED_MODELS`). Migration
idempotente. Reuso de `lib/crypto/secrets.ts` (`KEYRING_SECRET`) para
`authPasswordEncrypted` e `webhookSecretEncrypted` — sem cripto nova.

**Decisão 3 — `CallProviderConfig` (entidade não prevista no briefing).** Criada por
dois motivos: (a) resolver o tenant num webhook **público** via `webhookToken` único
(consulta sistêmica com `prismaBase`, depois `withResolvedContext({ organizationId })`
para o restante do fluxo); (b) tornar o adapter genérico **configurável** sem deploy
(`fieldMappings` + mapa de status). Auth do webhook suporta **HMAC e/ou token**.

**Decisão 4 — Idempotência por `(organizationId, provider, providerCallId)`.** O
histórico é alimentado pelo webhook (fonte da verdade), não pelo JsSIP — chamada de
ramal físico/perdida também entra. Reenvio do mesmo evento só atualiza
status/timestamps/duração, nunca duplica.

**Decisão 5 — Gravações no storage local existente.** Re-hospedadas via
`saveFile` no bucket `recordings` (já na whitelist), URL própria `/api/storage/...`
— não depende de link que expira no provedor. Sem S3.

**Decisão 6 — Adapter plugável.** `services/call-adapters/` com interface
`normalizeCallEvent` + registry; `generic-sip` dirigido por config. Ponto claro para
plugar `asterisk` etc. no futuro, sem assumir payload fixo.

**Decisão 7 — Widget global persistente.** Montado em `(app)/layout.tsx` (irmão de
`{children}`, `z-[55]`), estado em Zustand (`softphone-store`), lógica SIP isolada em
`useSoftphone`. Não atrelado a rota — chamada não cai ao navegar.

---

### 2026-06-16 — Módulo de E-mail (IMAP/SMTP multi-conta) como DOMÍNIO NOVO, sem "tipo de canal" especial [DECISÃO — agente OPUS]

**Contexto.** Briefing pede caixa de entrada de e-mail multi-conta (IMAP/SMTP),
envio, e vínculo automático com contatos/leads, com UI 100% no Design System v2.
Já existe `ChannelType.EMAIL` no enum de canais, mas aquele domínio é orientado a
mensageria WhatsApp/Meta (Baileys, templates, webhooks) e **não** modela
caixa-postal IMAP/SMTP. Reaproveitá-lo acoplaria conceitos distintos.

**Decisão 1 — Domínio próprio, não estende `Channel`.** Duas tabelas novas,
`email_accounts` e `emails`, com `organizationId` direto (multi-tenant) entrando
em `RLS_PROTECTED_TABLES` (`lib/rls.ts`). Enforcement primário continua sendo a
Prisma Extension app-layer (`withOrgFromCtx`/`withOrgContext`), igual ao resto do
CRM — RLS é a 2ª camada (ainda não ENABLE em prod). Migration idempotente
(`IF NOT EXISTS` + `DO $$`), no padrão das demais.

**Decisão 2 — Reuso de criptografia existente.** A senha IMAP/SMTP usa
`encryptSecret`/`decryptSecret` (`lib/crypto/secrets.ts`, AES-256-GCM, env
`KEYRING_SECRET`). Coluna `passwordEncrypted` (`@map("password_encrypted")`).
Senha **nunca** retorna em nenhuma resposta de API nem é logada; descriptografa
só no momento de abrir a conexão. NÃO criar serviço de cripto novo.

**Decisão 3 — Dependências.** `imapflow` (IMAP, TS-first, promises) + `nodemailer`
(SMTP de facto + `verify()` para teste de conexão). Não havia lib IMAP/SMTP no
backend; estas são as escolhas mantidas/ativas em 2026.

**Decisão 4 — Contrato de erro por campo.** Endpoints de conta retornam
`{ ok:false, field, message }` no 1º erro. Ordem de teste obrigatória: IMAP
**depois** SMTP, parando no 1º erro — é o que define qual campo destacar. Camada
`email-imap.ts`/`email-smtp.ts` traduz exceções do provedor para `{ field, message }`.

**Decisão 5 — Vínculo de contato via use-case existente.** A resolução de
`contactId` na sincronização usa `getContacts({ emailExact })` para match e
`createContact(...)` (services/contacts.ts) para criação — que já dispara
`logEvent`/efeitos colaterais. PROIBIDO inserir em `contacts` direto. Criação só
quando `createContactsForReplies = true`.

**Decisão 6 — Visibilidade no BACKEND.** `shared` = visível a quem tem
`email_account:view`; `personal` = só `ownerUserId` (gate `email_account:view_own`).
Caixa combinada (`GET /emails` sem accountId) = união das contas acessíveis ao
usuário, resolvida no serviço, não na UI. Novo resource `email_account` no
catálogo de permissões + item `email` na sidebar (backend + catálogo FE espelhado).

**Decisão 7 — Estrutura de arquivos (segue convenção do repo).**
- Backend services: `email-accounts.ts` (CRUD + orquestra teste), `email-imap.ts`,
  `email-smtp.ts`, `email-sync.ts` (IMAP→DB→resolução de contato).
- Rotas: `app/api/email-accounts/**` e `app/api/emails/**` (padrão `withOrgContext`).
- Frontend: feature `src/features/email-v2/` (types/api/hooks/components) + page
  fina `src/app/(app)/email/page.tsx`. UI só com componentes/tokens do DS v2.
- `checkbox` e `segmented-control` não existem em `components/ui` — criar seguindo
  tokens do DS v2 (não componentes soltos fora do DS).

**Decisão 8 — Threading e dedup.** `threadId` = assunto normalizado (sem
`Re:`/`Fwd:`) quando `groupInThreads`, senão `messageId`. Unicidade
`(accountId, messageId)` evita reinserção em re-sync.

**Aberto (defaults assumidos, ajustáveis):** leitura da mensagem via `Sheet`
(drawer) do DS v2; RLS das tabelas novas fica "policy-ready" mas não ENABLE
(mesmo estado do resto do schema).

---

### 2026-06-22 — Auto-deal não recria negócio em reengajamento de deal fechado (decisão fica na automação) [DECISÃO — agente Opus]

**Decisão.** `services/auto-deals.ts` (`ensureOpenDealForContact`): quando o
contato não tem negócio `OPEN` mas já possui um negócio fechado (WON/LOST), o
auto-deal **não cria** um novo (retorna `skipped` / `has_closed_deal`). Mantém o
negócio fechado intacto. Para contato **sem nenhum negócio** (primeiro contato),
o comportamento é o de antes: cria e dispara `deal_created` (regra de recepção
preservada).

**Contexto.** Bug do contato `+5511940571366`: deal #2493 foi para "Perdido"
(LOST); ao reengajar, o auto-deal — que só checava `OPEN` — criou o #3729 e
re-disparou `receptivo_geral` (gatilho `deal_created`), gerando negócio
duplicado. Além de duplicar o card, criar um OPEN aqui faz o gatilho
`message_received` enxergar `dealStatus = OPEN` (ver `enrichContext`),
impossibilitando uma automação de reengajamento filtrada por WON/LOST.

**Direção de produto (definida pelo usuário).** O reengajamento de negócio
fechado é **regra de negócio** e deve ser modelado no builder: uma automação
com gatilho `message_received` filtrado por `dealStatus = WON,LOST`, usando
`condition` para decidir entre `create_deal` (novo) ou `move_stage` (reabre —
mover para estágio não-terminal já seta `status = OPEN`). O código apenas para
de duplicar e devolve o controle para essa automação.

**Alternativas descartadas.**
- *Auto-deal reabrir LOST automaticamente / filtro `onlyIfFirstDeal` no
  `deal_created`* (implementado e revertido): hardcoda a decisão e mexe na regra
  `deal_created`, que o usuário quer preservar.
- *Janela de reativação por tempo*: rejeitada (não se aplica ao negócio).

**Pendências/caveats.** (1) `whatsapp-flow-response.ts` usa o mesmo helper: para
um lead com deal fechado, a gravação de campos de formulário fica sem deal
(alerta "nenhum negócio aberto") até a automação reabrir — a automação de
reengajamento deve reabrir antes de depender de campos de deal. (2) Rodar
`npm install` + `next build` antes do deploy (clone sem `node_modules`).
(3) Avaliar limpeza dos duplicados já existentes. (4) Guard de reentrada em
`automation-executor.ts` foi **revertido** antes do deploy em prod — escopo
mínimo: só `auto-deals.ts` para não introduzir efeito colateral não validado.

---

### 2026-06-15 — Migração DEV_BRANCH → prod (DNA): nova migration `backfill_catalog_permissions` e protocolo manual de aplicação [DECISÃO — agente Opus]

**Decisão.** Antes do merge `DEV_BRANCH → main`, aplicar manualmente em prod
as 11 migrations idempotentes da DEV_BRANCH **+ uma 12ª nova**
(`20260615120200_backfill_catalog_permissions/migration.sql`) que faltou na
DEV_BRANCH para atualizar `roles.permissions` dos presets MANAGER e MEMBER de
orgs já existentes (DNA, EduIT, teste). Aplicação via
`scripts/dev/apply-dev-branch-migrations.mjs` — script idempotente que faz
BEGIN/COMMIT por arquivo, com checagem de `_prisma_migrations` antes/depois.

**Contexto.** A DEV_BRANCH adicionou novos resources ao `PERMISSION_CATALOG`
(catalog/inventory/job_opening/org_unit + product:manage_*) e atualizou
`src/lib/authz/presets.ts` com 14 keys novas no MANAGER e 5 no MEMBER. Pelo
comentário do próprio `presets.ts`, mudanças de preset **exigem migration de
update para refletir em orgs existentes** — a DEV_BRANCH esqueceu essa
migration, então roles snapshotados (DNA) ficariam fail-closed nas features
novas pós-merge. A migration nova segue exatamente o pattern idempotente
(`UNNEST + DISTINCT`) já estabelecido em
`20260609180000_add_nav_permissions/migration.sql` — preserva customizações
manuais e nunca duplica entradas.

**Alternativas descartadas.**
- *"Reset to preset" via UI da DNA pós-merge*: exigiria intervenção humana
  na DNA e perderia qualquer customização que o admin tivesse adicionado às
  permissions. Reprovado.
- *Não fazer nada e esperar usuário descobrir*: causaria fail-closed
  silencioso (gestores sem acesso a Catálogo/Inventário/Vagas), suporte
  reativo. Reprovado.
- *`prisma migrate deploy` em prod*: prod usa `SKIP_PRISMA_MIGRATE=1` por
  política — aplicação manual via `db execute --file` ou equivalente é o
  pattern do projeto. As migrations já são escritas idempotentes
  (`IF NOT EXISTS`, `DO $$ EXCEPTION`) justamente para isso. Mantido.

**Impacto.**
- 12 migrations registradas em `_prisma_migrations` do prod.
- DNA: MANAGER 88→102 perms, MEMBER 31→36 perms (gap de catálogo
  preenchido). 1866 contatos numerados (`Contact.number` 1..1866). 1 produto
  ligado ao "Catálogo padrão" criado automaticamente. Tabelas Group vazias
  (criadas zeradas — sem efeito até o admin configurar).
- EduIT: idem (183 contatos numerados, 2 produtos no novo catálogo default).
- Backup defensivo de 82MB (`backups/prod-2026-06-15-175443/data.sql`,
  formato `pg_dump --data-only`) — restaurável via `psql -f data.sql` num
  schema com as migrations aplicadas. Não versionado (`.gitignore`).
- Scripts adicionados (commitáveis):
  `scripts/dev/inspect-prod-readonly.mjs`,
  `scripts/dev/apply-dev-branch-migrations.mjs`,
  `scripts/dev/backup-prod-data.mjs`,
  `scripts/dev/verify-prod-postmigration.mjs`.
- Risco residual: zero quebra na main rodando (todas mudanças aditivas — o
  Prisma client da main não enxerga colunas/tabelas novas, então não as
  consulta).

---

### 2026-06-13 — Permissões por GRUPO com escopo (modelo Kommo) em `/settings/permissions` — entidade `Group` nova, ADITIVA ao RBAC de papéis [DECISÃO — agente OPUS]

**Decisão (escolhida pelo usuário: "modelo completo" + nível "Equipe" adiado).**
Novo domínio `Group` (Prisma) com membros e permissões **com escopo por ação**
(`PermissionLevel`: `NONE | SELF | TEAM | ALL`), espelhando o mockup estilo
Kommo. Modelos: `Group`, `GroupMember`, `GroupPermission`, `GroupStageGrant`,
`GroupFieldGrant` + extras no grupo (`sharedInbox`, `mediaAccess`,
`sidebarRoutes`). Migrado via `prisma db push` (crm_dev sem migrations).

**Por quê ADITIVO (não substitui papéis).** O RBAC de papéis (`Role.permissions
string[]` + `UserRoleAssignment`) continua intacto. Permissões efetivas de um
user = **união** papéis ∪ grupos. No resolver (`lib/authz/index.ts`,
`loadFromDb`): toda `GroupPermission` com nível ≥ `SELF` injeta a key booleana
`resource:action` no `can()`; o nível fica num mapa `scopes` (resource → action
→ nível) no `AuthzContext` para dirigir a visibilidade own/all. Usuários sem
grupos mantêm exatamente o comportamento atual (fail-safe — evita repetir o
incidente de "sumiço de dados").

**Nível "Equipe" (TEAM) adiado.** Sem estrutura de times no sistema, o enum
inclui `TEAM` (forward-compat) mas a UI mostra apenas `NONE/SELF/ALL` ativos
(`Equipe` aparece desabilitado como "em breve"). No resolver, `TEAM` é tratado
como `ALL` defensivamente, mas nunca é gravado pela UI.

**Enforcement (escopo desta entrega).**
- **Gating de ação** (create/view/edit/delete/export) via `can()`: vale para
  **todas** as entidades, pois grupos alimentam `can()`.
- **Visibilidade de linha own/all**: ligada em **deals** e **conversas** via
  `getVisibilityFilter` (grupos só EXPANDEM: nível `ALL` no `view` promove o
  usuário "own"→"all"; nunca restringem ali).
- **Etapas (`GroupStageGrant`) e campos (`GroupFieldGrant`)**: têm UI +
  persistência completas, mas o enforcement por etapa/campo fica **staged**
  (reaproveitará o caminho de `ScopeGrants` / flag `rbac_granular_scope_v1`)
  para não esconder dados por engano nesta fase.

**Rotas.** `GET/POST /api/groups`, `GET/PUT/DELETE /api/groups/[id]`,
`POST /api/groups/[id]/members`, `DELETE /api/groups/[id]/members/[userId]`
(substituem o stub 501). Gate: `settings:permissions`. Membros reaproveitam o
mesmo padrão de `UserRoleAssignment`. UI: hub em `/settings/permissions` +
editor full-width em `/settings/permissions/groups/[groupId]`.

---

### 2026-06-13 — Grupos de acesso de mensageria (`/settings/conversations`): herança PRAGMÁTICA + assinatura ainda global [DECISÃO — agente OPUS]

**Contexto.** Reconstrução de `/settings/conversations` para um modelo de 3 telas
(lista de grupos → editor de preset → editor custom com herança). O brief assume
herança+override e assinatura por-grupo, mas o backend tem `Role.permissions`
**plano** (lista de chaves efetivas), sem herança nem override, e assinatura
**global** por organização (`OrganizationSetting` lido pelo composer).

**Decisão (escolhida pelo usuário entre 3 opções).**

1. **Herança pragmática, não em runtime.** Adicionada **uma coluna aditiva**
   `Role.inheritsFrom String?` (+ índice) via migration idempotente
   (`ADD COLUMN IF NOT EXISTS`). Grupos personalizados continuam guardando as
   permissões **efetivas** em `permissions`; a UI calcula "herdado vs
   personalizado" por **diff** contra o efetivo do base (`inheritsFrom`).
   Helpers puros e testados em `frontend/src/features/messaging-roles/inheritance.ts`.
   - `can()` **não** muda — não há resolução de herança no servidor.
   - **Cascata não é automática.** Editar um preset não propaga sozinho. A
     propagação é uma **ação explícita** ("Reaplicar aos dependentes ao salvar"),
     que preserva o que cada dependente personalizou medindo override contra o
     base **anterior** ao save.

2. **Serviço de roles (`services/roles.ts`):** `createRole`/`updateRole` aceitam
   `inheritsFrom` (validado: precisa ser role da MESMA org; não pode herdar de si
   mesmo). `deleteRole` passa a **recusar exclusão com membros** (`assignments>0`)
   — a UI antecipa a regra, mas o servidor é a fonte da verdade. Zod das rotas
   `POST/PUT /api/roles` estendido com `inheritsFrom`.

3. **Assinatura permanece GLOBAL no v1 (pendência registrada).** O brief pede
   assinatura por-grupo substituindo o toggle global. Mantivemos o toggle global
   (`agentSignatureEnabled/Editable`) **sem reinterpretar** silenciosamente como
   per-role. Tornar por-grupo exige adicionar a permission `signature:edit` ao
   catálogo + religar o composer para ler a permission da role em vez do
   `OrganizationSetting` — **trabalho de backend a fazer numa próxima fase.**

**Por quê.** Entregar o UX das 3 telas (comparar grupos, criar por área, herdado×
personalizado com `↺ herdar`) com **mudança mínima e aditiva** no backend,
evitando reescrever o núcleo de autorização. O trade-off aceito é cascata manual
em vez de herança viva.

**Não-objetivo / dívida.** Herança real em runtime e assinatura por-grupo ficam
para uma fase futura (exigiriam storage de override + mudança no `can()`/composer).

---

### 2026-06-13 — Catálogo por Capacidades, Fase 2: services agnósticos sobre os primitivos existentes [DECISÃO — agente OPUS]

**Decisão.** Os três services do PRD (Fase 2) nascem como **camadas agnósticas
sobre o que já existe**, sem reescrever o legado:

- **`allocation.ts`** — fachada (vocabulário AllocationPool/Movement) sobre
  `inventory.ts`, que já é a porta única transacional/auditada. Reexporta
  `getBalance/consume/reserve/release/restock/reverse`; adicionei `adjust`
  (delta assinado, reason ADJUSTMENT, respeita `allowNegative`) **em
  `inventory.ts`** (onde vive o `lockPool`); e o **alerta de saldo baixo**:
  `consume`/`reserve` da fachada resolvem o `lowThreshold` da config da
  capability `allocation` (ProductCapability → fallback CatalogCapability) e
  emitem `ALLOCATION_LOW` ao cruzar o limite.
- **`fulfillment.ts`** — `onCommercialDealWon(dealId)` 100% agnóstico: para cada
  produto com capability `fulfillment`, lê `config.creationTrigger`
  (MANUAL→tarefa "configurar operação" via `FULFILLMENT_SETUP_REQUIRED`;
  BY_AUTOMATION→no-op; ON_WON→cria deal `dealRole=OPERATIONAL` no pipeline da
  config + `DealLink(ORIGINATED)`). **Zero `if (kind)`** — convive com o legado
  `product-fulfillment.ts` (que continua por kind). Ligado pós-commit ao lado do
  gancho legado em `deals.ts` (moveDeal e markDealWon).
- **`stakeholder-notify.ts`** — nova `evaluateStakeholderRules({productId,
  event, ...})`: carrega `StakeholderRule` (event×role×templateRef), casa papéis
  com `ProductStakeholder` e entrega pelo mecanismo LGPD-mínimo já existente.

**Steps de automação genéricos** (em `automation-executor.ts`): `allocation.adjust`
(operation adjust|consume|restock|reserve|release, roteado pela fachada p/ disparar
o alerta) e `stakeholder.notify`. Sem lógica por vertical.

**`createDeal` ganhou `dealRole?`** (opcional; default COMMERCIAL no schema) para
o fulfillment criar deals operacionais.

**Schema:** `EventEntityType` ganhou `PRODUCT` (migration aditiva
`20260613140000_event_entity_product`) para o `ALLOCATION_LOW` sem deal.
Verificação: lint limpo, `tsc` mantém 21 erros pré-existentes (0 novos), build verde.

---

### 2026-06-13 — Catálogo Universal por Capacidades: coexistência aditiva com o domínio multi-tipo (Fases 0–1) [DECISÃO — agente OPUS]

**Decisão.** Implementar o catálogo agnóstico por capacidades do PRD
(`decision-log/PRD-catalogo-capacidades.md`) **sobre** o domínio de produtos
multi-tipo de 2026-06-11, sem reescrever nada. O núcleo passa a conhecer
`Product`/`Catalog`/capacidades; os verticais (curso, vaga, SaaS…) só existem
como TEMPLATES de dados que ligam capacidades — **nenhum `if (kind === ...)`
novo**.

**Por que coexistência (e não substituição).** O schema já tinha, há 2 dias,
`ProductKind`, `InventoryPool/Movement`, `ProductOffer/Plan/Shipping`,
`CourseConfig`, `JobOpening`, `ProductStakeholder` — com código vivo. O PRD §5
diz "não existem `CourseConfig`/`JobOpening`", mas removê-los seria regressão
destrutiva. Optou-se por **congelar o legado** e mapear cada capacidade aos
primitivos existentes:

| Capacidade | Implementação (reuso) |
|---|---|
| `allocation` | `InventoryPool` / `InventoryMovement` (= AllocationPool/Movement) |
| `pricing` | `ProductOffer` |
| `recurrence` | `ProductPlan` |
| `shipping` | `ProductShipping` + **`ShippingRange`** (novo: faixas de CEP) |
| `stakeholders` | `ProductStakeholder` + **`StakeholderRule`** (novo: event×role×template) |
| `scheduling` | **`CapacitySlot`** (novo: caminho agnóstico que sucede `CourseClass`) |
| `fulfillment` | **`DealLink`** (novo) + **`Deal.dealRole`** |

**Registro de capacidades = só código.** O conjunto fechado de 8 capacidades
vive em `src/lib/capabilities/` (Fase 0): cada uma exporta `key`/`label`/
`description` + schema Zod do `config`. Não há tabela `Capability` (evita fonte
dupla de verdade); as junctions `CatalogCapability`/`ProductCapability` guardam
`capabilityKey` como string validada pelo registry, e `config Json` validado
pelo Zod antes de persistir. Adicionar capacidade = PR (código+schema+validação),
nunca ação de usuário. Exposto ao frontend por `GET /api/capabilities`
(JSON Schema serializado para o wizard montar sub-perguntas).

**Migration (`20260613130000_catalog_capabilities`).** 100% aditiva e
idempotente (`IF NOT EXISTS` / `DO $$ ... EXCEPTION WHEN duplicate_object $$`),
aplicada no dev via `prisma db execute` (mantém `SKIP_PRISMA_MIGRATE=1`; nunca
`migrate deploy` em prod). Novos models: `Catalog`, `CatalogCapability`,
`ProductCapability`, `CapacitySlot`, `ShippingRange`, `StakeholderRule`,
`DealLink`. Extensões: `Product.catalogId`, `Deal.dealRole` (default
`COMMERCIAL`, indexado — PRD §9). Enum `InventoryReason` ganhou alias `RELEASE`
(coexiste com `RESERVATION_RELEASE`). **Backfill:** um `Catalog` default por org
+ capability `pricing` ligada + produtos sem catálogo movidos pro default.
Atenção: o `migrate diff` capturou drift pré-existente do banco de dev
(`channels.defaultPipelineId`, `contacts.number NOT NULL`) que foi **removido à
mão** da migration por não pertencer a esta feature (e `contacts.number NOT NULL`
sem default quebraria tabela populada).

Todos os 7 models novos entraram em `SCOPED_MODELS` (multi-tenant). Verificação:
schema válido, `prisma generate` ok, `tsc --noEmit` mantém os 21 erros
pré-existentes (0 novos), lint limpo.

---

### 2026-06-12 — Atribuição Canal → Funil (planejado, aguardando backend) [DECISÃO — agente OPUS]

**Decisão.** Documentado o plano para roteamento de origem (canal A → funil X,
canal B → funil Y) como mudança **aditiva**: `Channel.pipelineId String?` +
uso em `ensureOpenDealForContact` (`src/services/auto-deals.ts`) com **fallback**
para o pipeline `isDefault` atual (zero regressão para canais sem funil setado).

**Contexto.** Diagnóstico a partir de dúvida do usuário comparando dois
paradigmas: (1) **permissão por agente por canal** e (2) **canal → funil**.
Conclusão da investigação: o paradigma (1) **já existe e é granular**
(`ScopeGrants` — `channel.view/send.users[userId]`, UI em
`features/permissions/user-permissions-view.tsx`, aplicado em
`conversation-access.ts`); o paradigma (2) **não existe** — todo inbound cai no
pipeline default, ignorando o canal.

**Status.** Não implementado. Parte de schema exige migração de banco, hoje
bloqueada por restrição operacional ("não subir commit do backend"). Plano,
partes e alternativas em `docs/decisoes/canal-funil.md`.

### 2026-06-11 — Produtos multi-tipo (Físico, Serviço, Curso, Vaga) com alocação consumível

**Decisão.** Evoluir o domínio de Produtos para 4 tipos sobre **dois primitivos
compartilhados** — alocação consumível via **ledger** (`InventoryPool` +
`InventoryMovement`) e **oferta por unidade** (`ProductOffer`) — de forma 100%
aditiva e multi-tenant. Nada de subsistema paralelo por tipo: cria-se o
primitivo e dá-se semântica por `Product.kind`.

**OrgUnit (não reusar Groups).** Criado model novo `OrgUnit` (filial/CNPJ,
endereço, auto-relação `parentId`). Os "groups" do projeto são stub de RBAC/filas
da Fase 3 (sem model Prisma, rota retorna `[]`/`501`) e semanticamente são
equipe/fila de atendimento, não unidade jurídica. `Company` é conta cliente B2B.
Tenant continua sendo `Organization`. Detalhes e alternativas em
`docs/decisoes/org-unit.md`.

**Estoque em modo PARALELO.** `Product.stock`/`trackStock` e o step de automação
legado `consume_stock` (mutação direta da coluna) ficam **intactos** para
compatibilidade. O ledger novo é a **fonte de verdade apenas dos pools novos**.
Saldo do pool = `sum(InventoryMovement.delta)`; nunca uma coluna mutável. Toda
baixa/reposição é um movimento dentro de `prisma.$transaction` (atômico, sem
corrida na última unidade), com ator e motivo.

**`Product.kind` vs `Product.type`.** Mantido o campo legado `type` (String
"PRODUCT"/"SERVICE", usado por rotas/import existentes) e adicionado `kind`
(enum `ProductKind`, default `PHYSICAL`). Backfill na migration:
`UPDATE products SET kind='SERVICE' WHERE type='SERVICE'`.

**Migration aplicada via `db execute` (não `migrate dev`).** O banco de dev local
(`crm_dev`) é gerenciado em estilo `db push` — `prisma migrate status` mostra as
84 migrations como "não aplicadas". Rodar `migrate dev` tentaria reaplicar tudo
do zero e quebraria. Então: o arquivo de migration
`prisma/migrations/20260611200000_products_multitype/migration.sql` foi gerado
(via `migrate diff` contra o banco real — delta 100% aditivo) e aplicado com
`prisma db execute`, seguido de `prisma generate`. O arquivo fica versionado para
prod/teammates (`migrate deploy`).

**FKs scalar (sem relation) de propósito.** `InventoryMovement.dealId`,
`JobOpening.b2bDealId`/`candidatePipelineId`/`consumeStageId`/`reserveStageId` e
`CourseConfig.postSalePipelineId` são `String?` sem `@relation` — são apenas IDs
referenciados por lógica de app (dropdowns), evitando acoplar `Deal`/`Pipeline`/
`Stage` a back-relations e mantendo o diff de schema enxuto. Queries por esses
campos usam o scalar diretamente (`where: { dealId }`).

**Multi-tenant.** Todos os models novos entraram em `SCOPED_MODELS`
(`src/lib/prisma.ts`) para auto-injeção de `organizationId`.

---

### 2026-06-09 — Escopo por usuário de funis e canais (ScopeGrants estendido)

**Decisão.** Permitir que um usuário individual tenha acesso só a funis
específicos e só veja/envie mensagens em canais específicos, estendendo o
sistema `ScopeGrants` existente (`permissions.scope.grants.v1`) em vez de
criar tabela nova. Tudo atrás da flag `rbac_granular_scope_v1`.

**Por quê estender ScopeGrants e não tabela nova.** Já existe storage
(`OrganizationSetting`), flag, normalização (`parseScopeGrants`) e enforcement
plumbing (`resource-policy.ts`). O override por usuário espelha o precedente
`crm.users[userId]`. Menos superfície, zero migration.

**Shape adicionado** (`scope-grants-shared.ts`, back + cópia front):
- `pipeline.users[userId] = string[]` — IDs de funis visíveis (`["*"]` = todos,
  `[]` = nenhum, chave ausente = cai na regra por papel / liberado).
- `channel.view.users[userId]` e `channel.send.users[userId]` — IDs de canais
  (`Channel.id`). Canais não tinham regra legada por papel, só override por
  usuário. `send` exige também `view`.

**Helpers puros novos:** `canAccessPipelineForUser`,
`listAllowedPipelineIdsForUser`, `canAccessChannelForUser`,
`listAllowedChannelIdsForUser`. Em `resource-policy.ts`:
`listAllowedPipelineIds`, `requireChannelScope`, `listAllowedChannelIds`;
`requirePipelineScope("view")` passou a considerar o override por usuário.

**Enforcement aplicado:**
- Funis: `getPipelines({allowedPipelineIds})`, `getDeals({allowedPipelineIds})`
  (filtro no WHERE — corrige paginação) e o board do kanban
  (`pipelines/[id]/board` GET+POST, que antes **não** checava scope — gap
  fechado).
- Canais: `getConversations`/`getTabCounts` (filtro `channelId in [...]`),
  `userHasConversationAccess` (acesso individual) e todas as rotas de envio
  (`messages`, `attachments`, `template`, `create`). Notas privadas não passam
  pelo gate de `send` (são internas).

**API de escrita:** endpoint dedicado `GET/PUT /api/users/[id]/scope-grants`
que faz **read-merge-write** — nunca apaga regras de outros usuários/papéis
(diferente de `PUT /api/settings/permissions`, cujo `setScopeGrants` substitui
o objeto inteiro). `null` = sem restrição (remove a chave do user); array =
restringe.

**Não mexido de propósito:** `effective-permissions` continua devolvendo
`channelGrants: []` — no front esse campo significa *tipos* de canal
(whatsapp/instagram), não IDs; preencher com IDs quebraria o filtro da inbox.
O backend é a fonte de verdade do enforcement.

**UI.** Editor por usuário em `UserPermissionsView` (sheet "Gerenciar"):
multiselect de funis + canais (ver/enviar), com toggle "Todos". Só tem efeito
real com a flag ligada.

---

### 2026-06-11 — GET /api/custom-fields aceita Bearer (dropdown de custom fields no node n8n)

**Decisão.** `GET /api/custom-fields` foi migrado de `withOrgContext`
(somente cookie NextAuth) para `authenticateApiRequest` + `runWithApiUserContext`,
passando a aceitar Bearer token. Motivo: o pacote `n8n-nodes-eduit-crm`
precisa listar as definições de campos personalizados para montar dropdowns
amigáveis em Create/Update de contato e negócio.

**Contexto.** As rotas por entidade (`/api/contacts/:id/custom-fields`,
`/api/deals/:id/custom-fields`) já haviam sido migradas para Bearer (bug
27/mai/26). A listagem global era a única que ainda barrava integrações.

**Autorização.** A resposta contém apenas DEFINIÇÕES (id/nome/label/tipo/opções),
dado não-sensível já exposto pelas rotas por entidade. Para `entity=deal`
mantém-se o gate `deal:view`; para contato segue o padrão de `/api/contacts`
(apenas autenticação). `POST` permanece restrito (sessão + `settings:custom_fields`).

**Alternativas descartadas.** (a) Manter `settings:custom_fields` no GET —
exigiria que o usuário do token tivesse permissão de configurações, quebrando
o dropdown para integrações comuns. (b) Resolver nomes de campo no node sem
listar (free-text) — funciona, mas perde a UX de dropdown pedida.

**Impacto.** Aditivo; sessão (UI) continua funcionando. Sem mudança de schema.
Requer deploy do backend para o dropdown aparecer no n8n.

---

### 2026-06-10 (PR 2) — Hardening do marketplace de widgets (robustez do iframe + rate limits + healthcheck bloqueante)

**Decisão.** Camada de proteção sobre o marketplace MVP do mesmo dia,
endereçando os riscos críticos identificados em análise (iframe sem
detecção de falha, sem rate limit no SSO, instalações órfãs, sem
healthcheck no publish). Quatro frentes:

1. **Runner do iframe à prova de falha** (`SafePartnerIframe`): overlay
   de loading até `onload` ou timeout de 20s; estado de erro acionável
   com "Tentar novamente" + "Abrir em nova aba" (sem token na URL);
   refresh real do iframe quando o token SSO renova (via `key`);
   `referrerPolicy="no-referrer"` no iframe e no ícone.
2. **Healthcheck bloqueante no portal** (`partner_portal_crm1/src/services/widget-healthcheck.ts`):
   HEAD com fallback GET (timeout 8s) que verifica reachability (2xx/3xx),
   anti-embed (`X-Frame-Options: DENY/SAMEORIGIN`, CSP `frame-ancestors`)
   e HTTPS em prod. Resultado salvo em `widgets.healthcheckOk/At/Message`
   (migration `20260610170000_add_widget_healthcheck`). `setAppStatus(ONLINE)`
   **bloqueia** se healthcheck não passou; editar `iframeUrl` invalida
   healthcheck e força reteste antes de re-publicar.
3. **Rate limits no backend** (usando `withRateLimit` que já existe):
   `auth.public` (10/min/IP) em `POST /api/public/widgets/sso/verify`
   (HMAC custa CPU; alvo natural pra brute-force); `api.default` em
   `GET /api/widgets/:slug/sso-token` (user), `POST install`/`uninstall`
   (org).
4. **Instalações órfãs e parceiro suspenso**: `listWidgetsWithState()`
   filtra parceiros `status != ACTIVE` do marketplace, MAS ainda devolve
   widgets que a org já instalou (mesmo OFFLINE/parceiro suspenso) com
   `disabled: true` + `disabledReason` — sem isso, a org perderia o
   botão Desinstalar e ficaria com estado fantasma. `installWidget`
   bloqueia nova instalação se parceiro SUSPENDED.

**Contexto.** O usuário pediu que o marketplace fosse "funcional, sem
crashar ou dar erro" mesmo com parceiros cadastrando apps reais.
Análise dos 3 repos identificou 5 riscos críticos (iframe sem
fallback, sem rate limit no verify, instalações órfãs, sem
healthcheck, JWT na query string). PR endereça os 4 primeiros; o 5º
(JWT em postMessage em vez de query) ficou pra fase futura porque
muda o contrato com parceiros.

**Alternativas descartadas.**
- *Não fazer healthcheck (só rodar quando o usuário abre)*: descobrir
  app morto quando o cliente CRM tenta usar é UX inaceitável. O custo
  de uma chamada HEAD por publish/teste manual é trivial.
- *Bloquear instalação quando widget vai OFFLINE depois*: quebraria
  orgs em produção quando o parceiro mexe no toggle. Manter "disabled
  mas removível" preserva a autonomia da org.
- *Rate limit no verify por slug*: parceiro malicioso pode usar 1 slug
  e ainda burlar. Por IP é mais robusto (e o JWT carrega autorização).
- *Tentar detectar X-Frame-Options dentro do browser do CRM*:
  impossível cross-origin (security boundary). Só `onload` timeout
  funciona — é o que `SafePartnerIframe` faz.

**Impacto.**
- Schema: `Widget` ganha `healthcheckOk`, `healthcheckAt`,
  `healthcheckMessage` (nullable; sem backfill — widgets internos não
  precisam). Replicado em `partner_portal_crm1/prisma/schema.prisma`.
- Backend: 4 endpoints com rate limit; `listWidgetsWithState` retorna
  `disabled`/`disabledReason`; `installWidget` rejeita parceiro suspenso.
- Frontend: `WidgetDto` ganha `disabled?`/`disabledReason?`; card mostra
  badge "Indisponível" e esconde botão Abrir; runner `/widgets/[slug]`
  envolve iframe em `SafePartnerIframe` com timeout 20s + UX de erro;
  ícone com `onError` → fallback `IconPuzzle`.
- Portal: `MAX_APPS_PER_PARTNER = 20`; `runHealthcheck` em
  `services/widget-healthcheck.ts`; UI de edit mostra resultado do
  healthcheck + botão "Rodar teste de conexão"; "Publicar ONLINE"
  desabilitado até passar.
- Telemetria: `getLogger("widgets.sso")` em emissão (info: ok / error:
  fail) e em verify (debug: ok / info: failed por `reason`); frontend
  `console.info/warn/error` com tag `widget.iframe` (load_ok/timeout/error)
  e duração — pronto pra plugar em analytics no futuro.

---

### 2026-06-10 — Marketplace de widgets com SSO via JWT + portal de parceiros (repo separado)

**Decisão.** A Central de Widgets (antes catálogo estático em
`src/lib/widget-catalog.ts`) virou marketplace: definição passou pra
tabela `Widget` (Postgres global, não tenant-scoped) com `ownerType`
(`INTERNAL` | `PARTNER`) + `status` (`DRAFT` | `ONLINE` | `OFFLINE`).
Widgets internos viraram seed (`smart_distribution`, `ai_agents`,
`status=ONLINE`); widgets de parceiros são cadastrados pelo novo repo
`partner_portal_crm1` e renderizados como **iframe** no CRM em
`/widgets/[slug]`, com um JWT SSO curto (5 min) carregando contexto
(`orgId`, `userId`, `userEmail`, `orgName`, `widgetSlug`) que o backend
do parceiro valida via `POST /api/public/widgets/sso/verify`.

**Contexto.** O usuário pediu uma forma de parceiros publicarem apps que
apareçam na seção de widgets. A escolha foi modelo Zendesk/Pipedrive
(iframe + SSO), porque:
- Parceiros podem usar qualquer stack (Easypanel já é o hosting deles).
- Nada roda no servidor do CRM além da emissão do JWT — superfície de
  ataque mínima, sem upload de código de terceiros.
- Toggle ONLINE/OFFLINE pelo próprio parceiro evita gargalo de revisão
  manual no MVP (sempre dá pra adicionar moderação depois).

**Alternativas descartadas.**
- *Apps "nativos"* (parceiro sobe bundle JS que o CRM carrega): exige
  sandbox forte (Web Workers/iframes próprios), versionamento, segurança
  de dependências — escopo enorme pro MVP.
- *Webhooks puros* (parceiro só recebe eventos, sem UI no CRM): não
  resolve "aparecer no marketplace e ter tela própria dentro do CRM".
- *Monorepo (pnpm workspaces) já no MVP*: aceleraria a duplicação do
  schema entre `backend_crm1` e `partner_portal_crm1`, mas exige
  reorganizar deploy/Easypanel de 3 apps. Adiado — copia manual do
  schema com aviso nos READMEs basta enquanto só dois modelos são
  compartilhados.

**Impacto.**
- Schema: `Widget`, `PartnerAccount`, enums `WidgetOwnerType` /
  `WidgetStatus`, migrations `20260610130000_add_widget_marketplace` +
  `20260610140000_add_widget_features`. `OrganizationWidget` permanece
  intacto (estado de instalação por org, tenant-scoped) e continua
  ligando ao catálogo por `widgetSlug` — referência LÓGICA, sem FK
  Prisma, pra manter tenant-scope limpo (Widget é global).
- `src/services/organization-widgets.ts`: passa a ler de `Widget` via
  `prismaBase` (global) + `OrganizationWidget` via `prisma` (org-scoped).
  Só widgets `status=ONLINE` aparecem. `installWidget` valida que o
  slug existe e está ONLINE; `hasOrganizationWidget` NÃO valida status
  do widget — uma org que já instalou continua "habilitada" mesmo se o
  parceiro tirar OFFLINE (evita parceiro derrubar serviço em produção
  trocando o toggle).
- `src/services/widget-sso.ts` + `WIDGET_SSO_SECRET`: emissão e verificação
  do JWT HS256 com `iss=crm-widgets-sso` e `aud=widget:<slug>`. Segredo
  separado do `AUTH_SECRET` (escopo isolado — comprometer um não expõe
  o outro). Em dev cai num fallback derivado do `AUTH_SECRET` pra não
  quebrar setups locais.
- `GET /api/widgets/:slug/sso-token` (auth requerida, org precisa ter
  o widget instalado e ativo) + `POST /api/public/widgets/sso/verify`
  (público, CORS `*`, sem cookie — confiança vem só da assinatura HMAC).
- Frontend: tipo `WidgetDto` ganha `ownerType`/`iframeUrl`/`partnerName`/
  `marketplaceStatus`; card mostra badge "Parceiro: X" quando PARTNER e
  botão **Abrir**; nova rota `/widgets/[slug]` redireciona widgets
  INTERNAL com rota própria (ex.: `smart_distribution`) e renderiza
  iframe sandbox (`allow-scripts allow-forms allow-same-origin
  allow-popups-to-escape-sandbox`) pros PARTNER, com refresh automático
  do token a cada 4 min.
- Novo repo `partner_portal_crm1` (irmão de `backend_crm1`/`frontend_crm1`):
  Next.js 15 + NextAuth Credentials + Prisma apontando pro mesmo
  Postgres (apenas `Widget` e `PartnerAccount` no schema duplicado).
  CRUD de apps, toggle ONLINE/OFFLINE/DRAFT, contagem de installs via
  `$queryRaw` em `organization_widgets` (evita duplicar o modelo no
  portal).
- Sincronia de schema entre repos: copia manual com aviso explícito nos
  READMEs dos dois lados ("alterou aqui? sincroniza lá"). Não é o ideal,
  mas é o trade-off consciente do MVP.

---

### 2026-06-09 — Ganho/Perdido viram ESTÁGIOS FIXOS do pipeline (modelo Kommo)

**Decisão.** Todo pipeline passa a terminar em dois estágios fixos —
"Ganho" (`Stage.isWon`) e "Perdido" (`Stage.isLost`) — e fechar um
negócio É movê-lo para um deles. `Deal.status` (OPEN/WON/LOST) **não
foi removido**: ele é sincronizado automaticamente com o estágio em
TODOS os caminhos de movimentação (`moveDeal`, bulk `move_stage` sync e
async via worker, step `move_stage` de automação). O inverso também
vale: `markDealWon`/`markDealLost`/`reopenDeal` agora movem o card para
o estágio correspondente (reabrir devolve pro último estágio
operacional). O Kanban v2 perdeu as abas Abertos/Ganhos/Perdidos e
busca o board com `status=ALL` — fechados vivem nas colunas terminais.

**Contexto.** Antes, ganhar/perder só mudava `Deal.status` e o card
ficava parado na coluna em que estava, com abas filtrando por status —
o usuário pediu paridade com o Kommo (estágios terminais fixos).

**Alternativas descartadas.**
- *Remover `Deal.status` e derivar tudo do estágio:* quebraria dashboard,
  analytics, distribuição, segmentos, automações (`deal_won`/`deal_lost`,
  filtro `dealStatus`) — dezenas de pontos leem o enum. Mantê-lo
  sincronizado preserva tudo sem reescrever relatórios.
- *Detectar terminal pelo NOME do estágio* (como o kanban legado fazia):
  frágil a rename/idioma. Flags booleanas no schema seguem o precedente
  de `Stage.isIncoming`.

**Impacto.**
- Schema: `Stage.isWon`/`isLost` + migration
  `20260609210000_add_terminal_stages` (idempotente: cria os 2 estágios
  em pipelines existentes e MOVE deals já WON/LOST para eles,
  garantindo `closedAt`).
- `pipelines.ts`: `TERMINAL_STAGES` exportado (usado também por
  `onboarding.ts::applyPipelineTemplate`); `createStage` clampa posição
  pra antes dos terminais; `updateStage` rejeita reposicionar terminal
  (`CANNOT_MOVE_TERMINAL_STAGE`); `deleteStage` rejeita
  (`CANNOT_DELETE_TERMINAL_STAGE`); `reorderStages` NORMALIZA (terminais
  sempre no fim, Ganho→Perdido) em vez de rejeitar — compat com clientes
  que mandam a lista completa.
- Side effects de fechar via movimentação (evento `STATUS_CHANGED` +
  `fireTrigger deal_won/deal_lost`) replicados na rota de move, no bulk
  e no worker — paridade com `PUT /deals/[id]/status`.
- `markDealLost` aceita motivo vazio (obrigatoriedade é decidida na
  rota pelo org setting `deals.loss_reason_required`; bulk já permitia).
- Frontend: colunas terminais sempre visíveis no fim (verde/vermelho via
  flags em `adapters.ts`), `/settings/pipeline` trava drag/rename/reorder
  dos fixos (cadeado + badge "Fixo") e "Nova etapa" insere antes deles.

---

### 2026-06-09 — Sort do Kanban por "última interação" server-side + RBAC de navegação (`nav:*`) com permission > role legado

**Decisão (3 partes, aprovadas em sequência pelo usuário).**

1. **Sort "Última interação" no Kanban (substitui "Valor").** Novo
   `BoardSortField = "lastInteraction"` em `services/deals.ts`. Como
   `Deal` não denormaliza a data da última conversa, o sort usa
   abordagem multi-query: ids leves por stage → `Conversation.groupBy`
   por `MAX(updatedAt)` → sort em memória → `findMany` paginado dos ids.
   Frontend troca as opções `value_*` por `interaction_*` e delega ao
   backend (junto com `created_*`; só `name_*` continua client-side).
   *Alternativa descartada:* denormalizar `lastInteractionAt` no Deal
   (migration + manutenção em todo write de mensagem; fica para quando
   o volume justificar).

2. **Sidebar principal controlada por RBAC.** Novo resource `nav` no
   catálogo (`nav:dashboard`, `nav:pipeline`, ... — 1 chave por ícone).
   Presets MANAGER/MEMBER ganham as chaves nos presets TS + migration de
   backfill (`20260609180000_add_nav_permissions`) para roles existentes.
   Frontend: `SidebarCatalogItem.requiredPermission` +
   `filterNavItemsByPermissions` em série com o filtro legado por role.
   **Semântica importante: permissões efetivas = UNIÃO de todas as roles
   do user.** Se o user tem "Operador" (preset MEMBER, com `nav:campaigns`)
   E uma role custom restrita, ele vê a união — para restringir de fato,
   remover a role preset do user (caso real do user `caio`).

3. **Settings: `requiredPermission` MANDA sobre `allowedRoles`.** Em
   `nav-visibility.ts::canSeeItem`, item com `requiredPermission` é
   decidido só pela permission (com wildcard `resource:*`); `allowedRoles`
   vira fallback apenas para itens sem permission declarada. *Motivo:*
   no modelo antigo (AND), um user com enum legado MEMBER e role custom
   que concede `settings:channels` nunca via o item — roles customizadas
   não conseguiam liberar nada no settings. Chaves fracas trocadas:
   Pipeline/Motivos de perda → `pipeline:manage_stages` (era
   `pipeline:view`/`deal:edit`), Tags → `tag:edit` (era `tag:view`) —
   senão todo MEMBER veria telas administrativas.

**Bug corrigido junto:** `addRoleAssignment` não chamava
`invalidateAuthzForOrg` (só o remove chamava) — mudança de role demorava
até 60s (TTL do cache Redis `authz:user:*`) para refletir.

**Arquivos.** Backend: `src/services/deals.ts`,
`src/app/api/pipelines/[id]/board/route.ts`, `src/lib/authz/permissions.ts`,
`src/lib/authz/presets.ts`, `src/services/roles.ts`,
`prisma/migrations/20260609180000_add_nav_permissions/`. Frontend:
`src/app/(app)/pipeline/_v2-client.tsx`, `src/features/pipeline-v2/api/board.ts`,
`src/lib/sidebar-catalog.ts`, `src/components/crm/nav-rail-v2.tsx`,
`src/lib/nav-visibility.ts`, `src/lib/settings-nav.ts`,
`src/features/permissions/*` (editor inline de roles por usuário).

---

### 2026-06-09 — Promoção dev→prod: aplicar as 9 migrations no `db_crm` manualmente, mantendo `SKIP_PRISMA_MIGRATE=1` [DECISÃO — agente OPUS]

**Decisão.** Para subir a `DEV_BRANCH` para `main` (deploy EasyPanel da org
**Dna Work**, banco `db_crm`), as 9 migrations pendentes foram aplicadas
**manualmente** via SQL (script Node + driver `pg`), **sem remover** o
`SKIP_PRISMA_MIGRATE=1`, e registradas à mão no `_prisma_migrations`.

**Contexto.** `db_crm` (Postgres 17.9, 187.127.27.39) tem drift conhecido no
histórico: `20240101000000_init` aparece **duas vezes** (uma com `finished_at`
nulo = FALHOU) e há 3 variantes de `add_contact_ad_tracking` que o repo não
tem. Com isso, deixar o entrypoint rodar `prisma migrate deploy` **aborta com
P3009** (failed migration) e cai no fallback bruto (`db execute` em todos os
`.sql`, sem registrar nada). As 9 migrations (`20260602*`..`20260608*`) eram
todas **aditivas** (novas tabelas/colunas, `ADD VALUE` em enum, particionamento
de `activity_events` que nasce vazia) — schema diff +253/-0, zero `DROP`/`ALTER`
em objeto existente.

**Procedimento executado (em janela de baixo tráfego, ~04h).**
1. Backup lógico completo (`db_crm-backup.ndjson`, 55.473 linhas) + baseline de
   contagens por tabela (`prod-rowcounts-before.txt`), ambos fora dos repos.
2. Aplicação das 9 `.sql` em ordem cronológica, cada uma atômica (rollback
   automático em erro). Todas idempotentes (`IF NOT EXISTS`/`DO` guards).
3. Registro das 9 em `_prisma_migrations` com `checksum` = sha256 do arquivo.
4. Verificação pós: 6 tabelas novas presentes, `activity_events` com 49
   partições, `campaigns.repliedCount` e enum `CONTACT_IMPORT` presentes,
   contagens de dados existentes **inalteradas**.

**Alternativas descartadas.** Remover `SKIP_PRISMA_MIGRATE` (cairia no fallback
bruto por causa do P3009); reconciliar todo o histórico do `_prisma_migrations`
(frágil, fica para o cutover definitivo).

**Impacto / pendências.**
- Manter `SKIP_PRISMA_MIGRATE=1` no EasyPanel (prod compartilha o drift).
- Subir worker ETL no EasyPanel (`APP_MODE=worker-etl`) — senão importação de
  contatos e progresso de campanha não processam.
- Drift do `_prisma_migrations` (init duplicado + `add_contact_ad_tracking`)
  ainda precisa ser reconciliado num cutover futuro.
- Rotacionar a senha do Postgres (trafegou em chat durante a operação).

---

### 2026-06-06 — Importação assíncrona (ETL) via worker dedicado [DECISÃO — implementação pendente]

**Decisão (arquitetura, agente OPUS).** Migrar a importação de CSV/XLSX do
fluxo **síncrono na request HTTP** (`POST /api/contacts/import` e similares)
para um pipeline **ETL assíncrono** processado por um **worker dedicado**,
reusando a infraestrutura existente (BullMQ + `BulkOperation` + polling).

Quatro escolhas travadas (defaults recomendados; usuário optou por seguir os
recomendados ao pular as perguntas):

1. **Transporte do arquivo → worker: parse na request + linhas no Postgres
   (Opção B).** A rota faz o *Extract* (parse via `readUploadedTable`, que já
   suporta CSV/XLSX) ainda na request e persiste as linhas normalizadas no
   banco; o worker faz só *Transform + Load* (os upserts pesados) lendo do
   Postgres em chunks. **Por quê:** o storage é disco local
   (`@/lib/storage/local.ts`, `STORAGE_ROOT`) e os workers atuais
   (`leads`, `whatsapp`) **não montam esse volume**. A Opção B evita exigir
   volume compartilhado no EasyPanel (menor risco operacional). A Opção A
   (arquivo num bucket `imports` + volume compartilhado, streaming) fica
   reservada para quando houver arquivos grandes demais para materializar
   linhas no DB.

2. **Fila/worker dedicado `import-etl` (não estender `leads-bulk`).** ETL é
   long-running e I/O/CPU pesado; isolar evita travar as bulk-ops rápidas
   (`move_stage`/`update_fields`) e permite afinar concorrência/escala de
   forma independente. Reusa `withSystemContext`, validação de org por
   `prismaBase` e o padrão de retries do `leads-worker.ts`.

3. **Estado/progresso: reusar `BulkOperation`** estendendo o enum
   `BulkOperationType` com `CONTACT_IMPORT` (depois `DEAL_IMPORT`,
   `PRODUCT_IMPORT`). O endpoint genérico `GET /api/bulk-operations/[id]` e o
   `BulkOperationProgressDialog` do frontend já servem a barra de progresso
   sem código novo.

4. **Escopo v1: Contatos.** Engine generalizável (Transform/Load por entidade)
   para plugar Deals/Produtos depois. **Mapeamento de colunas:** manter o
   auto-map por nome de header já existente (menor risco); UI de mapeamento
   manual (extract→preview→map→confirm) fica como follow-up.

**Plano de implementação (a executar em SONNET — código repetitivo c/ spec):**
- `prisma/schema.prisma`: + valores no enum `BulkOperationType` + tabela
  `ImportRow` (ou coluna JSON em chunks no `BulkOperation.payload`) +
  migration.
- `src/lib/queue.ts`: `IMPORT_ETL_QUEUE_NAME`, payload `ImportEtlPayload`,
  `enqueueImportEtl(...)` (espelha `enqueueLeadsBulk`).
- `src/workers/etl-worker.ts`: consumidor da fila (espelha `leads-worker.ts`)
  + `src/jobs/import/contact-import.job.ts` (Transform+Load em chunks,
  reaproveitando a lógica de upsert hoje inline em `contacts/import/route.ts`).
- Refatorar `POST /api/contacts/import` → 202 `{ operationId, total }`
  (extract + cria `BulkOperation` PENDING + grava linhas + enfileira). Manter
  fallback síncrono se Redis indisponível (como `enqueueLeadsBulk`).
- `package.json`: `start:worker:etl`(:prod) + entrada no
  `scripts/build-workers.mjs`. EasyPanel: 1 processo novo (sem volume extra).
- Frontend: a tela de import passa a abrir o `BulkOperationProgressDialog`
  (infra já pronta) quando a resposta for 202.

**Compat retroativa.** Imports de Deals/Produtos seguem síncronos até serem
portados. O contrato de resposta do import de contatos muda (201→202): o
frontend precisa tratar os dois (`res.status`), igual já faz no bulk de deals.

---

### 2026-06-06 — Activity Log: cobertura de eventos (G1–G5) + origem do lead (G4)

**Decisão.** Fechados os gaps de instrumentação do log unificado:
- **Chamadas WhatsApp** (`meta-whatsapp-calls-webhook`): no evento
  `terminate` emite `CALL_COMPLETED`/`CALL_MISSED` com duração, status,
  gravação e quem iniciou. `entityType=CONVERSATION` (chamada é sub-evento
  da conversa) para **evitar migration de enum** com um tipo `CALL`.
- **Mensagens recebidas** (Baileys + Meta webhook): `MESSAGE_RECEIVED`
  com `actor=INTEGRATION` rotulado com a identidade do contato (o enum
  `ActorType` não tem `CONTACT`; a origem técnica é a integração).
- **Notas**: nota via composer do Inbox (`isPrivateNote`) e via
  `contacts/[id]/notes` sem `dealId` passaram a logar `NOTE_ADDED` (antes
  o `return` antecipado e o `if (dealId)` deixavam buracos).
- **Conversa fechada/reaberta**: `CONVERSATION_CLOSED/REOPENED` na rota
  single (`actions`) — o bulk já cobria. Emitido direto com
  `entityType=CONVERSATION`, **independente de haver deal aberto** (antes
  só logava via `createDealEvent`, que some quando não há deal).
- **Tarefas granulares**: `ACTIVITY_DUE_CHANGED`, `ACTIVITY_DESCRIPTION_CHANGED`,
  `ACTIVITY_RENAMED`, e `ACTIVITY_COMPLETED` com `result`. Tarefas ligadas
  só a contato (sem deal) agora logam via `logEvent(entityType=ACTIVITY)`.
- **Delete**: `DEAL_DELETED`/`CONTACT_DELETED`. **Crítico:** NÃO preencher
  a FK (`dealId`/`contactId`) nesses eventos — `onDelete: Cascade` apagaria
  o próprio registro de auditoria. O id vai em `entityId` (string livre) +
  `meta`. Restore inexiste (deletes são hard-delete, sem soft-delete).
- **Origem do lead (G4)**: o ator `INTEGRATION` do Bearer token era
  **perdido** porque `runWithApiUserContext` sobrescrevia o actor para
  `HUMAN`. Corrigido propagando `actor` via `ApiUser` (resolvido em
  `authenticateApiRequest`). Lead via n8n/API agora aparece com o nome do
  token, não do usuário técnico; `CREATED` carrega `source` do payload.

**Por quê.** Reclamação do usuário: "nem todas as atividades estão sendo
logadas, notas e mensagens recebidas". A causa raiz era dupla: (a) caminhos
de escrita sem `logEvent`, e (b) dependência de `createDealEvent` (entity
DEAL) que silenciava eventos quando não havia deal vinculado.

**Convenção firmada.** `entityType` segue o sujeito visível (DEAL > CONTACT
> CONVERSATION > ACTIVITY > MESSAGE). Inbound resolve o deal aberto do
contato em best-effort para enriquecer o filtro. Tudo fire-and-forget
(`void`) — log nunca derruba a operação principal.

---

### 2026-06-06 — Fase 1 DW: `activity_events` particionada por mês (mesmo Postgres)

**Decisão.** Em vez de criar uma instância/DB separada agora, `activity_events`
foi convertida em **tabela particionada por RANGE (`occurredAt`), mensal**,
no mesmo Postgres. PK passou a ser composta `(id, occurredAt)` (exigência do
Postgres: chave de partição em toda PK/UNIQUE). Migration
`20260606170000_partition_activity_events` (idempotente, com guarda via
`pg_partitioned_table`). Funções `logs_ensure_activity_events_partition()` e
`logs_drop_old_activity_events_partitions()` + script
`scripts/activity-events-partitions.ts` (cron) para criar partição do mês
seguinte e aplicar retenção (default 24 meses).

**Por quê.** Tabela append-only que cresce com o tráfego. Particionar dá
partition pruning nas queries de DW, vacuum isolado das tabelas quentes e
DROP de partição antiga metadata-only (sem WAL bloat). Feito agora porque a
tabela é nova/pequena — menor risco de conversão.

**Alternativas descartadas.**
- *Instância Postgres dedicada já.* Op cost 2x, dual-write frágil, cross-DB
  joins quebram. Reservado para Fase 2 (logical replication para réplica
  read-only) quando passar de ~5M eventos.
- *`multiSchema` do Prisma (schema `logs`).* Exigiria `@@schema` em ~100
  models — invasivo e arriscado com o drift de migration atual.

**Pontos de atenção.**
- PK composta é compatível porque o código só faz `create()`/`findMany()`
  (nenhum `findUnique`/`update`/`delete` por `id` isolado em `activityEvent`).
- A migration recria a tabela (rename → cria particionada → copia → dropa
  legado). **Aplicar deliberadamente** dado o drift local↔remoto: rodar o
  SQL via `prisma db execute`, depois `migrate resolve --applied`, depois
  `generate` — mesma sequência usada na migration base do activity_events.
- Partição `DEFAULT` é rede de segurança; o cron deve manter as mensais à
  frente para que ela fique vazia (não dá pra criar partição de um range
  que já tenha linhas na DEFAULT).

---

### 2026-06-06 — Callbacks de socket Baileys precisam de `withSystemContext` explícito (perda de AsyncLocalStorage)

**Decisão.** Toda mensagem inbound no `BaileysSession` é processada
dentro de `withSystemContext(orgId, () => handleBaileysMessage(...))`.
O `organizationId` do channel é resolvido uma única vez no `connect()`
e cacheado na propriedade `this.organizationId` para evitar roundtrip
por mensagem.

**Por quê.** O `BaileysManager.startAll()` envolve o `connect()` em
`withSystemContext`, mas o `AsyncLocalStorage` **não atravessa o
boundary do EventEmitter do socket**. O callback `sock.ev.on("messages.upsert", ...)`
dispara em outro tick fora do scope original, então o store fica
`undefined` no momento da execução.

Consequência observada (relato do usuário "existem leads em conversa
mas a fase do funil não aparece"): contatos eram criados (porque
`prisma.contact.create` com `withOrgFromCtx` aparentemente herdava
contexto por outras vias — `parseMessage` faz pré-fetch e isso
parece preservar o frame), mas `ensureOpenDealForContact` falhava
no `getOrgIdOrThrow()` interno (criação fallback da stage `isIncoming`)
ou no `withOrgFromCtx` da criação do deal. O `.catch` interno era
`log.warn` apenas, então **falhava silenciosamente**.

**Alternativas descartadas.**
- *Resolver `organizationId` por mensagem dentro do handler.* Roundtrip
  extra ao DB por inbound, e mantém a ergonomia ruim de "qualquer
  função chamada precisa lembrar de re-estabelecer contexto".
- *Tornar `runWithActor` / helpers tolerantes a contexto ausente
  (fallback global).* Mascararia o bug e abriria espaço para vazamento
  cross-tenant em outras superfícies.

**Pontos de atenção.** Todo `sock.ev.on(...)` novo no `BaileysSession`
(connection.update, contacts.upsert, messages.update já existentes)
está hoje OK porque não toca em modelos scoped — mas qualquer novo
handler que vá escrever no Prisma scoped precisa do mesmo envelope.

**Arquivos.** `src/workers/baileys/baileys-session.ts` (envelope +
cache), `src/services/auto-deals.ts` (sem alteração — já estava
correto, apenas dependia de contexto válido).

**Remediação histórica.** `src/scripts/backfill-inbox-deals.ts` cria
deals para contatos órfãos retroativamente (idempotente via
`ensureOpenDealForContact`). Já executado em prod (3 deals criados).

---

### 2026-06-06 — Stage `isIncoming` sempre visível no Kanban

**Decisão.** Em `getBoardData` (`src/services/deals.ts`), removida a
regra `filter((s) => !s.isIncoming || s.deals.length > 0)`. A stage
de entrada (Lead de Entrada) agora **sempre renderiza** como coluna.

**Por quê.** O `stage.deals` é a slice **pós-filtro** (status=OPEN
padrão + visibility do usuário + filtros avançados / busca). Qualquer
filtro ativo zerava o array de deals da incoming e a coluna sumia —
mesmo havendo leads reais no banco. Bug reportado como "existem leads
mas a fase do funil não aparece". A regra antiga existia para evitar
coluna vazia inútil; o trade-off não compensa o risco de esconder a
porta de entrada do funil sob qualquer filtro.

**Arquivos.** `src/services/deals.ts` (~linha 796).

---

### 2026-06-06 — `getContactById` achata `stage.{name,color,pipelineId}` para o formato esperado pelo frontend

**Decisão.** O retorno de `getContactById` agora expõe `stageName`,
`stageColor` e `pipelineId` flat em cada deal (além do `stage` objeto
preservado por compatibilidade).

**Por quê.** O contrato `ContactDetail` no frontend
(`features/inbox-v2/api/misc.ts`) declara `deals[].stageName?: string`.
O backend só retornava `deals[].stage: { id, name, color }`. O adapter
`toContactAside` lia `d.stageName ?? null` → null → contact-aside
mostrava "Sem estágio" mesmo com `stageId` válido. Achatar no
backend (em vez de mudar o adapter ou todo o frontend) é o caminho
de menor risco.

**Arquivos.** `src/services/contacts.ts` (include do stage com
`pipelineId` + map de retorno).

---

### 2026-05-29 — Tenancy P0: `userOrgFilter` escopa super-admin à org ativa + fecha IDOR no `PUT /api/users/[id]`

**Decisão.** Inverter a ordem das checagens em `userOrgFilter`
(`src/lib/auth-helpers.ts`): a **org ativa tem prioridade sobre o
super-admin**. O bypass `return {}` agora só ocorre quando o
super-admin **não** tem `organizationId` (contexto de plataforma).
Além disso, o `PUT /api/users/[id]` ganhou um pré-check escopado
(`prisma.user.findFirst({ where: { id, ...userOrgFilter(session) } })`,
404 se fora do escopo) espelhando o que o `DELETE` já fazia.

```ts
// antes (bypass vinha primeiro — vazava cross-org):
if (session.user.isSuperAdmin) return {};
if (!session.user.organizationId) return { organizationId: "__none__" };
return { organizationId: session.user.organizationId };

// depois (org ativa primeiro):
if (session.user.organizationId) return { organizationId: session.user.organizationId };
if (session.user.isSuperAdmin) return {};
return { organizationId: "__none__" };
```

**Contexto.** Operador relatou: "ao adicionar usuários na org eduit
estão vindo usuários da org DNA". Auditoria (Playwright + leitura de
código) confirmou: o usuário `fabio@eduit.com.br` é super-admin **com**
org ativa, então `userOrgFilter` retornava `{}` e a tela de Equipe
(`GET /api/users`) — e mais 6 endpoints org-scoped — listavam users de
**todas** as orgs do cluster. Pior: `DELETE`/`PUT /api/users/[id]`
permitiam apagar/editar users de outra org só conhecendo o id (IDOR).

**Por que esta abordagem (correção central, não por-endpoint).** Os 7
callers de `userOrgFilter` foram auditados; **todos querem escopo por
org** (os próprios comentários em `kanban/filter-options` e
`conversations/[id]/messages` mencionam tentativas anteriores de fechar
vazamentos). Nenhum caller está sob `/admin/*`. As rotas `/admin/*` têm
lógica de acesso própria e **não** dependem de `userOrgFilter`. Logo,
corrigir o helper conserta os 7 de uma vez sem risco de regressão em
fluxo legítimo de administração de plataforma.

**Alternativas descartadas.**

- **Adicionar `organizationId` explícito em cada um dos 7 `where`.**
  Mais verboso, frágil (o 8º caller futuro esqueceria) e não resolve o
  IDOR do `PUT`. O ponto único de verdade é o helper.
- **Remover o bypass de super-admin por completo.** Quebraria o
  contexto de plataforma sem org (onde ver tudo é intencional). Mantido
  apenas para `organizationId == null`.
- **Mover `User` para os `SCOPED_MODELS` da Prisma Extension.** Inviável:
  o login (NextAuth `authorize`) precisa achar `User` por email **sem**
  contexto de org. Por isso o filtro de `User` é manual e centralizado
  neste helper.

**Impacto / comportamento preservado.**

- Super-admin **com** org: agora vê só a própria org nas telas
  org-scoped (Equipe, filtros do Kanban, avatares de agente, analytics,
  status/schedules de agentes). Para visão cross-org, usar `/admin/*`.
- Super-admin **sem** org: inalterado (visão global).
- `PUT /api/users/[id]` cross-org → 404 (antes: editava).

**Arquivos.**

- `backend/src/lib/auth-helpers.ts` — reordenação de `userOrgFilter`.
- `backend/src/app/api/users/[id]/route.ts` — pré-check escopado no `PUT`.

**Verificação.** `tsc` sem erros novos (baseline já tinha os mesmos
erros pré-existentes de `$transaction`/`TransactionClient` em
`users/route.ts:98` e `[id]/route.ts`). Validação ao vivo via Playwright
(`GET /api/users` deve retornar só users da org eduit) **pendente até o
deploy** — o ambiente em produção ainda roda o código antigo.

---

### 2026-05-27 — Gatilho `manual` + botão "Rodar automação"

**Decisão.** Novo `triggerType: "manual"` adicionado ao enum
compartilhado. Disparo exclusivamente via endpoint imperativo
`POST /api/automations/[id]/run`. Frontend ganha um componente
reutilizável `<RunAutomationButton>` plugado em:

- `ConversationHeader.toolbarActions` no inbox (ao lado de
  Transferir e Lembrar).
- `DealHeader > HeaderActionCluster` no detalhe do negócio
  (kanban), apenas quando há contato vinculado.

O endpoint é **restrito ao próprio tipo `manual`**: tentar
disparar uma automação `message_received`, `stage_changed` etc.
retorna 409. Justificativa: evita duplo-disparo (a interação
original já dispara o gatilho reativo) e bypass de filtros
configurados no trigger.

**Contexto.** Operador pediu literalmente: "preciso ter um tipo de
gatilho de automação que é manual, por exemplo, eu no meu inbox
ou no kanban, DENTRO da conversa do meu cliente, eu tenho a opção
de executar uma automação".

**Alternativas descartadas.**

- **Permitir disparar qualquer automação manualmente.** Tentador
  mas abre duas portas ruins: (1) duplo-disparo se o gatilho
  original também dispara em paralelo, (2) operador escapa de
  filtros (canal, stage, dealStatus) que o gatilho original
  respeita.
- **Reaproveitar `tag_added` como "trigger manual de facto".**
  Quebra rastreabilidade no log (toda execução manual pareceria
  automática) e mistura conceitos.
- **Botão direto no card do kanban.** Polui o card; o operador
  já clica no card pra ver detalhes — colocar no detalhe (drawer)
  é mais natural e respeita a hierarquia visual existente.

**Comportamento por design (registrado pra evitar regressão).**

- **Sem trava de duplicata** (rate-limit/dedup): enfileira igual
  aos gatilhos reativos. Se virar problema, adicionar dedup-key
  de 1 min no `enqueueAutomationJob`.
- **`enqueueAutomation` recebe `event: "manual"`.** O executor
  só usa `event` pra logging (`log.debug`, mensagem do
  `AutomationLog`); nenhum step tem lógica condicional por
  evento, então `"manual"` é totalmente seguro.
- **Tolerante a `dealId` stale.** UI pode passar um dealId
  obsoleto (operador alternou conversas em paralelo) — o
  endpoint ignora silenciosamente em vez de falhar.

**Arquivos.**

- `backend_crm1/src/lib/automation-workflow.ts` —
  `AutomationTriggerType` + enum + `triggerTypeLabel` +
  `summarizeTriggerConfig` + `defaultTriggerConfig` ganham `manual`.
- `backend_crm1/src/services/automations.ts` —
  `evaluateTrigger` case `manual` (passa sempre);
  `GetAutomationsParams.triggerType` + `where.triggerType` no
  `getAutomations`.
- `backend_crm1/src/app/api/automations/route.ts` — GET aceita
  `?triggerType=manual` (usado pelo botão pra listar manuais).
- `backend_crm1/src/app/api/automations/[id]/run/route.ts` —
  novo endpoint POST.
- `frontend_crm1/src/lib/automation-workflow.ts` — espelha enum +
  label + default + summary do backend.
- `frontend_crm1/src/components/automations/trigger-config-fields.tsx`
  — case `manual` renderiza um bloco explicativo (sem campos).
- `frontend_crm1/src/components/automations/run-automation-button.tsx`
  — novo componente (dropdown que lista manuais + dispara).
- `frontend_crm1/src/app/(dashboard)/inbox/client-page.tsx` —
  acopla o botão em `toolbarActions`.
- `frontend_crm1/src/components/pipeline/deal-detail/header.tsx`
  — acopla o botão no `HeaderActionCluster` (só se há contato).

---

### 2026-05-27 — Filtro de `dealStatus` em `message_received`/`message_sent`

**Decisão.** Gatilhos `message_received` e `message_sent` ganharam
filtro opcional por `dealStatus` (`OPEN` / `WON` / `LOST`). O campo
aceita CSV pra "any of" — a UI expõe a opção composta "Ganho ou
Perdido" (CSV `WON,LOST`) que é o caso prático combinado pelo
operador (mesma automação cobre retenção pós-venda e
reengajamento). `enrichContext` foi estendido pra buscar o deal
mais recente em qualquer status (priorizando `OPEN`, com fallback
pra `WON`/`LOST`) e expor `data.dealStatus`.

Diferente dos filtros `stageId`/`pipelineId` (best-effort, passam
quando o lado direito é desconhecido), `dealStatus` é **estrito**:
se o operador filtrou por status e o contato não tem deal nenhum,
o gatilho NÃO dispara. Justificativa: um filtro de status só faz
sentido quando há um negócio pra comparar — passar best-effort
disparararia automações em qualquer "lead sem negócio", o que é
exatamente o oposto da intenção do filtro.

**Contexto.** Operador pediu literalmente: "preciso de mensagem
recebida quando é um contato que está GANHO ou PERDIDO". Cenários
típicos: cliente WON volta a falar (pós-venda, NPS, upsell) e
lead LOST volta a falar (reengajamento, "boas-vindas de volta").

**Alternativas descartadas.**

- **Multi-select com checkboxes.** Mais flexível mas paga UX por
  +1 dep ou +50 linhas custom; o caso prático é 1 valor ou a dupla
  WON+LOST. Resolvemos com 4 opções single + 1 composta.
- **Dois gatilhos novos (`message_received_won`,
  `message_received_lost`).** Polui o enum, duplica código e ainda
  não cobre "Ganho OU Perdido" naturalmente.
- **Sempre buscar deal mais recente independente de status (sem
  fallback explícito).** Mais simples, mas o caso comum (filtro
  por stage de lead OPEN) ficaria suscetível a "vazar" stage de
  deal já fechado. Priorizar OPEN preserva o comportamento antigo
  pra usuários que não usam o filtro novo.

**Impacto.** `enrichContext` agora roda até 2 queries (1 normal +
fallback only-on-miss) em vez de 1 — overhead desprezível e só
ocorre em `message_received`/`message_sent`. Automações existentes
sem `dealStatus` setado continuam idênticas (passam por todos
status).

**Arquivos.**

- `backend_crm1/src/services/automation-triggers.ts` —
  `enrichContext` agora busca também WON/LOST como fallback e
  expõe `data.dealStatus`.
- `backend_crm1/src/services/automations.ts` — `evaluateTrigger`
  case `message_received|message_sent` aceita `dealStatus` (CSV)
  com semântica estrita.
- `frontend_crm1/src/components/automations/trigger-config-fields.tsx`
  — dropdown "Status do negócio" no bloco message_received/sent.
- `frontend_crm1/src/lib/automation-workflow.ts` —
  `defaultTriggerConfig` inicializa `dealStatus: ""` e
  `summarizeTriggerConfig` rotula bonitinho (Em aberto / Ganho /
  Perdido / Ganho ou Perdido).

---

### 2026-05-27 — Inbox: lista de conversas com paginação (cap 200)

**Decisão.** O endpoint `GET /api/conversations` agora aceita
`perPage` até **200** (antes era 100). A lista de conversas no inbox
no frontend foi migrada de `useQuery` (1 chamada hardcoded de
`perPage=60`) para `useInfiniteQuery`: pede 60 por página e dispara
`fetchNextPage` via `IntersectionObserver` numa sentinela no final
do `<ul>`, com `rootMargin: 240px` pra pré-carregar antes do
operador bater no fim.

**Contexto.** Operador com 455 conversas em "Entrada" relatou que
"a rolagem trava e não aparece tudo". O front pedia apenas 60
conversas e nunca pedia mais — não havia paginação subsequente.
Sintoma típico de lista limitada sem infinite scroll: o scroll
funciona, mas só percorre os 60 itens carregados.

**Alternativas descartadas.**

- **Subir `perPage` pra 500 e renderizar tudo de uma vez.** Mais
  simples mas paga renderização de 500 linhas com `MotionDiv` +
  swipe-row + avatars no boot inicial — visivelmente travado em
  máquinas modestas e desperdiça largura de banda se o operador
  só interage com as 20 do topo.
- **Virtualização (`react-virtual`/`@tanstack/react-virtual`).**
  Solução ideal pra listas muito grandes, mas a lista atual tem
  cards complexos (avatar, tags, swipe actions, presença) e
  alturas variáveis. Migração teria escopo bem maior. Infinite
  scroll resolve o caso atual (40 conversas/operador é o p95) com
  zero refactor de item.

**Impacto.** Boot continua puxando só 60. A invalidação por
ações (`assign`, `read`, `resolve`, realtime) continua funcionando
porque react-query refetcha automaticamente todas as páginas já
carregadas. `refetchInterval: 20_000` segue ativo. UX nova: rodapé
mostra "Carregando mais…" durante fetch e "Fim da lista · N
conversas" quando esgota.

**Arquivos.**

- `backend_crm1/src/services/conversations.ts` — cap
  `perPage` 100 → 200.
- `frontend_crm1/src/components/inbox/conversation-list.tsx` —
  `useQuery` → `useInfiniteQuery` + `IntersectionObserver` +
  rodapé de paginação.

---

### 2026-05-27 — `add_tag`/`remove_tag` espelham em `TagOnContact` + `TagOnDeal`

**Decisão.** Os steps `add_tag` e `remove_tag` em
`automation-executor.ts` agora persistem em ambas as tabelas:
`tags_on_contacts` (como antes) **e** `tags_on_deals` (novo).
Pra o deal alvo usamos `rt.dealId` quando presente; senão buscamos
o deal `OPEN` mais recente do contato como fallback best-effort.
Backfill SQL aplicado em produção pra refletir tags já existentes no
contato → deal aberto (idempotente via `ON CONFLICT DO NOTHING`).

**Contexto.** Operador relatou: "no inbox aparece a TAG CLT, mas no
kanban não. Tem que ser igual." A inbox renderiza
`contact.tags` (lado esquerdo: contato), enquanto o card do kanban
renderiza `deal.tags`. Como `add_tag` só salvava em
`TagOnContact`, o resultado visual era inconsistente: tag aparecia
em uma tela, sumia em outra. Decisão é tratar o step como
"adiciona em todos os lugares relevantes da pessoa", que é a
expectativa do operador.

**Alternativas descartadas.**

- **Opção entity (contact|deal) no step.** Cobre o caso técnico
  mas força operador a escolher — e ele praticamente sempre quer
  ambos. Adia decisão pra UI sem ganho prático.
- **Renderizar tags de contato no card do kanban (fix puro de UI).**
  Quebra o conceito de tag de deal (que existe pra qualificar
  o negócio independente do contato). Mantemos os dois conceitos
  separados no schema; só fazemos o step refletir nos dois.
- **Backfill via Prisma seed.** SQL direto via script ad-hoc é
  mais barato pra um one-off com 2 linhas. Documento aqui pra
  rastreio.

**Impacto.** `add_tag` agora roda +1 query (upsert na
`tags_on_deals`) e +1 query se precisar fallback pro deal aberto.
`remove_tag` idem. Custo aceitável dado o baixo volume de tag ops
por automação. Backward-compatible: configs antigos seguem
funcionando — só ganham a sincronização de borda.

---

### 2026-05-27 — Formatação legível das respostas do WhatsApp Flows

**Decisão.** Reescrita do `formatWhatsappFlowResponse` em
`lib/meta-whatsapp/parse-flow-response.ts` pra parsear o formato cru
do Meta Flows e produzir um texto formatado:

- **Labels:** `screen_<n>_Nome_Do_Campo_<idx>` →
  `Nome do Campo` (remove prefixo de tela, sufixo de índice e troca
  underscores por espaço, com title-case que respeita conectivos em
  minúsculo — `Data de Nascimento`, não `Data De Nascimento`).
- **Valores de single/multi-select:** `0_SIM`, `2_Noite`,
  `0_1_ano_do_ensino_médio`, `0_Anoto_e_falo_com_o_supervisor_😅`
  → `SIM`, `Noite`, `1 ano do ensino médio`,
  `Anoto e falo com o supervisor 😅` (remove o índice de opção e
  underscores). Multi-select chega como string com vírgulas
  (`1_Tarde, 0_Manhã`) ou array — ambos tratados.
- **Datas ISO:** `2010-03-04` → `04/03/2010`.
- **Layout:** cada campo vira `*Pergunta*\n↳ Resposta` separados por
  linha em branco; cabeçalho com nome do flow em itálico. Limite
  ampliado de 1000 → 2000 chars (formulários com 6+ campos chegavam
  truncados).

**Contexto.** Operador relatou: "a resposta que vem do flows do
whatsapp fica muito ruim de entender, os dados precisam ser tratados".
Antes, o `formatKey` antigo tinha um early-return absurdo: "se a chave
já contém maiúscula, devolve crua" — o que matava todos os formulários
do Meta (chaves vinham com `Nome_Completo`, contendo maiúscula). Texto
salvo na `Message.content` ia ilegível pra inbox.

**Alternativas descartadas.**

- **Mapeamento por flow JSON definition.** O ideal seria puxar os
  labels do JSON do Flow (cadastrado na Meta) e usar diretamente.
  Mas: (a) requer fetch a cada inbound (latência no webhook), (b)
  os labels do Flow já são derivados das mesmas chaves
  `screen_X_Nome_Y` por convenção da Meta — a tradução pura por
  regex chega no mesmo resultado em ~99% dos casos com zero
  acoplamento à Meta API.
- **Renderização rica no front (cards com pergunta/resposta).**
  Mexeria em vários componentes da inbox e renderização da
  timeline. Texto formatado direto na `Message.content` resolve em
  uma camada só e segue compatível com qualquer cliente que
  renderize markdown estilo WhatsApp.

**Impacto.** Backward-compatible — mensagens antigas no DB
permanecem como estão (já foram salvas). Novas respostas de Flow
entram formatadas. Inbox, dashboard e timeline do contato passam a
mostrar `*Nome Completo*\n↳ Erika de Jesus domingos` em vez de
`screen_0_Nome_Completo_0: Erika de Jesus domingos`.

---

### 2026-05-27 — `has_tag`/`not_has_tag` enxergam tags atualizadas + união contact+deal

**Decisão.** Três ajustes no `automation-executor.ts` para fazer
condições de tag funcionarem no fluxo de receptivo:

1. **`continueFromStep` popula tags.** A função que continua o fluxo
   depois de `wait_for_reply`/`question` montava o `RuntimeContext`
   sem os arrays `contactTagIds/Names`/`dealTagIds/Names`. Resultado:
   condition `has_tag` sempre via `undefined` no lado esquerdo e
   caía no `else`. Agora chama `loadAutomationTagSnapshot` antes de
   montar o `rt`.
2. **Refresh após `add_tag`/`remove_tag`.** Dentro do loop de execução
   (em `executeAutomation` e `continueFromStep`), assim que o step
   termina e foi `add_tag`/`remove_tag`, recarregamos as tags pra
   que conditions subsequentes enxerguem o novo estado — antes o
   snapshot era de `resolveRuntimeContext` (início do job).
3. **União contact+deal nas ops de tag.** No `condition` case,
   quando `rule.op` é `has_tag`/`not_has_tag` e o field é
   `contact.tags`/`deal.tags`/`contact.tagIds`/`deal.tagIds`, o
   `left` da comparação passa a ser a UNIÃO dos dois arrays
   correspondentes (nomes ou ids). Motivo: hoje o step `add_tag`
   persiste só em `TagOnContact` (não tem opção entity), então
   operadores que escolhem `deal.tags` na UI esperando ver a tag
   recém-adicionada via `add_tag` no fluxo não veriam match. União
   elimina essa armadilha sem exigir UI nova.

**Contexto.** Operador relatou: "rodou a automação de receptivo, mas a
condição de tag não foi, eu selecionei CLT, depois tem a condição, mas
o fluxo seguiu e ignorou essa condição". Diagnóstico nos logs do
banco: o branch da condition retornava SUCCESS mas o próximo step
executado era sempre o `elseStepId`, indicando que `has_tag` retornava
`false` mesmo com a tag adicionada. Três causas convergentes: rt
sem tags em continuação, snapshot stale dentro do loop, e mismatch
contact/deal na config vs `add_tag`.

**Alternativas descartadas.**

- **Mudar `add_tag` pra ter entity (contact|deal).** Resolveria o ponto 3
  na raiz, mas exige UI nova no `step-config-panel`, migração silenciosa
  pros configs existentes (operadores teriam que reabrir cada step pra
  setar `entity: "contact"`), e tem efeito-rede zero pro caso atual.
  Mantemos `add_tag` em contact e fazemos união no condition — mesma UX
  com 1/10 do esforço.
- **Refrescar o rt inteiro depois de cada step.** Mais "robusto" mas
  ridículo em custo (5 queries por step × N steps). Refresh seletivo
  pós-`add_tag`/`remove_tag` é suficiente porque só tags mudam
  externamente ao `rt`.

**Impacto.** Backward-compatible — automações com `has_tag` em config
antiga que dependiam do separator contact vs deal viam falso negativo
(armadilha), agora funcionam. Custo: +1 query por step de tag e +2
queries por continuação (tags do contato + tags do deal).

---

### 2026-05-27 — Auto-deal prioriza pipeline `isDefault` (não mais "mais antigo")

**Decisão.** Em `services/auto-deals.ts` (`ensureOpenDealForContact`),
a query `prisma.pipeline.findFirst` passou de
`orderBy: { createdAt: "asc" }` para
`orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }]`. Resultado:
quando uma org tem mais de um pipeline, o auto-deal é criado no
pipeline marcado como padrão na UI (`/pipelines` → toggle "Padrão");
o mais antigo segue como fallback quando nenhum default existe.

**Contexto.** Operador relatou: "quando um número que não existe enviar
mensagem para o whatsapp, tem que criar lead e contato direto na
primeira etapa do kanban". O sistema JÁ criava o lead+contato+deal,
mas no pipeline "Atendimento" (mais antigo, sem `isDefault`) ao invés
do "Pipeline Principal" (`isDefault: true`, usado de fato pelo
operador). O lead "sumia" porque o operador estava olhando o pipeline
errado.

**Alternativas descartadas.**

- **Pipeline configurável por canal/source.** Mais flexível
  (`channels.config.defaultPipelineId`) mas é overkill — operador tem
  um único kanban "verdadeiro". `isDefault` já existe no schema, só
  faltava ser respeitado aqui.
- **Migrar o lead atual ("caio") pro pipeline default.** Não toquei
  em dados — futuras mensagens caem no pipeline certo, e o
  `ensureOpenDealForContact` é idempotente (não recria se já existe
  deal aberto). Operador pode mover o deal manualmente se quiser.

**Impacto.** Backward-compatible: orgs com um único pipeline (ou sem
`isDefault` setado) seguem com o comportamento anterior (mais antigo).
Para a org atual, novos leads WhatsApp passam a entrar em "Pipeline
Principal → Lead de Entrada" (`position: 0`, `isIncoming: true`).

---

### 2026-05-27 — Trigger `message_received` best-effort no filtro de estágio + DELETE de contato sem bloqueio

**Decisão.**

1. Em `services/automations.ts`, `evaluateTrigger` para
   `message_received`/`message_sent` deixou de ser *fail-closed* quando
   o config tem `stageId`/`pipelineId` mas o `enrichContext` não
   consegue popular (contato sem deal aberto). Nova regra: bloqueia só
   quando *conhecemos* o estágio do contato e ele diverge; quando não
   conhecemos, passa.
2. Em `app/api/contacts/[id]/route.ts`, removido o early-return `409`
   por `checkContactDeals`. O `deleteContact` já nullifica deals
   (preserva histórico no kanban) e remove em cascata
   conversations/messages/activities/notes/automation_logs.

**Contexto.** Operador relatou: (a) gatilho de mensagem com filtro de
estágio nunca disparava — diagnóstico: contato sem deal aberto no
momento da mensagem (cenário-padrão em receptivo) caía no fail-closed;
(b) "quero excluir o lead independente se tem deal ou não" — a
checagem era defensiva demais, o serviço já tratava o caso.

**Alternativas descartadas.**

- Criar auto-deal síncrono antes do trigger: acopla webhook ao kanban,
  aumenta latência. Best-effort no enrich mantém o padrão atual.
- Cascade delete dos deals: perde histórico. Nullify deixa o deal no
  kanban como "contato removido", semanticamente correto.

**Impacto.** Backward-compatible para automações com deal aberto.
Operadores em receptivo agora veem `message_received` disparar
sempre — pra filtragem fina usar `condition` step. Deals órfãos
(sem `contactId`) passam a existir; o front já trata `deal.contact ===
null`.

---

### 2026-05-27 — Ops `has_tag` / `not_has_tag` nas condições de automação

**Decisão.** Estender `automation-condition.ts` com dois novos operadores
(`has_tag` e `not_has_tag`) e enriquecer o `RuntimeContext` em
`automation-executor.ts` para expor `contactTagNames`/`contactTagIds` e
seus pares de deal. No `evalRoot` da condition, esses arrays viram
`contact.tags` (nomes), `contact.tagIds` (IDs), `deal.tags`,
`deal.tagIds`. O comparador case-insensitive em `evalCondition` aceita
match contra qualquer um dos dois arrays — o usuário escolhe um NOME
no picker da UI, mas configs antigos que salvarem ID continuam
funcionando.

**Contexto.** O operador pediu "se tem TAG X adicionada ou não" como
opção explícita na condição. A infra já tinha `add_tag`/`remove_tag`
como passos de ação, mas faltava a contrapartida de leitura no
`condition`. Usar o `includes` genérico contra `contact.tags` daria
pra resolver tecnicamente, mas seria descobrível só pra quem soubesse
o path do evalRoot — operador prefere ver "Tem a tag" como op de
primeira classe.

**Alternativas descartadas.**

- **Adicionar só o campo `contact.tags` e reusar `includes`/`empty`.**
  Funciona em runtime, mas a UI ficaria confusa (ops irrelevantes
  visíveis pro campo de tags). Preferimos ops explícitos com label
  "Tem a tag" / "Não tem a tag", filtrados no select da UI quando o
  campo é de tag — UX claro.
- **Carregar tags lazy no `evalCondition`.** Mais "preguiçoso" mas
  exigiria uma query extra por rule de condition. Carregando junto no
  `resolveRuntimeContext` (uma única `include`) batemos no banco uma
  vez por job — muito mais barato.
- **Salvar IDs no value picker em vez de nomes.** Mais resiliente a
  renomes mas exige que o operador veja UUIDs (ruim). O picker salva
  nome; o evaluator faz match contra nome E id (case-insensitive),
  então compat com configs antigas que vinham com ID é mantida.

**Impacto.** Backward-compatible — automações antigas sem ops de tag
não veem diferença (tags são carregadas mas só consultadas se a rule
pedir). Custo de banco: +1 include em `resolveRuntimeContext`
(`TagOnContact` + `TagOnDeal`) por job — tabela tem índice em
`(contactId)`/`(dealId)`, custo negligível.

---

### 2026-05-27 — Filtros de pipeline/estágio nos gatilhos de automação

**Decisão.** Estender o `evaluateTrigger` em `src/services/automations.ts`
para suportar filtros opcionais por `pipelineId` e `stageId` nos gatilhos
`contact_created`, `deal_created`, `deal_won` e `deal_lost`. Também
padronizar a leitura de `stageId`/`pipelineId` em `message_received` e
`message_sent` (antes só lia `dealStageId`/`dealPipelineId` enriquecidos
internamente — agora aceita os dois nomes pra permitir que a UI escreva
os campos canônicos).

Como o evento `contact_created` é disparado em paralelo ao auto-deal
(via `ensureOpenDealForContact` em `src/services/auto-deals.ts`), o
filtro por estágio só vale se o deal já tiver sido criado quando o
trigger chegar no worker. Pra maximizar a janela útil, `enrichContext`
em `src/services/automation-triggers.ts` agora faz um lookup
best-effort do deal aberto mais recente do contato.

**Contexto.** O operador relatou no chat que (a) não conseguia editar a
automação depois de salvar o fluxo e (b) faltavam gatilhos do tipo
"mensagem recebida em X estágio" e "lead/contato criado em X estágio".

- **(a)** Já existia rota de edição (`PUT /api/automations/[id]`) — o
  problema era UX no frontend: o nó do gatilho no canvas era inerte. A
  correção é só no frontend (ver entrada gêmea no AGENT.md do
  frontend_crm1).
- **(b)** O backend já enriquecia `message_received`/`message_sent` com
  estágio do deal aberto, mas (i) lia só `dealStageId`/`dealPipelineId`
  (forçando a UI a escrever esses nomes específicos), e
  (ii) `contact_created` retornava sempre `true` sem nenhum filtro.

**Alternativas descartadas.**

- **Adicionar um novo gatilho separado, `contact_created_in_stage`.**
  Multiplicaria o número de tipos sem ganho — o mesmo evento com config
  opcional já cobre os dois casos (filtra ou não filtra). Mais código
  pra manter e mais friction pro usuário escolher entre dois gatilhos
  quase idênticos.
- **Reordenar o disparo: criar o deal ANTES de emitir
  `contact_created`.** Tem efeito colateral em quem já usa o gatilho
  hoje (o payload mudaria de momento de emissão). Como o trigger é
  fire-and-forget e vai pro worker (delay natural de BullMQ), a janela
  de race quase sempre fica do nosso lado — o enrich best-effort
  resolve >95% dos casos sem mudar contratos.
- **Forçar `stageId` obrigatório quando configurado no
  `contact_created`.** Já é o comportamento (`if (stageId && !dataStageId)
  return false`), só explicitado no comentário pra evitar bug futuro.

**Impacto.** Automações existentes que usam `contact_created` ou
`deal_*` sem `stageId`/`pipelineId` configurado continuam disparando
exatamente como antes (filtros opcionais — só restringem se
preenchidos). Mudança backward-compatible.

---

### 2026-05-27 — `POST /api/leads` atômico + Bearer destravado em `/custom-fields`

**Decisão.**

1. Migrar `GET/PUT /api/contacts/[id]/custom-fields` e
   `GET/PUT /api/deals/[id]/custom-fields` de `withOrgContext` para o par
   `authenticateApiRequest` + `runWithApiUserContext`. Resultado prático:
   ambos passam a aceitar **Bearer**, igual ao restante de `/api/contacts/*`
   e `/api/deals/*`.
2. Criar `POST /api/leads` — endpoint **atômico** que faz lead-or-create em
   uma única chamada: contato (idempotente por phone → email), bloco
   opcional de deal no `stageId` escolhido, custom fields de contato e de
   deal (resolvidos por `fieldId` **ou** `name`), e disparo do trigger
   `deal_created`.

**Contexto.** O usuário rodando integração via n8n bateu em três muros:

- O curl `GET /api/contacts?phone=...` parecia funcionar mas retornava 456
  contatos (todos da org) porque o deployment antigo no Easypanel
  (`banco-backend-crm.6tqx2r.easypanel.host`) rodava código **antes** do
  PR que adicionou `?phone=` exato (entrada AGENT.md de 26/mai/2026,
  linha 77). O deployment correto (`backend-backend.v74knz.easypanel.host`)
  já tinha o filtro e devolvia `total=1`. Resolveu trocando a URL no n8n.
- `PUT /api/contacts/[id]/custom-fields` e `PUT /api/deals/[id]/custom-fields`
  devolviam 401 mesmo com Bearer válido porque ambos usavam
  `withOrgContext`, que só lê cookie do NextAuth (não tem fallback para
  Bearer). Validado por reprodução com curl real:
  `GET /api/contacts/<id>/custom-fields` com Bearer → 401 "Não autorizado.".
- Mesmo destravados, o fluxo "criar lead com contato + custom fields +
  stage" exigia 4 round-trips (`POST /api/contacts` → `POST /api/deals` →
  `PUT contact custom-fields` → `PUT deal custom-fields`), com janela de
  inconsistência se alguma das chamadas falhasse no meio. n8n não tem
  transação distribuída — o estado podia ficar parcial (contato sem deal,
  deal sem custom fields).

**Alternativas descartadas.**

- **Trocar `withOrgContext` por `withApiAuthContext` em todos os ~70 routes
  que ainda usam o primeiro.** Tentador, mas a maioria desses routes é
  admin/settings/inbox interno que **não tem caso de uso Bearer hoje** e
  carrega contratos de sessão (cookies, CSRF) que mudariam de comportamento.
  Risco/benefício ruim — refatoração ampla por um requisito que cobre 2 rotas.
- **Criar `/api/v2/leads` em outro path e deixar a v1 quebrada.** Versionar
  cedo demais cria carga cognitiva e dois caminhos pra manter. O endpoint
  novo é aditivo (nenhum endpoint existente muda contrato), não precisa
  bump de versão.
- **Webhook do n8n entrando direto em `/api/webhooks/n8n` (sem Bearer).**
  Significaria HMAC compartilhado e rota pública — mais superfície de
  ataque e divergência do padrão Bearer já documentado. Bearer com token
  por org é o caminho canônico.
- **Custom field upsert via array `[ { name, value } ]` em vez de `[ { fieldId, value } ]`.**
  Mantemos suporte aos dois (resolve por `name` quando `fieldId` está
  ausente). Resolver por name é "human-friendly" pro n8n; resolver por id
  é determinístico e não muda quando a label do campo é editada. O endpoint
  novo aceita os dois e devolve `missingCustomFields` quando o `name` não
  bate — falha não-fatal, não derruba a request inteira.

**Impacto.**

- Zero migração de schema. Apenas três arquivos novos/alterados:
  - `src/app/api/contacts/[id]/custom-fields/route.ts` (Bearer destravado).
  - `src/app/api/deals/[id]/custom-fields/route.ts` (Bearer destravado;
    mantém `requirePermissionForUser` + `canEditFieldForUser` por campo;
    continua gerando evento `CUSTOM_FIELD_UPDATED` na timeline).
  - `src/app/api/leads/route.ts` (novo, ~360 linhas; reusa
    `createContact`, `updateContact`, `createDeal`,
    `upsertContactCustomFieldValues`, `upsertDealCustomFieldValues`).
- A idempotência do `POST /api/leads` é **best-effort**, não transacional:
  o lookup de contato roda fora da transação (Prisma extension não
  envolve `findFirst` em transação implícita). Em concorrência alta, duas
  chamadas com o mesmo phone podem ambas criar contato — colisão raríssima
  no caso real (n8n + lead único por trigger) e fica P2002 quando email
  é único na org. Follow-up: usar `prisma.contact.upsert` + chave única
  composta `(organizationId, phone_normalized)` exigiria nova column +
  migration; não foi feito agora.
- O endpoint **sempre cria deal novo** quando o bloco `deal` está presente
  (mesmo se o contato foi reusado). Deduplicar deal automaticamente
  exigiria mais regras de negócio (qual stage? mesma pipeline? deal aberto
  ou qualquer?) e não cabe nesse PR. Caller faz `GET /api/deals?contactPhone=...`
  antes se precisar.
- `API_REFERENCE.md` atualizado: prefixo `crm_` → `eduit_`, body real do
  `PUT custom-fields` (array de `{ fieldId, value }`, não objeto literal),
  seção nova "`POST /api/leads`" com exemplo n8n.

---

### 2026-05-26 — `POST/PUT /api/users` diferencia P2002 cross-org

**Decisão.** Quando `prisma.user.create()` (POST `/api/users`) ou
`prisma.user.update({ data: { email } })` (PUT `/api/users/[id]`) caem em
`P2002` por colisão de `email`, o handler agora faz uma **segunda query
cross-org** (`prisma.user.findFirst({ where: { email } })`) para descobrir
**em qual organização** o duplicado vive. Se for em outra org, devolve uma
mensagem específica do tipo *"E-mail já cadastrado em outra organização
('Foo Inc.'). Peça ao usuário para sair da outra ou contate o suporte."* —
em vez do genérico *"E-mail já cadastrado."*. Aproveitou-se a passada para
normalizar `email.trim().toLowerCase()` e `name.trim()` no POST (o PUT já
fazia isso).

**Contexto.** `User.email` é `@unique` **global** no schema (linha 280 do
`schema.prisma`, comentário canônico: "um email pertence a uma única
org"). Combinado com `/api/signup` aberto, qualquer pessoa pode criar uma
org "fantasma" via signup público e ficar com o próprio email
sequestrado pra colisão. Caso real (2026-05-26): a admin DnaWork tentou
cadastrar `larissa@dnawork.ai` em `org_dnawork` e recebeu 409 — a Larissa
tinha feito signup público antes e ficou de ADMIN solo em uma org `dna-work`
com `onboardingCompletedAt=null`. Como `/settings/team` só lista users da
**própria** org (`userOrgFilter`), a duplicada era invisível e a "exclusão"
da admin nem ia a lugar nenhum (404 silencioso, percebido como sucesso).
Mensagem genérica fazia o admin ficar 30+ min sem saber por onde sair.

A correção do **caso pontual** foi um `DELETE FROM organizations WHERE id
= '<ghost>'` em transação (cascade do schema limpou User + agent_status +
agent_presence_logs + login_attempts + audit_log). Esse PR trata apenas a
prevenção da próxima ocorrência.

**Alternativas descartadas.**

- **Tornar `User.email` único por org (`@@unique([email, organizationId])`).**
  Resolveria de vez (o admin DnaWork conseguiria cadastrar `larissa@…` na
  org dele independentemente de outra org ter o mesmo email). MAS quebra
  premissa do NextAuth/login atual ("email identifica univocamente a
  conta"). Login precisaria pedir org (slug, subdomínio, dropdown) — é
  redesenho de auth, fora de escopo de bugfix. Migration também é
  arriscada em prod com 10k+ users.
- **Bloquear `/api/signup` para domínios de orgs já existentes.** Heurístico
  (e-mail Gmail/Hotmail anula o critério, e-mail corporativo é o caso útil
  mas exige extrair o domínio e comparar com algum campo da Organization
  que hoje não existe). Vale como follow-up, não como fix do P2002.
- **Soft-delete em `User.delete()` para nunca derrubar o registro.** O
  schema já tem `isErased` + `erasedAt` pra LGPD, mas o `DELETE
  /api/users/[id]` é hard delete proposital — soft-delete misturaria
  semântica e ainda não resolveria o caso (a Larissa não foi deletada de
  jeito nenhum, ela está em **outra** org).
- **Retornar o `organizationId` do duplicado no body do 409.** Vazaria
  informação cross-tenant (a admin DnaWork não tem motivo legítimo de
  saber o ID interno da org-fantasma). O nome da org vai porque o admin
  precisa de uma pista acionável; ID interno fica de fora.

**Impacto.**

- Zero alteração em schema, migration, NextAuth ou frontend (a UI já mostra
  `data.message` cru, então a string nova aparece automaticamente).
- O findFirst extra só roda no caminho de erro (P2002), que é raríssimo —
  não afeta latência do happy path.
- `prisma.user.findFirst` opera cross-org porque `User` **não está em
  `SCOPED_MODELS`** do `prisma.ts`. Nada a fazer manualmente; documentar
  aqui pra não regredir caso alguém pense em adicionar User ao scope no
  futuro.
- Follow-up sugerido (não incluso neste PR): considerar gating do
  `/api/signup` por allowlist de domínios ou por flag, pra reduzir a
  chance de "orgs fantasmas" criadas por convidado em vez de admin.

---

### 2026-05-26 — Filtros exatos `?email` / `?phone` em `/api/contacts` e `?contactEmail` / `?contactPhone` em `/api/deals`

**Decisão.** Estender os GETs de listagem com **filtros 1:1** (não-contains)
pelo email/telefone do contato, sem criar endpoint novo. Em `getContacts`
entraram `emailExact` e `phoneExact`; em `getDeals` entraram `contactEmail`,
`contactPhone` e `contactId`. Os `route.ts` correspondentes leem os query
params `email`, `phone` (contacts) e `contactEmail`, `contactPhone`,
`contactId` (deals) e repassam ao service. Comportamento de `?search=` e
qualquer chamada existente **fica intocado** — só ficou a superfície maior.

**Contexto.** O backend só tinha `?search=` (contains case-insensitive em
`name|email|phone|customFields`). Para integrações (n8n, Zapier, Make)
isso é ruim porque:

1. *Falso positivo:* procurar `maria@a.com` matcha também `mariaclara@a.com.br`.
2. *Sem booleano de existência:* o caller precisa baixar a página e fazer
   comparação manual no nó Code do n8n.
3. *Dois round-trips para deals:* não existia jeito de perguntar "esse
   contato tem deal aberto?" sem antes resolver o contactId via `/api/contacts`.

O caso disparador foi um workflow n8n "lead-or-create" — o operador queria
1 chamada por entidade para decidir entre `POST` (criar) ou `PUT`
(atualizar). Com `?search=` precisava de 1 GET + nó Code + IF — frágil
para emails parecidos.

**Por que estender o GET existente, e não criar `/api/contacts/lookup`.**

- **Estender GET (escolhido)** ✅ — segue o padrão do projeto (filtros via
  query são a forma canônica em todo o `app/api/**`). Diff trivial: ~20
  linhas em service + ~5 em route, zero quebra de compat. n8n usa direto
  com `?perPage=1` (`total=0` = não existe, `total>=1` = existe e dados já
  vêm em `items[0]`).
- **Endpoint dedicado `lookup` / `exists`** — semanticamente mais explícito,
  mas adiciona 2 endpoints a uma superfície já grande (318 rotas). Duplica
  a lógica do listing principal. Recusado por custo de manutenção.
- **`HEAD /api/contacts?email=...`** — idiomático HTTP (200 existe / 404
  não), mas no-code (n8n) lida muito melhor com JSON paginado do que com
  status code puro. Recusado por DX.
- **Workaround só no n8n** (status quo) — não resolve o falso positivo de
  `contains`. Mantém o overhead em todo workflow novo. Recusado.

**Match de telefone — tolerância a formatação.** O `Contact.phone` é
salvo só com `.trim()` no `route.ts` de POST (sem normalizar dígitos).
Existem registros com `+5511999998888`, `(11) 99999-8888`, `5511999998888`
no mesmo banco. Para `?phone` fazer sentido na prática usamos:

```ts
OR: [
  { phone: { equals: rawInput } },              // valor cru
  { phone: { endsWith: digitsOnly } },          // últimos N dígitos
]
```

Só ativa o `endsWith` quando o input tem >= 8 dígitos (evita matchar
"99" como sufixo). Não fizemos backfill de normalização do `phone` — seria
mudança destrutiva sem ganho proporcional; o `endsWith` cobre o caso real.

**Match de email.** `equals` com `mode: "insensitive"` (o Prisma traduz
para `ILIKE` no Postgres) — o input é forçado a lowercase antes da query
para evitar problemas com providers que case-folding diferente.

**Sem registro órfão.** A combinação `?email=` + `?lifecycleStage=LEAD`
funciona: ambos viram condições adicionais no `where` (AND). Mesmo
princípio para `?contactEmail=` + `?status=OPEN&pipelineId=...` em deals.

**Impacto operacional.**

- n8n: workflows ganham 1 chamada a menos por lead (era GET + Code; agora é
  só GET com `?email=`). Update no `API_REFERENCE.md` §6.1, §7.1 e §19.
- Sem migration. Sem mudança de schema.
- Bearer token continua sendo a forma recomendada de auth (mesmo padrão).

**Alternativas descartadas (resumo).**

- Endpoint dedicado `lookup` (acima).
- `HEAD` request (acima).
- Forçar normalização de `phone` no banco (custo > benefício para um caso
  resolvido por `endsWith`).
- Aceitar regex no `?phone=` (overkill; usuário pode usar `?search=` se
  precisar de fuzzy).

---

### 2026-05-26 — `Message.templateConfigId` (FK) corrige roteamento de Flow inbound

**Decisão.** Adicionar FK `Message.templateConfigId → WhatsAppTemplateConfig`
(nullable, `onDelete: SET NULL`) e gravar o vínculo em todos os call sites de
envio outbound de template. O resolver `resolveFlowDefinitionForInbound` passa
a usar esse FK como caminho primário (cascata exata → nome Meta → best-match
por field keys).

**Contexto.** O resolver original, quando a resposta inbound chegava com
`flow_token`, fazia `whatsAppTemplateConfig.findFirst({ where: { flowId: { not:
null } }, orderBy: { updatedAt: "desc" } })` — escolhia *qualquer* template
config com flowId da organização, ignorando completamente qual template foi
de fato enviado. Em orgs com 2+ templates Flow, a resposta era roteada para
o flow errado, os `fieldKey` não casavam, e todos os campos caíam em `skipped`
com motivo "Campo não configurado no flow do CRM". Sintoma reportado: *"o
form está configurado mas não preenche os dados nos campos do negócio"*.

**Por que FK e não outra abordagem.**

- **FK (`templateConfigId`)** ✅ — resolução O(1), integridade referencial,
  `onDelete: SET NULL` preserva histórico se o config for deletado.
- **String `templateMetaName`** — resiliente a deleção do config, mas
  renomear template Meta quebraria casamento futuro.
- **String `templateGraphId` (Meta ID)** — imune a renames internos, mas se
  a Meta refizesse o template (novo `metaTemplateId`), também quebraria.

A FK ainda permite consultas analíticas tipo "quantas respostas o flow X
gerou" via join — string IDs não dão isso barato.

**Mensagens antigas.** A coluna é nullable. Mensagens pré-migration mantêm
`templateConfigId = NULL` e seguem usando o fallback histórico (nome Meta +
best-match por keys) — não há backfill porque o gap só dói quando a org
tem múltiplos templates Flow, e a resposta antiga já foi processada (ou
não) há tempos.

**Call sites de envio atualizados:**

- `app/api/conversations/[id]/template/route.ts` — envio manual da inbox.
- `services/automation-executor.ts` — ação `send_whatsapp_template` de
  automações (Funil de Automações).
- `services/ai/tools.ts` — tool `send_whatsapp_template` do Agente IA.
- `services/scheduled-messages-worker.ts` — fallback template ao expirar
  janela 24h.

**Call sites NÃO atualizados (não disparam Flow):**

- `app/api/conversations/[id]/call-permission/route.ts` — pedido de
  permissão de ligação WhatsApp. Template específico sem botão Flow.
- `services/missed-call-schedule-offer.ts` — oferta de reagendamento após
  ligação perdida. Template fixo sem Flow.
- `workers/campaign-worker.ts` — campanhas em massa. Hoje campanhas não
  suportam Flow; quando passarem a suportar, atualizar aqui.

**Alternativas descartadas.**

- **Sem migration, só corrigir resolver pelo `flowMetaName`.** Funciona se
  a Meta sempre enviasse `nfm_reply.name`, mas ela não envia consistentemente
  — varia por categoria/template. A FK é o único caminho 100% determinístico.
- **Backfill retroativo das mensagens antigas.** Custo > valor: respostas
  antigas já foram processadas. Backfill via heurística seria adivinhar.

**Como testar pós-deploy.**

1. `prisma migrate deploy` aplica `20260526090000_add_message_template_config_id`
   no startup do container `APP_MODE=api`.
2. Enviar template Flow novo pela inbox → conferir no banco
   `SELECT template_config_id FROM messages WHERE conversation_id = '...' ORDER BY created_at DESC LIMIT 1;`
3. Cliente responde o Flow no WhatsApp → conferir log `[whatsapp-flow] apply
   concluído` com `flowDefinitionId` igual ao esperado e `applied.length > 0`.

---

### 2026-05-22 — APP_MODE separa API/workers no EasyPanel (1 imagem, 3 serviços)

**Decisão.** O Dockerfile produz uma única imagem que pode executar em três
modos via env `APP_MODE`:

- `APP_MODE=api` (default) — Next.js standalone server. Único modo que aplica
  `prisma migrate deploy` no entrypoint (workers não aplicam migrations para
  evitar race condition entre serviços do mesmo deploy).
- `APP_MODE=worker-whatsapp` — `node dist/workers/campaign-worker.js`. Consome
  as filas `campaign-dispatch` + `campaign-send` (lógica de envio Meta Cloud
  API JÁ existente — não foi reescrita).
- `APP_MODE=worker-leads` — `node dist/workers/leads-worker.js`. Consome a
  fila `leads-bulk` (operações em massa de Deals: `bulk-update-fields`,
  `bulk-move-stage`).

No EasyPanel, criar 3 serviços apontando para o MESMO repositório/imagem,
diferenciados apenas pela env `APP_MODE`. Todos compartilham `DATABASE_URL`,
`REDIS_URL`, `NEXTAUTH_*` etc. — workers só precisam do subconjunto que usam,
mas sem prejuízo se receberem todas.

**Contexto.** Antes desta mudança, o Dockerfile só subia `node server.js`.
O `campaign-worker.ts` existia mas não tinha script npm nem branch no
entrypoint — campanhas enfileiravam jobs que ninguém consumia em produção,
a menos que alguém executasse `tsx src/workers/campaign-worker.ts` manualmente
em outro processo. Quando o usuário pediu BullMQ workers, descobrimos que
~95% da infra já existia; o gap era operacional (deploy + ergonomia).

**Por que esbuild compila os workers em vez de usar `tsx` em prod.** O runner
stage do Dockerfile copia apenas `.next/standalone`, que é o output do Next
trace — ele inclui só pacotes que o bundle Next referencia em runtime. `tsx`
(em `dependencies` no package.json) NÃO é referenciado pelo Next e portanto
não é copiado para o runner. `npm run build:workers` (`scripts/build-workers.mjs`)
usa esbuild para empacotar `campaign-worker.ts` e `leads-worker.ts` em CJS
standalone, externalizando `@prisma/client` (que precisa vir dos engines
nativos copiados em `node_modules/@prisma/*`). Dev local mantém `tsx` por
ergonomia (sem rebuild a cada edit) — scripts `start:worker:*` (dev) vs
`start:worker:*:prod` (Docker).

**Por que migrations só em APP_MODE=api.** Se workers também aplicassem
`prisma migrate deploy`, três serviços competiriam pelo mesmo lock de
migration no Postgres em cada deploy. O serviço API é o "owner" das migrations;
workers assumem que o schema está pronto. Em ambientes `SKIP_PRISMA_MIGRATE=1`
(test apontando para banco do monólito), nem o API aplica — operador roda
manual via `psql`.

**Alternativas descartadas.**

- **Dockerfile.worker separado.** Imagem por papel é mais enxuta mas dobra
  complexidade de CI/registry e desincroniza versões entre API e worker.
  Uma imagem só com `APP_MODE` é mais simples para o tamanho atual do projeto.
- **Migrations dentro do worker.** Levaria a race condition se 3 serviços
  do mesmo deploy subissem em paralelo. Mesmo com `IF NOT EXISTS` no SQL,
  o `_prisma_migrations` table não tolera concorrência limpa.
- **Rodar workers in-process do Next API.** Já fazemos isso para timers leves
  (`sse-bus.ts` bootstrap), mas BullMQ Workers ocupam um event loop e
  competiriam com requests HTTP. Processos separados isolam falhas (worker
  morto não derruba a API) e permitem scaling independente.

---

### 2026-05-22 — BulkOperation: Postgres como fonte da verdade do progresso

**Decisão.** Operações em massa enfileiradas no BullMQ registram seu estado
em uma tabela `bulk_operations` no Postgres (modelo `BulkOperation`). O Redis
mantém apenas o job na fila enquanto está sendo processado; todo histórico,
progresso, erros e auditoria vivem no Postgres.

Endpoints criados:

- `POST /api/deals/bulk` — modo async opt-in (flag `async: true` no body,
  ou auto-async se `dealIds.length > 50`) para `action: "move_stage"`. Outras
  ações (change_owner, mark_won, mark_lost, delete) continuam síncronas por
  enquanto.
- `POST /api/deals/bulk/custom-fields` — NOVA funcionalidade (não existia
  bulk de custom fields antes), sempre async, com `BulkOperation` tracking.
- `GET /api/bulk-operations/[id]` — frontend pollar progresso via
  `{ total, processed, succeeded, failed, progressPercent, errors[] }`.

Idempotência: a Prisma extension de scope filtra todas as queries por
`organizationId`. Workers usam `withSystemContext(orgId, ...)` para
configurar o AsyncLocalStorage antes de invocar handlers que usam `prisma`
(scoped). `_update-progress.ts` usa `prismaBase` (sem scope) para atualizar
o `BulkOperation` — evita acoplamento com a extension nos workers compilados.

**Contexto.** O backend tinha 5 filas BullMQ em produção, mas nenhum modelo
para rastrear estado de operações em massa fora do escopo de campanhas
WhatsApp (que tem seu próprio modelo `Campaign` + `CampaignRecipient`). Para
operações de Deals em lote, faltava completamente um trilho — `POST
/api/deals/bulk` rodava 100% síncrono com loops N+1.

**Por que não usar apenas o estado do BullMQ.** O BullMQ remove jobs com
`removeOnComplete: true` (default no projeto). Sem snapshot em DB, o
histórico se perde — impossível responder "que bulk operations rodaram nessa
org no último mês?". Além disso, polling do frontend ficaria amarrado ao
Redis estar acessível pela rota API, o que dobra a superfície de
dependência.

**Cuidado 7 do enunciado (idempotência + fire-and-forget):**

- `bulk-move-stage` reverifica `stageId !== target` antes de cada update.
  Deals já na stage destino são contados como sucesso sem disparar
  `DealEvent` ou `fireTrigger`. Retry do job não reaplica triggers.
- `updateMany` atômico por chunk de 50 deals. Side effects (`createDealEvent`,
  `fireTrigger`) ficam fora da transação principal — fire-and-forget com log,
  igual ao helper síncrono `moveDeal` em `services/deals.ts`.
- Erros por-deal são acumulados em `BulkOperation.errors` (JSON array) com
  cap de 500 entradas. Worker continua processando os demais deals do chunk.
- Re-throw acontece apenas em erros de infraestrutura (DB down) que causam
  retry do job inteiro pelo BullMQ.

---

### 2026-05-14 — User movido entre orgs: gera registros órfãos sob RLS

**Decisão.** Sempre que um `User` for movido entre `Organization`s (campo
`organizationId` no `users`), TODOS os registros 1:1 que carregam
`organizationId` denormalizado precisam ser atualizados na mesma transação,
ou Prisma RLS começa a devolver `P2025`/`P2003` em loop nos heartbeats.

Tabelas afetadas conhecidas:

- `agent_statuses` (1:1 com user, indexado por `userId @unique`)
- *(adicionar aqui qualquer outra tabela com `organizationId + userId@unique`
  que aparecer no futuro)*

**Contexto.** Descoberto investigando `prisma.agentStatus.upsert()` em loop
no log do backend separado. O user `adm@dnawork.ai` foi originalmente
criado em `org_eduit` e depois movido para `org_dnawork`. O registro
`agent_statuses` ficou com `organizationId = org_eduit`. Quando o user
faz heartbeat:

1. Sessão tem `organizationId = org_dnawork` (org atual do user).
2. Prisma extension de RLS injeta `WHERE organizationId = 'org_dnawork'`
   no `findUnique` interno do upsert.
3. Não acha o registro (que existe, mas em outra org).
4. Vai pro `create` path.
5. Conflita em `userId @unique` (já existe um registro com esse userId).
6. Prisma normaliza isso como `P2025: Record not found`.

A produção do monólito (`crm.eduit.com.br`) provavelmente não tinha esse
loop antes porque rodava com Prisma extension RLS desativado, ou
processava cross-org sem filtrar (super-admin path).

**Como detectar.**

```bash
DATABASE_URL=... node scripts/diagnose-agent-status.mjs
```

Mostra registros cross-org. Se houver, rodar:

```bash
DATABASE_URL=... node scripts/fix-agent-status-cross-org.mjs
```

(move cada AgentStatus pra `organizationId` igual ao do user dono).

**Alternativas descartadas.**

- **Cascade deletar AgentStatus quando user muda de org.** Perde
  histórico de presença e o user fica "OFFLINE" até próximo ping. Pior UX.
- **Remover o `organizationId` redundante de `agent_statuses`.** O index
  por org existe pra performance de dashboards multi-tenant (listar todos
  agentes ONLINE de uma org). Tirar quebraria essas queries.

**Impacto.**

- Hardening defensivo aplicado em `PUT /api/agents/[id]/status` (igual ao
  já existente em `POST /api/agents/me/ping`): captura `P2025/P2003`,
  responde 200 silenciosamente. Não polui log nem quebra UX se voltar a
  aparecer registro órfão.
- TODO técnico: encontrar e bloquear o lugar do código que **move user
  entre orgs** (super-admin tool) e adicionar transação que atualize
  `agent_statuses.organizationId` em conjunto. Sem isso, novos órfãos
  podem nascer.

### 2026-05-14 — Sem Redis em ambiente de teste compartilhado com produção

**Decisão.** No ambiente de teste no Easypanel
(`banco-backend-crm.6tqx2r.easypanel.host`), o backend separado roda **sem
Redis**. As envs `REDIS_URL` e `SSE_ENABLE_REDIS_PUBSUB` ficam ausentes.
Cache, rate-limit e SSE pub/sub usam o fallback em memória que já existe
no código.

**Contexto.** O Redis disponível na infra atual está no project
"banco" (junto do Postgres) e é **o mesmo Redis usado pelo monólito de
produção** em `crm.eduit.com.br`. Dois pontos:

1. Hostname interno do Docker (`banco_redis-crm`) **não resolve cross-project**
   no Easypanel — só dentro do mesmo project. Daí o
   `getaddrinfo ENOTFOUND banco_redis-crm` no backend separado.
2. Mesmo se conseguíssemos conectar (expondo Redis externamente ou
   movendo de project), **compartilhar Redis com produção é inaceitável**:
   cache de `Organization`/feature flags/subscription colide, SSE
   entrega eventos cruzados entre teste e produção, rate-limit do
   teste consome budget da produção. Risco real de cache poisoning
   em produção por conta de um ambiente de teste.

**Alternativas descartadas.**

- **Expor Redis externamente e compartilhar com produção.** Inseguro
  (Redis com auth fraca é vetor comum de ransomware) e contamina
  produção (ver acima).
- **Subir um Redis novo no project do backend separado.** Funciona, mas
  é overhead pra um ambiente que é só validação de UI/login. Reservado
  para o deploy real em VPS de cliente final.

**Impacto.**

- Cache 100% em memória → válido enquanto for 1 réplica do backend
  (que é o caso atual). Escalar pra 2+ réplicas exige Redis dedicado.
- SSE entrega eventos só para conexões na **mesma instância** do
  backend — também ok pra 1 réplica.
- Rate-limit por IP/user fica per-instance — fine pra teste.
- Em deploy de cliente final (VPS nova): criar Redis dedicado no mesmo
  project do backend e setar `REDIS_URL=redis://default:SENHA@{project}_{redis}:6379`
  e `SSE_ENABLE_REDIS_PUBSUB=1`.

### 2026-05-14 — Backend aponta para `db_crm` com `SKIP_PRISMA_MIGRATE=1`

**Decisão.** No ambiente de teste no Easypanel
(`banco-backend-crm.6tqx2r.easypanel.host`), o backend separado se conecta
**ao mesmo banco `db_crm`** que o monólito de produção (`crm.eduit.com.br`),
com `SKIP_PRISMA_MIGRATE=1` no entrypoint para evitar tentar aplicar a baseline
nova em um banco já populado.

**Contexto.** O `db_crm` em `187.127.27.39:5432` já tem schema multi-tenant
completo (71 tabelas, 60 migrations registradas) e dados reais de produção
(16 users, 3 organizations, 260 conversations, 915 messages). O backend
separado nasceu com a baseline `20240101000000_init` gerada via
`prisma migrate diff --from-empty`. Como `_prisma_migrations` do `db_crm`
não conhece essa baseline (e o reverso: o repo do backend não tem 2
migrations `20260429*_add_contact_ad_tracking` que existem no `db_crm`),
deixar o `prisma migrate deploy` rodar no boot quebra (tenta aplicar
baseline e dá `relation already exists`). O drift de schema é só
cosmético (índices/defaults) — todas as colunas que o `schema.prisma`
referencia existem no `db_crm`.

**Alternativas descartadas.**

- **Criar banco novo zerado e seed.** Perde os dados reais e os 16 users
  existentes — todos os testes contra produção e sessões ativas viriam abaixo.
- **Forçar drop + reaplicar baseline no `db_crm`.** Destrutivo demais para
  banco que ainda é usado pelo monólito em produção. Risco real de perder
  conversas e tickets ativos.
- **Reconciliar histórico de migrations.** Editar `_prisma_migrations` à mão
  pra alinhar com o repo é frágil e dificil de auditar; `SKIP_PRISMA_MIGRATE=1`
  é mais seguro até o cutover definitivo.

**Impacto.**

- Para qualquer deploy do backend separado contra o **mesmo banco do monólito**,
  setar `SKIP_PRISMA_MIGRATE=1` no env do Easypanel é obrigatório.
- Quando subir em VPS nova com banco zerado (cenário cliente final), **NÃO**
  setar `SKIP_PRISMA_MIGRATE`. O entrypoint vai aplicar a baseline + 58
  migrations subsequentes normalmente.
- Drift entre repo e `db_crm` precisa ser reconciliado antes do cutover
  definitivo: capturar as 2 migrations `add_contact_ad_tracking` do
  `db_crm` para o repo, gerar nova baseline, dropar o `_prisma_migrations`
  no `db_crm` e re-marcar tudo como aplicado (single-shot, em janela de
  manutenção).

### 2026-05-14 — Não listar `NEXTAUTH_URL` em `next.config.ts > env`

**Decisão.** O bloco `env: { NEXTAUTH_URL: ... }` foi removido do
`next.config.ts` do backend. `process.env.NEXTAUTH_URL` é lido em runtime
de verdade.

**Contexto.** Em Next.js, qualquer variável listada no `env` do
`next.config.ts` é **inlineada como string literal no bundle em build time**.
Para um backend que só serve API (sem `next-auth/react` no client), esse
inline não tem benefício e cria uma armadilha: o build do Easypanel
capturou `NEXTAUTH_URL=http://localhost:3000` (fallback) e ficou imune
a trocar a env no painel sem rebuild. Sintomas observados:

- Cookie de sessão emitido sem prefixo `__Secure-` e sem flag `Secure`,
  porque `useSecureCookies = nextAuthUrl.startsWith("https://")` viu o
  inlined `"http://..."` e calculou `false`.
- `Location` no 302 pós-login apontava para `http://localhost:3000`.
- Middleware Edge do frontend procurava `__Secure-authjs.session-token`
  e não achava → redirect infinito pra `/login`.

**Alternativas descartadas.**

- **Manter o bloco e setar `NEXTAUTH_URL` em build-args do Docker.** Fica
  refém de o build sempre rodar com o env correto, e qualquer rebuild com
  env errada (cenário Easypanel real) volta a quebrar silenciosamente.
- **Hardcoded em `auth.config.ts`.** Pior — vira release-blocker em cada
  ambiente diferente.

**Impacto.** Trocar `NEXTAUTH_URL` no painel agora exige apenas
**Restart** (não Rebuild). Cookie passa a sair com `__Secure-` + flag
`Secure` quando atrás de HTTPS, exatamente como o middleware Edge do
frontend espera ler via `getToken({ secureCookie: true })`.

---

### 2026-05-14 — Re-fork a partir do `main` multi-tenant (`pre-update-multitenant` → `multi-tenant`)

**Decisão.** Os repositórios `frontend_crm1` e `backend_crm1` foram **regenerados
a partir do zero** usando como fonte o `main` atual do monólito original
(`mfpi1209/crm`). O fork anterior (de `e78c979`, branch `split-frontend-backend`,
tag `pre-update-multitenant` em ambos os repos) era um snapshot **single-tenant**,
desatualizado em **248 commits** em relação ao `main` no momento da separação.

**Contexto.** A separação inicial (anterior a 2026-05-14) foi feita a partir de
`e78c979`, um ponto no monólito **antes** da implementação de multi-tenancy
(`Organization` + `OrganizationFeatureFlag` + `OrganizationSubscription` + RLS),
MFA, audit log, billing/Stripe, WhatsApp Flow Builder, AuthZ scope grants, e
~240 outros commits de evolução. Como o produto comercial precisa rodar em
multi-tenant (cada cliente = uma `Organization`), continuar evoluindo o fork
single-tenant era inviável.

Repos antes do re-fork (tagueados como `pre-update-multitenant`):
- `backend_crm1@5ed72ce` — single-tenant baseline gerada em 2026-05-14.
- `frontend_crm1@3b8a940` — Dockerfile inicial.

**Alternativas descartadas.**

- **Merge `main` na `split-frontend-backend` do monólito.** Rebase de 248
  commits em cima de um fork que **já removeu** partes do código geraria
  conflito em centenas de arquivos. Cada commit do main toca paths que o
  fork não tem mais (ou tem em outra forma), exigindo resolução manual
  arquivo por arquivo. Custo alto, risco de regressão silenciosa.

- **Continuar evoluindo o fork single-tenant.** Tecnicamente possível, mas
  significa reescrever toda a multi-tenancy de novo dentro do fork — duplicação
  de trabalho e provável divergência permanente do produto principal. O custo
  de oportunidade é o de NÃO ter os features que já existem no main (MFA,
  audit, billing, etc.).

- **Manter o monólito como single-source e fazer separação via reverse-proxy.**
  Não atende ao requisito de deploy independente em VPS diferentes para futuros
  clientes. O usuário definiu que o produto final será multi-VPS.

**Procedimento (idempotente; ver `fork-strategy.mjs` na raiz do workspace).**

1. **Salvaguardas.** Tags `pre-update-multitenant` push'adas em
   `backend_crm1` e `frontend_crm1`. Tag `pre-split-redo-2026-05-14` local no
   monólito (na branch `split-frontend-backend` em `e78c979`).
2. **Atualização do monólito local.** `git checkout main && git pull` para
   trazer todos os 248 commits.
3. **Wipe controlado.** Em cada repo destino, todo conteúdo é apagado
   **exceto** os arquivos exclusivos da separação (Dockerfile,
   `docker-entrypoint.sh`, `.env.example`, `package.json`, scripts de
   manutenção, `src/lib/api.ts`, `src/lib/auth-public.ts`, etc.). A lista
   completa fica no array `PRESERVE` do `fork-strategy.mjs`.
4. **Copy whitelist.** Apenas os paths classificados como "backend" (ou
   "frontend") são copiados do monólito atualizado. Lista no array
   `COPY_FROM_MONOLITH`.
5. **Limpeza no frontend.** Após copiar `src/lib/`, arquivos `server-only`
   (`prisma.ts`, `queue.ts`, `auth.ts`, `audit/`, `billing/`, etc.) são
   removidos do frontend (lista em `FRONTEND_LIB_BLACKLIST`).
6. **`patch-api-urls.mjs`.** Roda no frontend para transformar
   `fetch("/api/...")` em `fetch(apiUrl("/api/..."))`, garantindo que as
   chamadas client-side cheguem ao backend mesmo quando ele está em outro
   host (configurável via `NEXT_PUBLIC_API_BASE_URL`).
7. **Baseline multi-tenant.** `prisma/migrations/20240101000000_init/`
   regerada via `prisma migrate diff --from-empty --to-schema-datamodel`
   (70 tabelas, 33 enums, ~250 índices — vs 53 tabelas / 27 enums da
   versão single-tenant).
8. **Banco staging.** Schema `public` dropado e recriado; baseline
   aplicada; as 58 migrations posteriores marcadas como aplicadas
   (`resolve --applied`).

**Impacto.**

1. `frontend_crm1` e `backend_crm1` passam a ser **os únicos repositórios
   ativos** do produto. O monólito `mfpi1209/crm` torna-se referência
   histórica apenas (read-only, sem deploy).
2. Qualquer cliente novo daqui pra frente sobe os dois containers (front
   + back) em um Easypanel próprio + banco próprio, criando sua
   `Organization` via wizard de signup público.
3. Banco staging atual (`banco@187.127.27.39`) foi recriado do zero com
   schema multi-tenant. **Contas anteriores foram perdidas no staging**
   (eram fixtures de teste, sem dados reais). A produção
   `crm.eduit.com.br` continua intocada — roda no monólito original.
4. Próximos features são desenvolvidos diretamente em `backend_crm1` ou
   `frontend_crm1`, sem voltar pro monólito.

---

### 2026-05-14 — Migration de baseline (`20240101000000_init`) [DEPRECADO — substituída pela versão multi-tenant]

**(Entrada original sobre a baseline single-tenant gerada no início do dia. Mantida
para referência histórica. A baseline atual em `prisma/migrations/` é a
multi-tenant gerada após o re-fork.)**

Decisão original: adicionada a migration `20240101000000_init/migration.sql`
para destravar `P3009` em bancos novos vazios. A versão single-tenant tinha
27 enums + 53 tabelas. A nova versão multi-tenant (após re-fork) tem 33 enums
+ 70 tabelas. Scripts utilitários (`scripts/clean-failed-migrations.mjs`,
`scripts/resolve-post-baseline.mjs`, etc.) continuam válidos e ficam mantidos
para recuperar futuros bancos que caiam em P3009.

### 2026-08-08 — Seleção de canal em nodes de mensagem da automação

**Modelo usado.** Cursor Grok 4.5.

**Decisão.** Nodes de mensagem (WA texto/mídia/lista/botões/template/produto + e-mail) passam a ter config.channelId opcional com herança: o primeiro node de mensagem do fluxo exige canal quando a org tem 2+ canais CONNECTED; os seguintes herdam (vazio = último canal do caminho) e podem override. UI: kebab no canvas + seletor no painel, ocultos se ≤1 canal conectado. Runtime grava Message.channelId e mantém o mesmo negócio; troca de canal aparece no divisor timeline "via {canal}". Save/ativar bloqueia sem canal no 1º node (quando multi-canal). Lista só canais CONNECTED. Escopo: todas as orgs; desenvolver na DEV_BRANCH.

**Contexto.** Orgs com múltiplos números WhatsApp (ex. Cruzeiro EAD: Acadêmico + CSV Atendimento) precisam escolher por qual canal a automação envia, sem abrir outro negócio.

**Alternativas descartadas.** Gravar channelId em todo node (ruidoso); substituir senderName/automação pelo nome do canal na bolha (quebra marca "Temas Transversais"); abrir novo negócio ao trocar canal.

**Impacto.** Frontend builder + utomation-executor + validação em update/toggle. Template já tinha channelId — unificado com o restante. ConnectionDivider existente passa a receber channelId das mensagens de automação.


### 2026-08-08 - Nodes de automacao "Ganho" e "Perda"

**Decisao.** Dois novos steps de acao: `mark_deal_won` (config `{ pipelineId, pipelineName? }`) e `mark_deal_lost` (config `{ pipelineId, pipelineName?, lostReason }`). Em runtime, resolvem o dealId como `move_stage` (rt.dealId -> cfg.dealId -> deal OPEN do contato, com `continueIfNoDeal` opcional) e chamam `markDealWon`/`markDealLost` com `opts.pipelineId` explicito - sem depender do pipeline ATUAL do deal, permitindo fechar num funil diferente do que o deal esta hoje. `markDealLost` em modo automacao valida o motivo so contra o catalogo do pipeline informado (`assertLostReasonAllowedForPipeline(pipelineId, reason, false)`), sem opcao "Outro". Sem migracao - reusa `Deal.lostReason` e `Stage.isWon/isLost`.

**Contexto.** Faltava fechar negocio (ganho/perdido) direto de um fluxo de automacao - so existia `move_stage` generico, que nao teria de onde tirar o motivo da perda nem qual pipeline usar quando o deal ja mudou de funil.

**Alternativas descartadas.** Reaproveitar `move_stage` puro com stageId fixo (perderia a validacao de motivo por pipeline e o disparo correto de `deal_won`/`deal_lost`); motivo de perda livre (foge do padrao "catalogo por pipeline" ja usado no kanban).

**Impacto.** `services/deals.ts` (`buildTerminalStageMovePatch` e `markDealWon`/`markDealLost` ganham `opts.pipelineId` opcional - callers existentes sem opts continuam iguais), `services/automation-executor.ts` (2 novos cases + `STEP_TYPE_LABELS`), `lib/automation-workflow.ts` (ACTION_STEP_TYPES/labels/default/summary/isStepIncomplete). Nao confundir com os triggers `deal_won`/`deal_lost` (permanecem gatilhos, inalterados).
