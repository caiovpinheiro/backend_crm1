# Inventário de agentes IA — Cruzeiro do Sul

> Gerado a partir do código-fonte e do script `scripts/inventory-org-agents.ts`.  
> **Não contém dados pessoais** — e-mails, telefones, CPF, RGM e chaves são omitidos.  
> Preencha os dados reais dos agentes rodando o script no banco de dev/prod (read-only).

---

## 1. Lógica acadêmica/vertical no código

A organização Cruzeiro do Sul usa o pack `verticalPack = "academic"`. Todo o vocabulário acadêmico (aluno, matrícula, polo, Acolhimento, Retenção, curso, prova etc.) vive em `src/verticals/academic/` e só é injetado no motor quando o agente tem esse pack. Abaixo o mapa de arquivos, triggers e efeitos.

### 1.1 Registro e contrato do pack

```24:31:src/verticals/index.ts
// REGISTRY: Record<string, VerticalPack> = { academic: academicPack }
export function getVerticalPack(id: string | null | undefined): VerticalPack | null
export function listVerticalPackIds(): string[]
```

- **O que faz**: centraliza o registro dos vertical packs.
- **Trigger**: chamado pelo runner/inbox a partir do `verticalPack` salvo no `AIAgentConfig`.
- **Agente/departamento afetado**: qualquer agente cujo `verticalPack = "academic"`.

### 1.2 Pipeline de interceptos acadêmicos

Arquivo: `src/verticals/academic/intercepts.ts`

```85:101:src/verticals/academic/intercepts.ts
export const ACADEMIC_INTERCEPT_ORDER = [
  "first_access",
  "ava_disciplines",
  "greeting_self_serve",
  "attendance_scope",
  "inaugural_class_link",
  "pending_handoff",
  "handoff_ack_silence",
  "ai_only_close",
  "inbound_audio",
  "keyword_handoff",
  "course_shopping",
  "curriculum_or_tce",
  "retention_intent",
  "opening_and_greeting_only",
] as const;
```

| Intercepto | Trigger | Efeito | Agente/Dept |
|---|---|---|---|
| `first_access` | Mensagem indica primeiro acesso / senha / portal (`isFirstAccessIntent`, `isFirstAccessStuckIntent`) | Cancela distribuição pendente, atribui IA, envia pacote de primeiro acesso | IA atendimento |
| `ava_disciplines` | Mensagem fala de Blackboard/AVA/disciplinas (`isAvaOrDisciplinesIntent`) | Atribui IA, envia mensagem de como ver disciplinas | IA atendimento |
| `greeting_self_serve` | Saudação pura, "?", "oi" (`isBareGreetingMessage`) | IA responde sem passar pela fila humana | IA atendimento |
| `attendance_scope` | Mensagem está fora do escopo configurado (`evaluateAttendanceScope`) | Handoff para departamento ou responde fora de escopo | Qualquer agente acadêmico |
| `inaugural_class_link` | Tag `calouros1008_*` ou pedido de link da aula inaugural | Envia link do YouTube da aula inaugural | Calouros / IA |
| `pending_handoff` | Existe `DistributionPending` ativo e aluno pede humano | Executa handoff acadêmico / fila | Fila humana |
| `handoff_ack_silence` | Aluno confirma/aceita fila após aviso de handoff | Limpa assignee, distribui para departamento | Fila humana |
| `ai_only_close` | Aluno pede encerramento ou despedida conclusiva | Fecha conversa e devolve card ao funil acadêmico | IA atendimento |
| `inbound_audio` | Mensagem de voz recebida | Handoff obrigatório para Atendimento/Retenção | Fila humana |
| `keyword_handoff` | Palavra-chave configurada em `keywordHandoffs` | Handoff acadêmico para Retenção/Atendimento/Acolhimento | Fila humana |
| `course_shopping` | Dúvida de valor/grade/info de outro curso ou site institucional | Handoff para Atendimento (não responde valores/grade) | Fila humana |
| `curriculum_or_tce` | Assinatura/envio de TCE ou pergunta "tem disciplina/estágio no curso?" | Handoff para Atendimento | Fila humana |
| `retention_intent` | Intenção de cancelar/trancar/desistir/trocar curso ou polo | Handoff para Retenção | Retenção |
| `opening_and_greeting_only` | Primeira mensagem + `openingMessage` configurada | Envia saudação e encerra o turno sem LLM | IA atendimento |

