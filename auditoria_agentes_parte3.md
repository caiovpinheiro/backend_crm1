# Auditoria agentes — parte 3 (handoff, log, acoplamento)

## 5. Handoff e log

### 5.1 Orquestração (código escolhe destino e aninha `runAgent`)

Arquivo `c:\Users\o_mar\Projects\crm1\_wt_be_inbox_dedupe\src\services\ai\coordinator-orchestrate.ts` (arquivo 138 linhas). Entrada:

```
export async function maybeOrchestrateCoordinatorTurn(args: {
  runArgs: RunArgs;
  agent: CoordinatorAgent;
  runNested: (next: RunArgs) => Promise<RunResult>;
}): Promise<RunResult | null>
```

Chamado em `runner.ts` L198–204 **antes** do LLM, se `!args.skipCoordinatorOrchestration`.

Fluxo copiado (L42–137):
- return null se skip, TABULACAO/ENCERRAMENTO, idle (`isIdleOrchestrationMessage`), ou `userWantsHumanDistribution`
- `suggestCoordinatorAiAgent(userMessage, peers)`; return null se sem dest ou dest === self
- se `conversationId && contactId`: opcional `sendAgentMessage` se `announceAiTransfer`; depois `executeOrchestratedHandoff({ target: "ai_agent", name: dest.name, reason: "Orquestração por assunto", ...})`
- `runNested({ ...runArgs, agentId: dest.id, skipCoordinatorOrchestration: true })`
- devolve nested result com tool sintética prepended:

```
    toolCalls: [
      {
        name: "transfer_to_ai_agent",
        args: { agentName: dest.name },
        result: { ok: true, assigned: true, agentName: dest.name },
      },
      ...nested.toolCalls,
    ],
```

Replay `source: "inbox_test"`: `conversationId` costuma ser ausente → o bloco `executeOrchestratedHandoff` não roda; só o nested `runAgent` no dest. Harness depois lê tools e troca `current` (`replay-agent-runs.ts` `inspectHandoff` / `applyHandoff`).

### 5.2 Motor de atribuição

`executeOrchestratedHandoff` — `agent-handoff.ts` L322+.

`assignNamedAi` L262–319:

```
  await prisma.$transaction((tx) =>
    assignOwnerToContactClusterTx(tx, {
      userId: args.user.id,
      via: null,
      contactId: args.contactId,
      dealId: args.dealId,
      conversationId: args.conversationId,
    }),
  );

  await createConversationEvent({
    conversationId: args.conversationId,
    action: "distribuicao",
    text: `Conversa transferida para o agente ${args.user.name}`,
    actor: "Agente IA",
    authorType: "bot",
    dedupeStartsWith: ["Conversa transferida para o agente"],
    dedupeWindowMs: 2 * 60 * 1000,
  }).catch(() => null);
```

`transferToAiAgentTool` execute (`tools.ts` L1430–1456) também chama `assignOwnerToContactClusterTx` com `via: "ai_handoff"`, SSE `conversation_assigned`, e se houver deal `createDealEvent(..., "AI_AGENT_ACTION", { action: "transferred_to_ai_agent", agentId, reason, targetAgentUserId, targetAgentName })`.

### 5.3 Evento de conversa (campos gravados)

`createConversationEvent` — `conversation-events.ts` L75–149. Persistência:

```
  const saved = await prisma.message.create({
    data: withOrgFromCtx({
      conversationId: args.conversationId,
      content: text,
      direction: "out",
      messageType: eventMessageType(args.action),
      isPrivate: true,
      authorType,
      senderName: actor,
      sendStatus: "sent",
    }),
  });
```

Campos do handoff IA→IA no evento: `content` = `"Conversa transferida para o agente ${name}"`, `senderName` = `"Agente IA"`, `authorType` = `"bot"`, `action` mapeada para `messageType`, `isPrivate: true`. **Não** há colunas separadas origem/destino além do texto. `fromAgentUserId` **não** é gravado nesse evento.

SSE `new_message`: `organizationId`, `conversationId`, `contactId`, `direction`, `messageType`, `content`, `timestamp: saved.createdAt`, `senderName`.

### 5.4 Log de run / tools

`runner.ts` L715–720 grava `AIAgentMessage` role `system` (prompt completo) e `user` (inbound). Tools: mensagens role `tool` com `toolName`/`toolData` — trecho de create das tools **não relido nesta coleta** (mesmo modelo L5254–5271).

`inbox-handler.ts` L1218–1260: se após tools o `assignedTo` é outro user type AI, envia `result.text` com `agentUserId` do destino e `logAi("handoff", { reason: "peer_ai", toUserId })`.

