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
3. Banco: `prisma` de `@/lib/prisma` (injeta `organizationId`). Sem contexto → throw. `prismaBase` só webhook sem org, seed, admin, script — com comentário.
4. Permission nova: entrar em `src/lib/authz/permissions.ts` **antes** de `can()`.
5. Trabalho pesado (Meta, mídia, campanha, CSV, automação) → BullMQ. HTTP valida, persiste, enfileira.
6. Não expanda o escopo com refatorações, documentação adicional ou criação de novos testes sem solicitação. Faça a menor alteração necessária. Quando código for alterado, execute apenas validações técnicas diretamente relacionadas à mudança. Plano curto se >3 arquivos.

## Nunca

- Inventar model `Lead` (é Deal) ou `Group` (stub; filial = `OrgUnit`).
- Recriar deal no inbound se o contato já tem WON/LOST (`src/services/auto-deals.ts`).
- Encerrar conversa ao mover etapa (`moveDeal`).
- Encerrar conversa (`RESOLVED`) sem devolver deal do funil Atendimento à origem acadêmica — inbox, lote, automação e IA passam por `restoreDealToAcademicOrigin`.
- Processar webhook Meta / send Graph / parse XLSX no `route.ts`.
- Renomear permission (deprecar + chave nova).
- `ENABLE RLS` não está em prod — não remova a extension Prisma “porque tem RLS”.
- `Channel.pipelineId` / `search_text` — ADRs, **não implementados**.
- Migrate no worker. Só `APP_MODE=api` migra no boot.

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

## Conceitos

- `Organization` = tenant · `OrgUnit` = filial/CNPJ · `Company` = cliente B2B · `Group` = não usar.
- Deal não tem `pipelineId`; funil vem do `Stage`.
- “Lead” no jargão = Deal.
- Inbound cai no pipeline `isDefault` (canal → funil ainda não existe).
- Encerrar ticket (humano ou IA) tira o card de Em Atendimento e devolve ao funil acadêmico.

## Decisões técnicas

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