### 1.3 Prompt acadêmico

```489:640:src/verticals/academic/atendimento-prompt.ts
export const academicAtendimentoRules = () =>
  `
## IDENTIDADE
Você é consultora de suporte acadêmico da **${officialInstitutionName()}** no WhatsApp...
`;
```

- **O que faz**: injeta identidade, regras de portal, AVA, provas, TCE, polos, calendário, mídia e confiança no system prompt.
- **Trigger**: `fallbackRules` do pack (quando `steeringRules` está vazio) e `promptBlocks` do runner.
- **Agente afetado**: agentes com `verticalPack = "academic"` e arquétipo `ATENDIMENTO` (ou sem arquétipo).

### 1.4 Roteamento para Acolhimento / Retenção / Atendimento

```70:240:src/verticals/academic/department-routing.ts
export function inferDepartmentFromContext(...): AcademicDeptKey
export async function resolveDepartmentByName(...)
export async function resolveDepartmentByKey(...)
export async function executeAcademicDepartmentHandoff(...)
```

- **O que faz**: classifica a intenção do aluno em `acolhimento`, `retencao` ou `atendimento` e dispara `executeDistribution`.
- **Trigger**: interceptos de handoff, tools `transfer_to_department`, LLM chamando `execute_distribution`.
- **Departamentos afetados**: Acolhimento, Retenção, Atendimento - SAC.

```500:610:src/verticals/academic/department-routing.ts
export async function restoreDealToAcademicOrigin(...)
```

- **O que faz**: ao encerrar um atendimento IA ou humano, move o card de volta do funil "Atendimento" para o estágio acadêmico de origem.
- **Trigger**: `closeAiOnlyConversation`, encerramento humano, automações de encerramento.

### 1.5 Encerramento e detecção de fim de atendimento

```20:560:src/verticals/academic/closure.ts
export function userWantsAiConversationClose(...)
export function shouldCloseAiAfterStudentMessage(...)
export function attendanceEndedInFarewell(...)
export async function closeAiOnlyConversation(...)
```

- **O que faz**: detecta pedidos de encerramento, agradecimentos conclusivos, "era só isso", despedidas e adiamentos; fecha e devolve o card ao funil acadêmico.
- **Trigger**: intercepto `ai_only_close`, worker de inatividade, varredura de fila, pós-envio do agente.

### 1.6 Escolha do coordenador/especialista

```10:80:src/verticals/academic/coordinator-pick.ts
export function pickAcademicCoordinatorPeer(userMessage: string, peers: PeerAiAgent[]): PeerAiAgent | null
```

- **O que faz**: sugere peer por `routingScope` quando o assunto é onboarding, retention ou general.
- **Trigger**: `suggestCoordinatorAiAgent` usado por `coordinator-orchestrate.ts`.
- **Agente afetado**: agente com `archetype = "COORDENADOR"`.

### 1.7 Configuração de tenant (nome da instituição, URLs, polos)

```1:140:src/verticals/academic/tenant-config.ts
export const ACADEMIC_SETTING_PREFIX = "vertical.academic.";
export type AcademicTenantConfig = { institutionName, portalUrl, firstAccessVideoUrl, appAndroidUrl, appIosUrl, poloList, deptRoster, ... };
```

- **O que faz**: lê `OrganizationSetting` com prefixo `vertical.academic.*` (institutionName, portalUrl, etc.).
- **Trigger**: `loadTenantConfig` chamado pelo `runVerticalIntercepts` antes de montar o prompt.
- **Dados afetados**: todo texto de prompt e mensagens de primeiro acesso/provas/polos.

### 1.8 Relatório acadêmico como fonte de dados

```1:170:src/verticals/academic/record-source.ts
export const ACADEMIC_RECORD_ENTITY = "matricula";
export const academicRecordSource: RecordSource = {
  entity: "matricula",
  label: "Matrículas (relatório acadêmico)",
  fields: [ { name: "nome", label: "Nome do aluno" }, { name: "curso", label: "Curso" }, { name: "polo", label: "Polo" }, ... ],
  ...
};
```

