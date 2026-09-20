# Motor de Agentes v2 — Especificação

Documento único do que a v2 precisa ser. Serve de base para o plano de implementação e para a UI.
Protótipo navegável da interface: usar como referência de comportamento e de vocabulário.

---

## 1. Objetivo e critério de sucesso

Um motor de agentes **genérico** dentro do CRM, simples de manter, com as mesmas capacidades do motor atual (v1), porém:

- 100% configurável, sem código de domínio de nenhum cliente;
- fácil de ajustar: para toda resposta ruim deve ser possível ver **por que** e **onde mexer**;
- integrado às features do CRM (departamentos, distribuição inteligente, campos, tabulações, automações).

**Critério de sucesso:** todo o comportamento atual da organização de referência (ver `docs/inventory/INVENTORY_CRUZEIRO.md`) deve ser reproduzível **apenas com configuração**. A organização é o caso de validação, não o alvo.

**Fora de escopo:** sincronização automática de departamentos (gerida no CRM) e o cockpit específico de vertical da tela antiga.

---

## 2. Princípios

1. Fluxo determinístico em código; o LLM só classifica e escreve. Ele nunca decide a transição.
2. Nada de domínio no código ou em presets (sem "aluno", "matrícula", "polo" etc.).
3. Um único caminho de código: agente único é um fluxo sem roteamento.
4. Proibido interceptor, hook implícito ou condicional por cliente. Comportamento novo = config, ferramenta ou bloco documentado.
5. O agente nunca afirma uma ação que não executou, e nunca responde o que não está nos materiais ou nos dados do cliente.
6. Rastro (trace) por turno desde o primeiro dia.
7. A conversa fica presa à versão de config com que começou.

**Reaproveitar da v1 (nível runner):** `generateWithTools`, `FACTORY_MAP`, `tool-governor`, RAG (upload, `embeddings.ts`, `retrieval.ts`, pgvector), `executeDistribution`, `crm-field-policy`, record sources, `sendAgentMessage`, Turn Manager, tabulações.
**Não reaproveitar:** `inbox-handler`, `verticals/*`, interceptors, pilotagem legada, `message-rules`, `coordinator-*`, `effect-claims`, `closure.ts`.

---

## 3. Blocos do motor

### 3.1 Contexto
- Identificação pelo telefone do canal → contato → negócios.
- Campos de contato e de negócio vêm do catálogo do CRM, com **três permissões separadas por campo**: ler, citar, atualizar (usar `crm-field-policy`).
- Record sources (bases adicionais) só quando **explicitamente** selecionadas na config do agente.
- Vários negócios abertos: usar o mais recente ou perguntar ao cliente (listando pelos campos "citar").
- Cliente **não** encontrado: pedir dado (com nº de tentativas), criar negócio/lead, encaminhar, ou passar para humano.

### 3.2 Variáveis
Pares chave/valor por agente (`@Nome da empresa`, `@Link da área do cliente`), usáveis em mensagens, regras, temas e prompt.

### 3.3 Entrada da conversa
Como a conversa chega decide o comportamento inicial:

| Origem | Comportamento |
|---|---|
| Cliente iniciou | Abertura + confirmação, conforme config |
| Automação / chatbot | Sem abertura; recebe histórico e variáveis coletadas; pode já vir com tema inicial |
| Pessoa ou outro agente | Sem abertura; recebe resumo, dados confirmados e motivo; continua de onde parou |

O agente também deve ser **destino de automação** ("transferir para agente X") e poder devolver a conversa a uma fila ou automação ao encerrar.

### 3.4 Mensagens com trecho condicional
Sintaxe: `Vi que você está em @Curso{, desde @Data de início}`. O trecho entre chaves só é renderizado se todos os campos citados nele tiverem valor. Nunca renderizar campo vazio nem o marcador cru. Vale para abertura, confirmação, transferência, regras e despedida. Formatação por tipo (data, moeda, número, lista).

