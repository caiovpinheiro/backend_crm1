# Auditoria externa — sistema de agentes de IA (orquestrador + especialistas)

Coleta somente leitura. Data da coleta: 2026-09-18.

Código-fonte inspecionado: worktree `c:\Users\o_mar\Projects\crm1\_wt_be_inbox_dedupe` (branch `DEV_BRANCH`, HEAD commit `cd2fda88` + working tree local não empurrado). Repositório irmão: `c:\Users\o_mar\Projects\crm1\backend_crm1_repo`. Frontend: `c:\Users\o_mar\Projects\crm1\frontend_crm1_repo` (não contém o runner).

Índice das partes:
- Este arquivo: seções 1 e 2
- `auditoria_agentes_parte2.md`: seções 3 e 4
- `auditoria_agentes_parte3.md`: seções 5 e 6

Segredos/PII: nomes, telefone, e-mail de clientes do fixture substituídos por `[REDACTED]`.

---

## 1. Log bruto do QA

### 1.1 JSON EasyPanel `/tmp/replay-lote2.json`, `.txt`, `.qa.json`

**NÃO ENCONTRADO** neste workstation.

Procurou-se:
- `c:\Users\o_mar\Projects\crm1\**\*replay*lote*`
- `c:\Users\o_mar\Projects\crm1\**\*.qa.json`
- `c:\Users\o_mar\Projects\crm1\_wt_be_inbox_dedupe\scripts\`
- pasta `/tmp` (Linux EasyPanel) — não existe nesta máquina Windows
- tabelas `ai_agent_runs` / `ai_agent_messages` — sem dump, sem conexão de leitura nesta tarefa

O schema onde o prompt final e tools de um run de produção seriam persistidos (não há dump):

`c:\Users\o_mar\Projects\crm1\_wt_be_inbox_dedupe\prisma\schema.prisma` linhas 5160–5272:

```
model AIAgentRun {
  id              String           @id @default(cuid())
  organizationId  String
  ...
  source          String           @default("inbox")
  conversationId  String?
  contactId       String?
  responsePreview String?
  ...
  systemPromptSnapshot String?  @db.Text
  ...
  createdAt       DateTime         @default(now())
  finishedAt      DateTime?
  messages AIAgentMessage[]
  @@map("ai_agent_runs")
}

model AIAgentMessage {
  id             String       @id @default(cuid())
  organizationId String
  runId          String
  role           String
  content        String       @db.Text
  toolName       String?
  toolData       Json?
  createdAt      DateTime     @default(now())
  @@map("ai_agent_messages")
}
```

Timestamps de turno de QA: **NÃO ENCONTRADO** no stdout (o harness não imprime ISO por turno). Só `createdAt` existiria em `AIAgentRun` se houvesse dump.

Args completos de tools e `result` JSON: **NÃO ENCONTRADO** nas capturas de stdout (só nomes concatenados).

### 1.2 Fixture inbound do ticket 403971 (não é o replay)

Arquivo `c:\Users\o_mar\Projects\crm1\_wt_be_inbox_dedupe\src\scripts\fixtures\joseph-replay-lote2.json` linhas 27–38 (PII mascarada):

```json
    {
      "id": "403971",
      "label": "[REDACTED]",
      "turns": [
        "Falar com equipe",
        "Financeiro",
        "Quero falar com a equipe"
      ],
      "contact": {
        "name": "[REDACTED]",
        "phone": "[REDACTED]"
      }
    }
