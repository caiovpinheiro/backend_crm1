# Paridade v1 → v2

> Mapeamento dos itens do `docs/inventory/INVENTORY_CRUZEIRO.md` para os blocos do `docs/SPEC_V2.md` e a configuração v2 que os reproduz.  
> **Seções pendentes de dados reais:** a tabela de mapeamento dos agentes existentes (seção 4) e os preenchimentos finos do mapeamento de interceptos só serão completados após rodar `npx tsx scripts/inventory-org-agents.ts "Cruzeiro do Sul"`. Até lá estão marcadas como `[PENDENTE — rodar script]`.

---

## 1. Lógica acadêmica/vertical no código

A organização de referência usava o pack `verticalPack = "academic"`. A v2 não terá packs. Cada comportamento vira configuração (`rules`, `themes`, `variables`, `knowledge docs`, `message models`, `automation`) e nenhum termo acadêmico fica no código.

| Item do inventário | Arquivo/função v1 | Bloco do SPEC_V2 | Configuração v2 / ação | Observação |
|---|---|---|---|---|
| **1.1 Registro do vertical pack** | `src/verticals/index.ts` | Nenhum — packs proibidos | Não existe equivalente. Todos os comportamentos viram config JSON do agente. | Descartado. |
| **1.2 Pipeline de interceptos** | `src/verticals/academic/intercepts.ts` `ACADEMIC_INTERCEPT_ORDER` | 3.6 Regras; 3.7 Temas; 3.13 Dono; 3.16 Paradas | Lista ordenada de `V2Rule` com condições e ações. | Mapeamento de cada intercepto abaixo. |
| `first_access` | `isFirstAccessIntent` | 3.6 Regras + 3.23 Primeiros dias | Regra: palavras-chave (`primeiro acesso`, `criar senha`, `esqueci senha`, `portal`, `app`) → ação `set_theme: onboarding_acesso` + enviar `message_model` de primeiro acesso. | Vira parte do fluxo "Primeiros dias". |
| `ava_disciplines` | `isAvaOrDisciplinesIntent` | 3.6 Regras + 3.7 Temas | Regra: palavras-chave (`disciplina`, `ava`, `blackboard`, `conteúdo`, `aula`, `materiais`) → `set_theme: acesso_conteudo`. Tema usa `knowledge_search` + `list_message_models` permitidos. Sem resposta nos materiais → handoff. | Sem termos acadêmicos no código. |
| `greeting_self_serve` | `isBareGreetingMessage` | 3.3 Entrada; 3.16 Cortesia | Regra: saudação pura e dono = `agente` sem tema ativo → ação `send_message` de abertura + `end_turn`. | Limitado a uma resposta de cortesia por atendimento. |
| `attendance_scope` | `evaluateAttendanceScope` | 3.15 Escopo e limites | Config `forbiddenSubjects`: assuntos que o agente nunca responde com resposta/destino próprios. Regra dispara uma vez; na insistência, handoff. | Fora de escopo = saída configurável. |
| `inaugural_class_link` | tag + pedido de link | 3.6 Regras + 3.10 Modelos | **Automação externa** (decidido). A automação detecta tag + data e envia `message_model` com link. Nada no código da v2. | Nada hardcoded. |
| `pending_handoff` | DistributionPending + pedido humano | 3.13 Dono; 3.17 Handoff | Se existir `DistributionPending` ativo e cliente pedir humano → chamar `handoff()` único. | Estado de dono vira `pessoa`. |
| `handoff_ack_silence` | aluno confirma/aceita fila | 3.13 Dono; distribuição | Quando dono está mudando para fila/pessoa e cliente manda ack, a distribuição já foi feita; agente fica em silêncio. | Não é decisão do LLM. |
| `ai_only_close` | pedido de encerramento ou despedida conclusiva | 3.14 Saídas; 3.18 Encerramento | **Encerrar é ação explícita**: regra (`tchau`, `obrigado`, `era só isso`, `pode encerrar`) → ação `close_conversation` com tabulação. Além disso, na **janela pós-encerramento** há um classificador (cortesia \| demanda nova \| ambíguo) e os limites de cortesia do 3.16. Os dois coexistem. | Não há detecção heurística implícita fora da regra/config. |
| `inbound_audio` | mensagem de voz sem transcrição | 3.5 Mídia recebida | Config de mídia para áudio: `transcrever` ou `transferir`. Se `transferir` ou sem transcrição → handoff. Se `transcrever` → `POST /api/media/transcribe` e continua o turno. | Reaproveita transcrição existente. |
| `keyword_handoff` | `keywordHandoffs` | 3.6 Regras | Regra com palavras-chave configuradas → ação `handoff` para destino configurado. | Mapeamento 1:1. |
| `course_shopping` | dúvida de curso/grade/valor | 3.11 Produtos; 3.15 Escopo | **Padrão: NÃO responde preço e grade.** Se o tema `informacoes_curso` existir, `productPolicy` fica **desligado** por padrão; a saída é handoff ou "não está nos materiais". Para responder produto, ligar `themes[].productPolicy.enabled` explicitamente. | O pack v1 respondia curso; na v2 isso é opção por tema, desligada por padrão. |
| `curriculum_or_tce` | assinatura/envio de documentos | 3.7 Temas + 3.10 Modelos | Tema `documentos_estagio` com `message_models` e `knowledge docs`. Sem material ou sem ação clara → handoff. | TCE vira conhecimento/modelo, não código. |
| `retention_intent` | cancelar/trancar/desistir/trocar | 3.6 Regras + 3.20 Humor | Regra: palavras-chave de retenção → `handoff` para fila de retenção configurada. Também pode acionar `sentiment = insatisfeito/irritado`. | Destino é config. |
| `opening_and_greeting_only` | `openingMessage` | 3.3 Entrada | Config `entry.openingMessage` com trecho condicional. Primeira mensagem do cliente + sem tema ativo → envia abertura e encerra turno. | Preserva `simulateTyping`/`markMessagesRead`. |
| **1.3 Prompt acadêmico** | `src/verticals/academic/atendimento-prompt.ts` | 3.1 Contexto; 3.2 Variáveis; 3.7 Temas; 3.10 Modelos | Substituído por: `tone`, `global_rules`, `variables` (`@NomeInstituicao`, `@UrlPortal`, etc.), `themes[].instructions`, `knowledge docs`, `message models`. | Nenhum texto acadêmico no código. |
| **1.4 Roteamento Acolhimento/Retenção/Atendimento** | `src/verticals/academic/department-routing.ts` | 3.17 Handoff | `handoff()` única chama `executeDistribution` passando `departmentId` resolvido pela config (nome da fila) ou `distributionRuleId`. | Departamentos vêm do catálogo do CRM. |
| **1.5 Encerramento e restore origin** | `src/verticals/academic/closure.ts` + `restoreDealToAcademicOrigin` | 3.18 Encerramento e janela pós-encerramento | **Ação explícita** `close_conversation` move o deal para `originStageId` guardado no estado. **Além disso**, mensagens na janela pós-encerramento são classificadas (cortesia \| demanda nova \| ambíguo) pelas regras de pós-close + limites de cortesia. | Estado guarda `originStageId`. |
| **1.6 Escolha do coordenador/especialista** | `src/verticals/academic/coordinator-pick.ts` | 3.17 Transferência entre agentes | **Transferência entre agentes v2 desde o início**, com limite de idas/voltas e herança de config. Padrão continua agente único. Usar `transfer_to_ai_agent` quando o tema definir outro agente como destino. | Opcional; usar somente se necessário. |
| **1.7 Tenant config** | `src/verticals/academic/tenant-config.ts` | 3.2 Variáveis; 3.9 Conhecimento | Variáveis do agente + knowledge docs com URLs/polos. | Nada no código. |
| **1.8 Relatório acadêmico como fonte de dados** | `src/verticals/academic/record-source.ts` | 3.1 Contexto | **Dados acadêmicos viram campos personalizados de contato/negócio** (resposta decidida). Não cria record source nova. | Usar `context_fields` e `search_crm_records`. |
| **1.9 Sync de departamentos** | `src/verticals/academic/ensure-dept-roster.ts` | Fora de escopo | Não existe na v2. Departamentos são criados manualmente no CRM. | Descartado. |
| **1.10 Guarda de URLs oficiais** | `src/verticals/academic/outbound-url-guard.ts` | 3.22 Guardas + novo `src/services/ai-v2/output-guard.ts` | Lista configurável `allowedDomains`. Antes de enviar, remover URLs não permitidas e registrar no trace. | Guarda genérica. |
| **1.11 Pontos de integração no motor v1** | `inbox-handler.ts`, `runner.ts`, etc. | 4. Agrupamento e canal; 3.13 Dono | A v2 não passa por nenhum desses. Entrada pelo Turn Manager, orquestração pelo `engine-v2`. | Não reaproveitar. |

