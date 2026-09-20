# Plano único de construção do motor v2

> Plano sem paradas. Substitui `docs/V2_CONSTRUCTION_PLAN.md` e cobre 100% do `docs/SPEC_V2.md`.  
> Regras: nenhum termo de domínio de cliente no código/presets; v1 inalterado; não duplicar tools/RAG/distribuição/modelos/catálogo existentes; handoff único; Turn Manager sempre para v2; escopo/paradas validados em código; **o agente nunca promete verificar e retornar depois — se depender de outra pessoa, transfere na hora**.

---

## 1. Visão

Criar um motor de agente declarativo e genérico (`engine = "simple"`) convivendo com o atual (`engine = "legacy"`).  
Toda a lógica vira configuração JSON validada por Zod; o LLM só classifica, escreve e retorna ações.  
Transições (handoff, encerramento, dono, paradas, botões) são determinísticas no código.  
Ação de encerramento é explícita; além dela, existe um classificador de mensagens dentro da janela pós-encerramento (cortesia \| demanda nova \| ambíguo) com limites de cortesia do SPEC 3.16.

---

## 2. Arquivos a criar

### Motor v2 e integração

| Arquivo | Responsabilidade (uma linha) |
|---|---|
| `src/lib/ai-v2/types.ts` | Tipos canônicos: `V2AgentConfig`, `V2Theme`, `V2Rule`, `V2EntryConfig`, `V2Owner`, `V2CloseReason`, `V2PendingInteractive`, `V2TurnLog`, `V2KnowledgeGap`. |
| `src/lib/ai-v2/config.ts` | Schema Zod `v2AgentConfigSchema`, normalização, validação, defaults e presets genéricos (Recepção, Atendimento, Vendas, Suporte técnico, Primeiros dias). |
| `src/lib/ai-v2/message-render.ts` | Renderizador de mensagens com `@variáveis`, trechos condicionais `{...}` e formatação por tipo; usado por TODAS as mensagens. |
| `src/services/ai-v2/engine.ts` | Orquestração do turno: regras determinísticas → identificação → LLM → execução de ações → handoff/close → trace. |
| `src/services/ai-v2/owner.ts` | Máquina de estado do dono (`pessoa | automação | agente | ninguém`), transições, precedência e gravação no trace. |
| `src/services/ai-v2/rules.ts` | Avaliador ordenado de `V2Rule`: condições e ações. |
| `src/services/ai-v2/themes.ts` | Seleção do tema ativo, allowlist de tools/docs/models/produtos e scope guard. |
| `src/services/ai-v2/context.ts` | Carrega contato, negócio(s) abertos, campos permitidos, variáveis da automação e snapshot para prompt/trace. |
| `src/services/ai-v2/actions.ts` | Executor das ações estruturadas (handoff, close, tag, field, note, activity, move_stage, message_model, product, template, ask_with_options, tabulate). |
| `src/services/ai-v2/handoff.ts` | Função única `simpleHandoff()` resolve departamento/fila/usuário/agente/automação e chama `executeDistribution`/assign. |
| `src/services/ai-v2/closure.ts` | Encerramento explícito: motivo, tabulação, devolução à etapa de origem, janela pós-encerramento, classificador de nova mensagem. |
| `src/services/ai-v2/interactive.ts` | Monta botões/lista/numerado, persiste `V2PendingInteractive`, resolve clique determinístico. |
| `src/services/ai-v2/media.ts` | Política de mídia: áudio (transcrever/transferir/pedir texto), imagem/documento (OCR placeholder/transferir/pedir descrição). |
| `src/services/ai-v2/onboarding.ts` | Fluxo "Primeiros dias": etapas ordenadas, critério de conclusão, lacunas, lembretes, progresso. |
| `src/services/ai-v2/sentiment.ts` | Humor do cliente (neutro/insatisfeito/irritado), limiar, ação. |
| `src/services/ai-v2/survey.ts` | Pesquisa de satisfação: tipo, pergunta, quando, registro da nota e motivo. |
| `src/services/ai-v2/output-guard.ts` | Remove links de domínios não autorizados e reforça a regra "não promete retornar depois". |
| `src/services/ai-v2/limits.ts` | Contadores de paradas (cortesia, oferta de ajuda, trocas sem avanço, mensagens sem sentido, loop). |
| `src/services/ai-v2/cost-guard.ts` | Acumula custo por turno/agente/org e handoff ao estourar teto. |
| `src/services/ai-v2/llm.ts` | Chamada via `generateWithTools` da v1, validação Zod do output, retry uma vez, fallback seguro. |
| `src/services/ai-v2/log.ts` | Grava `AISimpleTurnLog` com origem, dono, regra, tema, prompt, JSON, actions, options, erro, tokens, latência, custo. |
| `src/services/ai-v2/automation-bridge.ts` | Lê `AutomationContext` ativo e variáveis ao entrar; chama `continueFromStep` ao encerrar quando configurado. |
| `src/services/ai-v2/agent-resolver.ts` | Resolve se a conversa usa v2 e qual agente (renomear/estender o existente). |

