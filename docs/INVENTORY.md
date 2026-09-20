# Inventário do Motor de Agentes de IA — Fase 0

> Gerado em 2026-09-19.  
> Nenhum código existente foi alterado nesta fase.  
> Cobertura: backend `backend_crm1_repo` + consumidor frontend `frontend_crm1_repo`.

## 1. Resumo executivo

O motor atual possui **~100 arquivos TypeScript** diretamente relacionados a agentes de IA no backend, além de componentes e hooks no frontend. Ele é funcional, mas acumulou complexidade em quatro áreas:

1. **Vertical acadêmica hardcoded** — termos, departamentos, regras e prompts específicos espalhados por prompts, interceptos e tools.
2. **Dualidade de runtime** — debounce legado em memória vs. Turn Manager persistente.
3. **Handoff/orquestração dispersa** — lógica de transferência em múltiplos arquivos.
4. **Guardrails reativos** — detecção de efeitos afirmados via regex em texto livre.

O inventário abaixo mapeia arquivos, contratos, dados, dependências e riscos para apoiar as próximas fases.

---

## 2. Backend — inventário por camada

### 2.1 Administração e configuração do agente

| Arquivo | Responsabilidade | Notas / Risco |
|---------|-------------------|---------------|
| `src/services/ai-agents.ts` | CRUD de `User` + `AIAgentConfig`; sanitização de piloting/steering; redação de chave OpenAI. | ~1000 linhas; reúne criação, update, listagem, delete, normalização e audit. |
| `src/lib/ai-agents/archetypes.ts` | Catálogo de arquétipos: SDR, ATENDIMENTO, VENDEDOR, SUPORTE, TABULACAO, ENCERRAMENTO, COORDENADOR. | Contém templates de system prompt e defaults de tools. |
| `src/lib/ai-agents/tools-catalog.ts` | Descrição das tools para o wizard de criação. | Referência central de IDs de tools. |
| `src/services/ai-agent-templates.ts` | Moldes de agente (`AgentTemplate`); upsert de templates de sistema. | Usa `prismaBase` com acesso dinâmico porque `prisma generate` pode não expor o model ainda. |
| `src/lib/ai-agents/observability.ts` | Hash de config, diff de auditoria, `AIAgentConfigAudit`. | `hashAgentBehaviorConfig` cobre 19 campos; diffs manuais. |
| `src/lib/ai-agents/readiness.ts` | Valida se agente autônomo tem escopo ou KB. | Bloqueia ativação AUTONOMOUS sem KB/escopo. |

### 2.2 Runtime principal

| Arquivo | Responsabilidade | Notas / Risco |
|---------|-------------------|---------------|
| `src/services/ai/runner.ts` | **Coração do motor**: carrega agente, histórico, RAG, monta prompt, chama LLM, persiste run, deriva outcome. | ~760 linhas; lógica condicional densa; acoplada com pack academic. |
| `src/services/ai/inbox-handler.ts` | Glue entre webhook e runner; aplica kill-switch, test mode, interceptos, regras de mensagem, opening message, fila. | ~1700 linhas; mistura lógica determinística e envio real. |
| `src/services/ai/provider.ts` | Fachada Vercel AI SDK/OpenAI; cache de clientes por chave. | Chave por agente, sem fallback global. |
| `src/services/ai/llm-retry.ts` | Retry com timeout por tentativa. | Isola retry do SDK. |
| `src/services/ai/tool-governor.ts` | Deduplicação e tetos de chamadas de tool. | Limites default: 24 calls/run, 3 reps/tool. |
| `src/services/ai/run-outcome.ts` | Deriva desfecho do estado final (`HANDOFF_COMPLETED`, `ANSWERED`, `TOOL_FAILED`, etc.). | Depende de `finalAssigneeType` pós-run. |
| `src/services/ai/effect-claims.ts` | Guardrail que descarta resposta se afirma efeito não realizado. | Baseado em regex sobre texto livre. |
| `src/services/ai/confidence.ts` | Parse do marcador `[CONFIANCA:X.X]` e handoff por baixa confiança. | Marcador oculto é removido antes do envio. |
| `src/services/ai/agent-vertical.ts` | Resolve vertical pack a partir do `userId` do agente atribuído. | Usado por worker/followup para achar ops do agente atual. |