---

## 2. Tabela de migração v1 → v2 (seção 5 do inventário)

| Funcionalidade v1 | Equivalente na v2 | Como migrar | Sem equivalente? |
|---|---|---|---|
| `systemPromptTemplate` + `steeringRules` | `tone` + `global_rules` + `themes[].instructions` + `knowledge` + `message models` | Copiar regras de negócio para `global_rules`; extrair FAQs para knowledge docs; transformar blocos longos em temas. | ❌ |
| Blocos de prompt do pack | `global_rules`, `themes`, `variables`, `knowledge docs`, `message models` | Criar themes para primeiro acesso, acesso a conteúdo, documentos, retenção etc. | ❌ |
| `enabledTools` + `toolConfig` | `themes[].allowed_tools` + `toolConfig` global | Mapear tools para allowlist do tema. | Parcial |
| `inboxPolicy` | `handoff.destination`, `out_of_hours.message`, `entry.openingMessage`, `media.*`, `human_request.keywords` | Configurar fila padrão e mensagens; mapear `routingScope` para temas. | ❌ |
| `keywordHandoffs` | `rules` determinísticas | Incluir keywords em `rules` com ação `handoff`. | ❌ |
| `openingMessage` | `entry.openingMessage` | Usar mensagens iniciais da v2 com trechos condicionais. | ❌ |
| Auto-close / farewell detection | `rules` + ação `close_conversation` + classificador pós-encerramento | Configurar regras de encerramento; classificador de cortesia/demanda/ambíguo atua na janela pós-close. | ⚠️ (de implícito para explícito + pós-close) |
| Roteamento por coordenador | `transfer_to_ai_agent` com limite de idas/voltas e herança | Cada agente v2 pode transferir para outro agente v2 quando o tema definir. Padrão: agente único. | ⚠️ |
| Interceptos determinísticos | Regras + LLM estruturado + actions allowlist | Converter interceptos em `rules` e `themes`. | ⚠️ |
| `vertical.academic.*` settings | `variables` + `knowledge docs` | Cadastrar URLs/polos como variáveis e docs. | ❌ |
| `studentAcademicRecord` | `context_fields` de contato/negócio | Dados acadêmicos viram campos customizados. | ⚠️ |
| Inaugural class link | Automação externa | Automacao detecta tag + data e envia modelo. | ⚠️ |
| URL guard | `allowed_domains` + `output-guard.ts` | Adicionar regra de domínios permitidos. | ⚠️ (nova implementação) |
| Restore deal to academic origin | Ação `close_conversation` + `move_stage` | Guardar `originStageId` e mover ao fechar. | ⚠️ |
| `ensureAcademicDepartmentRoster` | Não existe | Gerenciar departamentos no CRM. | ⚠️ |
| `identityConfirmationEnabled` | `entry.confirmationMessage` da v2 | Usar confirmação de cadastro no início. | ❌ |