### Tools novas no registry da v1

| Arquivo | Responsabilidade |
|---|---|
| `src/services/ai/tools-v2.ts` | Adiciona ao `FACTORY_MAP`: `update_field`, `send_message_model`, `send_product`, `list_message_models`, `knowledge_search`, `ask_with_options`. |

### APIs

| Arquivo | Responsabilidade |
|---|---|
| `src/app/api/ai-agents-v2/route.ts` | CRUD de agentes v2 (lista, cria, duplica). |
| `src/app/api/ai-agents-v2/[id]/route.ts` | GET/PUT/DELETE de um agente v2; PUT salva rascunho. |
| `src/app/api/ai-agents-v2/[id]/publish/route.ts` | Publica config, grava `AIAgentConfigAudit` com `source: "simple"`. |
| `src/app/api/ai-agents-v2/[id]/versions/route.ts` | Versões publicadas. |
| `src/app/api/ai-agents-v2/[id]/versions/[versionId]/revert/route.ts` | Reverter para versão. |
| `src/app/api/ai-agents-v2/[id]/test/route.ts` | Simular turno. |
| `src/app/api/ai-agents-v2/catalogs/route.ts` | Catálogo combinado para a tela. |
| `src/app/api/ai-agents-v2/presets/route.ts` | Presets genéricos. |
| `src/app/api/ai-agents-v2/[id]/logs/route.ts` | Logs do agente. |
| `src/app/api/ai-agents-v2/[id]/knowledge/route.ts` | CRUD docs (reaproveita v1). |
| `src/app/api/ai-agents-v2/[id]/knowledge/search/route.ts` | Testar busca RAG por tema. |
| `src/app/api/ai-agents-v2/[id]/knowledge-gaps/route.ts` | Listar lacunas de conhecimento e ação "virar material". |
| `src/app/api/conversations/[id]/return-to-agent/route.ts` | Devolver conversa para o bot. |
| `src/app/api/conversations/[id]/interactive-click/route.ts` | Resolver clique de botão/lista. |

### Modificações no Turn Manager

| Arquivo | Responsabilidade |
|---|---|
| (modificar) `src/services/ai/turn-manager.ts` | Já roteia simple agents para `processSimpleTurn`; renomear import para `processV2Turn` e garantir independência de `AI_TURN_MANAGER`. |

### Frontend