### 2.3 Ferramentas

| Arquivo | Responsabilidade | Notas / Risco |
|---------|-------------------|---------------|
| `src/services/ai/tools.ts` | Implementação de todas as 16 tools disponíveis. | ~2000 linhas; mistura lógica de CRM, WhatsApp, handoff e distribuição. |
| `src/services/ai/crm-field-policy.ts` | Política de leitura de campos CRM via `search_crm_records`. | Exposição controlada por `readableFields`. |
| `src/services/ai/academic-record-policy.ts` | Política de exposição de dados acadêmicos (`consultar_matricula`). | Acadêmico hardcoded. |
| `src/services/ai/sensitive-fields.ts` | Lista de campos sensíveis que devem ser avisados na UI. | Usado na configuração. |
| `src/services/ai/message-rule-runtime.ts` | Execução das ações de `message-rules` no inbox (transfer, tag, fixed reply). | Bridge entre regras declarativas e ações. |

### 2.4 Handoff e orquestração

| Arquivo | Responsabilidade | Notas / Risco |
|---------|-------------------|---------------|
| `src/services/ai/agent-handoff.ts` | Handoff orquestrado: departamento, usuário humano, outro agente IA. | Usa `assignOwnerToContactClusterTx`. |
| `src/services/ai/department-handoff.ts` | Resolve departamento e executa `executeDistribution`. | Acadêmico: aliases de departamentos. |
| `src/services/ai/coordinator-orchestrate.ts` | Orquestrador COORDENADOR escolhe especialista por assunto. | Aninha `runAgent`; usa `pickPeerForTopic` do pack. |
| `src/services/ai/transfer-gate.ts` | Gate de transferência humana baseado em `inboxPolicy.transferPolicy`. | Depende de pack para "tema justifica". |
| `src/services/ai/human-queue-policy.ts` | Mensagens de fila, horário humano, fuso. | Default seg–sex 8h–19h, sáb 9h–16h. |
| `src/services/ai/piloting-actions.ts` | `sendAgentMessage` e `executeAgentHandoff`; persiste/envia mensagens e transfere. | Mistura autonomia, Meta/Baileys, SSE, draft. |
| `src/services/ai/farewell-close.ts` | Handler do arquétipo ENCERRAMENTO. | Decide closed vs handoff. |
| `src/services/ai/close-ai-conversation.ts` | Encerra conversa somente-IA. | Usado por interceptos e worker. |

### 2.5 Prompt e contexto

| Arquivo | Responsabilidade | Notas / Risco |
|---------|-------------------|---------------|
| `src/lib/ai-agents/system-prompt.ts` | Monta system prompt efetivo (template + overrides + data/hora + contexto). | ~460 linhas; renderização condicional densa. |
| `src/lib/ai-agents/piloting.ts` | Normalização de piloting: opening, inactivity, keywords, qualification, businessHours, outputStyle, autoClose. | Tipos e defaults. |
| `src/lib/ai-agents/steering.ts` | Normalização de `toolConfig`, `inboxPolicy`, message rules, media inbound. | ~900 linhas; muitos campos JSONB. |
| `src/lib/ai-agents/message-rules.ts` | Regras declarativas de mensagem (match + action). | Genérico por design. |
| `src/lib/ai-agents/media-placeholder.ts` | Reconhecimento de placeholders de mídia. | Centraliza regra antes duplicada. |
| `src/lib/ai-agents/farewell-closer.ts` | Detecta despedida do contato. | Arquétipo ENCERRAMENTO. |
| `src/lib/ai-agents/tabulation-classifier.ts` | Identifica agentes de tabulação. | Heurística por nome/arquétipo/tools. |
| `src/lib/ai-agents/pricing.ts` | Estimativa de custo por modelo/tokens. | Usado no run. |

### 2.6 RAG / knowledge / contexto adicional

