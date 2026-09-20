# AUTOVERIFICAÇÃO — Motor de Agentes v2

Estado real do código em `src/services/ai-v2`, `src/lib/ai-v2`, `src/app/api/ai-agents-v2` e `frontend_crm1_repo/src/app/(app)/ai-agents-v2` comparado com `docs/SPEC_V2.md`.

> Regra aplicada: **pessimista**. Se algo está declarado no schema/config mas nenhum código o usa ponta a ponta, marca como **SÓ CONFIG**. Se a lógica existe mas não cobre todos os cenários do SPEC, marca **PARCIAL**. Só marca **PRONTO E TESTADO** quando há arquivo, função e teste que provam o comportamento.

---

## Tabela de status

| # | Item do SPEC | Estado | Arquivo / função | Evidência | O que falta |
|---|--------------|--------|------------------|-----------|-------------|
| 1 | **Contexto: identificação por telefone** | PARCIAL | `src/services/ai-v2/context.ts` `loadV2Context` | Carrega `contact` a partir do `contactId` da conversa (`processV2Turn` linha 119). Script `scripts/ai-v2-check-context.ts` busca por telefone. | Não identifica o contato pelo número do remetente dentro do motor — assume que a conversa já tem `contactId`. Não trata “cliente não encontrado” nos 3 modos do SPEC; se `contactId` ausente, apenas retorna erro. |
| 1 | **Campos com ler / citar / atualizar** | PARCIAL | `src/services/ai-v2/context.ts` `buildExposure` + `partitionFieldValues` | `context.ts:26-38` só inclui campos com permissão `read`/`cite` no snapshot. Testes unitários não cobrem a política. | `update_field` em `actions.ts:76-93` atualiza qualquer campo sem consultar a allowlist de escrita. Não há enforcement de `write`. |
| 1 | **Vários negócios abertos** | PARCIAL | `src/services/ai-v2/context.ts` `loadV2Context` linhas 158-183 | Busca até 5 deals e usa `deals[0]` como `selectedDeal`. | Não pergunta ao cliente qual deal quando há mais de um; não usa campos “citar” para escolher. |
| 1 | **Record sources (bases adicionais)** | NÃO EXISTE | — | `context.ts` usa apenas `contact`/`deal`. | Nenhuma integração com `record-sources` ou fontes externas. |
| 2 | **Variáveis fixas da empresa** | PRONTO E TESTADO | `src/lib/ai-v2/message-render.ts` `buildVariableMap` | Variáveis do agente + campos do contato/negócio são unidos e renderizados. Testes em `__tests__/unit.test.ts:55-75`. | — |
| 2 | **Mensagens com trecho condicional `{ }`** | PRONTO E TESTADO | `src/lib/ai-v2/message-render.ts` `renderMessage` | Suporta `@Var{ texto }` e remove blocos quando `Var` está vazio. Testes em `unit.test.ts:70-77`. | — |
| 2 | **TODAS as mensagens passam pelo renderer** | PARCIAL | `src/services/ai-v2/engine.ts` | `confirmationMessage`, `identificationMessage`, `handoff.message`, `goodbyeMessage`, mensagens de mídia usam `renderMessage`. | A resposta principal (`llmOutput.reply`) é enviada diretamente em `engine.ts:489` sem passar por `renderMessage`. Portanto variáveis/condicionais podem não ser aplicadas à resposta do modelo. |
| 3 | **Entrada: cliente iniciou** | PARCIAL | `src/services/ai-v2/engine.ts` `processV2Turn` | Fluxo de `idle` → `confirming`/`identifying`/`handoff` existe. Teste em `engine.test.ts:160-177`. | Não diferencia origem “cliente” vs “automação” vs “pessoa” além do `owner` já gravado. |
| 3 | **Entrada: automação (lê AutomationContext e variáveis)** | PARCIAL | `src/services/ai-v2/automation-bridge.ts` `loadV2AutomationBridge` + `mapAutomationVariables` | Lê `getContactActiveContexts` e mapeia variáveis conforme `entry.automationVariablesMapping`. | As variáveis mapeadas são injetadas em `vars`, mas não há teste de ponta a ponta. `continueV2AutomationOnClose` existe mas **não é chamado** no encerramento. |
| 3 | **Entrada: pessoa/outro agente** | PARCIAL | `src/services/ai-v2/engine.ts` linha 164 | Se `owner === "pessoa"`, apenas registra e não responde. | Não detecta automaticamente que uma pessoa respondeu para trocar o dono; a troca só acontece via handoff do botão “devolver para IA” (não implementado no frontend v2). |
| 4 | **Mídia: áudio transcrito antes das regras** | SÓ CONFIG | `src/services/ai-v2/media.ts` `evaluateV2Media` | Aceita config `media.audio.action = "transcribe"`. | Nenhuma transcrição é feita. `evaluateV2Media` apenas retorna `{action, message}`; o motor trata `transcribe` igual a `handoff`/`ask_text` no `engine.ts:261-290` (sempre handoff). |
| 4 | **Mídia: imagem/describe** | SÓ CONFIG | `src/services/ai-v2/media.ts` | Config existe. | Não há OCR/visão. Qualquer imagem/documento com `action = "describe"` cai no mesmo handoff genérico. |
| 5 | **Regras determinísticas: condições** | PARCIAL | `src/services/ai-v2/rules.ts` `evaluateV2Rules` | Implementa `message_type`, `keywords`, `first_message`, `deal_stage`, `field_equals`, `no_deal`, `media_kind`, `negate`. Testes em `unit.test.ts:80-120`. | `out_of_hours` sempre recebe `withinBusinessHours: true` em `engine.ts:300`. `contact_tag` sempre recebe `[]`. `survey_received` sempre retorna `false`. Portanto 3 condições são SÓ CONFIG. |
| 5 | **Regras determinísticas: ações** | PARCIAL | `src/services/ai-v2/rules.ts` + `engine.ts:319-348` | `send_message`, `handoff`, `close_conversation`, `no_reply`, `set_theme`, `add_tag`, `record_knowledge_gap` são executadas. | `set_variable` não altera estado persistente. `send_message_model` não envia modelo. Regras com `send_message` fixo não passam pelo renderer. |
| 6 | **Temas: allowlist de tools aplicada no executor** | PARCIAL | `src/services/ai-v2/engine.ts` linha 443 | Cria `allowedTools` com `theme.allowedTools` + básicos e descarta ações fora da lista. Teste indireto no engine? Não há teste específico. | Não é function calling — o LLM nunca vê as tools; as ações vêm do JSON de saída e são filtradas depois. Allowlist de `knowledge docs` e `message models` por tema não é usada. |
| 6 | **Temas: allowlist de docs/modelos/produtos** | SÓ CONFIG | `src/lib/ai-v2/types.ts` `V2Theme` | Campos existem no schema. | Nenhum código lê `allowedKnowledgeDocIds`, `allowedMessageModelIds` ou `productPolicy`. |
| 6 | **Transferência entre agentes com limite de idas/voltas** | NÃO EXISTE | `src/services/ai-v2/handoff.ts` `simpleHandoff` | Só trata `destination.type === "department"`. | `ai_agent`, `distribution_rule`, `user`, `automation` são ignorados. Não há contador de transferências entre agentes. |
| 7 | **Ferramentas novas no FACTORY_MAP / loop** | PARCIAL | `src/services/ai-v2/actions.ts` `EXECUTORS` | `create_deal`, `add_tag`, `create_activity`, `move_stage`, `close_conversation`, `tabulate_conversation`, `update_field`, `handoff` funcionam via serviços existentes. | `add_note` é declarado no schema (`llm.ts:19`) mas **não está em EXECUTORS** (`actions.ts:247-265`). `search_products`, `search_crm_records`, `knowledge_search`, `list_message_models` não existem. `send_message_model`, `send_product`, `send_whatsapp_template` são stubs que retornam `ok: true` sem enviar nada. Não há loop de function calling: LLM é chamado com `toolChoice: "none"` (`llm.ts:171`). |
| 8 | **RAG: upload, associação a tema, busca filtrada** | SÓ CONFIG | `src/lib/ai-v2/types.ts` `V2Theme.allowedKnowledgeDocIds` | Schema aceita IDs. | Nenhuma busca de conhecimento é feita. `knowledge_search` não implementado. Não chama `retrieveAgentKnowledge`. |
| 8 | **RAG: suporte a PDF** | NÃO EXISTE | — | — | PDF não extraído; `knowledge-extract` não tocado. |
| 9 | **Modelos de mensagem: seleção, preenchimento, envio** | SÓ CONFIG | `src/services/ai-v2/actions.ts` `executeSendMessageModel` | Só retorna `{ ok: true, modelId }`. | Não carrega o modelo, não preenche variáveis, não envia. |
| 9 | **Template fora das 24h** | SÓ CONFIG | `src/services/ai-v2/actions.ts` `executeSendWhatsappTemplate` | Só retorna `{ ok: true, templateName }`. | Não verifica janela nem envia template. |
| 10 | **Produtos: política por tema, envio, ações ligadas** | SÓ CONFIG | `src/lib/ai-v2/types.ts` `V2ProductPolicy` + `actions.ts` `executeSendProduct` | Schema aceita config de produto; executor de produto é stub. | `productPolicy` nunca lido. `send_product` não busca/produz mensagem. |
| 11 | **Botões/listas: montagem e persistência** | PARCIAL | `src/services/ai-v2/interactive.ts` | `decideInteractiveFormat`, `buildInteractiveText`, `normalizeInteractiveOptions`, `persistPendingInteractive` existem e têm teste unitário (`unit.test.ts:192-204`). | Nenhum código chama `persistPendingInteractive`. `ask_with_options` em `actions.ts:225-232` retorna as opções, mas `engine.ts` não as envia nem persiste. |
| 11 | **Botões: clique determinístico** | PARCIAL | `src/services/ai-v2/interactive.ts` `resolvePendingInteractive` | Resolve por `buttonId`, número ou label; marca como resolvido. Teste? Apenas testes manuais de formato. | Não existe rota/API que receba um clique de botão e chame `resolvePendingInteractive`. Não integrado ao inbound. |
| 11 | **Botões: fallback numerado, fora 24h, canal sem suporte** | SÓ CONFIG | `src/services/ai-v2/interactive.ts` `decideInteractiveFormat` | Lógica de fallback numerado existe. | Nunca chamada com `sessionWindowOpen` real. Não envia mensagem de fallback. |
| 12 | **Dono da conversa** | PARCIAL | `src/services/ai-v2/types.ts` `V2Owner` + `engine.ts` + `state.ts` | Estado `owner` persiste em `ai_simple_conversation_states.owner`. `engine.ts:164` respeita `owner === "pessoa"`. | Não detecta resposta humana para trocar dono automaticamente. Não implementa precedência “automação reassumindo”. `trace` não grava `previousOwner`, `reason`, `actor`. |
| 12 | **Handoff: departamento / fila / usuário / distribuição inteligente** | PARCIAL | `src/services/ai-v2/handoff.ts` `simpleHandoff` + `actions.ts` `executeHandoff` | Usa `executeDistribution` com `departmentId` quando `type === "department"`. Teste indireto em `engine.test.ts:230-248`. | `distribution_rule`, `user`, `ai_agent`, `automation` não implementados. |
| 13 | **Saídas: 13 situações da tabela 3.14** | PARCIAL | `src/services/ai-v2/engine.ts` | `handoff`, `close_conversation`, `outOfScope` (schema) e mensagens de erro/fallback cobrem alguns casos. | `outOfScope` não dispara ação específica. “Erro/timeout do modelo ou ferramenta” só gera handoff genérico; não usa mensagem configurável por caso. “Cliente sumiu” depende de worker externo que ainda não existe para v2. Não há 13 saídas distintas testadas. |
| 14 | **Escopo / assuntos proibidos validados em código** | SÓ CONFIG | `src/lib/ai-v2/types.ts` `globalRules` + `outOfScope` | Configuração aceita regras globais e `outOfScope`. | Nenhuma validação de domínio/aluno/polo/cruzeiro no código (bom), mas também nenhum guarda de assuntos proibidos além do prompt. |
| 15 | **Parar de responder: cortesia com resposta única** | PARCIAL | `src/services/ai-v2/closure.ts` + `engine.ts:190-224` | Post-close `courtesy` conta `courtesyReplies` e para após `maxCourtesyReplies`. Teste em `unit.test.ts:140-152`. | Contador só usado no pós-encerramento. Demais limites (`helpOffers`, `stalledExchanges`, `nonsenseMessages`, `loopCount`) têm funções em `limits.ts` mas **nunca são chamados** no `engine.ts`. |
| 15 | **Oferta única, trocas sem avanço, silêncio temporário, loop** | SÓ CONFIG | `src/services/ai-v2/limits.ts` | `shouldStopHelpOffer`, `shouldStopStalled`, `detectLoop` existem. | Nenhuma integração no motor. Contadores não são incrementados. |
| 16 | **Encerramento: janela pós-encerramento (3 casos)** | PARCIAL | `src/services/ai-v2/closure.ts` + `engine.ts:190-257` | Classifica em `courtesy`/`new_demand`/`ambiguous` e aplica comportamentos configuráveis. Teste em `unit.test.ts:140-152`. | Classificação é só por keyword fixa, não por LLM leve. Não trata opção clicada na pergunta `ask_with_options`. |
| 16 | **Encerramento: devolver etapa de origem** | SÓ CONFIG | `src/services/ai-v2/state.ts` `originStageId` | Coluna existe no estado. | `engine.ts:closeState` (`engine.ts:722-740`) tem comentário: “Devolver à etapa de origem exigiria guardar originStageId ao iniciar atendimento. Aqui movemos para a primeira etapa do funil como placeholder.” Não implementado. |
| 16 | **Encerramento: devolver para automação** | SÓ CONFIG | `src/services/ai-v2/automation-bridge.ts` `continueV2AutomationOnClose` | Função existe. | **Não é chamada** em `closeState` nem em `engine.ts`. |
| 17 | **Tabulação** | PARCIAL | `src/services/ai-v2/actions.ts` `executeTabulate` + `executeCloseConversation` | Grava `tabulationId` vindo da ação do LLM. | Não classifica automaticamente lendo a conversa inteira. Não respeita `requireTabulationOnClose` do departamento. Não sugere para humano confirmar. |
| 17 | **Humor do cliente (sentiment)** | PRONTO E TESTADO | `src/services/ai-v2/sentiment.ts` | Detecta `angry`/`dissatisfied`/`neutral` e dispara ação configurada. Testes em `unit.test.ts:125-135`. | — |
| 17 | **Pesquisa de satisfação** | SÓ CONFIG | `src/services/ai-v2/survey.ts` | `buildSurveyMessage`, `parseSurveyScore`, `recordSurveyResponse` existem. | Nunca chamado pelo motor. Só funciona se o LLM emitir ação `start_survey` e o executor gravar a resposta; nenhum gatilho automático. |
| 18 | **Guarda: domínios permitidos** | PRONTO E TESTADO | `src/services/ai-v2/output-guard.ts` `guardV2Output` | Remove URLs fora da allowlist. Teste em `unit.test.ts:155-162`. | — |
| 18 | **Guarda: modo rascunho (DRAFT)** | PARCIAL | `src/services/ai-v2/engine.ts` passa `AUTONOMOUS`/`DRAFT` para `sendV2TextMessage` | Repassa para `sendAgentMessage`, que salva rascunho quando `DRAFT`. | Não há UI v2 para aprovar rascunho (usa infra da v1). |
| 18 | **Guarda: teto de custo** | SÓ CONFIG | `src/services/ai-v2/cost-guard.ts` `checkV2CostCap` | Implementa `dailyTokenCap`. | **Nunca chamado** no `engine.ts`. `costCap.mensal` ignorado. `log.ts` usa modelo fixo `gpt-4o-mini` para estimar custo, não o modelo real. |
| 18 | **Guarda: dados sensíveis no trace** | PARCIAL | `src/services/ai-v2/log.ts` | Grava snapshot do contexto como JSON. | Não há redação de CPF/telefone no snapshot; se o operador liberou, vai parar no log. Não configurável. |
| 19 | **Trace: TODOS os campos do SPEC 3.24** | PARCIAL | `src/services/ai-v2/log.ts` `logV2Turn` | Grava `owner`, `stage`, `themeId`, `appliedRuleId`, `crmContext`, `prompt`, `llmOutput`, `executedActions`, `discardedActions`, `reply`, `handoff`, `closed`, `latencyMs`, `inputTokens`, `outputTokens`, `versionId`. | Faltam: `previousOwner`, `reason` (actor/motivo da troca de dono), trechos RAG, `buttonId`/`buttonLabel`, custo real (`costUsd` computado mas não persistido), warnings do output guard. |
| 20 | **Onboarding (Primeiros dias): etapas e critérios** | PARCIAL | `src/services/ai-v2/onboarding.ts` | `currentV2OnboardingStep`, `isV2OnboardingStepCompleted`, `advanceV2OnboardingState` existem e têm critérios `field_filled`/`client_reply`/`stage`/`action`. | Estado `onboarding_state` fica só em `collectedVariables` local do turno; não é carregado nem persistido em `ai_simple_conversation_states`. Lembretes e entrega final não implementados. |
| 20 | **Onboarding: lacunas de conhecimento** | PARCIAL | `src/services/ai-v2/onboarding.ts` `recordV2KnowledgeGap` | Grava em `AIV2KnowledgeGap`. | Só criado via ação `record_knowledge_gap`; não há endpoint de listagem nem ação “virar material”. |
| 21 | **Wizard: 12 telas da seção 6** | NÃO EXISTE | `frontend_crm1_repo/src/app/(app)/ai-agents-v2/client-page.tsx` + `[id]/client-page.tsx` | Existe lista, criação por preset, edição JSON bruta, teste de LLM e logs. | Nenhuma das 12 telas do wizard (Começar, Jeito de falar, Reconhecer cliente, Materiais, Início, Assuntos, Regras, Saídas, Equipe/horários, Classificar/encerrar, Testar/publicar, Mapa) existe. A config é editada como JSON em textarea. |
| — | **Turn Manager por agente v2 / v1 isolada** | PRONTO E TESTADO | `src/services/ai/turn-manager.ts` + `inbound-debounce.ts` + workers | `turn-manager.ts` roteia `engine === "simple"` para v2. Workers v1 (`ai-agent-inactivity-worker.ts`, `retry-unanswered-ai-inbound.ts`, `sweep-finished-ai-conversations.ts`) excluem `engine = 'simple'`. Testes em `__tests__/turn-manager.test.ts`. | — |
| — | **APIs / CRUD / teste / logs v2** | PRONTO E TESTADO | `src/app/api/ai-agents-v2/*` + `src/services/ai-v2/agents.ts` | `GET/POST /api/ai-agents-v2`, `GET/PUT/DELETE /[id]`, `/test`, `/logs`, `/presets`. | — |
| — | **Smoke test de contexto** | PRONTO E TESTADO | `scripts/ai-v2-check-context.ts` | Busca contato por telefone e imprime deals abertos. | — |
| — | **Schema/migração v2** | PRONTO E TESTADO | `prisma/schema.prisma` + `migrations/20260920184800_ai_v2_full_config/migration.sql` | Tabelas `ai_simple_conversation_states`, `ai_v2_pending_interactives`, `ai_v2_knowledge_gaps`, `ai_agent_survey_responses` e colunas novas. | — |