| Arquivo | Responsabilidade |
|---|---|
| `src/app/(app)/ai-agents-v2/page.tsx` | Server component da listagem. |
| `src/app/(app)/ai-agents-v2/client-page.tsx` | Lista, cria a partir de preset, ativa/desativa, deleta. |
| `src/app/(app)/ai-agents-v2/new/page.tsx` | Wizard novo (escolhe fluxo). |
| `src/app/(app)/ai-agents-v2/[id]/page.tsx` | Página de edição com abas Config/Test/Logs. |
| `src/app/(app)/ai-agents-v2/[id]/client-page.tsx` | Estado global, tabs, dialogs, validação Zod. |
| `src/app/(app)/ai-agents-v2/[id]/config-tab.tsx` | Wizard de configuração com seções do SPEC 6. |
| `src/app/(app)/ai-agents-v2/[id]/test-tab.tsx` | Playground fiel ao canal + painel "por que respondeu isso?". |
| `src/app/(app)/ai-agents-v2/[id]/logs-tab.tsx` | Lista de turnos com detalhes. |
| `src/components/ai-v2/behavior-selector.tsx` | Presets de comportamento da resposta (reaproveitar). |
| `src/components/ai-v2/rule-builder.tsx` | UI "Quando… Então…" ordenável. |
| `src/components/ai-v2/theme-editor.tsx` | Editor de tema com tools, docs, models, produtos, destino. |
| `src/components/ai-v2/field-permissions.tsx` | Seletor de campos com ler/citar/atualizar. |
| `src/components/ai-v2/message-model-picker.tsx` | Escolha de modelos internos + template oficial. |
| `src/components/ai-v2/conditional-message-editor.tsx` | Editor de mensagens com `@Campo{, texto}`. |
| `src/components/ai-v2/onboarding-steps-editor.tsx` | Etapas do início. |
| `src/components/ai-v2/interactive-preview.tsx` | Preview de botões/lista/numerado. |
| `src/components/ai-v2/knowledge-gaps-panel.tsx` | Lacunas de conhecimento e "virar material". |

### Migrations e scripts

| Arquivo | Responsabilidade |
|---|---|
| `prisma/migrations/YYYYMMDDHHMMSS_ai_v2_full_config/migration.sql` | Alterações nas tabelas v2, tabela de opções pendentes, tabela de lacunas, holiday em `OrganizationSetting`. |
| `scripts/ai-v2-check-context.ts` | Dado um telefone, imprime contato, negócios abertos e campos permitidos carregados pela v2 (smoke test do deploy). |
| `scripts/inventory-org-agents.ts` | Já criado; usado para preencher `docs/v2-parity.md`. |
| `scripts/ai-v2-migrate-agent.ts` | (opcional) Lê config v1 e gera rascunho v2 + relatório de gaps. |

### Tests

| Arquivo | Responsabilidade |
|---|---|
| `src/services/ai-v2/__tests__/engine.test.ts` | Fluxo completo. |
| `src/services/ai-v2/__tests__/rules.test.ts` | Regras determinísticas. |
| `src/services/ai-v2/__tests__/interactive.test.ts` | Botões, lista, numerado, clique. |
| `src/services/ai-v2/__tests__/closure.test.ts` | Pós-encerramento: cortesia, demanda nova, ambíguo. |
| `src/services/ai-v2/__tests__/onboarding.test.ts` | Etapas do início, lacunas, lembretes. |
| `src/services/ai-v2/__tests__/turn-manager.test.ts` | V2 usa Turn Manager independente de flag; v1 não muda. |
| `src/services/ai-v2/__tests__/message-render.test.ts` | Variáveis, condicionais, formatação. |
| `src/services/ai/__tests__/tools-v2.test.ts` | Tools novas. |

---

## 3. Arquivos a modificar

