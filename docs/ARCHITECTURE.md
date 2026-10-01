# Arquitetura do Motor de Agentes de IA

> Versão: Fase 0 — Inventário.  
> Fonte de verdade: backend `src/services/ai/` + `src/lib/ai-agents/` + `src/verticals/`.  
> Consumidor: frontend Next.js em `frontend_crm1_repo/src/features/ai-agents/`.

## 1. Visão geral

O motor de agentes de IA é um runtime LLM multi-tenant acoplado ao CRM. Ele recebe mensagens inbound (WhatsApp/Meta, Baileys, messaging), roda um agente configurado em `AIAgentConfig`, executa um loop de ferramentas (tool-loop) e, dependendo do resultado, responde ao cliente, transfere para um humano ou encerra o ticket.

### Agentes são `User` do tipo `AI`

- Cada agente é um registro em `User` (`type = AI`) ligado 1:1 a `AIAgentConfig`.
- O agente aparece em seletores de responsável, filas de distribuição e presença como qualquer outro usuário.
- O nome visível vem de `User.name`; o comportamento vem de `AIAgentConfig`.

### Fontes de ativação (`RunSource`)

- `inbox` — webhook de mensagem inbound.
- `inbox_test` — replay/QA, ferramentas de efeito são simuladas.
- `playground` — tela de teste do agente.
- `automation` — step de automação.
- `api` — API pública/external.

---

## 2. Componentes principais

### 2.1 Administração / CRUD de agentes

- `src/services/ai-agents.ts` — criação, edição, listagem, redação de chave OpenAI.
- `src/lib/ai-agents/archetypes.ts` — catálogo de arquétipos: SDR, ATENDIMENTO, VENDEDOR, SUPORTE, TABULACAO, ENCERRAMENTO, COORDENADOR.
- `src/lib/ai-agents/tools-catalog.ts` — descrição das tools para o wizard.
- `src/services/ai-agent-templates.ts` — `AgentTemplate` (moldes de sistema + org).
- `src/lib/ai-agents/observability.ts` — diff/audit/hash de config.
- `src/lib/ai-agents/readiness.ts` — valida se agente autônomo tem KB ou escopo.

### 2.2 Runtime de execução

- `src/services/ai/runner.ts` — **coração do motor**. Carrega agente, monta system prompt, chama LLM, persiste `AIAgentRun` + `AIAgentMessage`.
- `src/services/ai/inbox-handler.ts` — **glue entre webhook e runner**. Aplica controles determinísticos (business hours, keyword handoff, opening message, interceptos de vertical, regras de mensagem) antes de chamar o LLM.
- `src/services/ai/provider.ts` — fachada Vercel AI SDK / OpenAI. Multi-tenant por chave de agente.
- `src/services/ai/llm-retry.ts` — retry com timeout por tentativa.
- `src/services/ai/tool-governor.ts` — deduplicação e tetos de chamadas de tool.
- `src/services/ai/run-outcome.ts` — deriva desfecho observado do estado final.
- `src/services/ai/effect-claims.ts` — guardrail determinístico: texto que afirma efeito sem tool ter executado é descartado.

### 2.3 Ferramentas (`tools`)

- `src/services/ai/tools.ts` — implementação de todas as tools (create_deal, move_stage, add_tag, create_activity, search_products, search_crm_records, consultar_matricula, send_whatsapp_template, transfer_to_department, execute_distribution, transfer_to_human, transfer_to_ai_agent, transfer_conversation, close_conversation, list_tabulations, tabulate_conversation).
- Cada tool recebe um `RunContext` e uma `ToolPolicy` opcional (allow/block/defaults).
- As tools executam mutações no CRM (deals, tags, activities, distribution, handoff, etc.).

### 2.4 Handoff / orquestração

- `src/services/ai/agent-handoff.ts` — `executeOrchestratedHandoff`: destinos `department`, `user`, `ai_agent`.
- `src/services/ai/department-handoff.ts` — resolve departamento e roda `executeDistribution`.
- `src/services/ai/coordinator-orchestrate.ts` — orquestrador COORDENADOR escolhe especialista por assunto e aninha `runAgent`.
- `src/services/ai/transfer-gate.ts` — decide se a transferência humana está liberada (política declarativa por `inboxPolicy`).
- `src/services/ai/human-queue-policy.ts` — mensagens de fila, horário de atendimento, fuso.
- `src/services/ai/piloting-actions.ts` — `sendAgentMessage` (persiste/envia OUT) e `executeAgentHandoff`.

### 2.5 Prompt / contexto

