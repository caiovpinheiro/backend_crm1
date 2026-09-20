# Plano de Reescrita do Motor de Agentes de IA

> Versão: Fase 0.  
> Baseado em `docs/ARCHITECTURE.md` e no inventário de código em `docs/INVENTORY.md`.

## Objetivo

Reescrever o motor de agentes de IA de forma que ele seja:

1. **Genérico por tenant** — sem hardcoding de vertical (`academic`, `Cruzeiro do Sul`, departamentos fixos).
2. **Testável de ponta a ponta** — contratos claros entre ingestão, orquestração, LLM, tools e efeitos; harness de teste sem depender de produção.
3. **Desacoplado** — separação entre: motor genérico, vertical packs, políticas operacionais, infraestrutura de mensagens e CRM.
4. **Observável e seguro** — todo efeito colateral é declarado, validado e auditado; guardrails não dependem de regex sobre texto livre.
5. **Simples de operar** — um único modo de ingestão/turno, prompt assembly previsível, handoff unificado.

O plano é executado em fases. **Nenhuma fase altera o código existente além do estritamente necessário para o seu escopo**. Cada fase para em um checkpoint para validação humana.

---

## Fases

### Fase 0 — Inventário

**Escopo**: Mapear tudo o que existe hoje sem alterar código.

**Entregáveis**:
- `docs/ARCHITECTURE.md`
- `docs/INVENTORY.md`

**CHECKPOINT 0**: validar resumo executivo, cobertura do inventário e riscos priorizados. Prosseguir para Fase 1 somente após aprovação.

---

### Fase 1 — Contratos e Test Harness

**Escopo**: Definir os contratos internos do novo motor e criar um harness de teste que rode runs completos sem LLM real e sem banco de produção.

**Entregáveis**:
- Tipos/ interfaces canônicos em `src/services/ai-core/types.ts`:
  - `AgentConfig`, `Run`, `Turn`, `Tool`, `Effect`, `HandoffTarget`, `Outcome`, `Policy`, `PromptBlock`.
- `src/services/ai-core/test-harness.ts`: executor de run com LLM stub e tools stub.
- Testes que reproduzem casos do replay atual (fixture `joseph-replay-lote2.json`) contra o novo contrato.
- Documento `docs/CONTRACTS.md` com diagrama de sequência dos fluxos: inbound, playground, automation, handoff, encerramento.

**CHECKPOINT 1**: contratos cobrem os 4 fluxos principais; harness executa ao menos 5 casos do fixture; não altera código de produção.

---

### Fase 2 — Desacoplamento da Vertical Acadêmica

**Escopo**: Extrair todo conhecimento específico da vertical `academic` do motor genérico.

**Entregáveis**:
- Novo pack `academic` em `src/verticals/academic/` reescrito contra o contrato genérico.
- Motor genérico sem referências a `aluno`, `matrícula`, `polo`, `Cruzeiro do Sul`, `Acolhimento`, `Retenção`, `Atendimento`.
- Prompt blocks, aliases, tool copy e interceptos passam a ser registrados pelo pack via plugin, não hardcoded no runner.
- Testes de regressão que garantem o mesmo comportamento do pack acadêmico.

**CHECKPOINT 2**: motor genérico compila; pack acadêmico plugado; testes de regressão passam.

---

### Fase 3 — Runtime Unificado de Turnos

**Escopo**: Consolidar debounce legado e Turn Manager em um único runtime de turnos persistente.

**Entregáveis**:
- Apagar `inbound-debounce.ts` (legado) e unificar em `turn-manager.ts`.
- `AI_TURN_MANAGER` deixa de existir; turnos persistentes são o único caminho.
- `ConversationTurn` como fonte única de entrada do runner.
- Testes de concorrência e de recovery após crash/restart.

**CHECKPOINT 3**: todos os caminhos de inbound passam pelo turn manager; nenhuma referência ao debounce legado; testes de concorrência passam.

---

### Fase 4 — Orquestração e Handoff Unificados

**Escopo**: Consolidar toda lógica de handoff/orquestração em um módulo único com contrato declarativo.

**Entregáveis**:
- `src/services/ai-core/orchestrator.ts` — decide destino (responder, transferir IA, transferir humano, encerrar) com base em políticas e estado.
- `src/services/ai-core/handoff.ts` — execução atômica de transferência (cluster assignment, eventos, SSE).
- Tools de transferência (`transfer_*`, `execute_distribution`, `close_conversation`) passam a delegar para o orquestrador.
- Eliminar `coordinator-orchestrate.ts`, `agent-handoff.ts`, `department-handoff.ts`, `piloting-actions.ts` (handoff) e dispersão em `tools.ts`.

**CHECKPOINT 4**: todas as transferências passam pelo orquestrador; testes de handoff IA→IA, IA→humano, humano→IA, fila e encerramento passam.

---

### Fase 5 — Prompt Assembly Declarativo e Governança de Efeitos

**Escopo**: Tornar o prompt uma composição declarativa de blocos e substituir o guardrail de efeitos por um contrato explícito.

**Entregáveis**:
- `src/services/ai-core/prompt-builder.ts` — monta prompt a partir de `PromptBlock[]` providos por config, pack e runtime.
- `src/services/ai-core/effects.ts` — registry de efeitos possíveis e validação pós-tool.
- Ferramentas declaram seu efeito (`EffectKind`); o runner valida que texto gerado só afirma efeitos realizados.
- Substitui `effect-claims.ts` baseado em regex por verificação estruturada.

**CHECKPOINT 5**: prompt é 100% composto por blocos declarados; validação de efeitos usa registry estruturado; testes de efeitos passam.

---

### Fase 6 — Rollout, Migração e Depreciação

**Escopo**: Fazer a transição do motor antigo para o novo sem downtime, com kill-switch e rollback.

**Entregáveis**:
- Feature flag `AI_CORE_V2=1` controla uso do novo motor.
- Adaptadores para API routes e workers usarem o novo motor quando a flag está ativa.
- Migration de dados: `AIAgentConfig` continua sendo a fonte; novos campos opcionais.
- Script de validação: compara desfecho de 100 runs do motor antigo e novo sobre fixtures.
- Documento `docs/MIGRATION.md` e plano de rollback.

**CHECKPOINT 6**: flag ativada em DEV; replay antigo e novo coincidem ≥ 95% dos casos; rollback documentado.

---

## Critérios gerais de aceite

- Nenhuma regressão em testes existentes sem decisão explícita.
- Cada fase entrega apenas o necessário; sem refatorações adjacentes.
- Documentação mínima: contratos e checkpoints. Histórico não é expandido automaticamente.
- Backend continua sendo a fonte de verdade; frontend só adapta depois que o contrato HTTP estabilizar.