| Arquivo | Alteração (uma linha) |
|---|---|
| `prisma/schema.prisma` | Expandir `AIAgentConfig.simpleConfig`; adicionar campos a `AISimpleConversationState`; criar `AIV2PendingInteractive` e `AIV2KnowledgeGap`; feriados via `OrganizationSetting` JSONB. |
| `src/services/ai/turn-manager.ts` | Importar e chamar `processV2Turn`; garantir simple agents sempre usem Turn Manager. |
| `src/services/ai/inbound-debounce.ts` | Ignorar conversas `engine = "simple"`. |
| `src/services/ai/inbox-handler.ts` | Ignorar conversas v2 no pipeline v1. |
| `src/services/ai/ai-agent-inactivity-worker.ts` | Ignorar conversas v2. |
| `src/services/ai/sweep-finished-ai-conversations.ts` | Ignorar conversas v2. |
| `src/services/ai/retry-unanswered-ai-inbound.ts` | Ignorar conversas v2. |
| `src/services/ai-simple/*` e `src/lib/ai-simple/*` | Remover/renomear para `ai-v2`; a v2 é construída do zero, sem manter presets acadêmicos. |
| `src/app/api/ai-simple/*` | Remover/renomear para `ai-agents-v2`. |
| `src/app/(app)/ai-agents-v2/*` existentes | Reescrever para novo schema wizard e abas. |
| `src/services/ai/tools.ts` | Adicionar novas tools no `FACTORY_MAP` e exportar factory functions. |
| `src/services/ai/message-models-retrieval.ts` | Adicionar filtro por tema e endpoint de busca por score. |
| `src/services/ai/retrieval.ts` | Adicionar filtro `themeIds` na busca de conhecimento. |
| `src/services/ai/knowledge-extract.ts` | Adicionar suporte a PDF (ou delegar a serviço externo). |
| `src/lib/channel-session.ts` | Expor helper `isSessionWindowOpen()` para v2. |
| `src/services/distribution/engine.ts` | Garantir `executeDistribution` aceite `userId` como destino e `triggerSource = "AI_AGENT"`. |
| `src/services/conversations.ts` | Adicionar helpers `returnConversationToBot()` e `setConversationOwner()`. |
| `src/services/ai-agents.ts` | CRUD v2 reaproveita funções de criptografia de chave e audit. |
| `src/lib/authz/permissions.ts` | Adicionar permissões `ai_agent_v2:*`. |
| `src/lib/org-settings.ts` | Adicionar chave `ai_v2.holidays` para feriados. |

---

## 4. O que vem da v1 e de onde

| Componente v2 | Fonte v1 | Arquivo / função |
|---|---|---|
| LLM com tools | `generateWithTools` | `src/services/ai/provider.ts` |
| Registry de tools | `FACTORY_MAP` + `buildToolSet` | `src/services/ai/tools.ts` |
| Governor de tools | `ToolCallGovernor` | `src/services/ai/tool-governor.ts` |
| Busca de conhecimento | `retrieveAgentKnowledge` + embeddings | `src/services/ai/retrieval.ts`, `src/services/ai/embeddings.ts` |
| Busca de modelos internos | `retrieveRelevantMessageModels` | `src/services/ai/message-models-retrieval.ts` |
| Distribuição / handoff | `executeDistribution` / `simulateDistribution` | `src/services/distribution/engine.ts` |
| Política de campos CRM | `loadCrmFieldCatalog`, `partitionFieldValues` | `src/services/ai/crm-field-policy.ts` |
| Identificação por campo | `resolveIdentityFields`, `identityValueMatches` | `src/services/ai/crm-field-policy.ts` |
| Record sources | `CORE_RECORD_SOURCES` + `search_crm_records` | `src/services/ai/record-sources.ts`, `src/services/ai/tools.ts` |
| Envio de mensagens | `sendAgentMessage` / envio de inbox | `src/services/ai/send-agent-message.ts` / rotas |
| Botões/lista Meta | `sendInteractiveButtonsToConversation`, `sendInteractiveListToConversation` | `src/services/outbound-messaging.ts` |
| Sessão 24h | `getConversationSession` | `src/lib/channel-session.ts` |
| Agrupamento | Turn Manager persistente | `src/services/ai/turn-manager.ts` |
| Tabulações | `list_tabulations`, `tabulate_conversation` | `src/services/ai/tools.ts` |
| Envio de template oficial | `send_whatsapp_template` | `src/services/ai/tools.ts` |
| Mover etapa | `move_stage` | `src/services/ai/tools.ts` |
| Criar negócio/tag/atividade | `create_deal`, `add_tag`, `create_activity` | `src/services/ai/tools.ts` |
| Auditoria de config | `AIAgentConfigAudit` | `prisma/schema.prisma` |
| Chave OpenAI por agente | `getAgentApiKey` | `src/services/ai/agent-key.ts` |
| Custo | `estimateCost`, `getModelPricing` | `src/lib/ai-agents/pricing.ts` |
| Transcrição de áudio | `POST /api/media/transcribe` | `src/app/api/media/transcribe/route.ts` |
| Permissões | `requirePermission` | `src/lib/authz/index.ts` |
| Bridge de automação | `continueFromStep`, `AutomationContext` | `src/services/automation-executor.ts`, `src/services/automation-context.ts` |