- `src/lib/ai-agents/system-prompt.ts` — monta system prompt com template, overrides, data/hora, contexto de contato/deal, regras de fallback.
- `src/lib/ai-agents/piloting.ts` — normalização de piloting (opening, inactivity, keyword, qualification, business hours, outputStyle, autoClose).
- `src/lib/ai-agents/steering.ts` — normalização de `toolConfig`, `inboxPolicy`, `messageRules`, media inbound.
- `src/lib/ai-agents/message-rules.ts` — regras de mensagem declaradas pelo operador.
- `src/services/ai/retrieval.ts` / `retrieval-query.ts` — RAG sobre knowledge docs.
- `src/services/ai/message-models-retrieval.ts` — modelos internos de mensagem como RAG.
- `src/services/ai/academic-record-policy.ts` / `crm-field-policy.ts` / `sensitive-fields.ts` — controle de exposição de dados.

### 2.6 Vertical packs

- `src/verticals/index.ts` — registry. Hoje só `academic`.
- `src/verticals/academic/pack.ts` — interceptos, prompt blocks, fallback rules, aliases, tool copy, inbox defaults, ops.
- `src/verticals/academic/intercepts.ts` — pipeline de interceptos pré/pós assignee.
- `src/verticals/academic/department-routing.ts` — roteamento por regex/tema.
- `src/verticals/academic/atendimento-prompt.ts` — constantes de prompt acadêmico.
- `src/verticals/academic/closure.ts` — detecção de despedida.
- `src/verticals/academic/ensure-dept-roster.ts` — seed de departamentos acadêmicos.
- `src/verticals/types.ts` — contrato genérico de vertical pack.

### 2.7 Ingestão / debounce / turnos

- `src/services/ai/inbound-debounce.ts` — debounce legado por conversação (Map + Redis claim). Ainda é o caminho de produção quando `AI_TURN_MANAGER` está desligado.
- `src/services/ai/turn-manager.ts` — novo agrupamento persistente de mensagens em `ConversationTurn`.
- `src/services/ai/turn-sweeper.ts` — sweeper que promove turnos READY e reclama PROCESSING travados.
- `src/services/ai/inbound-debounce.ts` também invalida turnos e cancela geração.

### 2.8 Workers / cron / timers

- `src/services/ai-agent-inactivity-worker.ts` — `setInterval` na API: follow-up/check-in, encerramento por silêncio, handoff por inatividade, retry de inbound sem resposta.
- `src/services/ai/turn-sweeper.ts` — worker/cron para `ConversationTurn`.
- `src/services/ai/sweep-finished-ai-conversations.ts` — varredura de conversas encerradas.
- `src/services/ai/replay-stuck-inbox.ts` — diagnóstico de inbounds presos.

### 2.9 Teste / QA / diagnóstico

- `src/scripts/replay-agent-runs.ts` — harness de replay em lote com fixtures.
- `src/app/api/ai-agents/[id]/test/route.ts` — playground dry-run com interceptos.
- `src/app/api/ai-agents/preview-prompt/route.ts` — preview do system prompt.
- `src/services/ai/test-mode*.ts` — modo de teste da conversa (tools de efeito simuladas).
- `src/services/ai/__tests__/*.ts` — 28 testes unitários de subsistemas.
- Auditoria externa: `auditoria_agentes.md`, `auditoria_agentes_parte2.md`, `auditoria_agentes_parte3.md`, `auditoria_agentes_parte4.md`.

---

## 3. Modelos de dados (Prisma)

- `AIAgentConfig` — configuração completa do agente (prompt, model, tools, piloting, steering, inboxPolicy, toolConfig, verticalPack, etc.).
- `AIAgentRun` — cada invocação do runner.
- `AIAgentMessage` — mensagens system/user/assistant/tool de um run.
- `AIAgentKnowledgeDoc` / `AIAgentKnowledgeChunk` — base de conhecimento vetorizada (pgvector).
- `AIAgentConfigAudit` — diff de alterações de config.
- `AgentTemplate` — moldes reutilizáveis.
- `ConversationTurn` — agrupamento persistente de inbound (Fase 1).
- `User` (`type = AI` / `HUMAN`), `Conversation`, `Message`, `Deal`, `Contact`, `Department`, `Pipeline`, `Stage`, `Tag`, etc.

---

## 4. Fluxos típicos

### 4.1 Inbound normal (modo legado / AI_TURN_MANAGER=0)

```
webhook Meta/Baileys
  → inbound-debounce (claim Redis + Map timer)
  → inbox-handler
       → kill-switch (ai.newAttendanceEnabled)
       → phone allowlist
       → test mode
       → vertical intercepts (pre_assignee)
       → message rules
       → opening message
       → runAgent
            → load agent/config
            → RAG knowledge + message models
            → render system prompt
            → generateWithTools (maxSteps)
            → persist AIAgentRun/Messages
            → effect-claims guardrail
            → derive outcome
       → sendAgentMessage (AUTONOMOUS) or draft (DRAFT)
       → follow-up media
```

### 4.2 Inbound com Turn Manager (AI_TURN_MANAGER=1)

```
webhook
  → turn-manager.appendToOpenTurn
  → estabiliza para READY
  → turn-sweeper / fast path claim
  → inbox-handler (com aggregatedText)
  → runAgent
```

