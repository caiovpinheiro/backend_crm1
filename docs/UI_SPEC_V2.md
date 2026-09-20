# UI_SPEC_V2.md — Tela de agentes IA v2

Este documento define a tela `/ai-agents-v2/[id]` campo a campo, mapeando cada controle a um caminho canônico do `v2AgentConfigSchema`.

## Regras gerais da tela

- Três abas fixas: **Config**, **Testar**, **Logs**.
- **Config** é dividida em seções: Geral, Jeito de falar, O que ele sabe, Assuntos, Saídas, Equipe e horários.
- Todo campo visível na tela deve ter um caminho equivalente no `v2AgentConfigSchema`. O bloco **Avançado (JSON)** só pode conter chaves que ainda não têm controle visual.
- **Salvar rascunho** persiste em `draftConfig` do agente. **Publicar** copia o rascunho para `simpleConfig`, ativa o agente e cria uma linha em `AIAgentConfigVersion`.
- Sem `confirm()` nativo do browser. Usar o diálogo de confirmação do design system (`useConfirm`).
- Catálogos de referência (destinos, documentos, modelos etc.) vêm de `GET /api/ai-agents-v2/catalogs`. A UI guarda o `id`; se o `id` não existir mais no catálogo, exibe o nome salvo com um aviso “não encontrado”.

## 1. Aba Config

### 1.1 Geral

| Campo na tela | Caminho no schema | Tipo | Default |
|---|---|---|---|
| Nome do agente | `name` | string | obrigatório |
| Ativo | `active` (coluna do `AIAgentConfig`, não dentro do JSON) | boolean | true |
| Fluxo | `flow` | select: `reception`, `full`, `onboarding` | `full` |
| Modelo LLM | `model` | select/string | `gpt-4o-mini` |
| Canais vinculados | `channelIds` | multi-select de ids | `[]` |
| Modo de execução | `autonomyMode` | select: `autonomous`, `draft` | `autonomous` |
| Domínios permitidos em links | `allowedDomains` | array de strings | `[]` |

### 1.2 Jeito de falar

| Campo na tela | Caminho no schema | Tipo |
|---|---|---|
| Comportamento da resposta | `responseBehavior` | select: `objective`, `balanced`, `natural`, `creative` |
| Tom / persona | `tone` | textarea |
| Regras globais | `globalRules` | lista de textos |

> O `responseBehavior` é convertido internamente em `temperature` (0.2, 0.4, 0.6, 0.8). O número nunca aparece na UI.

### 1.3 O que ele sabe

| Campo na tela | Caminho no schema | Tipo |
|---|---|---|
| Documentos de conhecimento globais | `allowedKnowledgeDocIds` | multi-select (catálogo `knowledgeDocs`) |
| Modelos de mensagem globais | `allowedMessageModelIds` | multi-select (catálogo `messageModels`) |

> A aba **Testar** mostra os trechos do RAG retornados pelas ferramentas de consulta.

### 1.4 Assuntos (themes)

Lista `themes`. Cada item tem:

| Campo na tela | Caminho no schema | Tipo |
|---|---|---|
| ID interno | `themes[].id` | string (gerado pela UI) |
| Nome do assunto | `themes[].name` | string |
| Gatilhos (palavras/frases) | `themes[].when` | lista de strings |
| Exemplos de mensagens | `themes[].examples` | lista de strings |
| Instruções específicas | `themes[].instructions` | textarea |
| Tools permitidas | `themes[].allowedTools` | multi-select fixo de tools |
| Docs permitidos (por assunto) | `themes[].allowedKnowledgeDocIds` | multi-select |
| Modelos permitidos (por assunto) | `themes[].allowedMessageModelIds` | multi-select |
| Handoff deste assunto | `themes[].handoffDestination` | destino (catálogo) |
| Máximo de turnos no assunto | `themes[].maxTurns` | number |
| Política de produtos | `themes[].productPolicy` | grupo de campos (igual ao produto global) |