---

## 5. O que NÃO reaproveitar da v1

- `src/services/ai/inbox-handler.ts` — pipeline v1 de interceptos/pilotagem.
- `src/verticals/*` — qualquer pack/vertical.
- `src/services/ai/interceptors/*` e `src/verticals/academic/intercepts.ts` — interceptores hardcoded.
- `src/services/ai/coordinator-orchestrate.ts` — roteamento por coordenador.
- `src/services/ai/effect-claims.ts` — guarda de efeito por regex.
- `src/services/ai/closure.ts` e `src/verticals/academic/closure.ts` — detecção heurística de encerramento.
- `src/services/ai/message-rules.ts` — regras de mensagem legadas.
- `src/services/ai/piloting.ts` — pilotagem antiga.
- `src/lib/ai-agents/system-prompt.ts` — prompt acoplado a verticals.
- `src/services/ai/inbound-debounce.ts` — debounce em memória.
- Workers de inatividade/limpeza v1 atuando em conversas v2.

---

## 6. O que será simplificado ou removido do que a v2 já tem hoje

- Config plana `simpleConfig` → schema completo com `entry`, `themes`, `rules`, `variables`, `media`, `limits`, `closure`, `handoff`, `onboarding`, `productPolicy`, `allowedDomains`, `autonomyMode`, `sentiment`, `nps`, `costCap`, `responseBehavior`.
- Ações limitadas a `add_tag | update_field | add_note` → actions alinhadas às tools do registry.
- Stages hardcoded → stages genéricos (`idle`, `confirming`, `identifying`, `active`, `closed`) + dono explícito.
- `human_active` boolean → `owner` com quatro valores.
- Handoff para `handoff_queue` string → destino tipado (department, distributionRule, user, aiAgent, automation).
- Presets acadêmicos → presets genéricos sem domínio.
- Prompt simples sem temas → prompt com themes, allowlists e contexto rico.
- Sem logs estruturados → log com versão e trace completo.
- Sem encerramento/pós-encerramento → close explícito + classificador pós-close.
- Sem botões/listas → interactive engine com fallback numerado.
- Sem Primeiros dias → wizard e motor de onboarding com etapas, lacunas e acompanhamento.
- Sem message-render → renderizador centralizado.
- Sem guarda de links → `output-guard.ts` com allowed domains.
- Sem sentiment/survey → módulos dedicados.
- Sem bridge de automação → `automation-bridge.ts`.

---

## 7. Modelo de dados e migrations

### Alterações no banco

1. **`AIAgentConfig.simpleConfig`** — manter JSONB; validado por Zod no app.

2. **`AISimpleConversationState`** (rename interno para `AIV2ConversationState`, manter tabela):
   - `stage: String`
   - `owner: String` (`pessoa | automacao | agente | ninguem`)
   - `originStageId: String?`
   - `postCloseWindowEndAt: DateTime?`
   - `closeReason: String?`
   - `versionId: String?`
   - `themeId: String?`
   - `counters: Json`
   - `identificationAttempts: Int`