### 3.5 Regras determinísticas
Lista ordenada, avaliada **antes** do LLM; a primeira que casar vence.
- Condições (combináveis): tipo de mensagem (áudio, imagem, documento), palavras-chave, etiqueta do contato, primeira mensagem, fora do horário, etapa do negócio, campo igual a valor, cliente sem negócio.
- Ações: enviar mensagem fixa, transferir (destino completo), adicionar etiqueta, forçar tema, encerrar, não responder.
- Toda regra aplicada aparece no trace.

### 3.6 Temas (especialidades)
Por tema: nome, quando usar, exemplos, instruções, ferramentas permitidas, documentos permitidos, destino de transferência, condição de escalar, **quem responde** (este agente ou outro agente) e tabulação sugerida. Opção "transferir direto, sem conversar".
O turno usa só as instruções, ferramentas e documentos do tema selecionado, mais tom e regras globais.

### 3.7 Ferramentas
Loop real de function calling com o registry da v1.
- **Consulta** (`search_products`, `search_crm_records`, `knowledge_search`): resultado volta ao modelo antes da resposta.
- **Efeito** (`create_deal`, `add_tag`, `create_activity`, `move_stage`, `send_whatsapp_template`, `update_field`, `add_note`, `close_conversation`, `tabulate_conversation`): allowlist por tema; `update_field` restrito aos campos com permissão de escrita.
- Limite de chamadas por turno; tudo registrado no trace.

### 3.8 Conhecimento (RAG)
Upload por agente reaproveitando `AIAgentKnowledgeDoc`/`Chunk` e `retrieveAgentKnowledge`; adicionar suporte a PDF em `knowledge-extract`. Documentos associados a temas, com busca filtrada pelo tema. "Testar busca" na UI. Campo de texto livre como opcional.

### 3.9 Saídas do atendimento (explícitas)
Toda saída precisa estar configurada:

| Situação | Config |
|---|---|
| Resolveu | Encerra, classifica, despede-se |
| Precisa de gente | Transfere para o destino do tema ou o padrão do agente |
| É de outro especialista | Encaminha levando resumo, dados e motivo |
| Não soube responder | Mensagem + ação (passar, reperguntar N vezes, encerrar) |
| Cliente pediu uma pessoa | Mensagem + transferência imediata |
| Resposta não está nos materiais | Mensagem específica; nunca completar com suposição |
| Erro/timeout do modelo ou ferramenta | Mensagem específica; sempre termina em gente |
| Cliente sumiu | Lembrete após X, encerramento após Y |
| Fora do horário | Aviso, aguardar ou transferir |

### 3.10 Transferência (handoff)
Uma única função. Destino completo: **departamento, fila, usuário ou distribuição inteligente** (`executeDistribution` com a estratégia do CRM). Configurável por tema, por regra e como padrão do agente. Marca `human_active`; botão "devolver para o agente" retoma. Transferência entre agentes passa resumo + dados coletados + motivo + tema, com limite de idas e voltas por conversa (padrão 2) e humano como saída.

### 3.11 Tabulação e encerramento
- Tabulações vêm do CRM (`list_tabulations` / `tabulate_conversation`).
- Configurável: quando classificar (ao encerrar, ao transferir ou ambos), tabulação de reserva, "não encerrar sem classificar", mapa tema → tabulação sugerida.
- O agente escolhe a tabulação **mais próxima do motivo real** da conversa, não do tema inicial.
- Ao encerrar: devolver o negócio à etapa anterior ao atendimento (etapa de origem guardada no estado), despedida opcional, devolver para automação opcional.

### 3.12 Guardas e observabilidade
- Domínios autorizados: links fora da lista são removidos e registrados.
- Modo de autonomia: autônomo ou rascunho (humano aprova).
- Trace por turno: origem da conversa, regra aplicada, tema, contexto do CRM usado, trechos do RAG, ferramentas e resultados, JSON de saída, motivo, tabulação, latência, tokens, erros.
- Versões de config (`AIAgentConfigAudit`) com reverter.
- Casos de teste criados ao marcar uma resposta como ruim.

---