| Arquivo | Responsabilidade | Notas / Risco |
|---------|-------------------|---------------|
| `src/services/ai/retrieval.ts` | Recuperação vetorial de `AIAgentKnowledgeChunk`. | pgvector via `$queryRaw`. |
| `src/services/ai/retrieval-query.ts` | Constrói query de RAG a partir de mensagens recentes. | Corta por sessão recente. |
| `src/services/ai/message-models-retrieval.ts` | RAG sobre modelos de mensagens internos. | Usado quando `useMessageModels=true`. |
| `src/services/ai/knowledge-docs.ts` | Upload, chunking, indexação de documentos. | Integração com storage. |
| `src/services/ai/knowledge-extract.ts` | Extração de texto de documentos. | |
| `src/services/ai/embeddings.ts` | Geração de embeddings (usa `provider.ts`). | |
| `src/services/ai/campaign-context.ts` | Contexto de campanha recente para o prompt. | |

### 2.7 Vertical packs

| Arquivo | Responsabilidade | Notas / Risco |
|---------|-------------------|---------------|
| `src/verticals/index.ts` | Registry de packs (hoje só `academic`). | |
| `src/verticals/types.ts` | Contrato genérico de pack: intercepts, promptBlocks, ops, constants. | **Base para desacoplamento.** |
| `src/verticals/academic/pack.ts` | Pack acadêmico: intercepts, tool copy, defaults, ops. | Ponto de entrada da vertical. |
| `src/verticals/academic/intercepts.ts` | Pipeline de interceptos pré/pós assignee. | ~1200 linhas; lógica específica acadêmica. |
| `src/verticals/academic/department-routing.ts` | Regex e frases de roteamento para Acolhimento/Retenção/Atendimento. | Hardcoded acadêmico. |
| `src/verticals/academic/atendimento-prompt.ts` | Constantes de prompt acadêmico (IDENTIDADE, REGRAS, TCE, mídia, confiança). | ~655 linhas; menciona Cruzeiro do Sul. |
| `src/verticals/academic/closure.ts` | Detecção de despedida/encerramento. | |
| `src/verticals/academic/default-message-rules.ts` | Regras de mensagem padrão para atendimento acadêmico. | |
| `src/verticals/academic/ensure-dept-roster.ts` | Seed de departamentos acadêmicos e e-mails de operadores. | |
| `src/verticals/academic/inaugural-class-link.ts` | Link de aula inaugural. | |
| `src/verticals/academic/outbound-url-guard.ts` | Guarda de URLs não oficiais. | |

### 2.8 Ingestão / debounce / turn manager

| Arquivo | Responsabilidade | Notas / Risco |
|---------|-------------------|---------------|
| `src/services/ai/inbound-debounce.ts` | Debounce legado (Map in-memory + Redis claim). | **Duplicado com turn-manager.** |
| `src/services/ai/turn-manager.ts` | Agrupamento persistente de inbound em `ConversationTurn`. | Novo caminho; flag `AI_TURN_MANAGER`. |
| `src/services/ai/turn-sweeper.ts` | Promove turnos READY e reclama PROCESSING travados. | Roda via setInterval/ cron. |
| `src/services/ai/inbound-debounce.ts` | Também invalida turnos e cancela geração. | |
| `src/services/ai/idle-inbound.ts` | Tratamento de inbound ocioso/curto. | |
| `src/services/ai/audio-inbound.ts` | Inbound de áudio/mídia. | |
| `src/services/ai/media-inbound.ts` | Tratamento de mídia inbound. | |
| `src/services/ai/phone-allowlist.ts` | Allowlist de telefones para IA. | |
| `src/services/ai/halt-inbound-burst.ts` | Proteção contra rajada de inbound. | |
| `src/services/ai/replay-stuck-inbox.ts` | Diagnóstico de inbounds presos. | |

### 2.9 Workers / timers / cron