3. **Nova `AIV2PendingInteractive`**:
   - `id`, `organizationId`, `conversationId`, `turnId`, `messageId`, `validUntil`, `options: Json`, `resolvedAt`, `resolvedBy`, `resolvedTarget`.

4. **Nova `AIV2KnowledgeGap`**:
   - `id`, `organizationId`, `agentId`, `themeId?`, `question: String`, `frequency: Int @default(1)`, `status: String @default("pending")`, `createdAt`, `updatedAt`.
   - Índices por `organizationId`, `agentId`, `status`, `updatedAt`.

5. **Associação knowledge ↔ tema**:
   - Adicionar `theme_ids String[]` em `AIAgentKnowledgeDoc`.

6. **Feriados**:
   - Usar `OrganizationSetting` JSONB com chave `ai_v2.holidays` (lista de `{date, name, recurring}`).

### SQL de exemplo (resumo)

```sql
ALTER TABLE "ai_simple_conversation_states"
  ADD COLUMN "owner" TEXT NOT NULL DEFAULT 'agente',
  ADD COLUMN "origin_stage_id" TEXT,
  ADD COLUMN "post_close_window_end_at" TIMESTAMPTZ,
  ADD COLUMN "close_reason" TEXT,
  ADD COLUMN "version_id" TEXT,
  ADD COLUMN "theme_id" TEXT,
  ADD COLUMN "counters" JSONB NOT NULL DEFAULT '{}',
  ALTER COLUMN "humanActive" DROP NOT NULL; -- manter legacy

CREATE TABLE "ai_v2_pending_interactives" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "organizationId" TEXT NOT NULL,
  "conversationId" TEXT NOT NULL,
  "turnId" TEXT,
  "messageId" TEXT,
  "validUntil" TIMESTAMPTZ NOT NULL,
  "options" JSONB NOT NULL DEFAULT '[]',
  "resolvedAt" TIMESTAMPTZ,
  "resolvedBy" TEXT,
  "resolvedTarget" TEXT
);
CREATE INDEX idx_aiv2pi_org ON "ai_v2_pending_interactives"("organizationId");
CREATE INDEX idx_aiv2pi_conv ON "ai_v2_pending_interactives"("conversationId");

CREATE TABLE "ai_v2_knowledge_gaps" (
  "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
  "organizationId" TEXT NOT NULL,
  "agentId" TEXT NOT NULL,
  "themeId" TEXT,
  "question" TEXT NOT NULL,
  "frequency" INTEGER NOT NULL DEFAULT 1,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_aiv2kg_org_agent_status ON "ai_v2_knowledge_gaps"("organizationId", "agentId", "status");

ALTER TABLE "ai_agent_knowledge_docs" ADD COLUMN "theme_ids" TEXT[] DEFAULT '{}';
```

### Backfill

- `engine = NULL` → `legacy`.
- Conversas v2 novas nascem com `owner = 'agente'` e `versionId` da publicação ativa.

---

## 8. Endpoints novos

| Método | Rota | Uso |
|---|---|---|
| GET/POST | `/api/ai-agents-v2` | Listar/criar agentes v2. |
| GET/PUT/DELETE | `/api/ai-agents-v2/[id]` | Ler/salvar rascunho/deletar. |
| POST | `/api/ai-agents-v2/[id]/publish` | Publicar config e gravar audit. |
| GET | `/api/ai-agents-v2/[id]/versions` | Versões publicadas. |
| POST | `/api/ai-agents-v2/[id]/versions/[versionId]/revert` | Reverter. |
| POST | `/api/ai-agents-v2/[id]/test` | Simular turno. |
| GET | `/api/ai-agents-v2/catalogs` | Dados da tela. |
| GET | `/api/ai-agents-v2/presets` | Presets genéricos. |
| GET | `/api/ai-agents-v2/[id]/logs` | Logs. |
| GET/POST/DELETE | `/api/ai-agents-v2/[id]/knowledge` | CRUD docs. |
| GET | `/api/ai-agents-v2/[id]/knowledge/search` | Testar busca RAG. |
| GET | `/api/ai-agents-v2/[id]/knowledge-gaps` | Lacunas. |
| POST | `/api/ai-agents-v2/[id]/knowledge-gaps/[gapId]/promote` | Virar material. |
| POST | `/api/conversations/[id]/return-to-agent` | Devolver ao bot. |
| POST | `/api/conversations/[id]/interactive-click` | Resolver clique. |

