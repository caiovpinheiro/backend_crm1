# Capacidades do CRM usadas pela v2

> Inventário do que já existe no backend para a v2 reaproveitar, e o que precisa ser criado.  
> Cobre 100% das seções 3 e 7 do `docs/SPEC_V2.md`.  
> Todos os caminhos são relativos a `backend_crm1_repo`.

---

## 1. Departamentos, filas e usuários

| Conceito | Modelo / Service | API existente | Observação |
|---|---|---|---|
| Departamentos | `prisma.department` | `GET /api/settings/departments` — `src/app/api/settings/departments/route.ts` | Lista id, nome, cor, ícone, `requireTabulationOnClose`, contagem de membros/conversas. |
| Membros de departamento | `prisma.departmentMember` | `GET/PUT/POST/DELETE /api/settings/departments/[id]/members` | Associação N:N de usuários a departamentos. |
| Usuários | `prisma.user` | `GET /api/users` — `src/app/api/users/route.ts` | Humanos e agentes IA (`type=AI`). |
| Fila de espera | `prisma.distributionPending` | `GET /api/distribution/pending`, `POST /api/distribution/pending/retry` | Leads sem responsável elegível. |
| Permissões | `prisma.role`, `prisma.userRoleAssignment` | `/api/settings/permissions/*`, `/api/users/[id]/effective-permissions` | Quem edita/publica agentes v2. |

### Serviço para usar na v2

- Listagem: `GET /api/settings/departments` e `GET /api/users`.
- Handoff: `executeDistribution` em `src/services/distribution/engine.ts` (`600:1250`) com `triggerSource: "AI_AGENT"`.
- Simulação: `simulateDistribution`.
- Handoff por usuário específico: chamar `executeDistribution` passando `userId` e sem regra/fila.

### O que falta

- **API de catálogo combinado** para a tela `/ai-agents-v2` (departamentos, usuários, pipelines/stages, campos, tabulações, modelos, templates, produtos, canais, regras de distribuição).

---

## 2. Distribuição inteligente

| Conceito | Arquivo / função | API | Observação |
|---|---|---|---|
| Motor | `src/services/distribution/engine.ts` `executeDistribution` | `POST /api/distribution/execute` | Avalia elegibilidade e atribui dono. |
| Simulação | `src/services/distribution/engine.ts` `simulateDistribution` | `POST /api/distribution/simulate` | Sem efeitos colaterais. |
| Elegibilidade | `src/services/distribution/assignee-eligibility.ts`, `responsibles.ts` | - | Online, fila, expediente. |
| Regras de distribuição | `src/services/lead-distribution.ts`, `src/app/api/distribution/route.ts` | `GET/POST /api/distribution` | `ROUND_ROBIN`, `RULE_BASED`, `MANUAL` por pipeline. |
| Disponibilidade | `src/services/lead-distribution.ts` `isAgentAvailable` | - | Online + horário de trabalho + almoço. |
| Escopo por departamento | `resolveDepartmentScope` em `src/services/distribution/engine.ts` | - | Respeita `distributionEnabled`. |

### Serviço para usar na v2

- Handoff único: `executeDistribution({ conversationId, contactId, dealId, triggerSource: "AI_AGENT", departmentId, userId, reassign: true })`.
- Testar destino: `simulateDistribution`.

### O que falta

- API que liste as regras de distribuição para a tela escolher a fila padrão do agente.

---

## 3. Pipelines e etapas

| Conceito | Arquivo / função | API | Observação |
|---|---|---|---|
| Pipelines | `src/services/pipelines.ts` | `GET/POST /api/pipelines` | Lista com stages. |
| Etapas | `prisma.stage` | `GET /api/pipelines/[id]/stages` | Dentro de um pipeline. |
| Mover negócio | `src/services/deals.ts` `moveDeal`, `updateDeal` | - | Usados pelas tools `move_stage`. |
| Reabrir ticket | `src/services/conversations.ts` `reopenResolvedAsNewTicket` | - | Cria ticket novo a partir de RESOLVED. |