- **O que faz**: expõe `studentAcademicRecord` como entidade pesquisável pelo motor genérico (`search_crm_records`).
- **Trigger**: tool `search_crm_records` habilitada.
- **Agente afetado**: qualquer agente acadêmico com a tool ligada.

### 1.9 Sync de departamentos acadêmicos

```1:270:src/verticals/academic/ensure-dept-roster.ts
const DEPT_DEFS = [
  { key: "acolhimento", names: ["Acolhimento"], ... },
  { key: "retencao", names: ["Retenção", "Retencao"], ... },
  { key: "atendimento", names: ["Atendimento - SAC", "Atendimento"], ... },
];
```

- **O que faz**: cria/atualiza os departamentos Acolhimento, Retenção e Atendimento - SAC e sincroniza membros a partir do `deptRoster`.
- **Trigger**: `executeAcademicDepartmentHandoff` com `force: true`.

### 1.10 Guarda de URLs oficiais

```1:100:src/verticals/academic/outbound-url-guard.ts
export function stripUnofficialUrls(text: string, contextText = ""): UrlGuardResult
```

- **O que faz**: remove do texto final do bot qualquer URL cujo host não seja o portal, app, certificado ou domínios configurados da instituição.
- **Trigger**: pós-processamento da resposta do agente no inbox-handler.

### 1.11 Pontos de integração no motor v1

| Arquivo | Linha / função | Papel |
|---|---|---|
| `src/services/ai/inbox-handler.ts` | `runVerticalIntercepts(earlyPack, { phase: "pre_assignee" })` | roda interceptos **antes** de atribuir agente |
| `src/services/ai/inbox-handler.ts` | `runVerticalIntercepts(agentPack, { phase: "post_assignee" })` | roda interceptos **depois** de atribuir agente |
| `src/services/ai/runner.ts` | `renderSystemPrompt(...)` + `pack.promptBlocks(...)` | injeta blocos de prompt do pack |
| `src/services/ai/coordinator-orchestrate.ts` | `suggestCoordinatorAiAgent(...)` | orquestra para especialistas usando `pickAcademicCoordinatorPeer` |
| `src/services/ai/agent-vertical.ts` | `getVerticalPack(row.verticalPack)` | resolve o pack a partir do agente |
| `src/services/ai/department-handoff.ts` | `ops?.executeAcademicDepartmentHandoff` | usa roteamento acadêmico quando disponível |

> **Impacto na v2**: agentes com `engine = "simple"` **não** passam por `inbox-handler`, runner, interceptos, pilotagem, effect-claims, coordinator-orchestrate, etc. Todo o comportamento acadêmico listado acima precisa ser traduzido para a `simpleConfig` da v2 (tones, rules, modes, actions, handoff_queue, knowledge docs).

---

## 2. Script de exportação

Criado em: `scripts/inventory-org-agents.ts`

Comando para rodar:

```bash
npx tsx scripts/inventory-org-agents.ts "Cruzeiro do Sul"
```

O script:

1. Lista organizações que batem com o argumento (nome ou ID).
2. Pede confirmação interativa.
3. Exporta `docs/inventory/cruzeiro-do-sul/agents.json` com:
   - dados da organização;
   - departamentos, funis/etapas, campos customizados, tabulações, modelos de mensagem e templates WhatsApp;
   - configuração completa de cada agente (prompts, tools, regras, pilotagem, handoff, knowledge docs, simpleConfig, etc.);
   - prompt final renderizado com `renderSystemPrompt` e contexto vazio;
   - estatísticas dos últimos 30 dias por agente (runs, handoffs, tokens, custo).
4. Salva o texto dos knowledge docs em `docs/inventory/cruzeiro-do-sul/knowledge/<agente>/<doc>.txt`.
5. **Nunca exporta** chaves OpenAI, e-mails, telefones, CPF, RGM ou endereços.

> Para preencher este relatório com dados reais, rode o script acima e substitua as seções 3–6 pelos valores de `agents.json`.