---

## 9. Estrutura da tela `/ai-agents-v2`

### Rotas

- `/ai-agents-v2` — listagem.
- `/ai-agents-v2/new?flow=reception|full|onboarding` — wizard de criação.
- `/ai-agents-v2/[id]?tab=config|test|logs` — edição/teste/logs.

### Wizard "Recepção"

1. Começar
2. Jeito de falar
3. Reconhecer o cliente
4. Para quem encaminha
5. Regras automáticas
6. Saídas
7. Encerrar e classificar
8. Testar e publicar

### Wizard "Agente completo"

1. Começar
2. Jeito de falar
3. O que ele sabe
4. Materiais
5. Mensagens prontas e produtos (product policy **desligado por padrão**)
6. Início da conversa
7. Assuntos
8. Regras automáticas
9. Saídas
10. Equipe e horários
11. Encerrar e classificar
12. Testar e publicar

### Wizard "Primeiros dias"

1. Começar
2. Jeito de falar
3. O que ele sabe
4. Etapas do início
5. Quando faltar informação
6. Acompanhamento
7. Saídas
8. Encerrar e entregar
9. Testar e publicar

### Componentes compartilhados

- `config-tab.tsx` monta as seções conforme o fluxo.
- `test-tab.tsx` simula canal: agrupamento, digitação, rascunho, botões clicáveis, handoff/close simulados, painel "por que".
- `logs-tab.tsx` lista turnos com expansão para snapshot, prompt, JSON e trace.
- `knowledge-gaps-panel.tsx` lista lacunas e botão "virar material".

---

## 10. Lista de testes (seção 9 do SPEC)

- Regras determinísticas: ordem, condições, ações, variáveis.
- Loop de ferramentas: allowlist por tema, governor, repetição, limite.
- Escrita restrita a campos com permissão.
- RAG filtrado por tema.
- Mensagem com campo vazio (trecho condicional oculto).
- Modelo de mensagem com variável faltante.
- Adaptar levemente vs envio literal.
- Template oficial fora da janela de 24h.
- Produto sem preço e produto inativo.
- Limite de produtos por vez.
- Transferência por distribuição inteligente.
- Transferência entre agentes e limite de idas/voltas.
- Conversa vinda de automação com variáveis.
- Cliente fora da base nos três modos.
- Saídas: não sabe, pediu pessoa, sem material, fora do escopo, erro, mídia.
- Áudio transcrito roteando certo.
- Imagem com texto lido (ou fallback).
- Opções: target inválido, >3 vira lista, fora das 24h numerado, clique expirado, resposta por número e por rótulo.
- Cortesia recebendo uma única resposta.
- Oferta única de ajuda.
- Silêncio temporário e retorno com mensagem válida.
- Detecção de loop agente↔automação e agente↔agente.
- Tabulação ao encerrar e ao transferir.
- Devolução de etapa ao encerrar.
- Humor disparando ação.
- Pesquisa de satisfação com nota e motivo.
- Agrupamento pelo Turn Manager.
- v1 não afetada (mesmo com `AI_TURN_MANAGER` desligado).
- Catálogo com id inexistente (aviso na tela/trace).
- Teto de custo.
- Onboarding: negócio vazio, parcial, fora de ordem, etapa travada, lembrete esgotado, lacuna registrada, entrega ao agente.
- Owner: pessoa assume, automação assume, devolver para agente, precedência.
- Pós-encerramento: cortesia, nova demanda, ambíguo.
- Publicação/revert de versão.
- Output guard: link não autorizado removido, promessa de retorno bloqueada.