### Serviço para usar na v2

- Catálogo: `GET /api/pipelines?includeStages=true`.
- Mover etapa: tool `move_stage` do `FACTORY_MAP` (`src/services/ai/tools.ts` `2215:2231`).
- Devolver à etapa de origem: guardar `originStageId` no estado ao iniciar atendimento e chamar `moveDeal` no encerramento.
- Janela pós-encerramento: `reopenResolvedAsNewTicket` para "nova demanda" dentro da janela.

### O que falta

- Estado v2 com `originStageId`, `postCloseWindowEndAt`, `closeReason`.
- Classificador de mensagem pós-encerramento (cortesia | demanda nova | ambíguo).
- Ação de devolver card à etapa de origem ao encerrar.

---

## 4. Campos de contato e de negócio

| Conceito | Arquivo / função | API | Observação |
|---|---|---|---|
| Catálogo de campos | `src/services/ai/crm-field-policy.ts` `loadCrmFieldCatalog` | `GET /api/ai-agents/crm-fields` | Builtin + custom fields; sensibilidade. |
| Allowlist de leitura | `isFieldReadable`, `partitionFieldValues` em `crm-field-policy.ts` | - | Libera campos configurados. |
| Busca de registros | `search_crm_records` tool em `src/services/ai/tools.ts` | - | Contato, empresa, negócio, produto, record sources. |
| Record sources | `src/services/ai/record-sources.ts` `CORE_RECORD_SOURCES` | - | Contato, empresa, negócio, produto. |
| Campos personalizados | `prisma.customField`, `src/services/custom-fields.ts` | `GET/POST /api/custom-fields` | Por entidade. |
| Identificação por campo | `resolveIdentityFields`, `identityValueMatches`, `normalizeIdentityValue` em `crm-field-policy.ts` | - | Casamento exato de identificador. |
| Atualizar negócio | `updateDeal` em `src/services/deals.ts` | - | Usado por `move_stage`; não há tool genérica `update_field`. |

### Serviço para usar na v2

- `loadCrmFieldCatalog`, `partitionFieldValues`, `isFieldReadable`.
- `resolveIdentityFields`, `identityValueMatches`.
- Record source `dealSource` para múltiplos negócios abertos.

### O que falta

- Permissão explícita `cite` (mostrar rótulo sem valor) além de `read`/`write`.
- Tool genérica `update_field` no `FACTORY_MAP`.
- Tool/service para criar contato quando cliente não existe.

---

## 5. Tabulações

| Conceito | Arquivo / função | API | Observação |
|---|---|---|---|
| Árvore | `src/services/tabulations.ts` `getTree`, `createNode` | `GET/POST /api/settings/tabulations?departmentId=...` | Hierarquia por departamento. |
| Classificador | `src/services/ai/tabulation-classify.ts` | - | Classifica conversa via LLM. |
| Tools | `list_tabulations`, `tabulate_conversation` no `FACTORY_MAP` | - | Já usadas pela v1. |
| Requisito no fechamento | `Department.requireTabulationOnClose` | - | Departamento exige tabulação. |

### Serviço para usar na v2

- Listar: `GET /api/settings/tabulations?departmentId=...`.
- Classificar: tool `tabulate_conversation` ou serviço subjacente.

### O que falta

- Mapa tema → tabulação sugerida na config v2.
- Modo "classificar automaticamente" vs "sugerir para pessoa confirmar".

---

## 6. Modelos de mensagem e templates oficiais do WhatsApp