| Arquivo | Responsabilidade | Notas / Risco |
|---------|-------------------|---------------|
| `src/services/ai-agent-inactivity-worker.ts` | Timer na API: nudge, close por silêncio, handoff por inatividade, retry unanswered. | Iniciado por `sse-bus.ts`; usa `prismaBase` cross-tenant. |
| `src/services/ai/turn-sweeper.ts` | Sweeper de turnos. | |
| `src/services/ai/sweep-finished-ai-conversations.ts` | Varre conversas IA encerradas. | |
| `src/services/ai/retry-unanswered-ai-inbound.ts` | Retry de inbound sem resposta. | |
| `src/services/ai/idle-followup.ts` | Mensagens de follow-up/check-in. | |
| `src/lib/distribution-execute-queue.ts` / `distribution-drain-queue.ts` | Filas BullMQ de distribuição. | Motor smart/leads. |

### 2.10 Test mode / QA / replay

| Arquivo | Responsabilidade | Notas / Risco |
|---------|-------------------|---------------|
| `src/services/ai/test-mode.ts` | Leitura/escrita do modo de teste (`aiTestModeUntil`, `aiTestModeById`). | |
| `src/services/ai/test-mode-turn.ts` | Simulação de turno em teste. | |
| `src/services/ai/test-mode-replay.ts` | Replay de runs em teste. | |
| `src/services/ai/test-mode-corrections.ts` | Correções aplicadas em modo teste. | |
| `src/services/ai/test-mode-why.ts` | Diagnóstico de porquê modo teste. | |
| `src/scripts/replay-agent-runs.ts` | Harness de replay em lote com fixtures. | ~500 linhas; depende de banco e org real. |
| `src/scripts/fix-agent-status-cross-org.mjs` | Script de correção de status. | |
| `src/scripts/diagnose-agent-status.mjs` | Diagnóstico de status de agentes. | |
| `src/scripts/dump-agent-prompts.ts` | Dump de prompts. | |
| `src/scripts/audit-cruzeiro-agents.ts` | Auditoria específica Cruzeiro. | |
| `src/scripts/seed-agent-steering.ts` | Seed de steering. | |

### 2.11 Testes existentes

Backend: **30 arquivos de teste** diretamente relacionados a IA.

`src/services/ai/__tests__/` (28):
- `run-outcome.test.ts`, `transfer-gate.test.ts`, `tool-governor.test.ts`, `effect-claims.test.ts`
- `turn-manager.test.ts`, `inbound-debounce.test.ts`, `inbound-batch-window.test.ts`
- `knowledge-docs.test.ts`, `knowledge-validity.test.ts`, `retrieval-block.test.ts`, `retrieval-query.test.ts`
- `crm-field-policy.test.ts`, `crm-field-catalog-generic.test.ts`, `crm-search-tool.test.ts`, `sensitive-fields.test.ts`
- `ai-test-mode.test.ts`, `ai-test-mode-tools.test.ts`, `ai-test-commands.test.ts`, `test-mode-turn.test.ts`
- `media-inbound.test.ts`, `academic-closure-context.test.ts`, `inbox-handler-vertical-pack.test.ts`
- `vertical-pack-intercepts.test.ts`, `message-rules-inbox.test.ts`
- `llm-retry.test.ts`, `provider-retry.test.ts`, `run-audit.test.ts`, `generic-agent-e2e.test.ts`

`src/lib/ai-agents/__tests__/`:
- `message-rules.test.ts`, `system-prompt.test.ts`, `tabulation-classify-policy.test.ts`

`src/verticals/academic/__tests__/`:
- `outbound-url-guard.test.ts`

### 2.12 API routes

#### Administração de agentes
- `GET/POST /api/ai-agents`
- `GET/PUT/DELETE /api/ai-agents/[id]`
- `POST /api/ai-agents/[id]/toggle-active`
- `GET /api/ai-agents/[id]/stats`
- `POST /api/ai-agents/[id]/test`
- `POST /api/ai-agents/preview-prompt`
- `GET/POST /api/ai-agents/[id]/knowledge`
- `GET/DELETE /api/ai-agents/[id]/knowledge/[docId]`
- `GET /api/ai-agents/metadata`
- `GET /api/ai-agents/crm-fields`
- `GET /api/ai-agents/product-fields`
- `POST /api/ai-agents/[id]/message-rules/test`
- `POST /api/ai-agents/drafts/[messageId]/approve|discard`
- `POST /api/ai-agents/cockpit-embed-token`

