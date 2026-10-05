# AGENTS — backend CRM EduIT

Playbook deste repo. **Este repositório é a fonte de verdade.** UI: `frontend_crm1` (`:3000`). Este repo é API + Prisma + workers (`:3001`). Mudou uma regra → atualize este arquivo.

Histórico de decisões técnicas: `docs/history/backend-decisions.md` (arquivado — consulte manualmente só quando precisar de contexto histórico; não é contexto cotidiano).

## Comportamento do Agent

- Faça a menor alteração necessária para cumprir cada tarefa.
- Comece pelos arquivos diretamente relacionados ao pedido.
- Não faça auditoria ampla do repositório sem necessidade.
- Não leia históricos apenas para obter contexto adicional.
- Não investigue subsistemas não relacionados à tarefa.
- Não expanda o escopo por conta própria.
- Não faça refatorações amplas sem solicitação.
- Não crie documentação adicional sem solicitação.
- Não abra navegador para validar alterações salvo quando solicitado explicitamente.
- Não use Browser, Computer Use ou screenshots salvo quando solicitado explicitamente.
- Para tarefas de backend, priorize leitura direcionada do código e validações diretamente relacionadas ao que foi alterado.
- Não tente validar visualmente mudanças de backend.
- Não registre automaticamente cada alteração realizada em arquivos de documentação histórica.

## Antes de código

1. Contrato HTTP muda **aqui primeiro**. Frontend só consome.
2. Handler: `requireAuth()` + `requirePermission(user, "recurso:acao")`.
3. Banco: `prisma` de `@/lib/prisma` (injeta `organizationId`). Sem contexto → throw. `prismaBase` só webhook sem org, seed, admin, script — com comentário. `mergeWhere` preserva o where original e AND com a org da sessão (divergente → vazio); write com `organizationId` divergente lança `TenantIsolationError`.
4. Permission nova: entrar em `src/lib/authz/permissions.ts` **antes** de `can()`.
5. Trabalho pesado (Meta, mídia, campanha, CSV, automação) → BullMQ. HTTP valida, persiste, enfileira.
6. Não expanda o escopo com refatorações, documentação adicional ou criação de novos testes sem solicitação. Faça a menor alteração necessária. Quando código for alterado, execute apenas validações técnicas diretamente relacionadas à mudança. Plano curto se >3 arquivos.

## Nunca

- Inventar model `Lead` (é Deal) ou `Group` (stub; filial = `OrgUnit`).
- Recriar deal no inbound se o contato já tem WON/LOST, ou se o mesmo telefone (com ou sem o 9) já tem deal em outro contato (`findExistingContactOnPhone` em `src/services/auto-deals.ts`). A busca é pelo deal, sem teto de contatos.
- Encerrar conversa ao mover etapa (`moveDeal`).
- Encerrar conversa (`RESOLVED`) sem devolver deal do funil Atendimento à origem acadêmica — inbox, lote, automação e IA passam por `restoreDealToAcademicOrigin`.
- Processar webhook Meta / send Graph / parse XLSX no `route.ts`.
- Renomear permission (deprecar + chave nova).
- `ENABLE RLS` não está em prod — não remova a extension Prisma “porque tem RLS”.
- `Channel.pipelineId` / `search_text` — ADRs, **não implementados**.
- Migrate no worker. Só `APP_MODE=api` migra no boot (e só com `RUN_MIGRATIONS_ON_BOOT` ligado). Falha de migration aborta o boot — não reintroduzir reexecução de `migration.sql` no entrypoint (`docs/deploy-seguro.md`).

## Handler

```ts
export async function GET() {
 const r = await requireAuth();
 if (!r.ok) return r.response;
 const denied = await requirePermission(r.session.user, "deal:view");
 if (denied) return denied;
 // RequestContext ativo. Use prisma (scoped).
}
```

Erro: `{ message: string }` (403 de authz também manda `required`). Middleware de `/api/*` devolve JSON, nunca HTML redirect.

ID na URL: CUID **ou** número por org (`src/lib/public-id.ts`, `idOrNumberWhere`). Não assumir CUID.