---

## 3. Funcionalidades da v1 ainda não suportadas na v2 (seção 6 do inventário)

| Funcionalidade v1 | Justificativa para descarte ou o que construir | Bloco do SPEC_V2 |
|---|---|---|
| **Roteamento por coordenador** | Construir `transfer_to_ai_agent` com limite de idas/voltas e herança de config. Padrão continua agente único. | 3.17 Transferência |
| **Interceptos determinísticos pré-LLM** | Substituídos pelo motor de `rules` determinísticas da v2. | 3.6 Regras |
| **Encerramento automático inteligente** | Não há detecção heurística de despedida. Encerramento via regra/ação explícita. Além disso, classificador pós-encerramento trata cortesia/demanda/ambíguo. | 3.18 Encerramento |
| **Guarda de URLs oficiais** | Construir `output-guard.ts` com `allowed_domains`. | 3.22 Guardas |
| **Devolução do card ao funil acadêmico** | Construir ação `close_conversation` que move o deal para `originStageId` guardado. | 3.18 Encerramento |
| **Sync automático de departamentos** | Fora de escopo. | Fora de escopo |
| **Aula inaugural / tag calouros** | Automação externa (decidido). | 3.6 Regras / Automações |
| **Políticas de produto (`productPolicy`)** | Substituída por `themes[].productPolicy`, **desligada por padrão**. Para responder produto, ligar explicitamente no tema. | 3.11 Produtos |

---

## 4. Mapeamento dos agentes existentes

> **[PENDENTE — rodar script]**  
> Preencher depois de executar:  
> `npx tsx scripts/inventory-org-agents.ts "Cruzeiro do Sul"`  
> O script gera `agents.json` e knowledge docs; os dados concretos (ids, nomes, filas, templates, knowledge docs) serão colados na tabela abaixo.

| ID | Nome | Arquétipo v1 | Engine hoje | Mapeamento v2 (presets/temas/regras) | Gaps |
|---|---|---|---|---|---|
| _colar de agents.json_ | | | | | |

---

## 5. Decisões pendentes que afetam a paridade

1. **Mapeamento dos agentes**: depende do inventário real (seção 4 acima).
2. **Detalhe dos interceptos acadêmicos**: alguns interceptos podem conter regras de negócio que só aparecerão na `systemPromptTemplate`/`steeringRules` do agente. O script deve exportar esses textos para que possamos converter em `global_rules` e `themes`.
3. **Modelos de mensagem e templates usados**: precisamos dos ids/nomes para montar as allowlists por tema.
4. **Knowledge docs existentes**: precisamos saber quais documentos pertencem a cada assunto para associar aos temas v2.
5. **Destinos de handoff**: nomes de departamentos/filas reais para configurar nos temas e regras.
