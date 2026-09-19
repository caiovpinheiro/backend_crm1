# Auditoria agentes — parte 4 (dump EasyPanel / teste-dev)

Coleta: 2026-09-18. Somente leitura. Esta máquina não tem sessão no EasyPanel nem `.env` com `DATABASE_URL` de produção/DEV remoto.

## Onde se procurou

- `c:\Users\o_mar\Projects\crm1\_wt_be_inbox_dedupe\.env` — **NÃO ENCONTRADO** (só `.env.example`)
- `c:\Users\o_mar\Projects\crm1\_wt_be_inbox_dedupe\.env.example` — sem connection string preenchida
- `/tmp/replay-lote2.json` e `/tmp/replay-lote2.qa.json` — path Linux do container; não existe no Windows local
- Prisma `AIAgentConfig` / `AIAgentRun` / `AIAgentMessage` — sem dump, sem query executada (sem credencial)

## Dump AIAgentConfig dos 4 agentes

**NÃO ENCONTRADO.**

Campos pedidos (`enabledTools`, `toolConfig`, `inboxPolicy`, `steeringRules`, `systemPromptTemplate`, `archetype`, `verticalPack`) viveriam em `ai_agent_configs` + `User.name`. Sem acesso ao banco da org `teste-dev`.

Único vestígio local (stdout de replay, não o banco):

```
{"org":{"id":"cmpptxqd00002od01pxxs0g12","slug":"teste-dev"},"start":{"id":"cmu75dymh0003zlgkgx2lg0i2","name":"Joseph","archetype":"COORDENADOR","announceAiTransfer":false},"agents":["Agente Acolhi","Agente Retenção","Joseph","Agente Atendimento"]}
```

## AIAgentRun + AIAgentMessage da última execução lote 2 (incl. 403971)

**NÃO ENCONTRADO.** `systemPromptSnapshot`, `toolName`, `toolData` não estão neste workstation.

## `/tmp/replay-lote2.json` e `/tmp/replay-lote2.qa.json`

**NÃO ENCONTRADO.**

Stdout do QA (8 turns) só lista findings SELF_TRANSFER, sem args das tools.

## Resposta: 403971 t0 — `agentName` do SEGUNDO `transfer_to_ai_agent`

**Não há JSON de toolData.** Inferência a partir do stdout clipado e do código de orquestração:

Linha de log:

```
403971 | t0 | Agente Atendimento | COMPLETED | → Agente Atendimento | transfer_to_ai_agent,transfer_to_ai_agent | Falar com equipe | …
```

`maybeOrchestrateCoordinatorTurn` prepende a primeira chamada com `args: { agentName: dest.name }` (`coordinator-orchestrate.ts`). Destino do tópico `"Falar com equipe"` via `pickPeerForTopic("general")` casa `/atendiment|\bsac\b|suporte/` → **Agente Atendimento**.

A segunda chamada está no `nested.toolCalls` do especialista já no desk Atendimento. Recusa em test-mode / auto-chamada usa o próprio nome.

**agentName do segundo `transfer_to_ai_agent`: `Agente Atendimento`.**

Confirmação com `toolData` no banco: **NÃO ENCONTRADO**.