Mutou Role/assignment → `invalidateAuthzForOrg` / `invalidateAuthzForUser`.

Job de worker: payload com `organizationId` + `runWithContext` antes de `prisma`. Ator `AUTOMATION` | `SYSTEM` | `AI` | `INTEGRATION`.

## Onde está a verdade

| Assunto | Arquivo |
|---------|---------|
| Permissions | `src/lib/authz/permissions.ts` |
| `can` / cache | `src/lib/authz/index.ts` |
| Auth HTTP | `src/lib/auth-helpers.ts` |
| Prisma tenant | `src/lib/prisma.ts` |
| Contexto | `src/lib/request-context.ts` |
| IDs numéricos | `src/lib/public-id.ts` |
| Filas | `src/lib/queue.ts` |
| Inbox acesso | `src/lib/conversation-access.ts` |
| Auto-deal | `src/services/auto-deals.ts` |
| Move de card | `src/services/deals.ts` → `moveDeal` |
| Tenant | `docs/tenant-subdomain.md` |
| Grupos WhatsApp QR | `src/services/whatsapp-groups.ts` (model `WhatsAppGroup`, não o stub `Group`) |
| Envio produto WhatsApp | `products.whatsappSendMode` em `OrganizationSetting` + `src/lib/product-whatsapp-send-mode.ts` |
| Vínculo produto Meta | model `ProductMetaLink` (`product_meta_links`) — **não** reutilizar `Product.catalogId` |
| Versão Graph API | `src/lib/meta-graph-version.ts` (`META_GRAPH_API_VERSION`, default `v21.0`) |

## Filas (`APP_MODE`)

| Fila | Worker |
|------|--------|
| `meta-webhook-events` | `worker-meta-webhook` |
| `meta-outbound` / `meta-attach` | `worker-whatsapp` |
| `automation-jobs` | `worker-automation` (`depth` anti-loop) |
| `campaign-dispatch` / `campaign-send` | `worker-campaigns` |
| `leads-bulk` | `worker-leads` (deals/conversas, não model Lead) |
| `import-etl` | `worker-etl` |
| `distribution-drain` / `distribution-execute` | `worker-distribution` |
| `baileys-control` / `baileys-outbound` | `worker-baileys` (WhatsApp QR; não é Meta Cloud API) |

API pública (n8n): `APP_MODE=api-public`, Bearer `eduit_…`. Não misturar com cookie de sessão.

## Produção (não quebrar)

- Health: `/api/health`. Métricas: `/api/metrics`.
- Inbox “mudo”: worker Meta + Redis + SSE (CORS/cookie). Não “consertar” no frontend primeiro.
- Pool de DB por processo. Não apontar todos os workers para o pool da API.
- Rate limit de sessão existe — debounce no FE; não desligar o limiter.
- Super-admin (`isSuperAdmin`) é o único sem `organizationId`.
- Migration em produção o operador roda no diretório do backend, depois que o código (pasta `prisma/migrations`) já está na máquina. Não usar `migrate dev` nem `npx prisma` daí. Comando:

```bash
node /opt/prisma-cli/node_modules/prisma/build/index.js migrate deploy --schema=prisma/schema.prisma
```

  Só aplica o que ainda não entrou em `_prisma_migrations`. Agent não executa isso no servidor de produção; avisa o operador quando a mudança inclui SQL novo.

## Atendimento IA — contrato

O motor sabe COMO atender; a configuração do tenant diz O QUE atender. Regra de negócio não entra em código, e garantia de atendimento não depende de o cliente ter escrito bem o prompt.

Ciclo de todo atendimento, igual em qualquer tenant: **identificar** (uma vez por conversa, pelos campos-chave configurados — identificação é insumo, não pedágio) → **entender** o assunto (assunto é do atendimento, não da frase: repetir o pedido não cria assunto novo) → **tentar resolver** com o que o operador ligou (prompt, RAG, tools) → **encaminhar** uma vez por assunto, com contexto, para quem resolve (IA ou fila humana).

Garantias do motor (não são configuráveis — o cliente não precisa escrever no prompt):