| Conceito | Arquivo / função | API | Observação |
|---|---|---|---|
| Modelos internos (`MessageTemplate`) | `src/services/templates.ts`, `src/services/ai/message-models-retrieval.ts` | `GET/POST /api/templates` | Texto com variáveis, anexos, categoria. |
| Busca lexical | `retrieveRelevantMessageModels` em `src/services/ai/message-models-retrieval.ts` | - | Usado pelo runner v1. |
| Templates Meta aprovados | `prisma.whatsAppTemplateConfig` | `GET /api/whatsapp-template-configs/approved` | Sincronizados da Meta. |
| Config local de templates | `prisma.whatsAppTemplateConfig` | `GET/PUT /api/whatsapp-template-configs` | Label, `agentEnabled`, body preview. |
| Envio de template | `send_whatsapp_template` tool no `FACTORY_MAP` | - | Envia template pelo WhatsApp. |
| Janela de sessão 24h | `getConversationSession` em `src/lib/channel-session.ts` | `GET /api/conversations/[id]/session-debug` | Botões/template de sessão. |
| Preenchimento de variáveis | `build-template-components.ts`, `buildOutboundTemplateMessageContent.ts` | - | Substitui `{{1}}`. |
| Renderização de mensagens | **novo** `src/lib/ai-v2/message-render.ts` | - | Variáveis `@Campo`, trechos condicionais `{...}`, formatação por tipo. |

### Serviço para usar na v2

- Modelos internos: `GET /api/templates`.
- Busca: `retrieveRelevantMessageModels` com filtro por tema.
- Templates aprovados: `GET /api/whatsapp-template-configs/approved`.
- Enviar template: tool `send_whatsapp_template`.
- Janela: `getConversationSession`.
- Preencher variáveis: `message-render.ts` para modelos internos + `build-template-components.ts` para templates Meta.

### O que falta

- Tools `list_message_models` e `send_message_model` no `FACTORY_MAP`.
- Allowlist de modelos por tema.
- Política "enviar como está" vs "adaptar levemente".
- Fallback de template oficial quando a janela de 24h expirou.

---

## 7. Catálogo de produtos

| Conceito | Arquivo / função | API | Observação |
|---|---|---|---|
| Modelo de produto | `prisma.product` | `GET/POST /api/products` | Produtos/serviços com preço, SKU, campos customizados. |
| Busca | `search_products` tool em `src/services/ai/tools.ts` | - | Por nome, SKU, descrição, campos customizados. |
| Política de apresentação | `AIAgentConfig.productPolicy` (JSON) | - | Orienta o prompt v1. |
| Envio de produto no WhatsApp | `src/services/conversation-products.ts` | `POST /api/conversations/[id]/products` | Nativo Meta ou fallback texto/imagem. |
| Vínculo produto ↔ Meta | `src/services/meta-catalog.ts`, `ProductMetaLink` | - | Publica item no catálogo Meta. |

### Serviço para usar na v2

- Consulta: `search_products`.
- Política: mover `productPolicy` para `themes[].productPolicy`.
- Envio: reaproveitar `src/services/conversation-products.ts` via tool `send_product`.

### O que falta

- Tool `send_product` no `FACTORY_MAP`.
- Política de produtos por tema (preço, imagem, link, quantos itens, ações ligadas).
- Ações: vincular produto ao negócio, criar negócio com produto, registrar interesse, enviar proposta.

> **Nota:** por padrão a v2 NÃO responde preço/grade de cursos. Responder produto só é ativado por tema, desligado por padrão.

---

## 8. Automações

| Conceito | Arquivo / função | API / step | Observação |
|---|---|---|---|
| Automações | `src/services/automations.ts`, `src/services/automation-executor.ts` | `GET/POST /api/automations` | Canvas de automações. |
| Transferir para agente de IA | step `transfer_to_ai_agent` em `src/services/automation-executor.ts` | - | Atribui `User.type=AI` e pode enviar saudação. |
| Perguntar ao agente de IA | step `ask_ai_agent` em `src/services/automation-executor.ts` | - | Chama `runAgent` e salva resposta. |
| Contexto | `src/services/automation-context.ts` | - | Mantém `AutomationContext` RUNNING/PAUSED com variáveis. |
| Variáveis | `interpolateVariables` em `src/services/automation-context.ts` | - | Substitui `{{nome}}`. |
| Continuação | `continueFromStep` em `src/services/automation-executor.ts` | - | Retoma step após resposta. |
| Bridge v2 | **novo** `src/services/ai-v2/automation-bridge.ts` | - | Lê contexto ativo ao entrar; chama `continueFromStep` ao encerrar quando configurado. |