Tools fixas disponíveis: `search_products`, `search_crm_records`, `knowledge_search`, `list_message_models`, `send_message_model`, `send_product`, `send_whatsapp_template`, `add_tag`, `update_field`, `add_note`, `create_deal`, `move_stage`, `create_activity`, `ask_with_options`, `handoff`, `close_conversation`.

### 1.5 Saídas

#### Entrada (`entry`)

| Campo na tela | Caminho no schema | Tipo |
|---|---|---|
| Mensagem de abertura | `entry.openingMessage` | string |
| Mensagem de confirmação | `entry.confirmationMessage` | string |
| Mensagem de identificação | `entry.identificationMessage` | string |
| Quando não encontrar negócio | `entry.onDealNotFound` | select: `ask_identification`, `create_deal`, `handoff` |
| Confirmar identidade antes de atender | `entry.confirmact` | boolean |
| Campos usados na confirmação | `entry.confirmationFields` | multi-select de campos do catálogo |

#### Handoff (`handoff`)

| Campo na tela | Caminho no schema | Tipo |
|---|---|---|
| Destino padrão | `handoff.defaultDestination` | destino (catálogo) |
| Mensagem padrão de handoff | `handoff.message` | string |
| Palavras-chave de pedido humano | `handoff.humanRequestKeywords` | lista de strings |

#### Encerramento (`closure`)

| Campo na tela | Caminho no schema | Tipo |
|---|---|---|
| Janela pós-encerramento (horas) | `closure.postCloseWindowHours` | number |
| Comportamento: cortesia | `closure.courtesyBehavior` | select: `no_reply`, `short_reply`, `reopen_and_route`, `ask_with_options` |
| Comportamento: nova demanda | `closure.newDemandBehavior` | select (mesmas opções) |
| Comportamento: ambíguo | `closure.ambiguousBehavior` | select (mesmas opções) |
| Mensagem de despedida | `closure.goodbyeMessage` | string |
| Devolver card à origem ao fechar | `closure.returnToOriginStage` | boolean |

#### Limites (`limits`)

| Campo na tela | Caminho no schema | Tipo |
|---|---|---|
| Máx. respostas de cortesia | `limits.maxCourtesyReplies` | number |
| Máx. ofertas de ajuda | `limits.maxHelpOffers` | number |
| Máx. trocas travadas | `limits.maxStalledExchanges` | number |
| Ação após travamento | `limits.stalledExchangesAction` | select: `handoff`, `close` |
| Limite de mensagens sem sentido | `limits.nonsenseLimit` | number |
| Ação após sem sentido | `limits.nonsenseAction` | select: `warn_and_silence`, `handoff` |
| Minutos de silêncio | `limits.silenceMinutes` | number |
| Janela de detecção de loop (min) | `limits.loopDetectionWindowMinutes` | number |
| Máx. repetições (loop) | `limits.maxLoopCount` | number |
| Máx. transferências IA→IA | `limits.maxAiTransfers` | number |

#### Regras determinísticas (`rules`)

Lista ordenada. Cada regra tem:

- `id`, `name`, `order`.
- Condições (`conditions`): tipo (`message_type`, `keywords`, `contact_tag`, `first_message`, `out_of_hours`, `deal_stage`, `field_equals`, `no_deal`, `survey_received`, `media_kind`), `values`, `field`, `expected`, `negate`.
- Ações (`actions`): tipo (`send_message`, `set_theme`, `handoff`, `add_tag`, `close_conversation`, `no_reply`, `send_message_model`, `send_whatsapp_template`, `set_variable`, `record_knowledge_gap`), `message`, `themeId`, `destination`, `tag`, `variable`, `modelId`.

### 1.6 Equipe e horários