---

## 11. Riscos e como evitar

| Risco | Mitigação |
|---|---|
| LLM retornar JSON inválido | Zod + retry 1x; falha → handoff seguro. |
| LLM inventar ação | Actions allowlist por tema; validar no executor; descartar/logar. |
| Loop infinito | Contadores por conversa + detecção de sequência repetida; handoff como saída. |
| v1 quebrada | `engine = "legacy"` default; modificações no Turn Manager aditivas e protegidas por `isSimpleEngineTurn`. |
| Migração de agentes acadêmicos | Migrar um por um; manter v1 até validar; usar script de conversão + `v2-parity.md`. |
| Performance do RAG | Índice `ivfflat` no `embedding`; busca filtrada por `theme_ids` com GIN. |
| Botões fora da janela de 24h | Fallback numerado + template aprovado; nunca falhar silenciosamente. |
| Custo | `dailyTokenCap` + `costCap`; ao estourar, handoff geral. |
| Dados sensíveis | `sensitiveTerms` + política de campos; redact no trace. |
| Promessa de retorno | Regra global em todos os presets e `output-guard.ts` bloqueia frases do tipo "volto depois". |
| Scope creep | MVP sem cockpit analítico, mensagens proativas em massa, sync de departamentos. |

---

## 12. Passos de migration e deploy no ambiente de dev

1. **Branch** — `feat/ai-v2` a partir da `DEV_BRANCH` atual.
2. **Migrations** — criar `prisma/migrations/YYYYMMDDHHMMSS_ai_v2_full_config/migration.sql` e rodar:
   ```bash
   npx prisma migrate dev --name ai_v2_full_config
   npx prisma generate
   ```
   No Easypanel dev, o deploy executa `prisma migrate deploy`.
3. **Deploy backend** — push dispara GitHub Action `build-and-push` para `ghcr.io/...-api:dev`; Easypanel puxa a imagem.
4. **Deploy frontend** — push correspondente no `frontend_crm1_repo` dispara build da imagem web.
5. **Env vars dev** — garantir `GROQ_API_KEY` configurado no Easypanel para transcrição; chaves OpenAI continuam por agente.
6. **Smoke test** — rodar no container dev:
   ```bash
   npx tsx scripts/ai-v2-check-context.ts +55...
   ```
   Depois acessar `/ai-agents-v2`, criar agente a partir de preset, salvar rascunho, publicar, abrir aba Testar e enviar "oi".
7. **Migração de agentes** — rodar `npx tsx scripts/inventory-org-agents.ts "Cruzeiro do Sul"` para preencher paridade, depois criar agentes v2 manualmente e alternar `engine` um por um.
8. **Limpeza futura** — quando nenhum agente usar `legacy`, remover arquivos v1 de motor/agente.

---

## 13. Dúvidas que só você pode responder

1. **Mapeamento dos agentes**: os dados reais do inventário (`agents.json`) confirmam a estratégia de converter cada agente acadêmico em um agente v2 único com temas, ou algum precisa ser coordenador com transferência entre agentes v2?
2. **Modelos de mensagem**: quais modelos internos/templates devem ser allowlist de cada tema? O script de inventário já exporta isso?
3. **Knowledge docs**: os documentos de conhecimento atuais cobrem "primeiro acesso", "acesso a conteúdo", "documentos" e "retenção", ou precisamos separar/gerar novos?
4. **Destinos de handoff**: quais departamentos/filas reais do CRM devem ser os destinos padrão de cada tema/regra?
5. **Pesquisa de satisfação**: quer habilitar NPS/CSAT desde o início ou deixar desligado por padrão nos presets genéricos?