### 5.5 Contexto passado de um agente ao outro

Nested orchestrator (`coordinator-orchestrate.ts` L121–125):

```
  const nested = await runNested({
    ...runArgs,
    agentId: dest.id,
    skipCoordinatorOrchestration: true,
  });
```

Espalha o mesmo `RunArgs`: `userMessage`, `history`, `contactId`, `conversationId`, `dealId`, `source`, etc. O especialista **não** recebe um resumo separado; lê a mesma janela.

Carga de histórico se `args.history` omitido (`runner.ts` L292–311): `loadHistoryFromConversation(conversationId, historyLimit, historySince)` → `{role, content}`. `priorUserMessages` = users da sessão recente (`trimToRecentSession`).

Harness de replay (`replay-agent-runs.ts`): `history` array local, `history.slice(-10)` em cada `runAgent`; após turno faz push user + assistant. Sem `conversationId` no teste, o histórico é só esse array em memória.

Prompt do especialista: `renderSystemPrompt` de novo com o `AIAgentConfig` do dest (template, steering, peers `formatSpecialistPeerBlock`).

---

## 6. Pontos de acoplamento com tenant/produto

Escopo da busca: `_wt_be_inbox_dedupe\src` (`*.ts`, `*.tsx`, `*.json`). Frontend CRM: não varrido linha a linha (templates duplicados em `frontend_crm1_repo\src\lib\ai-agents\`).

Ocorrências de `aluno` / `matricul` / `cancelament` / `unidade` são numerosas (dezenas de arquivos). Abaixo: **lista completa** para nomes de agentes/org/instituição; para as palavras genéricas, **índice arquivo→contagem** + trechos no roteador e pack. Grep content de cada linha de `aluno` em todo o monorepo: não colado (centenas de hits); arquivos e contagens em 6.5.

### 6.1 `Joseph`

| arquivo | linha |
|---|---|
| `src\scripts\replay-agent-runs.ts` | 9, 12, 354 |
| `src\scripts\__tests__\replay-qa.test.ts` | 7, 14, 151, 171, 182 |

Default: `process.env.REPLAY_START_AGENT ?? "Joseph"` (L354). `--org` default `teste-dev` L351.

### 6.2 `Acolhi` / `Agente Acolhi`

| arquivo | linha |
|---|---|
| `src\scripts\__tests__\replay-qa.test.ts` | 15, 19, 23 |

Regex de roteamento (não o string `Acolhi`): `coordinator-route.ts` L72 `/acolh|.../`

### 6.3 `Agente Atendimento` / `Agente Retenção` (string literal)

| arquivo | linha |
|---|---|
| `src\scripts\__tests__\replay-qa.test.ts` | 40, 41, 45, 49, 65, 69, 76, 97, 123 |
| `src\services\ai\tools.ts` | 1322 (`ex.: 'Agente Retenção'`) |

### 6.4 `teste-dev` / `Cruzeiro`

| arquivo | linha | trecho |
|---|---|---|
| `src\scripts\replay-agent-runs.ts` | 9, 12, 351 | `teste-dev` |
| `src\scripts\replay-agent-runs.ts` | 331 | `instituicao: "Cruzeiro do Sul Virtual"` |
| `src\scripts\fixtures\joseph-replay-lote2.json` | 87 | inbound com “Cruzeiro do Sul” (texto de aluno) |
| `src\scripts\fixtures\joseph-replay-lote2.json` | 667 | URL Google “EAD - Cruzeiro do Sul Vila Prudente” |
| `src\verticals\academic\atendimento-prompt.ts` | 20–23, 418, 582 | `OFFICIAL_INSTITUTION_NAME = "Cruzeiro do Sul"` |
| `src\verticals\academic\intercepts.ts` | 1210 | comentário “Cruzeiro” |
| `src\verticals\academic\department-routing.ts` | 263 | comentário EduIT → Cruzeiro |
| `src\verticals\academic\ensure-dept-roster.ts` | 185 | comentário org acadêmica (Cruzeiro) |
| `src\services\distribution\pending-drain-guard.ts` | 51 | comentário Cruzeiro EaD / Retenção |
| `src\lib\prisma.ts` | 132 | comentário Cruzeiro EaD |
| `src\services\__tests__\automation-branch-routing.test.ts` | 5 | comentário incidente Cruzeiro |
| `src\lib\phone.ts` | 128 | comentário + telefone exemplo `[REDACTED no espírito da coleta: arquivo contém +5585…]` |
| `src\lib\phone.test.ts` | 125 | comentário org Cruzeiro EaD |
| `src\lib\deal-import-core.ts` | 542, 703 | comentários Cruzeiro EaD |
| `src\lib\__tests__\automation-distribution-scope.test.ts` | 4 | comentário Cruzeiro EaD |

### 6.5 Desks Acolhimento / Retenção / Atendimento (produto academic)

`ensure-dept-roster.ts` L21–29:

```
const DEPT_DEFS = [
  { key: "acolhimento", names: ["Acolhimento"], ... },
  { key: "retencao", names: ["Retenção", "Retencao"], ... },
  { key: "atendimento", names: ["Atendimento - SAC", "Atendimento"], ... },
]
```

`coordinator-route.ts` L1–4, 26–78, 104–107 (regex e frases de destino).

`archetypes.ts` L97: `"Acolhimento / Retenção / Atendimento"`.

`pack.ts` L99: `"Encaminha para Acolhimento, Retenção ou Atendimento conforme o tema."`

`atendimento-prompt.ts` L535–537, e demais menções no mesmo arquivo (49 hits da palavra `aluno` nesse arquivo).

`department-routing.ts`: L2, 70, 82, 120–123, 164, 172–174, 183, 214, 227, 310 (`acolhimento: "Acolhimento"`), 861, 898, 908–909.

`intercepts.ts` L1094, 1160 `"Acolhimento"`.

`cockpit-academic.ts` L80 `if (t.includes("acolh")) return "Acolhimento"`.

`automation-workflow.ts` L216 comentário Acolhimento.

`department-handoff.ts` L108 comentário.

`tabulation-analytics.ts` L57 comentário.

`app\api\leads\route.ts` L171 comentário.

`generic-agent-e2e.test.ts` L484 `"Acolhimento"`.

`tools.ts` L1573–1574 `enforceAtendimentoIfAcolhimentoBlocked`.

### 6.6 `aluno` — arquivos e número de matches (`rg` count)

Inclui `replay-agent-runs.ts` (4), `runner.ts` (2), `tools.ts` (13), `inbox-handler.ts` (11), `system-prompt.ts` (1), `coordinator-route.ts` (1), `steering.ts` (2), `tools-catalog.ts` (3), `transfer-gate.ts` (1), `atendimento-prompt.ts` (49), `closure.ts` (11), `department-routing.ts` (6), `intercepts.ts` (7), `pack.ts` (3), `academic-record-policy.ts` (7), `sensitive-fields.ts` (6), `message-models-retrieval.ts` (6), `academic-records.ts` (5), e os demais arquivos listados no count da coleta (seção grep `aluno` em `_wt_be_inbox_dedupe\src`). Linha a linha de todos os hits: **não colada neste md** (volume). Abrir cada arquivo do count.

`system-prompt.ts` L161: `'O aluno age em cima disso.'`

`transfer-gate.ts` L180 regex contém `|aluno|`.

### 6.7 `unidade`

`atendimento-prompt.ts` L610: `selecionar a **unidade** (ex.: UNICID - EAD)`.

Outros hits de `unidade` no grep combinado `cancelament|matricul|unidade` incluem `inventory.ts`, `quota.ts`, `capabilities`, APIs de produtos — ver count da coleta.

### 6.8 `matrícula` / `cancelamento`

`coordinator-route.ts` L33–35, 41–43, 104–105.

`transfer-gate.ts` L157, 180, 206–209 (strings ASK/STOP).

`archetypes.ts` L81, 97.

`tools-catalog.ts` `consultar_matricula`.

`default-message-rules.ts` (2).

`academic-record-policy.ts` (12).

`atendimento-prompt.ts` (16 no grep combinado).

`replay-agent-runs.ts` seed `tipoMatricula: "MATRICULA"`, `curso: "Pedagogia"`, `polo: "EAD"` L328–333.

### 6.9 IDs fixos de tenant

Org id `cmpptxqd00002od01pxxs0g12` e agent id `cmu75dymh0003zlgkgx2lg0i2` aparecem **só** na captura de stdout da seção 1 (não no código). Seed de e-mails de roster academic: `ensure-dept-roster.ts` (mapa de e-mails — **não copiado** para não espalhar PII de operadores; arquivo L~30+).

### 6.10 Frontend

Não varrido com a mesma lista. Caminhos esperados: `frontend_crm1_repo\src\lib\ai-agents\archetypes.ts`, `steering.ts`, `tools-catalog.ts`. **NÃO ENCONTRADO** nesta coleta o dump de linhas.

---

Fim da coleta.
