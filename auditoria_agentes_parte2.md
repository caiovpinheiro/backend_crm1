# Auditoria agentes — parte 2 (tools, QA, guard)

Continua de `auditoria_agentes.md`. Fonte: `_wt_be_inbox_dedupe`.

## 2.6 Fallback de steering do pack academic (`ACADEMIC_ATENDIMENTO_RULES`)

Arquivo `c:\Users\o_mar\Projects\crm1\_wt_be_inbox_dedupe\src\verticals\academic\atendimento-prompt.ts` linhas 502–655. `OFFICIAL_INSTITUTION_NAME` = `"Cruzeiro do Sul"` (linha 23). URLs oficiais: constantes no mesmo arquivo (linhas 1–20 da região de URLs — ver arquivo). Texto:

```
## IDENTIDADE
Você é consultora de suporte acadêmico da **Cruzeiro do Sul** no WhatsApp. Fale curto, natural e acolhedor (tá/pra). Você NÃO é um robô.
O aluno é aluno da Cruzeiro do Sul — trate como tal. PROIBIDO falar de forma genérica: "sua instituição", "a sua faculdade", "a instituição", "o portal da sua instituição". Diga **Cruzeiro do Sul** (ou "Portal do Aluno", "Área do Aluno") pelo nome.
Nunca oriente o aluno a "procurar a instituição" como se você fosse de fora — você É o atendimento da Cruzeiro do Sul.
```

O restante do template (seções RELATÓRIO DE MATRICULADOS até CONFIANÇA) está no arquivo nas linhas 508–655 sem omissão no disco. Cópia integral nesta pasta: abrir `atendimento-prompt.ts` L502–L655. Não há snapshot tenant-resolvido além desta constante de compile-time.

`pack.ts` L85–92:

```
  fallbackRules: (archetype) => {
    if (archetype !== "ATENDIMENTO") return "";
    return [
      ACADEMIC_ATENDIMENTO_RULES,
      ACADEMIC_CURRICULUM_TCE_RULES,
      ACADEMIC_MEDIA_CAPABILITY_RULES,
      ACADEMIC_CONFIDENCE_RULES,
    ].join("\n\n");
  },
```

COORDENADOR com `steeringRules` vazio: `fallbackRules` devolve `""` (não é ATENDIMENTO).

---

## 3. Definições das tools

### 3.1 Catálogo (wizard / `enabledTools`)

Arquivo `c:\Users\o_mar\Projects\crm1\_wt_be_inbox_dedupe\src\lib\ai-agents\tools-catalog.ts` linhas 22–151. Lista completa de ids:

`create_deal`, `move_stage`, `add_tag`, `create_activity`, `search_products`, `search_crm_records`, `consultar_matricula`, `send_whatsapp_template`, `transfer_to_department`, `execute_distribution`, `transfer_to_human`, `transfer_to_ai_agent`, `transfer_conversation`, `close_conversation`, `list_tabulations`, `tabulate_conversation`.

Descrições e `defaultForArchetypes` — arquivo integral L22–151 (já lido na coleta). Destaques:

`transfer_to_human` L104–109:
```
    id: "transfer_to_human",
    label: "Transferir para humano",
    description:
      "Tira a conversa do agente de IA e atribui a um operador humano via fila de Distribuição. Usado sempre que o tema sair do escopo do agente.",
    category: "handoff",
    defaultForArchetypes: ["SDR", "ATENDIMENTO", "VENDEDOR", "SUPORTE", "ENCERRAMENTO", "COORDENADOR"],
```

`transfer_to_ai_agent` L112–117:
```
    id: "transfer_to_ai_agent",
    label: "Transferir para outro agente IA",
    description:
      "Entrega a conversa a outro agente de IA da organização, que assume a continuidade do atendimento. Usado pelo agente de primeiro contato para direcionar cada caso ao agente especializado. O aluno recebe um aviso antes da troca, e conversa, contato e negócios abertos passam para o agente de destino.",
    category: "handoff",
    defaultForArchetypes: [],
```

`transfer_conversation` L120–125:
```
    id: "transfer_conversation",
    label: "Passar a conversa",
    description:
      "Passa a conversa para um departamento (a fila escolhe quem atende), uma pessoa da equipe ou outro agente de IA. Pessoa indisponível vai para a fila do departamento dela.",
    category: "handoff",
    defaultForArchetypes: ["ATENDIMENTO", "SUPORTE", "COORDENADOR"],
```