```

Cópia idêntica em `c:\Users\o_mar\Projects\crm1\backend_crm1_repo\src\scripts\fixtures\joseph-replay-lote2.json` (mesmo trecho).

### 1.3 Captura de stdout — recorte lote 2 `--limit 35` (chat Cursor, execução EasyPanel anterior ao QA PASS)

Formato cru da linha (clip 60/80 caracteres). Sem timestamp. Sem JSON de tools.

Org slug impresso no início daquela execução (texto colado no chat):

```
{"org":{"id":"cmpptxqd00002od01pxxs0g12","slug":"teste-dev"},"start":{"id":"cmu75dymh0003zlgkgx2lg0i2","name":"Joseph","archetype":"COORDENADOR","announceAiTransfer":false},"agents":["Agente Acolhi","Agente Retenção","Joseph","Agente Atendimento"],"lote":"2","cases":["403969","403970","403971","403972","403973","403974","403976","403977","403978","403979","403980","403982","403983","403984","403985","403986","403987","403988","403989","403990","403991","403992","403993","403994","403995","403996","403997","403998","403999","404000","404001","404002","404003","404004","404005"]}
```

Ticket 403971 (três linhas, ordem t0–t2), texto colado no chat sem alteração de ordem; nome do aluno na resposta do agente mascarado:

```
403971 | t0 | Agente Atendimento | COMPLETED | → Agente Atendimento | transfer_to_ai_agent,transfer_to_ai_agent | Falar com equipe | Oi, [REDACTED]! Estou aqui para ajudar você no setor de Atendimento da Cruzeiro do Su…
403971 | t1 | Agente Atendimento | COMPLETED | - | Financeiro | Não entendi essa mensagem. Me fala em uma frase o que você precisa (acesso, matr…
403971 | t2 | Agente Atendimento | COMPLETED | transfer_to_ai_agent | Quero falar com a equipe | [REDACTED], eu já sou do setor de Atendimento e estou aqui para ajudar você com o que…
```

O restante das 189 linhas dessa execução (403969–404005) está no histórico da conversa Cursor (mensagem do operador com o dump `--limit 35`). **NÃO ENCONTRADO** como arquivo `.json` local. A transcrição completa ALUNO/AGENTE dessa execução **NÃO ENCONTRADO** (o clip 60/80 era o formato então deployado).

### 1.4 Captura de stdout — execução posterior (8 turns) com bloco QA

Imagem EasyPanel (2026-09-18). Texto visível:

```
wrote /tmp/replay-lote2.json (8 turns)
wrote /tmp/replay-lote2.txt (transcrição completa)

===== QA REPLAY =====
PASS  fail=0  warn=5
WARN 403969 t0 SELF_TRANSFER — Agente Acolhi transfer_to_ai_agent para si
WARN 403970 t0 SELF_TRANSFER — Agente Atendimento transfer_to_ai_agent para si
WARN 403971 t0 SELF_TRANSFER — Agente Atendimento transfer_to_ai_agent para si
WARN 403971 t2 SELF_TRANSFER — Agente Atendimento transfer_to_ai_agent para si
WARN 403972 t1 SELF_TRANSFER — Agente Acolhi transfer_to_ai_agent para si
===== FIM QA =====

wrote /tmp/replay-lote2.qa.json
```

Conteúdo de `/tmp/replay-lote2.json`, `/tmp/replay-lote2.txt` e `/tmp/replay-lote2.qa.json` dessa execução: **NÃO ENCONTRADO** nesta máquina.

Turnos 403969–403972 em formato ALUNO/AGENTE dessa execução: **NÃO ENCONTRADO** (só o resumo QA acima). Inferência de ordem a partir do fixture: 403969 (1 inbound), 403970 (1), 403971 (3), 403972 (2) = 8 turns.

### 1.5 Forma do registro que o harness gravaria (código)

`TurnRecord` em `c:\Users\o_mar\Projects\crm1\_wt_be_inbox_dedupe\src\scripts\replay-agent-runs.ts` (working tree, linhas 59–73):

```
type TurnRecord = {
  caseId: string;
  turnIndex: number;
  inbound: string;
  agentId: string;
  agentName: string;
  fromAgentName: string;
  llmInvoked: boolean;
  runId: string | null;
  status: string | null;
  text: string;
  tools: Array<{ name: string; args: unknown; result: unknown }>;
  rule: { action: string; label: string; department: string | null } | null;
  switchedTo: string | null;
  skipped: string | null;
};
```

O JSON de saída é `{ org, startedAs, at, turns: TurnRecord[] }` (`replay-agent-runs.ts` após o loop). Campo `at` é `new Date().toISOString()` no fim do job, não por turno.

---

## 2. Prompts de sistema

### 2.1 Prompt FINAL montado (variáveis resolvidas) por agente Joseph / Acolhi / Atendimento / Retenção

**NÃO ENCONTRADO.**

Procurou-se:
- `systemPromptSnapshot` em dumps JSON / logs locais
- `AIAgentMessage` role=system
- `/tmp` EasyPanel
- seed com texto já interpolado para org `teste-dev`

O que existe é a **função de montagem** (mesmo código do runner e do preview HTTP). Sem org name, agent name, contact, RAG e `steeringRules` salvos do tenant, o texto final não pode ser reproduzido aqui.

Endpoint de preview (sem RAG/DB de conversa): `c:\Users\o_mar\Projects\crm1\_wt_be_inbox_dedupe\src\app\api\ai-agents\preview-prompt\route.ts` linhas 14–80. Corpo aceita `systemPromptTemplate`, `archetype`, `verticalPack`, `enabledTools`, `steeringRules`, `systemPromptOverride`, `productPolicy`. Resposta dessa API para os quatro agentes: **NÃO ENCONTRADO**.

Não há arquétipo separado “Acolhimento” ou “Retenção” no código. Os três especialistas usam o template do arquétipo `ATENDIMENTO` (`archetypes.ts`). A diferenciação no tenant é `User.name` + `steeringRules`/`enabledTools` no banco — **NÃO ENCONTRADO** o JSON `AIAgentConfig` da org `teste-dev`.

### 2.2 Template no código — arquétipo COORDENADOR (orquestrador)

`c:\Users\o_mar\Projects\crm1\_wt_be_inbox_dedupe\src\lib\ai-agents\archetypes.ts` linhas 109–142:

```
    id: "COORDENADOR",
    label: "Coordenador — Orquestra o atendimento",
    ...
    defaultTools: ["transfer_conversation", "transfer_to_human"],
    defaultTone: "objetivo, claro e direto (WhatsApp)",
    suggestedModel: "gpt-4.1-mini",
    systemPromptTemplate: `Você é {{agent_name}}, coordenação do atendimento da {{company_name}}. Você NÃO tira dúvida do cliente.

## Sua missão
Entender o assunto da mensagem e passar a conversa para o destino certo com \`transfer_conversation\`.

## Destinos
- \`department\`: a fila do departamento escolhe quem atende.
- \`user\`: uma pessoa da equipe, pelo nome como está no CRM. Se ela estiver indisponível, a conversa vai para a fila do departamento dela.
- \`ai_agent\`: outro agente IA especialista da organização.

## Regras
- Não explique o assunto do especialista — passe para o agente IA certo.
- NÃO transfira saudação, agradecimento ou recado sem assunto (“depois eu falo”). Uma frase curta e espere.
- Destino preferido: \`ai_agent\`. Humano só se o contato pediu atendente ou não houver especialista.
- Se o contato pedir humano/atendente, passe para departamento ou pessoa.
- Uma transferência por turno. O aviso ao cliente só existe se o interruptor da Inbox estiver ligado; senão a troca é silenciosa (não escreva "vou te encaminhar").
- Não invente nomes de departamento, pessoa ou agente.

## Tom de voz
{{tone}}. Responda em {{language}}.

## Contexto
- Contato: {{contact_name}} ({{contact_phone}})
- Deal: {{deal_summary}}
- Tags: {{contact_tags}}`,
```

### 2.3 Template no código — arquétipo ATENDIMENTO (usado por Acolhi / Atendimento / Retenção se o tenant não sobrescreveu `systemPromptTemplate`)

`archetypes.ts` linhas 76–106:

```
    id: "ATENDIMENTO",
    ...
    defaultTools: [
      "add_tag",
      "create_activity",
      "consultar_matricula",
      "transfer_to_department",
      "execute_distribution",
      "transfer_to_human",
      "transfer_conversation",
      "close_conversation",
    ],
    systemPromptTemplate: `Você é {{agent_name}}, consultora de suporte virtual da {{company_name}}. Seu nome não importa — você conversa como pessoa real pelo WhatsApp.

## Sua missão
Resolver dúvidas de primeiro nível com base na documentação, no relatório de matriculados (\`consultar_matricula\`) e nas tools. Quando precisar de humano, roteie o departamento (Acolhimento / Retenção / Atendimento) e acione a distribuição — não espere automação de início de pipe.

## Tom de voz
{{tone}}. Responda em {{language}}.

## Contexto da conversa
- Cliente: {{contact_name}} ({{contact_phone}})
- Histórico de deals: {{deal_summary}}
- Tags: {{contact_tags}}
- Última interação humana: {{last_human_interaction}}`,
```

### 2.4 Variáveis `{{...}}` e montagem runtime

`c:\Users\o_mar\Projects\crm1\_wt_be_inbox_dedupe\src\lib\ai-agents\system-prompt.ts` linhas 93–154 (`TemplateVars`, `renderTemplateVars`) e 238–460 (`renderSystemPrompt`).

Chaves: `agent_name`, `company_name`, `tone`, `language`, `contact_name`, `contact_phone`, `contact_tags`, `deal_summary`, `deal_stage`, `deal_products`, `last_human_interaction`.

Preenchimento no runner (`runner.ts` 638–670):

```
    const systemPrompt = renderSystemPrompt({
      template: classifierRun
        ? ARCHETYPE_MAP.TABULACAO.systemPromptTemplate
        : agent.systemPromptTemplate,
      override: runtimeOverride,
      productPolicy: agent.productPolicy,
      archetype: classifierRun ? "TABULACAO" : agent.archetype,
      ...
      templateVars: {
        agent_name: agent.user?.name ?? null,
        company_name: org?.name ?? null,
        deal_products: null,
        last_human_interaction: null,
      },
    });
```

`company_name` = `Organization.name` do banco. Valor para slug `teste-dev`: **NÃO ENCONTRADO**.

`runtimeOverride` (`runner.ts` 549–580) concatena `systemPromptOverride` (se não duplicar steering), `steeringRules` ou fallback do pack, bloco “não sei”, auto-close, regras de exame/TCE/matrícula do pack, e o bloco `## Transferência entre agentes IA` conforme `inboxPolicy.announceAiTransfer`.

Bloco extra COORDENADOR (`system-prompt.ts` 304–324) + `formatCoordinatorRoutingBlock` (`coordinator-route.ts` 90–114). Lista de nomes de agentes: vem de `prisma.aIAgentConfig.findMany` no turno — **NÃO ENCONTRADO** dump. A captura de stdout da org listou: `"Agente Acolhi","Agente Retenção","Joseph","Agente Atendimento"`.

### 2.5 Configuração de tenant que preenche o template

Campos Prisma `AIAgentConfig` (não dumpados): `systemPromptTemplate`, `systemPromptOverride`, `steeringRules`, `tone`, `language`, `enabledTools`, `toolConfig`, `inboxPolicy`, `verticalPack`, `productPolicy`, `archetype`. Relação `user.name`.

Fallback se `steeringRules` vazio e pack academic + archetype ATENDIMENTO: `pack.ts` 85–92 concatena `ACADEMIC_ATENDIMENTO_RULES` + TCE + mídia + confiança.

Constante de instituição no pack:

`atendimento-prompt.ts` linha 23:

```
export const OFFICIAL_INSTITUTION_NAME = "Cruzeiro do Sul";
```

Texto completo `ACADEMIC_ATENDIMENTO_RULES` (`atendimento-prompt.ts` 502–655) — este é o fallback de steering do pack, interpolado em compile-time com `OFFICIAL_INSTITUTION_NAME` e URLs oficiais do mesmo arquivo. Copiado na íntegra em `auditoria_agentes_parte2.md` seção 2.6 (tamanho).

Wizard frontend (espelho de templates): `c:\Users\o_mar\Projects\crm1\frontend_crm1_repo\src\lib\ai-agents\archetypes.ts` — **não lido linha a linha nesta coleta**; o contrato de template no backend é a fonte usada pelo runner.

Continua em `auditoria_agentes_parte2.md`.