- Toda mensagem do cliente recebe resposta. Turno não termina sem saída (`inbox-handler.ts`, follow-up de fila).
- A identificação é da conversa, não do agente (`Conversation.aiIdentified*`). Quem recebe não pergunta de novo.
- Ninguém devolve a conversa para um agente que já atendeu este assunto (`conversationPeerHistory`).
- Sem destino IA válido, vai para a fila humana. Não existe terceira saída chamada silêncio.
- Agente que recebe transferência no meio do atendimento não se reapresenta.
- Não afirmar efeito que não aconteceu (guardrail de efeito) e não repetir a mesma frase (trava de eco).
- Todo atendimento termina com desfecho: resolvido, na fila humana, ou encerrado pelo cliente.

Pilotado pelo cliente: prompt/tom/abertura de cada agente, `routingScope` (é por ele que o roteamento decide), RAG e `steeringRules`, tools ligadas e campos que elas leem, campos-chave de identificação e de desempate, fila humana (departamentos, horário, termos que contam como pedido de humano, mensagens padrão).

Medição por conversa: `node dist/workers/audit-attendance.js --org <slug>`.

## Conceitos

- `Organization` = tenant · `OrgUnit` = filial/CNPJ · `Company` = cliente B2B · `Group` = não usar.
- Deal não tem `pipelineId`; funil vem do `Stage`.
- “Lead” no jargão = Deal.
- Inbound cai no pipeline `isDefault` (canal → funil ainda não existe).
- Encerrar ticket (humano ou IA) tira o card de Em Atendimento e devolve ao funil acadêmico.

## Decisões técnicas