### Serviço para usar na v2

- Entrada de automação: `automation-bridge.ts` lê `AutomationContext` ativo e expõe variáveis.
- Saída: ao encerrar, se houver `nextAutomationStep` na config, chamar `continueFromStep`.

### O que falta

- Step de automação configurável "devolver para automação X no step Y".
- Gravação do `source: "automation"` no trace.

---

## 9. Canais, mídia recebida e transcrição

| Conceito | Arquivo / função | API | Observação |
|---|---|---|---|
| Canais | `src/services/channels.ts` | `GET/POST /api/channels` | WhatsApp (Meta/Baileys), Instagram, Facebook, e-mail, webchat. |
| Janela 24h | `getConversationSession` em `src/lib/channel-session.ts` | `GET /api/conversations/[id]/session-debug` | Define botões/template de sessão. |
| Recebimento Meta | `src/lib/meta-webhook/handler.ts`, `src/lib/meta-webhook/messaging-handler.ts` | - | Cria `Message` com `messageType`, `mediaUrl`, `interactiveButtonId`. |
| Recebimento Baileys | `src/workers/baileys/message-handler.ts` | - | Áudio, imagem, documento. |
| Placeholder de mídia | `src/lib/ai-agents/media-placeholder.ts` | - | Mapeia `[Áudio]`, `[Imagem]` etc. |
| Decisão determinística de mídia | `src/services/ai/audio-inbound.ts`, `src/services/ai/media-inbound.ts` | - | Áudio → handoff; imagem/documento → política `inboxPolicy.media`. |
| Transcrição de áudio | `POST /api/media/transcribe` — `src/app/api/media/transcribe/route.ts` | - | Groq Whisper + fallback HF. |
| Envio de botões/lista | `sendInteractiveButtonsToConversation`, `sendInteractiveListToConversation` em `src/services/outbound-messaging.ts` | Rotas internas | Limites Meta. |
| Clique inbound | `parseInteractiveBlock` em `src/lib/meta-webhook/handler.ts` | - | Extrai `interactiveButtonId`. |
| Anexos | `src/app/api/conversations/[id]/attachments/route.ts` | `POST /api/conversations/[id]/attachments` | Download/upload. |

### Serviço para usar na v2

- Canal: `conversation.channel` / `channelId`.
- Áudio: `POST /api/media/transcribe` quando config = `transcrever`.
- Imagem/documento: hoje só handoff/pedir texto; OCR/leitura de documento **não existe**.
- Botões/lista: `sendInteractiveButtonsToConversation` / `sendInteractiveListToConversation` quando Meta + janela aberta.
- Clique: `Message.interactiveButtonId` + tabela de opções pendentes.

### O que falta

- OCR/visão para imagens.
- Leitura de texto em documentos diversos (PDF não é suportado em `knowledge-extract.ts`).
- Tabela/serviço de opções pendentes (`AIV2PendingInteractive`).
- Fallback numerado + interpretação por número/rótulo.
- Regras determinísticas por tipo de mídia no motor v2.
- Classificador de mensagem pós-encerramento.

---

## 10. Horários de atendimento e feriados

| Conceito | Arquivo / função | API | Observação |
|---|---|---|---|
| Horário do agente | `AIAgentConfig.businessHours` (JSON) + `inboxPolicy.humanAttendanceHours` | - | Configurado na tela do agente v1. |
| Resolução de fuso/horário | `src/services/ai/human-queue-policy.ts` `resolveAgentTimezone`, `isHumanAttendanceWindowOpen` | - | Default seg–sex 8h–19h, sáb 9h–16h. |
| Business hours genérico | `src/lib/ai-agents/piloting.ts` `normalizeBusinessHours`, `isWithinBusinessHours` | - | Validação de JSON de horário. |
| Disponibilidade do usuário | `src/services/lead-distribution.ts` `isAgentAvailable` | - | Online + schedule. |
| Feriados | `OrganizationSetting` (JSON) | - | **Não existe tabela**; usar chave JSONB por organização. |