---

## 3. Mapa dos agentes (preencher após rodar o script)

| ID | Nome | Arquétipo | Engine | Vertical | Tools habilitadas | Handoff trigger principal | Mapeamento para v2 | Gaps na v2 |
|---|---|---|---|---|---|---|---|---|
| _colar do agents.json_ | | | | | | | | |

Colunas:
- **Engine**: `legacy` (motor v1) ou `simple` (motor v2).
- **Vertical**: `academic` ou `null`.
- **Tools habilitadas**: lista de `enabledTools` (ex.: `search_crm_records`, `search_products`, `transfer_to_human`, `add_tag`, ...).
- **Handoff trigger principal**: `keywordHandoffs`, retenção, áudio, fora de escopo, pedido humano, etc.
- **Mapeamento para v2**: quais `modes`/`rules`/`actions` da v2 cobrem o comportamento atual.
- **Gaps na v2**: o que a v2 ainda não suporta (ver seção 5).

---

## 4. Fluxo típico de conversa (motor v1)

1. **Ingesta**: mensagem do aluno entra pelo webhook Meta/Baileys.
2. **Pre-assignee**: `inbox-handler` roda `runVerticalIntercepts("pre_assignee")`:
   - primeiro acesso, AVA/disciplinas, saudação e link inaugural são resolvidos **sem** atribuir consultor humano.
3. **Atribuição**: conversa é atribuída a um agente IA (por canal, deal, ou fallback autônomo).
4. **Post-assignee**: `runVerticalIntercepts("post_assignee")` roda:
   - escopo, handoff pendente, ack de fila, encerramento, áudio, keyword, curso/TCE/retenção.
5. **Saudação**: se for primeiro contato e houver `openingMessage`, a IA envia a saudação.
6. **Runner / LLM**: monta system prompt com template + `steeringRules`/`systemPromptOverride` + blocos do pack acadêmico, chama LLM com tools (`search_crm_records`, `transfer_to_department`, `execute_distribution`, `close_conversation`, ...).
7. **Pós-LLM**: guarda de URLs, effect-claims, encerramento pós-despedida.
8. **Handoff**: se tool/fallback acionar, `executeAcademicDepartmentHandoff` resolve departamento e chama `executeDistribution`.
9. **Encerramento**: `closeAiOnlyConversation` restaura o deal ao funil acadêmico via `restoreDealToAcademicOrigin`.

---

## 5. Tabela de migração v1 → v2

| Funcionalidade v1 | Equivalente na v2 | Como migrar | Sem equivalente? |
|---|---|---|---|
| `systemPromptTemplate` + `steeringRules` | `rules` + `knowledge` da `simpleConfig` | Copiar regras de negócio para `rules`; extrair FAQs para knowledge docs | ❌ |
| Blocos de prompt do pack acadêmico (`atendimento-prompt.ts`) | `rules`, `modes` e knowledge docs | Criar modes para primeiro acesso, provas, polo, TCE, etc.; colar URLs/rotas no knowledge | ❌ |
| `enabledTools` + `toolConfig` | `allowed_actions` + tool definitions do sistema v2 | Mapear `add_tag`, `create_activity`, `move_stage`, `send_whatsapp_template`, etc. | parcial — v2 usa actions, não tools do runner v1 |
| `inboxPolicy` (handoff messages, departmentAliases, routingScope) | `handoff_message`, `handoff_queue`, `modes` | Configurar fila padrão e mensagens de handoff; mapear routingScope para modes | ❌ |
| `keywordHandoffs` | modo/handoff + regras de texto | Incluir keywords em `rules` ou `modes` | ❌ |
| `openingMessage` | `confirmation_message` / `identification_message` | Usar messages iniciais da v2 | ❌ |
| Auto-close / farewell detection (`closure.ts`) | Não existe na v2 | Implementar encerramento como action `close_conversation` se tool disponível; senão, humano fecha | ⚠️ |
| Roteamento por coordenador (`coordinator-orchestrate.ts`) | Não existe na v2 | Cada agente v2 é isolado; usar um único agente v2 com modes para cada assunto | ⚠️ |
| Interceptos determinísticos (`intercepts.ts`) | Regras + LLM estruturado + actions allowlist | Converter interceptos em `modes` e `rules`; confiar no LLM com Zod + guarda de ações | ⚠️ |
| `vertical.academic.*` settings (URLs, polos) | knowledge docs + `rules` | Cadastrar URLs/polos como documentos de conhecimento | ❌ |
| `studentAcademicRecord` / `search_crm_records` | `context_fields` do contato/deal + actions `search_products`/`add_tag` | Definir `context_fields` que a v2 lê; actions só leem/escrevem no CRM | ⚠️ |
| Inaugural class link (`inaugural-class-link.ts`) | Não existe na v2 | Criar automation externa ou mode + knowledge doc com link | ⚠️ |
| URL guard (`outbound-url-guard.ts`) | Não existe na v2 | Adicionar regra proibindo URLs não oficiais; não há validação automática | ⚠️ |
| Restore deal to academic origin (`restoreDealToAcademicOrigin`) | Não existe na v2 | Usar action `move_stage` no encerramento, se tool for permitida | ⚠️ |
| `ensureAcademicDepartmentRoster` (sync de departamentos) | Não existe na v2 | Manter departamentos configurados manualmente no CRM | ⚠️ |
| `identityConfirmationEnabled` | `confirmation_message` da v2 | Usar `stage = "awaiting_confirmation"` | ❌ |