#### Status / presença / cockpit
- `GET /api/agents/status`
- `PUT /api/agents/[id]/status`
- `POST /api/agents/me/ping`
- `POST /api/agents/me/activity`
- `GET /api/agents/schedules`
- `GET/PUT /api/agents/[id]/schedule`
- `POST /api/agents/inbound-voice`
- `GET /api/public/agent-cockpit`
- `GET /api/public/agent-cockpit/cases`
- `GET /api/monitor/agents`
- `GET /api/inbox/agent-capacity`

#### Permissões
- `GET/PUT /api/settings/agent-permissions`
- `GET/PUT /api/settings/agent-permissions/[userId]`

### 2.13 Modelos de dados (Prisma)

- `AIAgentConfig` — configuração completa do agente.
- `AIAgentRun` — invocação do runner.
- `AIAgentMessage` — trace system/user/assistant/tool.
- `AIAgentKnowledgeDoc` / `AIAgentKnowledgeChunk` — base de conhecimento vetorizada.
- `AIAgentConfigAudit` — auditoria de mudanças.
- `AgentTemplate` — moldes de agente.
- `ConversationTurn` — agrupamento persistente de inbound.
- `User` (`type = AI` / `HUMAN`), `Conversation`, `Message`, `Deal`, `Contact`, `Tag`, `Pipeline`, `Stage`, `Department`, `DistributionPending`, etc.

---

## 3. Frontend — consumidor principal

> Não é fonte de verdade do motor, mas consome as APIs e mantém templates/prompts espelhados.

| Caminho | Responsabilidade |
|---------|-------------------|
| `src/app/(app)/ai-agents/page.tsx` | Lista de agentes. |
| `src/app/(app)/ai-agents/[id]/page.tsx` + `client-page.tsx` | Tela de edição do agente. |
| `src/components/ai-agents/agent-wizard.tsx` | Wizard de criação. |
| `src/components/ai-agents/agent-playground.tsx` | Playground de teste. |
| `src/components/agent-settings/agent-settings-dialog.tsx` | Diálogo de configuração. |
| `src/components/agent-settings/sections/*.tsx` | Seções: identity, rules, tools, scope, crm-fields, piloting, message-rules, placeholder, openai-key. |
| `src/lib/ai-agents/archetypes.ts` | Espelho dos arquétipos. |
| `src/lib/ai-agents/steering.ts` | Espelho de steering/tool config. |
| `src/lib/ai-agents/tools-catalog.ts` | Espelho do catálogo. |
| `src/lib/ai-agents/piloting.ts` | Espelho de piloting. |
| `src/lib/ai-agents/message-rules.ts` | Espelho de regras. |
| `src/lib/ai-agents/use-tool-catalog.ts` | Hook de catálogo. |
| `src/lib/ai-agents/academic-atendimento-prompt.ts` | Constante de prompt acadêmico espelhada. |
| `src/features/ai-agents/*` | Cockpit, cases, hooks, API client. |

**Risco**: qualquer mudança de contrato HTTP exige ajuste no frontend. O plano prevê estabilizar contrato no backend antes de tocar no frontend.

---

## 4. Dependências externas e infraestrutura

| Dependência | Uso no motor |
|-------------|--------------|
| OpenAI (`@ai-sdk/openai`) | LLM + embeddings. Chave por agente. |
| Vercel AI SDK (`ai`) | `generateText`, `embedMany`, tool-loop. |
| Meta WABA API | Recebimento/envio WhatsApp, templates, typing/read receipts. |
| Baileys | Canal WhatsApp alternativo. |
| Postgres + pgvector | Dados + similarity search de knowledge. |
| Redis | Cache, claims, filas BullMQ. |
| BullMQ | Workers assíncronos (Meta webhook/outbound, automação, campanhas, ETL, distribuição). |
| Storage local/S3 | Documentos de knowledge. |

---

## 5. Variáveis de ambiente relevantes