### Serviço para usar na v2

- `resolveAgentTimezone`, `isHumanAttendanceWindowOpen`, `isWithinBusinessHours`.
- Feriados: `OrganizationSetting` com chave `ai_v2.holidays` (lista de datas).

### O que falta

- UI/API para editar feriados na config da organização.
- Integração de feriados no cálculo de horário.

---

## 11. RAG

| Conceito | Arquivo / função | API | Observação |
|---|---|---|---|
| Docs de conhecimento | `src/services/ai/knowledge-docs.ts` | `GET/POST /api/ai-agents/[id]/knowledge` | CRUD + validade + status. |
| Chunking + embeddings | `src/services/ai/embeddings.ts` `chunkText`, `indexKnowledgeDoc` | - | Chunks, embeddings via `embedTexts`. |
| Busca vetorial | `src/services/ai/retrieval.ts` `retrieveAgentKnowledge` | `GET /api/ai-agents/[id]/knowledge?search=...` | pgvector, topK, validade. |
| Regras de resposta | `src/services/ai/retrieval.ts` `KNOWLEDGE_ANSWER_RULES`, `formatRetrievalBlock` | - | Proíbe "varia", "depende", força enumeração. |
| Extração de documentos | `src/services/ai/knowledge-extract.ts` | - | Suporta `.txt`, `.md`, `.csv`, `.tsv`, `.docx`; **não PDF**. |

### Serviço para usar na v2

- CRUD e indexação: reaproveitar.
- Busca: `retrieveAgentKnowledge` com filtro por `themeIds`.
- Regras de resposta: `KNOWLEDGE_ANSWER_RULES` + `formatRetrievalBlock`.

### O que falta

- Associação documento ↔ tema (`theme_ids` em `AIAgentKnowledgeDoc`).
- Busca filtrada por tema.
- Suporte a PDF na extração.
- Lacunas de conhecimento: **nova tabela** `AIV2KnowledgeGap` (pergunta, tema, agente, frequência, status) + endpoint de listagem e ação "virar material".

---

## 12. Registry de ferramentas e function calling

| Conceito | Arquivo / função | Observação |
|---|---|---|
| Fachada LLM | `src/services/ai/provider.ts` `generateWithTools` | Retry, timeout, abort. |
| Tool factories | `src/services/ai/tools.ts` `FACTORY_MAP` | Tools v1. |
| Construção do toolset | `src/services/ai/tools.ts` `buildToolSet` | Policy, governor, test mode. |
| Governor | `src/services/ai/tool-governor.ts` `ToolCallGovernor` | Limites por run/tool. |
| Contexto das tools | `RunContext` em `src/services/ai/tools.ts` | conversationId, contactId, dealId, etc. |

### Serviço para usar na v2

- LLM: `generateWithTools`.
- Tools de consulta: `search_crm_records`, `search_products`.
- Tools de efeito existentes: `create_deal`, `add_tag`, `create_activity`, `move_stage`, `send_whatsapp_template`, `close_conversation`, `tabulate_conversation`, `execute_distribution`.
- Governor: `ToolCallGovernor`.
- Test mode: `withTestModeSimulation`.

### O que falta

- Tools novas: `update_field`, `send_message_model`, `send_product`, `list_message_models`, `ask_with_options`, `knowledge_search`.
- Allowlist de tools por tema na config v2.

---

## 13. Mensagens interativas (botões e listas)

| Conceito | Arquivo / função | API | Observação |
|---|---|---|---|
| Envio de botões | `sendInteractiveButtonsToConversation` em `src/services/outbound-messaging.ts` | Rotas internas | Até 3 botões, título ≤ 20 chars. |
| Envio de lista | `sendInteractiveListToConversation` em `src/services/outbound-messaging.ts` | Rotas internas | Até 10 opções. |
| Clique inbound | `parseInteractiveBlock` em `src/lib/meta-webhook/handler.ts` | - | Extrai id do botão. |
| Janela 24h | `getConversationSession` em `src/lib/channel-session.ts` | - | Botões só dentro da janela Meta. |