---

## Top 10 itens mais críticos (SÓ CONFIG / PARCIAL / NÃO EXISTE)

1. **Loop de ferramentas / function calling (item 7)** — `llm.ts` usa `toolChoice: "none"`. `search_products`, `search_crm_records`, `knowledge_search`, `add_note`, `list_message_models` não existem; `send_product`, `send_message_model`, `send_whatsapp_template` são stubs. Isso quebra a promessa de “ações estruturadas” do SPEC.
2. **Wizard do frontend (item 21)** — A tela é só JSON bruto. Nenhuma das 12 telas de configuração existe; administrador precisa editar `simpleConfig` manualmente.
3. **RAG filtrado por tema e PDF (item 8)** — `allowedKnowledgeDocIds` é só config. Nenhuma busca de conhecimento é feita; PDF não é extraído.
4. **Transferência entre agentes e destinos completos (item 12)** — `handoff.ts` só aceita `department`. `ai_agent`, `user`, `distribution_rule`, `automation` ignorados. Não há controle de idas/voltas.
5. **Mensagens interativas ponta a ponta (item 11)** — Montagem e resolução existem, mas ninguém persiste, envia ou recebe o clique. Botões/listas não chegam ao cliente.
6. **Onboarding persistente e lembretes (item 20)** — Etapas existem, mas o estado não é carregado/salvo. Lembretes e “entrega final” não implementados.
7. **Custo/teto de tokens e pesquisa de satisfação (itens 17/18)** — `checkV2CostCap` e `buildSurveyMessage` existem, mas **nunca são chamados** no motor.
8. **Encerramento completo: origem da etapa + automação (item 16)** — `returnToOriginStage` e `continueV2AutomationOnClose` não são usados.
9. **Mídia: transcrição/OCR (item 4)** — Config aceita `transcribe`/`describe`, mas nenhum processamento real ocorre.
10. **Horário de atendimento / feriados / out_of_hours (item 5)** — `withinBusinessHours` é hardcoded `true`; regra `out_of_hours` nunca dispara.