### 3.2 Schema Zod enviado ao modelo (execução)

`transfer_to_ai_agent` — `tools.ts` L1309–1342:

```
function transferToAiAgentTool(ctx: RunContext) {
  return tool({
    description:
      "Entrega a conversa a outro agente de IA especializado, que assume a continuidade do atendimento. " +
      "Use quando já entendeu a necessidade e ela é do escopo de outro agente. " +
      "NÃO use em saudação, recado sem assunto ou 'depois eu falo'. " +
      "Se a política pedir aviso, `noticeMessage` é o que o aluno recebe ANTES da troca. " +
      "Depois de chamar esta tool NÃO escreva mais nada — quem fala com o aluno agora é o outro agente.",
    inputSchema: z.object({
      agentName: z.string().min(2).describe(
          "Nome do agente de destino, exatamente como está cadastrado (ex.: 'Agente Retenção').",
        ),
      noticeMessage: z.string().min(3).optional().describe(
          "Aviso ao aluno antes da troca. Ignorado se o operador desligou o aviso na Inbox.",
        ),
      reason: z.string().describe(
          "Motivo curto da classificação, para auditoria interna. NÃO vai para o aluno.",
        ),
      tagName: z.string().optional().describe(
          "Tag marcada no contato antes da transferência (ex.: 'RET-IA'). Precisa já existir no CRM.",
        ),
    }),
```

`transfer_to_human` — `tools.ts` L1180–1202:

```
    description:
      copy?.transferToHuman ??
      "Transfere a conversa para um consultor humano via Distribuição Inteligente. " +
        "ÚLTIMO RECURSO: só quando o contato pedir humano/atendente, ou você já tentou as tools/base e ainda não puder seguir com segurança. " +
        "Citar financeiro, acesso, matrícula ou horário NÃO basta. Se puder orientar, NÃO chame esta tool. " +
        "Quando chamar, a distribuição EXECUTA de verdade; confirme ao contato que um atendente vai ajudar. " +
        "Prefira `departmentName` quando souber a área. Se omitir, o sistema infere.",
    inputSchema: z.object({
      reason: z.string().describe(
          "Motivo curto do handoff, para o atendente ler (ex: 'Cliente pediu cancelamento').",
        ),
      departmentName: z.string().optional().describe(
          "Nome do departamento de destino (opcional).",
        ),
    }),
```

Pack academic substitui `copy.transferToHuman` (`pack.ts` L96–97): `"Transfere o aluno para um consultor humano quando ele pedir ou o tema exigir."`

`transfer_conversation` — `tools.ts` L1984–2007:

```
    description:
      "Passa a conversa para um destino: departamento (fila escolhe um consultor), uma pessoa da equipe, ou outro agente de IA. " +
      "Use `department` quando a área importa e qualquer consultor serve; `user` para alguém específico; `ai_agent` para um especialista IA da organização. " +
      "Pessoa indisponível (offline/expediente/fila cheia) cai na fila do departamento dela — não deixa o ticket parado nela. " +
      "Para departamento e pessoa, só chame se o contato pediu humano/atendente ou você não puder seguir com segurança.",
    inputSchema: z.object({
      target: z.enum(["department", "user", "ai_agent"]).describe(
          "department = fila do departamento; user = pessoa da equipe; ai_agent = outro agente IA.",
        ),
      name: z.string().min(1).describe(
          "Nome do departamento, da pessoa ou do agente IA (como está no CRM). Também aceita o id.",
        ),
      reason: z.string().optional().describe("Motivo curto, para o próximo atendente ler."),
    }),
```

`transfer_to_department` / `execute_distribution`: **NÃO copiados aqui na íntegra**; factories em `tools.ts` `FACTORY_MAP` L2065–2082.

### 3.3 Quais tools cada agente recebe

1. Persistido: `AIAgentConfig.enabledTools` (tenant). Dump: **NÃO ENCONTRADO**.

2. Defaults de arquétipo na criação: `archetypes.ts` `defaultTools` (COORDENADOR: `transfer_conversation`, `transfer_to_human`; ATENDIMENTO: lista em §2.3). `transfer_to_ai_agent` tem `defaultForArchetypes: []`.