## 4. Agrupamento e canal
- Toda conversa da v2 usa o **Turn Manager persistente**, independente da flag `AI_TURN_MANAGER`. Agentes v1 não mudam.
- Nada da v1 (worker de inatividade, interceptors, jobs) pode agir em conversas de agentes v2.
- Respostas longas podem ser quebradas em mensagens; indicador de digitação; no modo rascunho nada é enviado antes da aprovação.

---

## 5. Contrato de saída do LLM

```json
{
  "reply": "texto para o cliente",
  "theme": "id do tema",
  "handoff": false,
  "concluded": false,
  "confirmed": null,
  "tabulation": "id da tabulação ou null",
  "collected": { "campo": "valor" },
  "reason": "por que respondeu assim"
}
```
Validado com zod. Saída inválida: uma nova tentativa; falhou de novo, aplica a saída de erro.

---

## 6. Papéis de agente e fluxos do wizard

Dois fluxos, mesmo motor. O papel é escolhido no primeiro passo.

**Recepção (organiza o atendimento)** — faz o primeiro atendimento, identifica, confirma e encaminha. Não responde dúvidas.
`Começar · Jeito de falar · Reconhecer o cliente · Para quem encaminha · Regras automáticas · Saídas · Classificar e encerrar · Testar e publicar`

**Agente completo (atendimento, vendas, SDR, suporte, especialista)**
`Começar · Jeito de falar · O que ele sabe · Materiais · Início da conversa · Assuntos · Regras automáticas · Saídas · Equipe e horários · Classificar e encerrar · Testar e publicar`

Especialistas **herdam** do agente de origem: tom, regras globais, campos do CRM, variáveis e links permitidos, com opção de sobrescrever.

### Telas (conteúdo essencial)
1. **Começar** — nome, canal, modelo (Recepção, Atendimento, Qualificar contatos novos, Vendas, Suporte técnico, Em branco).
2. **Jeito de falar** — tom (múltiplo), tamanho da resposta, regras globais, prévia.
3. **O que ele sabe / Reconhecer o cliente** — tabela de campos com ler/citar/atualizar e valor de exemplo; vários negócios; cliente fora da base; variáveis fixas.
4. **Materiais** — upload, situação do processamento, associação a temas, testar busca.
5. **Início da conversa** — origem (cliente, automação, pessoa), abertura, confirmação com trecho condicional, identificação; mapeamento de variáveis da automação.
6. **Assuntos / Para quem encaminha** — lista; por tema: quando usar, exemplos, instruções, ferramentas, materiais, destino, quem responde, tabulação sugerida, transferir direto. Botão "mapa do atendimento".
7. **Regras automáticas** — lista ordenável "Quando… Então…", ativar/desativar, reordenar.
8. **Saídas** — não sabe, pediu pessoa, sem material, erro; resumo de todas as saídas.
9. **Equipe e horários** — destino padrão, mensagem, horários, inatividade.
10. **Classificar e encerrar** — tabulações do CRM, quando classificar, reserva, mapa tema → tabulação, devolver etapa, despedida, devolver para automação.
11. **Testar e publicar** — simulação fiel ao canal (agrupamento de mensagens, digitação, rascunho pendente de aprovação, transferências visíveis), painel "por que respondeu isso?" com atalho para editar o tema ou a regra, modo de envio, links permitidos, checklist.

### Vocabulário (código → tela)
`preset` → Modelo · `tone` → Tom de voz · `global_rules` → Regras que ele sempre segue · `context_fields` → Campos do contato e do negócio · `variables` → Informações fixas da empresa · `knowledge/RAG` → Materiais de consulta · `entry point` → Como a conversa chega · `confirm_deal` → Confirmar o cadastro · `themes` → Assuntos / Demandas · `tools allowlist` → O que ele pode fazer · regras determinísticas → Regras automáticas · `executeDistribution` → Distribuição inteligente · `handoff` → Passar para uma pessoa · `transfer_to_ai_agent` → Passar para um especialista · `human_active/release` → Equipe atendendo / Devolver para o agente · `tabulate_conversation` → Classificar o atendimento · `autonomyMode DRAFT` → Sugerir resposta para aprovar · `trace` → Por que respondeu isso? · `playground` → Conversa de teste.