### Serviço para usar na v2

- Enviar opções: serviços de outbound-messaging quando Meta + janela aberta.
- Receber clique: `Message.interactiveButtonId` + `AIV2PendingInteractive`.
- Fallback: implementar lista numerada em texto + template aprovado fora da janela.

### O que falta

- Tabela/serviço de opções pendentes.
- Montador de fallback numerado.
- Configuração UI de botões/lista por mensagem.

---

## 14. Auditoria de config, chave e custo por agente

| Conceito | Arquivo / função | API | Observação |
|---|---|---|---|
| Auditoria de config | `AIAgentConfigAudit` (`prisma/schema.prisma` `5010:5025`) | - | Grava diff de create/update. |
| Chave OpenAI por agente | `src/services/ai/agent-key.ts` `getAgentApiKey` | - | Lê `AIAgentConfig.openaiApiKeyEnc`. |
| Custo estimado | `src/lib/ai-agents/pricing.ts` `estimateCost` | - | Preços por modelo. |
| Teto de tokens | `AIAgentConfig.dailyTokenCap` | - | Já existe. |
| Uso do agente | `AIAgentRun` | `GET /api/ai-agents/[id]/stats` | Runs, handoffs, tokens. |
| Permissões | `src/lib/authz/permissions.ts` | - | Verifica `settings:ai`. |

### Serviço para usar na v2

- Auditoria: `AIAgentConfigAudit` com `source: "simple"`.
- Chave: `getAgentApiKey(agentId)`.
- Custo: `estimateCost(model, inputTokens, outputTokens)`.
- Teto: respeitar `dailyTokenCap` e `costCap`; ao estourar, handoff.

### O que falta

- Endpoint de publicar config v2.
- Endpoint de listar/reverter versões.
- Custo acumulado por turno no log v2.
- Fallback de chave configurável.

---

## 15. Guardas, privacidade e comportamento

| Conceito | Arquivo / função | Observação |
|---|---|---|
| Domínios autorizados | **novo** `src/services/ai-v2/output-guard.ts` | Remove URLs cujo host não esteja na allowlist antes de enviar. |
| Dados sensíveis | `crm-field-policy.ts` `sensitiveTerms` | Campos que o agente nunca pede. |
| "Não quero falar com robô" | Regra v2 | Transferência imediata. |
| Nunca prometer retorno | Regra global + output guard | Se depender de outra pessoa, transfere na hora; não há memória entre conversas nesta versão. |

---

## Resumo do que NÃO existe hoje

1. Catálogo combinado da configuração v2.
2. Motor determinístico de regras pré-LLM na v2.
3. Motor de temas com allowlist de tools/documentos/modelos/produtos.
4. Variáveis fixas da empresa + variáveis da automação.
5. Renderizador de mensagens com `@variáveis` e trechos condicionais.
6. Bridge automação ↔ v2.
7. Tools novas: `update_field`, `send_message_model`, `send_product`, `list_message_models`, `ask_with_options`, `knowledge_search`.
8. Associação knowledge docs ↔ tema e busca filtrada.
9. Extração de PDF.
10. OCR/visão para imagens e leitura de documentos diversos.
11. Handoff por usuário específico ou estratégia de distribuição configurada.
12. Devolução do card à etapa de origem ao encerrar.
13. Estado de dono da conversa e troca no trace.
14. Classificador e ação pós-encerramento.
15. Opções pendentes e execução determinística de cliques.
16. Política de produtos por tema (desligada por padrão).
17. Pesquisa de satisfação e detecção de humor do cliente.
18. Suporte a feriados (usar `OrganizationSetting` JSON).
19. Tabela de lacunas de conhecimento.
20. Wizard v2 com os três fluxos e telas da seção 6 do SPEC.
21. Painel "por que respondeu isso?".
22. Script `scripts/ai-v2-check-context.ts`.