---

## 6. Funcionalidades da v1 que ainda não têm equivalente na v2

1. **Roteamento por coordenador (`COORDENADOR` → especialistas)**  
   A v2 é single-agent por conversa. Não há transferência IA→IA automática por assunto.

2. **Interceptos determinísticos pré-LLM**  
   Toda lógica de `intercepts.ts` (primeiro acesso, AVA, áudio, calouros, keyword handoff, course shopping, curriculum/TCE, retenção) não existe na v2. Precisa ser reescrita como `rules`/`modes` e confiar no LLM estruturado.

3. **Encerramento automático inteligente**  
   `closure.ts` detecta despedidas, agradecimentos, "era só isso", adiamentos e fecha. A v2 ainda não tem detector de fim de conversa; encerramento só via action explícita ou humano.

4. **Guarda de URLs oficiais**  
   A v2 não valida se a resposta contém apenas URLs autorizados.

5. **Devolução do card ao funil acadêmico**  
   `restoreDealToAcademicOrigin` não existe na v2. A action `move_stage` pode mover para um estágio fixo, mas não rastreia a origem acadêmica anterior.

6. **Sync automático de departamentos/roster**  
   `ensureAcademicDepartmentRoster` é exclusivo do pack acadêmico.

7. **Aula inaugural / tag calouros**  
   Envio determinístico de link do YouTube para calouros com tag `calouros1008_*` não existe na v2.

8. **Políticas de produto (`productPolicy`)**  
   A v2 não tem bloco específico de apresentação de produtos; `search_products` retorna dados brutos e o prompt genérico deve conter as regras.

---

## 7. Perguntas para você

1. **Quantos agentes acadêmicos existem hoje?** O script vai listar, mas já sabemos se há apenas um agente `ATENDIMENTO` acadêmico ou também `COORDENADOR`, `TABULACAO`, `ENCERRAMENTO`, SDRs, vendedores etc.?

2. **A v2 deve substituir o pack acadêmico por UM agente único com modes?** Ou queremos vários agentes v2 (SAC educacional, SDR, Comercial) convivendo com o v1?

3. **Quais interceptos determinísticos são críticos e não podem depender só do LLM?** Exemplos: áudio → humano, retenção → Retenção, course shopping → Atendimento. Esses devem virar regras duras na v2?

4. **Como tratar o encerramento e a devolução do card ao funil acadêmico na v2?** Adicionamos uma action `close_conversation`/`move_stage` e regras de despedida no `rules`?

5. **A aula inaugural (calouros) continuará sendo enviada pela v1 ou deve migrar para automação/mode da v2?**

---

*Arquivos criados:*
- `scripts/inventory-org-agents.ts`
- `docs/inventory/INVENTORY_CRUZEIRO.md`