---

## 7. Catálogos do CRM (nunca fixos no código)
Departamentos, filas, usuários, estratégias de distribuição, pipelines e etapas, campos de contato e negócio (padrão e personalizados), tabulações, modelos de mensagem, automações, canais.
Carregados por API na tela de configuração. A config guarda **ids**; a tela mostra nomes; id inexistente gera aviso na tela e no trace.

---

## 8. Convivência e migração
- Flag `engine: legacy | simple` por agente decide o caminho da mensagem.
- Migração agente por agente, com conversor do que der e relatório do que precisa de ajuste manual.
- Quando nenhum agente usar `legacy`, apagar o motor antigo (não comentar).

---

## 9. Testes mínimos
Regras determinísticas (ordem e condições) · loop de ferramentas (consulta e efeito) · allowlist por tema · escrita restrita a campos permitidos · RAG filtrado por tema · mensagem com campo vazio · transferência por distribuição inteligente · transferência entre agentes e limite de idas e voltas · conversa vinda de automação com variáveis · cliente fora da base nos três modos · saídas (não sabe, pediu pessoa, sem material, erro) · tabulação ao encerrar e ao transferir · devolução de etapa · agrupamento pelo Turn Manager · v1 não afetada · catálogo com id inexistente.

---

## 10. Prompt para o Cursor (modo Plan)

> Com base no código deste projeto e em `docs/inventory/INVENTORY_CRUZEIRO.md`, monte o plano de implementação da v2 conforme `SPEC_V2.md`, que é a fonte da verdade.
>
> Antes do plano, faça o **entendimento do CRM** e me entregue em `docs/CRM_CAPABILITIES.md`: para cada capacidade usada pela v2 (departamentos, filas, usuários, distribuição inteligente, pipelines/etapas, campos de contato e negócio com política de leitura/escrita, tabulações, modelos de mensagem, automações e gatilho de transferência para agente, canais, anexos e áudio, horário de atendimento), diga onde ela vive no código, qual serviço/função usar, qual API já existe para listar/consumir e o que falta.
>
> Depois, o plano único (sem fases com paradas), contendo:
> - arquivos a criar e modificar, uma linha cada;
> - o que vem da v1 e de onde;
> - o que será simplificado em relação ao que a v2 já tem hoje;
> - endpoints novos para os catálogos do CRM e para a configuração;
> - estrutura da tela `/ai-agents-v2` com os dois fluxos de wizard (recepção e agente completo) e as telas listadas na seção 6;
> - `docs/v2-parity.md`: cada item das seções 1, 5 e 6 do inventário mapeado para o bloco e a configuração que o reproduz, ou justificativa de descarte;
> - riscos e como evitar;
> - passos de migration e deploy no ambiente de dev;
> - até 5 dúvidas que só eu posso responder.
>
> Regras: nenhum termo de domínio no código ou em presets; não alterar o comportamento de agentes v1; não duplicar implementação de ferramenta, RAG ou distribuição já existentes; handoff sempre por uma única função. Não escreva código ainda.

---

## 11. Dono da conversa

A) Estado explícito de quem conduz a conversa: `pessoa` | `automação` | `agente` | `ninguém`.

B) Só o dono envia mensagem. Ao transferir, o dono muda.

C) Regras de precedência documentadas:
- Pessoa sempre vence automação e agente enquanto estiver ativa (respondeu recentemente dentro do limite configurado).
- Automação pode reassumir se estiver em step pausante e o cliente responder, exceto se uma pessoa já tomou o controle.
- Agente reassume quando a pessoa devolve explicitamente (botão "devolver para o agente") ou quando a automação o designa.
- `ninguém` só ocorre em conversas encerradas ou sem atribuição.

D) Registrar toda troca de dono no trace (`owner`, `previousOwner`, `reason`, `actor`).

