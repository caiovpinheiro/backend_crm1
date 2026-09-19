# Auditoria v1 — motor de agentes IA

Base: backend e frontend na `DEV_BRANCH` (worktrees `_wt_be_inbox_dedupe` e `_wt_fe_closing_dev`), 19/09/2026. Somente leitura.

## 1. Veredito

Agente único para a clínica: **sim, sai pelo wizard**, com duas ressalvas que não são de código de agente — a IA nasce muda até alguém ligar `ai.newAttendanceEnabled` na organização, e o operador vai ler jargão de faculdade em várias telas.

Orquestrador + especialistas: **não**. `routingScope` é o campo que diz a cada especialista qual assunto é dele, e não existe um único controle de UI que o escreva em todo o frontend. Sem ele o roteamento por código nunca dispara, e o coordenador cai num caminho que resolve o destino por **nome** de agente.

A regra central está invertida num ponto estrutural: o pack de vertical não é um modelo de configuração gravado no banco, é código executado em runtime (`getVerticalPack`), e o módulo genérico de configuração importa o pack acadêmico direto.

## 2. Achados

| # | Problema | Arquivo:linha | O que quebra para a clínica | Gravidade |
|---|---|---|---|---|
| 1 | `routingScope` não tem controle de UI (zero ocorrências no frontend) | `coordinator-orchestrate.ts:95-104` | Especialistas ficam sem assunto; `dest` é sempre null e o coordenador nunca roteia por código | bloqueia |
| 2 | Atendimento IA vem desligado na organização | `attendance-gate.ts:13-17` | Agente criado e ativo não responde nada ao inbound; não há tela para a chave | bloqueia |
| 3 | Destino do handoff IA→IA é resolvido por nome, não por id | `coordinator-route.ts:105-109` | Renomear "Agendamento" quebra o roteamento em silêncio | degrada |
| 4 | `transfer_to_department` resolve o departamento por nome | `department-handoff.ts:47-51` | Idem para "Financeiro"; regra de assunto também grava nome | degrada |
| 5 | `consultar_matricula` está no catálogo do núcleo, não é integração do tenant | `tools.ts:2484`, `ai-agents.ts:58`, FE `tools-catalog.ts:65-67` | Wizard da clínica oferece "Consultar matrícula do aluno" como ferramenta disponível | degrada |
| 6 | Pack de vertical é código em runtime, não configuração | `steering.ts:28`, `:807-829`, `runner.ts` (`getVerticalPack`) | Um vertical de clínica exigiria escrever código no núcleo, não cadastrar dado | degrada |
| 7 | Cinco controles de Pilotagem são gravados e nunca lidos | `inbox-handler.ts:737` | Palavras-chave de handoff e todo o bloco de inatividade não têm efeito | degrada |
| 8 | Fila humana sem tela: `humanAttendanceHours`, `queueMessage`, `humanRequestKeywords`, `transferPolicy`, `media` | `steering.ts:619-645`, `human-queue-policy.ts:59-70` | Clínica fica com seg-sex 8h-19h fixo e textos de fila do default | degrada |
| 9 | `departmentAliases` tem chaves fixas `acolhimento`/`retencao`/`atendimento` | `steering.ts:622-623` | Não há como declarar apelido de "Agendamento" ou "Financeiro" | degrada |
| 10 | Jargão acadêmico visível na tela de criação/edição | FE `simple-editor.tsx:107,187,259,311`; `inbox-policy-panel.tsx:77,185-193,294`; `rules-section.tsx:50`; `archetypes.ts:116` | Operador da clínica lê "Cruzeiro", "aula inaugural", "pacote de primeiro acesso", "Carregar padrão acadêmico" | degrada |
| 11 | Vocabulário de produto na expansão de query dos modelos internos | `message-models-retrieval.ts:95-112` | Com `useMessageModels` ligado, a busca injeta "blackboard", "duda", "portal aluno" | degrada |
| 12 | `archetype` não pode ser alterado depois da criação | FE `agent-settings-dialog.tsx:383-418` | Errar coordenador/especialista no wizard obriga recriar o agente | degrada |
| 13 | `confidenceThreshold` nulo vira 0.4 implícito | `steering.ts:959` | Campo vazio na tela sugere ausência de regra que existe | cosmético |
| 14 | `isAcademicSelfServeTurn` roda para todo tenant | `inbox-handler.ts:150-163` | Comportamento é genérico; só o nome e os comentários são de outro produto | cosmético |
| 15 | Saudação de fallback cita portal e Blackboard | `inbox-handler.ts:174-183` | Não atinge a clínica: as três chamadas são atrás de `agentPack` (`:519`, `:998`, `:1487`) | cosmético |

## 3. Os três primeiros a corrigir

**1 — `routingScope` na tela.** É o único item que impede por completo o segundo formato do produto: sem ele o orquestrador existe no código e não existe para quem configura.

**2 — Ligar a IA junto com a criação do agente.** Um tenant que termina o wizard e não recebe resposta nenhuma parece produto quebrado, e a causa está numa chave que não aparece em lugar algum da interface.

**3 — Handoff por id nos dois caminhos (agente e departamento).** É a falha que não dá sinal: a operação renomeia um departamento meses depois e o roteamento para de funcionar sem erro, sem log e sem ninguém relacionar as duas coisas.

## 4. Suposições

Assumi que a clínica é criada sem `verticalPack`, porque o wizard não oferece escolha de pack nem de template — e é isso que salva o tenant novo de boa parte da cópia acadêmica, que está atrás de `agentPack`.

Assumi que "criar só pelo wizard" inclui as telas de configuração pós-criação do agente (diálogo de edição), mas não inclui abrir banco, rodar script ou editar JSON — por isso campo sem controle de UI conta como indisponível.

Assumi que departamentos, horários de consultor e campos personalizados da clínica são cadastrados nas telas próprias de configuração do CRM, que são genéricas e não foram contadas como achado.

Assumi que `enabledTools` no wizard reflete o catálogo do frontend (`tools-catalog.ts`), já que é ele que monta a lista exibida.

Não validei em execução: a simulação foi por leitura de código, sem criar tenant nem rodar o motor.