- 2026-10-05 — Grok 4.7 — **Anexo em nota interna**: `POST /api/conversations/:id/attachments` com `asNote=1` grava o arquivo no storage da org e cria mensagem `isPrivate` (o tipo segue a mídia) sem canal, sem reabrir ticket e sem janela de 24h. O texto vai na legenda; documento guarda `texto` + `📎 nome`. A tabela `Note` recebe só o texto, como a nota sem arquivo.
- 2026-10-05 — Grok 4.7 — **Distribuição ligada só no bloco e na ferramenta**: `executeDistribution` com origem `SYSTEM` não atribui. Com `distribution.enabled=true`, atribuem o bloco `execute_distribution` da automação, a ferramenta homônima do agente de IA (só se estiver em `enabledTools`) e a redistribuição manual. A drenagem só completa essa fila. Conversa nova sem esse pedido não entra, mesmo com `distribution.autoOnInbound=true`. Desligado, ninguém é atribuído.
- 2026-10-05 — Grok 4.7 — **Favorito do Bwipo Keeps**: `KeepNote.favorite` (por usuário, a nota já é pessoal). A estrela fica no card. `GET /api/keeps?folder=notes&favorite=1` lista só as marcadas. No "/" da conversa, a busca `keeps` ou `keep` mostra só esses favoritos e insere o texto da nota. Não entra em `agent_message_shortcuts`.
- 2026-10-03 — Claude Opus 5.5 — **Lista do inbox pela última mensagem**: `conversations.lastMessageAt` = última mensagem de CHAT (recorte da prévia do card, `src/lib/conversation-last-message.ts`: pública, `in`/`out`, fora nota/`ai_draft`/ligação WhatsApp/`event*`). Quem cria mensagem de chat grava a coluna no `conversation.update` que já existe (`...lastMessageAtData(saved)`); sem update, `touchConversationLastMessageAt` (só avança); inbound vai no `touchInbound` (GREATEST). Ler/atribuir/encerrar não mexe. A lista ordena e pagina por `COALESCE("lastMessageAt", "updatedAt") DESC, id DESC` (índices de expressão da migration `20261003150000`; mudar a expressão desliga o índice). Cursor v2; v1 aceito por uma versão. Em modo cursor `total` é real ou `null` e `page` é `null`. Backfill: `scripts/backfill-conversations-last-message-at.mjs`.
- 2026-10-02 — Cursor Grok 4.7 — **Informação rastreada no `PUT /api/contacts/:id`**: os mesmos 17 campos do painel (UTM/click ID + `adCtwaClid`, `adHeadline`, `adResolvedId`, `adSourceId`) podem ser atualizados. Ausente, null ou string em branco não apaga. Valor preenchido substitui. O node n8n manda isso na coleção `trackedInfo` de Contact → Update.
- 2026-10-02 — Cursor Grok 4.7 — **Tipo da Inteligente fora do org-wide**: responsável com `type` (ex.: Acolhimento) não entra no sorteio de lead sem departamento. Só recebe quando o tipo pedido é o dela ou o lead já está no departamento dela (`inDepartment`). Cruzeiro EaD: Danubia/Marilia pegavam ticket de SAC porque a conversa ainda não tinha departamento e o pool era a org inteira.
- 2026-10-02 — Cursor Grok 4.7 — **Informação rastreada no `POST /api/leads`**: o contato do lead aceita os 13 campos de UTM/click ID e os 4 do bloco Meta (`adCtwaClid`, `adHeadline`, `adResolvedId` = ad_id, `adSourceId`). Ausente, null ou string em branco não grava e não apaga. Com `fillEmptyContactFieldsOnly`, campo que já tem texto no contato fica como está. O node n8n manda isso em `trackedInfo` nas duas operações de Deal + Contact.
- 2026-10-01 — Grok 4.7 — **Sem widget, sem distribuição**: `maybeDistributeNewInboundTicket` sai na hora se `smart_distribution` não está instalado. Não reavalia elegibilidade, não zera responsável, não chama 1º atendimento nem enfileira. O gate que já existia em `executeDistribution` ficava depois dessa limpeza. Agente de IA desligado (`active=false`, nenhum AUTONOMOUS) também não tira o humano: `tryAssignFirstAttendanceAi` só limpa o dono herdado quando há agente para assumir.
- 2026-10-01 — Grok 4.7 — **Grade curricular do curso**: `CourseConfig.gradeUrl` (+ nome e mime). HTTPS ou arquivo no storage. Variável `{{grade}}` na mensagem do produto. O encaminhamento anexa o arquivo depois do texto. Upload de automação também aceita DOC/DOCX/XLS/XLSX/PPT/PPTX/TXT/CSV (o zip solto continua recusado).
- 2026-10-01 — Grok 4.7 — **Mídia dinâmica no `send_whatsapp_template`**: `config.headerMediaUrl` com `{{...}}` é resolvido por contato (`interpolateMessageVariables`, o mesmo root da campanha) antes de `injectTemplateHeaderMediaComponent`. URL fixa e upload interno não passam por isso. O arquivo de exemplo da criação do template continua só `header_handle` da Meta.
- 2026-10-01 — Cursor Grok 4.7 — **Duplicata de negócio no funil**: `Pipeline.allowDuplicateDeals` (default `true`). Desligado, o funil guarda um deal OPEN comercial por contato. Criação (API, automação `create_deal`, import) reaproveita o card mais à frente. Ao desligar, os abertos repetidos daquele funil são unidos nesse card (notas, tarefas, produtos e histórico vão junto). A opção fica em `/settings/pipeline`. Não é trava de uma org.
- 2026-10-01 — Cursor Grok 4.7 — **autoOnInbound desligado não distribui**: `distribution.autoOnInbound=false` volta a valer no inbound e na drenagem. Sem passo `execute_distribution` (ou IA / redistribuição manual) o motor não atribui. A leitura dos dois toggles (`distribution.enabled` e `distribution.autoOnInbound`) é direta no banco, sem o cache de 60s. Com o kill switch `distribution.enabled=false`, nem o passo da automação atribui.
- 2026-10-01 — Claude Fable 5.1 — **Ping de presença com gravação limitada**: `/api/agents/me/ping` grava `system_usage_sessions` no máximo 1x por usuário a cada 45 s (`recordHeartbeatThrottled`: `SET cache:presence:ping:<userId> 1 NX EX 45` via `cache.tryClaim`); os demais pings respondem 200 sem tocar no banco. Seguro porque o offline só vem depois de `SYSTEM_PRESENCE_STALE_MS` = 300 s (regra: limite ≥ 90 s → 45 s; abaixo disso, metade do limite). Sem Redis o claim cai no mapa em memória do processo (cada processo grava ao menos 1x por janela). Falha de gravação solta o claim.
- 2026-10-01 — Claude Fable 5.1 — **Consumidor de `CONVERSATION_CLOSED`**: o encerramento humano grava esse tipo na `activity_outbox` desde 17/09 e nada consumia (`startActivityOutboxWorker` nunca teve chamador; o projetor de tabulação filtra o outro tipo). `startConversationClosedOutboxProjector` roda no `worker-whatsapp` ao lado do projetor de tabulação: filtro `payload->>type = CONVERSATION_CLOSED` (os dois nunca pegam a mesma linha), `FOR UPDATE SKIP LOCKED` dentro da transação, checagem de idempotência antes do INSERT, `occurredAt` = `createdAt` da outbox, sem espelho no chat. `ACTIVITY_OUTBOX_WORKER=0` desliga (padrão ligado; em produção só com `activity_events_org_idem_idx` presente); `ACTIVITY_OUTBOX_WORKER_BATCH` (100) e `ACTIVITY_OUTBOX_WORKER_INTERVAL_MS` (5000). Ao ligar, a fila acumulada entra em `activity_events` com a data original. O loop genérico `pollAndProjectActivityOutbox` continua sem uso — não ligar (pega todos os tipos, lock fora de transação, `occurredAt` = agora).
- 2026-10-01 — Claude Fable 5.1 — **Índice de idempotência de `activity_events`**: `activity_events_org_idem_idx`, parcial em (`organizationId`, `idempotencyKey`) `WHERE idempotencyKey IS NOT NULL`, é o índice da checagem que a projeção da outbox faz antes de cada INSERT. Produção já tinha (criado à mão, `ON ONLY` + `CONCURRENTLY` por partição); a migration `20261001150000_activity_events_org_idem_idx` só cria onde falta — se o nome já existe ela consulta o catálogo e sai sem pegar lock na tabela. Não é UNIQUE (tabela particionada por `occurredAt`); o `@@unique` do schema não existe no banco.
- 2026-10-01 — Claude Fable 5.1 — **"digitando…" do contato (Baileys)**: o worker assina a presença do JID só quando uma mensagem trafega numa conversa `OPEN` (recebida, ou enviada pelo CRM em ticket onde o contato já escreveu) — nunca em massa na conexão/reconexão. TTL 10 min, teto de 50 JIDs vivos e 10 assinaturas/min por sessão (`BAILEYS_CONTACT_TYPING_*`); `BAILEYS_CONTACT_TYPING=0` desliga tudo. `composing`/`recording` vira `typing` com `source: "contact"` (só ids, `userName` nulo), sem consulta ao banco por evento. Política em `src/workers/baileys/contact-typing.ts`. Meta Cloud API não publica typing de contato.
- 2026-09-30 — Cursor Grok 4.7 — **Mensagem recebida na etapa**: o gatilho usa o deal que está na etapa configurada (`stageIds`), não o negócio aberto mais novo do contato. Se houver mais de um card nessa etapa, o `move_stage` move todos. "Sim"/ack não cancela esse gatilho; fluxo sem filtro de etapa continua sem disparar em ack.
- 2026-10-02 — Cursor Grok 4.7 — **Campo vazio não apaga**: PUT de custom field (deal e contato) e `update_field` da automação ignoram valor em branco quando o campo já tem texto. O Flow já pulava resposta vazia; o apagamento vinha do salvamento mandando `""` por cima (Polo, Nro. da Inscrição, CPF, RGM).
- 2026-09-30 — Cursor Grok 4.7 — **Flow não fala com o cliente**: resposta de WhatsApp Flow com telefone ou e-mail inválido não grava o campo e não envia mensagem na conversa. O aviso "Assistente CRM" ("Não consegui salvar…", tentativa 1/2) saiu de `applyWhatsappFlowResponseToContact`.
- 2026-09-28 — Cursor Grok 4.7 — **Mensagem padrão ao encaminhar produto**: `ProductMessageTemplate` por org (`kind` + `courseLevel` null = qualquer nível). Texto com `{{variavel}}`. Resolução: modelo ativo do nível do curso, senão o do tipo sem nível, senão o texto atual do frontend. `GET /api/products/:id/message` renderiza. Permissões `product:view` / `product:edit`. Sem alterar o envio nativo Meta.
- 2026-09-23 — Cursor Grok 4.7 — **Campos para entrar na etapa**: `Stage.requiredDealFieldIds` (só `CustomField` entity=deal). `moveDeal`, lote e automação `move_stage` recusam a troca com `STAGE_FIELDS_REQUIRED` enquanto algum desses campos estiver vazio. Reordenar na mesma etapa não exige. `PUT /api/pipelines/:id/stages/:stageId` grava a lista.
- 2026-09-23 — Cursor Grok 4.7 — **Visibilidade de funil por papel**: `RolePipelineGrant` (`canView=false`) bloqueia o funil; `RoleStageGrant` com `canView=false` e `canEdit=false` bloqueia a etapa. Sem linhas = vê tudo (roles atuais não mudam). Allow-list legado (só grants positivos) continua valendo. União entre papéis: o mais permissivo vence. ADMIN ignora. Enforcement em listagens (pipelines, board/Flow, deals, inbox, dashboard, busca), GET direto, lote e SSE — fora da flag `rbac_granular_scope_v1`.
- 2026-09-23 — Cursor Grok 4.7 — **Dashboard de tabulação**: o encerramento humano grava `CONVERSATION_TABULATED` na `activity_outbox` e o dashboard lê `activity_events`. O projetor (`startTabulationOutboxProjector`, timer no `worker-whatsapp` junto dos outros sweepers) copia só esse tipo, com `occurredAt` = `createdAt` da outbox, sem espelhar no chat e sem projetar `CONVERSATION_CLOSED`. `actorUserId` novo vai no payload. Na fila antiga, o id sai de `deal_events` `CONVERSATION_CLOSED` (mesma conversa, janela −2/+5 min) e, se não houver, do `ASSIGNEE_CHANGED` em `activity_events` (±2 min).
- 2026-09-22 — Cursor Grok 4.7 — **Colunas de ActivityEvent**: `sourceIsReconstructed` (e as dimensões `pipelineId`/`fromStageId`/`toStageId`/`tabulationId`/`departmentId`/`channel`/`source`/`triggeredByUserId`) estavam no schema desde 1077c3dc sem migration — `migrate deploy` não tinha pendência e o INSERT do log falhava com 42703. Migration `20260922180000_activity_events_dimension_columns` faz `ADD COLUMN IF NOT EXISTS` no pai particionado. Sem índice/FK em `triggeredByUserId` (lock no boot). `idempotencyKey` já estava em `20260917190000_activity_outbox`.
- 2026-09-22 — Cursor Grok 4.7 — **Ativação perdidos (DNAWORK)**: envio de automação não grava template em conversa `RESOLVED` — abre ticket novo e o `wait_for_reply` aponta para ele. Timeout não aborta com `already_resolved` se `closedAt` é anterior à pausa (o ramo "Não responde" marca o deal). Inbound só cancela a espera se o consultor falou depois da pausa; `hasHumanReply` do ciclo anterior não descarta a resposta.
- 2026-09-22 — Cursor Grok 4.7 — **Teto de fila da Inteligente voltou**: `queueCount >= queueLimit` marca `QUEUE_LIMIT_REACHED` e tira da elegibilidade (`eligibility.ts`). `0` = não recebe. O sorteio continua por peso (`volume`); a carga só barra quem estourou o teto. Drenagem da espera (`consultantHasFreeSlot`, `liveFreeCapacityForUser`) para no limite. Quem já é dono não perde o card só por fila cheia. Modo Por Leads segue sem esse teto.
- 2026-09-22 — Cursor Grok 4.6 — **inicio-pipe duplicado**: `processIncomingMessage` não consome inbound enquanto `send_whatsapp_message` está in-flight (`timeoutAt` null). Esse ponteiro é o 1º passo do `ensureExecutionContext`, não uma espera; tratar como “question sem botões” reenviava o menu no mesmo ticket (`conversation_created` + `continueFromStep`). Espera real de texto continua só com timer.
- 2026-09-22 — Cursor Grok 4.6 — **Fase 3 arquivos/mídias**: proxy Meta só com URL ligada à org (mensagem/avatar) e token do canal; `Cache-Control: private, no-store`. Transcribe/mp3 usam `fetchAuthorizedAudioBuffer` (allowlist Meta, storage com ACL, uploads legado com dono). GET `/api/storage` restringe `keeps`/`data-exports`/`imports`/anexo de sala privada; inbox por org. Tetos: 16 MB processo, 50 MB proxy, 64 MB gravação. Capa de produto e `reHostRecording` passam por `assertSafeOutboundUrl` + `redirect: error`. Sem política nova por consultor.
- 2026-09-22 — Cursor Grok 4.6 — **XSS (logo / HTML 404 / TipTap / widgets / IG OAuth)**: `updateBranding` só grava `logoUrl` via `normalizeOrganizationLogoUrl` (storage `branding` raster da org, https sem SVG/HTML, ou o valor já persistido). Upload continua em `POST /api/organization/logo` (magic bytes, sem SVG; primeiro admin do onboarding é `UserRole.ADMIN` e passa em `requireManager`). Sem migração de logos antigos. HTML de e-mail permanece em iframe `sandbox` sem `allow-scripts`. Iframe de widget parceiro pode ter `allow-scripts`+`allow-same-origin` só com `iframeUrl` http(s) fora do tenant/API. Listener Instagram exige `event.source === popup` e origin da página ou da API. CSP enforcing **não** entra nesta etapa.
- 2026-09-22 — Cursor Grok 4.6 — **Team-chat SSE Fase 2**: `team_chat_*` só entrega a `audienceUserIds` resolvido no publisher pela membership real da sala (`loadRoomMemberUserIds`); `memberIds` no payload permanece contrato FE e não autoriza. Sem audiência → fail-closed. `isSuperAdmin` não bypassa sala privada (continua vendo atendimento por org). `leaveRoom`/`deleteRoom` usam `extraAudience` no aviso; conteúdo posterior não inclui o removido. `revokeUser` entrega `sse_access_revoked`, remove listeners locais e publica no Redis. Work item sem `roomId`: o publisher resolve a sala pela origem (`room` / mensagem / reunião); se ainda não houver sala, `extraAudience` = criador + participantes + assignees — nunca a org inteira. Sem política nova de visibilidade de inbox.
- 2026-09-22 — Cursor Grok 4.6 — **Isolamento tenant Fase 1**: `mergeWhere` AND externo com a org autenticada (não substitui filtro divergente). `Call`/`CallEvent`/`SipExtension`/`CallProviderConfig`/`DiscountCategory`/`AgentPermission` entram em `SCOPED_MODELS`. Write com org divergente lança. Upsert com @@unique composto de outra org lança. `webhookToken` só no detalhe/create com `sip_extension:manage`. `effective-permissions` usa `userOrgFilter` + `agentPermissionWhere` (org do alvo). Sem ENABLE RLS.
- 2026-09-19 — Cursor Grok 4.6 — **Catálogo Meta/WhatsApp (fase 1)**: modo de envio é da org (`products.whatsappSendMode`, default `normal` se a chave não existir). Vínculo Bwipo↔Meta vive em `ProductMetaLink` (channel + `metaCatalogId` + `productRetailerId`), separado do `Catalog` interno. Detecção: `GET /{WABA}/product_catalogs` com o token do Channel já conectado. Publicação individual: `POST /api/products/:id/meta-link` cria/atualiza o item no catálogo Commerce (nome, preço, imagem https) e grava o vínculo; sem sync em massa. Envio nativo só em `POST /api/conversations/:id/products` (um card nativo por produto; sem `product_list` — a Meta costumava entregar só 1 item). Sem vínculo/permissão faz fallback para o envio atual (attachments/texto) sem bloquear o atendimento. `MetaWhatsAppClient` ganhou `sendCatalogProduct` / `sendCatalogProductList` / `listProductCatalogs` / `createCatalogProduct` sem alterar sendImage/sendText.
- 2026-09-17 — Cursor Grok 4.6 — **Falar na hora após transferência IA→IA**: `inboxPolicy.speakOnAiTransfer` (aba Inbox do destino). Ligado: depois do aviso, envia a mensagem de abertura da Pilotagem do destino. Desligado = espera o próximo inbound. Sem `openingMessage`, o interruptor não envia nada.
- 2026-09-17 — Cursor Grok 4.6 — **Pacote de primeiro acesso no CRM**: `inboxPolicy.firstAccessPackMessage` (aba Inbox). O intercepto envia esse texto literal; vazio = pack de fábrica. Interceptos de primeiro acesso / disciplinas / oi não reassumem conversa já com humano.
- 2026-09-17 — Cursor Grok 4.6 — **Capa de produto externa no encaminhar**: `POST .../attachments` JSON `reuseUrl` continua só storage da org. Se a URL não é storage mas é exatamente `Product.imageUrl` da mesma org (https público), a API baixa, grava em `automation-media` e atualiza o catálogo — depois segue send-by-reference. Não abre reuse para URL arbitrária.
- 2026-09-17 — Cursor Grok 4.6 — **KeepCategory** (modo Categorias): model `keep_categories` + `KeepNote.categoryId`. CRUD em `/api/keeps/categories`. Cor obrigatória na paleta exclusiva de categoria; notas herdam a cor. Models Keep* entram em `SCOPED_MODELS`.
- 2026-09-14 — Cursor Grok 4.6 — **KeepNote.color**: paleta nomeada (`coral`…`blossom`), `null` = padrão. `PATCH` aceita `color`; `GET /api/keeps?color=` filtra (repetir o param; `none` = sem cor). Resposta inclui `usedColors` + `hasUncolored` para o Filtrar só mostrar cores em uso.
- 2026-09-14 — Cursor Grok 4.6 — **Modelo interno: passo só de texto**: `MessageTemplate.attachments[]` aceita item sem `url` com `messageBefore` (texto extra na sequência, sem arquivo). Arquivo novo entra depois do último texto. Teto: 5 arquivos (`MAX_TEMPLATE_ATTACHMENTS`) e 10 passos no array (`MAX_TEMPLATE_SEQUENCE_ITEMS`). `mediaUrl` espelha o primeiro item **com** url. Envio: `content` → para cada passo, texto (se houver) e depois o arquivo (se houver).
- 2026-09-09 — Cursor Grok 4.6 — **Bwipo Keeps** usa models `KeepNote` / `KeepAttachment` / `KeepImport` (`keep_notes`), não o `Note` de contato/negócio. Conteúdo é JSON TipTap. Arquivos no bucket de storage `keeps`. Permissões `keep:*` + `nav:bwipo-keeps`. Notas são por `organizationId` + `userId` (sem compartilhamento nesta versão). Ordem do mural: `KeepNote.position` (float); `PATCH /api/keeps/reorder`.
- 2026-09-15 — Cursor Grok 4.6 — **Mensagens de grupo QR** ficam em `WhatsAppGroupMessage`, não em `Conversation`/`Message` do inbox. Inbound `@g.us` não cria ticket nem deal. Participante com telefone abre 1:1 no inbox (`skipSend`) ou o deal OPEN no pipeline.
- 2026-09-15 — Cursor Grok 4.6 — **Template + wait_for_reply**: o envio não pausa quando `nextStepId` é `wait_for_reply`/`closing_protocol` — o wait dona o timer (ex.: 30 min). Inbound só cancela contexto pausado se o consultor já respondeu (`hasHumanReply`); dono herdado no card não aborta a espera. Cards já presos no envio não andam sozinhos.