E) Esse estado substitui qualquer verificação espalhada de "tem humano atendendo" (`humanActive` etc.). A UI mostra quem está conduzindo e por quê.

---

## 12. Encerramento e janela pós-encerramento

### 12.1 Encerramento é um estado da conversa
- Motivos padronizados: `resolved`, `inactivity`, `transferred`, `human_closed`, `automation_closed`.
- Guarda `tabulationId` (obrigatória quando configurado).
- Guarda `closedAt`, `closedBy` (pessoa, agente, automação ou nulo).
- Guarda resumo automático e/ou motivo curto.

### 12.2 Janela pós-encerramento
- Configurável, padrão **6h** após `closedAt`.
- Mensagens recebidas dentro da janela são classificadas em:
  - **cortesia/despedida**
  - **nova demanda**
  - **ambíguo**
- Config por caso:
  - `cortesia` → não reabrir (com resposta curta opcional, ex.: "Disponha!").
  - `nova demanda` → reabrir e rotear direto.
  - `ambíguo` → perguntar ao cliente.
- Padrões fixos: cortesia = não reabrir; nova demanda = reabrir e rotear; ambíguo = perguntar.
- A classificação é feita por uma chamada leve ao modelo (máx. 1 passo) ou por regras determinísticas; o resultado entra no trace.

### 12.3 Inatividade
- Encerramento por inatividade é do agente: lembrete após X, aviso, encerramento após Y.
- Nunca uma automação externa age em uma conversa que o agente está conduzindo.
- Se o dono for `pessoa`, a contagem de inatividade do agente pausa.

### 12.4 Tabulação
- Roda no encerramento lendo a conversa inteira, inclusive turnos de humanos.
- Config:
  - `classify_automatically` — agente escolhe e aplica sozinho;
  - `suggest_to_human` — sugere para a pessoa confirmar.
- Se um humano encerrou, o agente ainda pode classificar (configurável).
- Sem tabulação configurada e com `requireTabulationOnClose` do departamento, a conversa não pode ser marcada como encerrada até resolver.

---

## 13. Mensagens com botões (API oficial)

### 13.1 Quando usar
O agente pode enviar botões de resposta (até 3, título ≤ 20 caracteres) ou lista (até 10 opções) quando:
- o canal for WhatsApp API oficial (Meta Cloud API);
- a conversa estiver dentro da janela de 24h (`getConversationSession` ativo).

### 13.2 Opções
Cada opção carrega:
- `id` estável;
- `label` visível;
- `action`: assunto, regra, ação (`close`, `reopen`, `transfer`, `confirm`) ou resposta de confirmação;
- metadados extras (`themeId`, `ruleId`, `tabulationId`, `templateName`, etc.).

### 13.3 Clique determinístico
O clique do cliente é tratado pelo código, **sem passar pelo LLM** para adivinhar intenção:
- localiza a mensagem enviada com o `id` da opção;
- executa a ação configurada;
- registra no trace (`buttonId`, `buttonLabel`, `action`, `result`).

### 13.4 Fallback automático
Quando botões/lista não são possíveis (canal não oficial, fora das 24h, mais opções que o limite):
- envia a mesma mensagem em **lista numerada de texto**;
- responder com o número tem o mesmo efeito do clique;
- fora das 24h, usa **template WhatsApp aprovado** se estiver configurado.

### 13.5 Onde configurar
- Mensagens de confirmação (sim/não/escolher cadastro).
- Pergunta do caso ambíguo do pós-encerramento.
- Regras automáticas que oferecem escolha.
- Perguntas de escolha entre negócios.

### 13.6 Trace
Toda mensagem com opções é registrada com:
- `messageId`, opções enviadas;
- opção clicada (`buttonId`, `buttonLabel`);
- ação executada ou erro (opção não existe mais, expirada etc.).

### 13.7 Testes obrigatórios
- Clique em botão roteando direto.
- Fallback numerado.
- Fora das 24h.
- Canal sem suporte a botões (Baileys/IG/FB).
- Opção clicada que não existe mais.
- Lista com 10 opções.