---

## Comportamentos diferentes do SPEC (mesmo que por motivo técnico)

- **Function calling ausente**: em vez do LLM chamar tools e o resultado voltar, o LLM devolve `actions[]` e o executor dispara serviços depois. Isso é mais simples, mas quebra “loop real de function calling com registry da v1”.
- **Resposta principal não renderizada**: `llmOutput.reply` é enviada diretamente, sem passar por `message-render.ts`. Só mensagens pré-definidas usam `@var`/`{ }`.
- **Handoff sempre por distribuição**: mesmo quando o destino é `user` ou `ai_agent`, o código ignora e cai em `executeDistribution` sem destino.
- **DRAFT usa infra da v1**: rascunho é salvo pela `sendAgentMessage` existente; não há tela v2 de aprovação.
- **Trace não separa custo real**: `estimateCost` é chamado com modelo fixo; o custo não é persistido.

---

## Testes que existem hoje e o que NÃO cobrem

**Testes unitários (`src/services/ai-v2/__tests__/unit.test.ts`)**
- `validateV2Config` (aceite/rejeição básica)
- `renderMessage` (variáveis, condicionais)
- `evaluateV2Rules` (keyword, negate)
- `detectV2Sentiment` / `shouldActOnSentiment`
- `classifyPostCloseMessage` / `getPostCloseBehavior`
- `guardV2Output` (URLs, promessa de retorno)
- `parseV2Counters`
- `selectV2Theme`
- `decideInteractiveFormat` / `buildInteractiveText`

**Testes de integração do motor (`src/services/ai-v2/__tests__/engine.test.ts`)**
- Primeira mensagem sem deal → handoff
- Primeira mensagem com deal → confirmação
- Confirmação negativa → identificação
- LLM pede handoff → transfere e muda dono

**O que os testes NÃO cobrem**
- Múltiplos negócios / pergunta ao cliente para escolher.
- Criação de deal a partir do fluxo (`onDealNotFound = create_deal`).
- Automação como origem e devolução para automação.
- Entrada por pessoa/outro agente e retomada.
- Mídia real (transcrição/OCR/describe).
- Ferramentas de consulta (RAG, produtos, CRM).
- Envio de modelo de mensagem, produto ou template WhatsApp.
- Botões: persistência, envio, clique determinístico, fallback.
- Transferência entre agentes e limite de idas/voltas.
- Classificação/tabulação automática no encerramento.
- Paradas por oferta única, trocas sem avanço, loop, nonsense.
- Teto de custo/tokens.
- Pesquisa de satisfação.
- Onboarding persistente e lembretes.
- Horário de atendimento / out_of_hours.
- Renderização da resposta do LLM.
- `add_note` e demais tools não implementadas.