### 4.3 Playground / teste

```
POST /api/ai-agents/[id]/test
  → message rules
  → vertical intercepts (dry-run)
  → runAgent(source=playground)
  → retorna text + systemPromptSnapshot + confidence
```

### 4.4 Coordenador

```
inbound para agente COORDENADOR
  → coordinator-orchestrate (antes do LLM)
       → pickPeerForTopic
       → executeOrchestratedHandoff
       → runNested(runAgent no especialista)
  → resultado unido com tool sintética transfer_to_ai_agent
```

---

## 5. API routes relacionadas

### Administração

- `GET/POST /api/ai-agents` — listar/criar.
- `GET/PUT/DELETE /api/ai-agents/[id]` — ler/editar/excluir.
- `POST /api/ai-agents/[id]/toggle-active` — ativar/desativar.
- `GET /api/ai-agents/[id]/stats` — estatísticas.
- `POST /api/ai-agents/[id]/test` — playground.
- `POST /api/ai-agents/preview-prompt` — preview de prompt.
- `GET/POST /api/ai-agents/[id]/knowledge` — docs de conhecimento.
- `GET/DELETE /api/ai-agents/[id]/knowledge/[docId]` — doc específico.
- `GET /api/ai-agents/metadata` — arquétipos, models, tools.
- `GET /api/ai-agents/crm-fields` — catálogo de campos CRM.
- `GET /api/ai-agents/product-fields` — catálogo de campos de produto.
- `POST /api/ai-agents/[id]/message-rules/test` — testar regras de mensagem.
- `POST /api/ai-agents/drafts/[messageId]/approve|discard` — aprovar/rascunho.

### Status / presença / cockpit

- `GET /api/agents/status` — status de agentes humanos.
- `PUT /api/agents/[id]/status` — atualizar status.
- `POST /api/agents/me/ping` — heartbeat.
- `POST /api/agents/me/activity` — atividade.
- `GET /api/agents/schedules` — horários.
- `GET/PUT /api/agents/[id]/schedule` — horário individual.
- `POST /api/agents/inbound-voice` — chamada de voz.
- `GET /api/public/agent-cockpit` — cockpit de leitura.
- `GET /api/public/agent-cockpit/cases` — casos do cockpit.
- `GET /api/monitor/agents` — monitoramento.
- `GET /api/inbox/agent-capacity` — capacidade.

### Permissões

- `GET/PUT /api/settings/agent-permissions/[userId]` — permissões de agente.
- `GET/PUT /api/settings/agent-permissions` — permissões gerais.

---

## 6. Dependências externas

- **OpenAI** — LLM e embeddings. Chave por agente (`openaiApiKeyEnc`), sem fallback global.
- **Meta WhatsApp Business API** — envio/recebimento de mensagens, templates, indicadores "digitando" e "lido".
- **Baileys** — canal WhatsApp alternativo.
- **Postgres + pgvector** — embeddings de knowledge docs.
- **Redis** — cache, claim de mensagens, geração, filas BullMQ.
- **BullMQ** — filas de workers (Meta webhook/outbound, automações, campanhas, ETL, distribuição).

---

## 7. Riscos arquiteturais atuais

1. **Acoplamento com vertical acadêmica**: `academic` é o único pack; strings, regex e departamentos (`Acolhimento`, `Retenção`, `Atendimento`, `Cruzeiro do Sul`) estão espalhados em prompts, interceptos e regras.
2. **Dualidade runtime**: debounce legado (`inbound-debounce.ts`) e Turn Manager (`turn-manager.ts`) coexistem via flag `AI_TURN_MANAGER`, duplicando lógica de agrupamento e cancelamento.
3. **Prompt assembly complexo**: `runner.ts` monta dezenas de blocos de prompt condicionais (`portalAccessHint`, `examAccessHint`, etc.) dependendo de pack, tools habilitadas e regras salvas. Difícil testar e auditar.
4. **Handoff disperso**: lógica de transferência vive em `tools.ts`, `agent-handoff.ts`, `department-handoff.ts`, `coordinator-orchestrate.ts`, `piloting-actions.ts`, `inbox-handler.ts` e interceptos verticais.
5. **Testabilidade limitada**: replay/QA depende de fixtures e dumps de produção; não há harness unitário que execute um run completo de ponta a ponta sem banco/LLM real.
6. **Efeitos colaterais ocultos**: tools mutam estado do CRM; o guardrail de `effect-claims` é reativo (pós-LLM) e baseado em regex, não em contrato explícito de efeito.
7. **Autonomia vs draft**: a decisão de enviar direto ou gravar rascunho depende de `autonomyMode`, mas a lógica de envio real (Meta, Baileys, SSE) fica em `piloting-actions.ts` e `send-agent-media.ts`, misturando runtime com infraestrutura.
8. **Chave OpenAI por agente**: sem fallback global, um agente sem chave falha silenciosamente em produção (run FAILED).