| Env | Significado |
|-----|-------------|
| `AI_DEFAULT_MODEL` | Modelo padrão de chat. |
| `AI_EMBEDDING_MODEL` | Modelo de embeddings. |
| `AI_AGENT_INACTIVITY_WORKER=0` | Desliga o worker de inatividade. |
| `AI_AGENT_INACTIVITY_INTERVAL_MS` | Tick do worker. |
| `AI_AGENT_IDLE_NUDGE_MS` / `AI_AGENT_IDLE_CLOSE_AFTER_NUDGE_MS` | Nudge/close por silêncio. |
| `AI_AGENT_RETRY_UNANSWERED_MS` | Retry de inbound sem resposta. |
| `AI_TURN_MANAGER` | Liga Turn Manager (default OFF no código atual). |
| `AI_TURN_DEBOUNCE_MS` / `AI_TURN_MAX_WAIT_MS` | Debounce/max wait do turno. |
| `AI_TURN_STALE_MS` / `AI_TURN_MAX_ATTEMPTS` | Teto de PROCESSING travado. |
| `OPENAI_API_KEY` | Não é usada pelo motor de agentes (chave por agente). |

---

## 6. Riscos priorizados

### R1 — Acoplamento com vertical acadêmica (Alto)
- `runner.ts` monta blocos de prompt com funções do pack academic (`formatFirstAccessHint`, `formatExamAccessHint`, etc.).
- `department-routing.ts`, `intercepts.ts`, `atendimento-prompt.ts` contêm strings de departamentos e instituição.
- **Impacto**: impede reutilização do motor para outros clientes/verticais.

### R2 — Dualidade debounce legado vs. Turn Manager (Alto)
- Produção ainda usa `inbound-debounce.ts` (`AI_TURN_MANAGER` default OFF).
- Cancelamento e agrupamento têm lógica duplicada.
- **Impacto**: bugs de concorrência, dificuldade de manutenção, testes duplicados.

### R3 — Handoff espalhado e difícil de auditar (Alto)
- Transferência vive em 5+ arquivos.
- `effect-claims.ts` usa regex para detectar promessas não cumpridas.
- **Impacto**: regressões silenciosas em handoff IA→IA, IA→humano, filas.

### R4 — Prompt assembly não-declarativo (Médio-Alto)
- `runner.ts` e `system-prompt.ts` montam blocos por composição manual e condicional.
- Difícil prever o prompt final sem rodar.
- **Impacto**: drift de prompt, dificuldade de teste.

### R5 — Test harness depende de banco/LLM real (Médio-Alto)
- Replay usa fixtures e organização real.
- Não há executor unitário de run completo com stubs.
- **Impacto**: lenta iteração, dependência de dados de produção.

### R6 — Chave OpenAI por agente sem fallback (Médio)
- Agente sem chave configurada produz run FAILED.
- **Impacto**: operador precisa cadastrar chave em cada agente; falhas se esquecido.

### R7 — `AIAgentConfig` JSONB denso (Médio)
- `toolConfig`, `inboxPolicy`, `businessHours`, `autoClosePolicy`, `qualificationQuestions` são JSONB.
- Normalização é manual e pode divergir entre backend e frontend.
- **Impacto**: bugs de configuração salvos de formas inesperadas.

### R8 — Workers e timers rodando na API (Médio)
- `ai-agent-inactivity-worker` é iniciado via `sse-bus.ts` com `setInterval` na API.
- Não é um worker BullMQ separado.
- **Impacto**: dificulta escala horizontal e isolamento de falhas.

---

## 7. Decisões pendentes para Fase 1

1. **Manter arquétipos fixos ou torná-los templates?** Hoje `AIAgentArchetype` é enum e `AgentTemplate` é tabela separada.
2. **Turn Manager será obrigatório?** Plano propõe sim; precisa confirmar se há requisito de manter debounce legado.
3. **Handoff humano continua via Distribuição Inteligente?** Provavelmente sim; contrato de handoff deve usar o motor de distribuição existente.
4. **Efeitos declarados por tool ou por descrição?** Plano propõe registry estruturado; confirmar se todas as 16 tools devem declarar efeito.
5. **Vertical genérica: só `academic` ou já precisa suportar outra?** Para Fase 2 basta extrair `academic`; nova vertical pode ser adicionada depois.
6. **Prompt blocks: todos no banco, todos no pack, ou híbrido?** Plano propõe pack fornecer blocos e config permitir overrides.