3. Runtime filtra tools humanas se `transferPolicy === "on_request_or_topic"` e o contato não pediu humano agora, exceto COORDENADOR/TABULACAO/ENCERRAMENTO (`runner.ts` L476–490):

```
    let runtimeTools = [...(args.enabledTools ?? agent.enabledTools)];
    if (
      inboxPolicyForRun.transferPolicy === "on_request_or_topic" &&
      !classifierRun &&
      agent.archetype !== "COORDENADOR" &&
      agent.archetype !== "TABULACAO" &&
      agent.archetype !== "ENCERRAMENTO" &&
      !askedHumanNow
    ) {
      runtimeTools = runtimeTools.filter(
        (id) =>
          id !== "transfer_to_human" &&
          id !== "execute_distribution" &&
          id !== "transfer_to_department",
      );
    }
```

`transfer_to_ai_agent` e `transfer_conversation` **não** são removidos nesse filtro.

4. Instanciação: `buildToolSet` `tools.ts` L2195–2212 — só ids em `enabledIds` que existem em `FACTORY_MAP`. Policy por tool: `toolConfig` (`allowedAgentNames`, `allowedDepartments`, …) `steering.ts` L32–75.

5. Destino de transferência IA: nome cadastrado (`user.name`). Allowlist `toolConfig.transfer_to_ai_agent.allowedAgentNames` (vazio = todos). Código do gate: `nameGate` em `agent-handoff.ts` L70–82.

6. Destino por assunto (código, não LLM): `coordinator-route.ts` `pickPeerForTopic` L71–74:

```
  const onboarding = by(/acolh|primeiro.?acesso|onboard|boas.?vind/);
  const retention = by(/reten|churn/);
  const general = by(/atendiment|\bsac\b|suporte/);
```

7. Test mode (`source: "inbox_test"`): `withTestModeSimulation` `tools.ts` L2121–2158 recusa `transfer_to_ai_agent` para o próprio `ctx.agentName`.

---

## 4. QA e guard

### 4.1 Avaliador (working tree, inclui critério SELF_TRANSFER ainda sem push)

Arquivo completo `c:\Users\o_mar\Projects\crm1\_wt_be_inbox_dedupe\src\scripts\replay-qa.ts` (229 linhas). Critérios:

| code | severity | condição |
|---|---|---|
| MISSING_TURN | fail | `rec.length !== fx.turns.length` |
| INBOUND_MISMATCH | fail | inbound ≠ fixture |
| RULE_SKIP | fail | `skipped` começa com `rule_human` ou `tool_human` |
| RULE_SKIP | warn se desk Atendimento/SAC, senão fail | `skipped` começa com `rule_department` |
| EMPTY_COMPLETED | fail | sem skip, status≠RULE, texto vazio, zero tools |
| EMPTY_COMPLETED | warn | texto vazio com tools |
| FALSE_NONSENSE | fail | texto canned ASK/STOP e `nonsenseGuardReply` é null |
| SELF_TRANSFER | warn | ver função abaixo |
| PING_PONG | warn | `switches >= 3` no caso |

PASS: `fail === 0` (`formatQaReport` L218–220). WARN não altera exit code. `replay-agent-runs.ts` `process.exitCode = 1` só se `qa.fail > 0` e sem `--qa-continue`.

SELF_TRANSFER (working tree L67–81):

```
function selfTransfer(turn: ReplayQaTurn): boolean {
  const shown = foldName(turn.agentName);
  const from = foldName(turn.fromAgentName || turn.agentName);
  const dests = turn.tools
    .filter((t) => isAiTransferTool(t.name))
    .map((t) => foldName(toolDestName(t.args)))
    .filter(Boolean);
  if (dests.length === 0) return false;
  if (from !== shown) {
    const hopsToShown = dests.filter((d) => d === shown).length;
    const hopsToFrom = dests.filter((d) => d === from).length;
    return hopsToFrom > 0 || hopsToShown > 1;
  }
  return dests.some((d) => d === from);
}
```

### 4.2 SELF_TRANSFER em `origin/DEV_BRANCH` (`cd2fda88`, o que o EasyPanel do screenshot rodou)

```
function selfTransfer(turn: ReplayQaTurn): boolean {
  const me = foldName(turn.agentName);
  if (turn.switchedTo && foldName(turn.switchedTo) === me) return true;
  return turn.tools.some((t) => {
    if (t.name !== "transfer_to_ai_agent" && t.name !== "transfer_conversation") {
      return false;
    }
    const dest = foldName(toolDestName(t.args));
    return dest.length > 0 && dest === me;
  });
}
```