| Campo na tela | Caminho no schema | Tipo |
|---|---|---|
| Horário de atendimento ativo | `businessHours.enabled` | boolean |
| Timezone | `businessHours.timezone` | string/select |
| Dias/horários | `businessHours.weekdays` | lista de `{ day, start, end }` |
| Mensagem fora do expediente | `businessHours.offHoursMessage` | string |
| Teto de custo diário (USD) | `costCap.maxUsdPerDay` | number |
| Teto de custo mensal (USD) | `costCap.maxUsdPerMonth` | number |
| Ação ao estourar custo | `costCap.action` | select: `handoff` |
| Teto de tokens diários | `dailyTokenCap` | number (0 = sem limite) |
| Tools habilitadas globalmente | `enabledTools` | multi-select fixo |
| Máx. chamadas de tool por turno | `toolGovernor.maxCallsPerTurn` | number |
| Máx. repetições da mesma tool | `toolGovernor.maxRepeatsPerTool` | number |

## 2. Bloco Avançado (JSON)

Só deve aparecer para chaves não cobertas pelas seções acima. Na FASE A, ficam aqui:

- `variables`
- `contextFields`
- `media`
- `sentiment`
- `survey`
- `onboarding`
- `productPolicy` (quando usado como fallback global, fora dos temas)

> A UI faz merge profundo: valores das abas sobrescrevem o JSON avançado; o JSON avançado só pode preencher campos ausentes nas abas.

## 3. Aba Testar

- Campo de mensagem + botão Enviar.
- Endpoint: `POST /api/ai-agents-v2/:id/test`.
- Para cada resposta, a UI deve mostrar cards com:
  - `appliedRuleId` (regra determinística que disparou, se houver)
  - `themeId` (assunto selecionado)
  - `reply` (texto que seria enviado ao cliente)
  - `reason` (motivo da resposta)
  - `toolCalls` — nome da tool, argumentos e resultado resumido
  - trechos do RAG (vêm dentro do resultado de `knowledge_search`)
  - `executedActions` — ações que seriam executadas
  - `discardedActions` — ações descartadas por allowlist
  - `handoff`, `closed`
  - tokens in/out e latência

## 4. Aba Logs

- Lista de `AISimpleTurnLog` do agente.
- Filtro por `conversationId`.
- Exibe: inbound, reply, regra aplicada, JSON do LLM, ações executadas/descartadas, handoff/closed, timestamp.

## 5. Catálogos

`GET /api/ai-agents-v2/catalogs` retorna:

```json
{
  "departments": [{ "id": "...", "name": "..." }],
  "distributionRules": [{ "id": "...", "name": "..." }],
  "users": [{ "id": "...", "name": "...", "type": "HUMAN|AI" }],
  "aiAgents": [{ "id": "...", "name": "..." }],
  "messageModels": [{ "id": "...", "name": "..." }],
  "knowledgeDocs": [{ "id": "...", "name": "..." }],
  "channels": [{ "id": "...", "name": "..." }],
  "pipelines": [{ "id": "...", "name": "...", "stages": [{ "id": "...", "name": "..." }] }],
  "contactCustomFields": [{ "id": "...", "name": "..." }],
  "dealCustomFields": [{ "id": "...", "name": "..." }],
  "products": [{ "id": "...", "name": "..." }],
  "whatsappTemplates": [{ "id": "...", "name": "..." }]
}
```

A UI guarda apenas o `id`. Quando um `id` salvo não aparece no catálogo, exibe o nome cacheado com badge/ícone de aviso.

## 6. Salvar vs Publicar

- **Salvar rascunho**: `PUT /api/ai-agents-v2/:id/draft` com body `{ config }`. Atualiza `AIAgentConfig.draftConfig`.
- **Publicar**: `POST /api/ai-agents-v2/:id/publish` com body opcional `{ comment?: string }`. Copia `draftConfig` → `simpleConfig`, seta `active=true` e insere `AIAgentConfigVersion`.
- A tela de edição carrega `draftConfig` se existir; senão carrega `simpleConfig`.

## 7. Alinhamento com schema

Os campos deste documento usam exclusivamente campos já existentes em `v2AgentConfigSchema`. Caso uma futura FASE adicione campo novo, ele deve ser adicionado primeiro ao schema e depois à tela, no mesmo commit.