(`git show cd2fda88:src/scripts/replay-qa.ts` equivalente ao index `e9f1ce27` no diff local.)

### 4.3 Diff unpushed (worktree vs `origin/DEV_BRANCH`)

Comando: `git diff` em `_wt_be_inbox_dedupe` (2026-09-18). Arquivos: `src/scripts/replay-qa.ts`, `src/scripts/replay-agent-runs.ts`, `src/scripts/__tests__/replay-qa.test.ts`.

Trecho `replay-qa.ts`:

```
+  fromAgentName?: string | null;
...
+function isAiTransferTool(name: string): boolean {
+  return name === "transfer_to_ai_agent" || name === "transfer_conversation";
+}
+
 function selfTransfer(turn: ReplayQaTurn): boolean {
-  const me = foldName(turn.agentName);
-  if (turn.switchedTo && foldName(turn.switchedTo) === me) return true;
-  return turn.tools.some((t) => {
-    if (t.name !== "transfer_to_ai_agent" && t.name !== "transfer_conversation") {
-      return false;
-    }
-    const dest = foldName(toolDestName(t.args));
-    return dest.length > 0 && dest === me;
-  });
+  const shown = foldName(turn.agentName);
+  const from = foldName(turn.fromAgentName || turn.agentName);
+  const dests = turn.tools
+    .filter((t) => isAiTransferTool(t.name))
+    .map((t) => foldName(toolDestName(t.args)))
+    .filter(Boolean);
+  if (dests.length === 0) return false;
+  if (from !== shown) {
+    const hopsToShown = dests.filter((d) => d === shown).length;
+    const hopsToFrom = dests.filter((d) => d === from).length;
+    return hopsToFrom > 0 || hopsToShown > 1;
+  }
+  return dests.some((d) => d === from);
 }
```

`replay-agent-runs.ts`: campo `fromAgentName` no `TurnRecord`; log `Joseph → Agente Acolhi`; preenchimento `fromAgentName: speaker.name` nos três `records.push`.

Testes novos: “handoff Joseph → especialista não é SELF_TRANSFER”; “especialista já no desk chamando a si mesmo é SELF_TRANSFER”.

### 4.4 Guard que aborta o LLM

`runner.ts` L313–336:

```
    if (!classifierRun) {
      const nonsense = nonsenseGuardReply(args.userMessage, priorUserMessages);
      if (nonsense) {
        await prisma.aIAgentRun.update({
          where: { id: run.id },
          data: {
            status: "COMPLETED",
            outcome: "ANSWERED",
            llmInvoked: false,
            finishedAt: new Date(),
            interceptsFired: ["nonsense_guard"] as unknown as Prisma.InputJsonValue,
          },
        }).catch(() => null);
        return {
          runId: run.id,
          text: nonsense,
          status: "COMPLETED",
          ...
          toolCalls: [],
        };
      }
    }
```

`transfer-gate.ts` L124–223 (idle + unintelligible + `nonsenseGuardReply`) — working tree:

Constantes:
```
export const NONSENSE_ASK_ONCE =
  "Não entendi essa mensagem. Me fala em uma frase o que você precisa (acesso, matrícula, financeiro, cancelar).";

export const NONSENSE_STOP =
  "Quando tiver um pedido objetivo (acesso, matrícula, financeiro, cancelar), me chama que eu te ajudo. Por aqui não consigo seguir com isso.";
```

```
export function nonsenseGuardReply(
  current: string,
  priorUserMessages: string[],
): string | null {
  const threadHasWork = priorUserMessages.some(
    (p) => !isIdleOrchestrationMessage(p) && !isUnintelligibleInbound(p),
  );
  if (threadHasWork) return null;
  const streak = unintelligibleStreak(current, priorUserMessages);
  if (streak >= 2) return NONSENSE_STOP;
  if (streak === 1) return NONSENSE_ASK_ONCE;
  return null;
}
```

`isIdleOrchestrationMessage` e `isUnintelligibleInbound`: `transfer-gate.ts` L124–187 (texto integral no arquivo).

Gate de transferência humana (não é o nonsense): `evaluateTransferGate` `transfer-gate.ts` L74+.

Continua em `auditoria_agentes_parte3.md`.
