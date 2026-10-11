# Motor v2 — mapa de decisões

O que o motor decide em cada turno, em que ordem, com que saída, o passo do
rastro que a explica e o teste que a protege. Nada aqui depende do produto
de um cliente: as regras vêm da configuração de cada agente.

Saídas possíveis de um turno: **responde**, **transfere** (pessoa, fila,
departamento, regra de distribuição ou outro agente de IA), **encerra**,
**espera** (não responde, mas segue aberto) e **silêncio** (limite).

Rastro: `src/services/ai-v2/trace.ts` (`traceStep`), gravado no log do
turno. Causa da transferência: `handoffCause` (`cost_cap`, `direct_theme`,
`error`, `guard`, `human_request`, `identification`, `limit`, `media`,
`media_failed`, `message_model_failed`, `message_model_not_allowed`,
`no_source`, `onboarding`, `sentiment`, `tried_and_failed`, `model`).

Testes: `src/services/ai-v2/__tests__/`. Onde o título do caso é citado,
é o `it(...)` do arquivo.

## 0. Antes do turno — quem atende

| Decisão | Saída | Teste |
| --- | --- | --- |
| Atendimento por IA desligado na org | solta a IA, distribui para pessoas | `first-attendance.test.ts` "atendimento por IA desligado…", "garantia… IA desligada" |
| Chave `ai.firstAttendanceEnabled` desligada | nada | `first-attendance.test.ts` "1º atendimento desligado pela chave…" |
| "Ok"/"obrigado" solto abrindo ticket | não abre atendimento de IA | "mensagem solta de cortesia…" |
| Contato fora da lista permitida | nada | "contato fora da lista permitida…" |
| Pessoa mantida após encerramento por fluxo | fica com a pessoa | "pessoa mantida após encerramento por fluxo…" |
| Canal aposentado/desconectado | nada | "canal aposentado ou desconectado…" |
| Fluxo de automação pausado aguardando o contato | não assume | "já está com um agente… fluxo pausado…" |
| Transferida por um agente para pessoa e aberta | fica de pessoa, em qualquer horário | "transferida por um agente para pessoa e aberta…" |
| Pendente na fila de pessoas | não assume, sem exceções | "pendente na fila de pessoas…" |
| Humano que já falou ou foi atribuído nesta conversa | fica | "humano: já falou ou foi atribuído…" |
| Herança de responsável antigo sem fala aqui | a IA assume | idem |
| Nenhum agente v2 ativo para o canal | nada | "nenhum agente v2 ativo…" |

## 1. Entrada do turno (`engine.ts`, `processV2TurnInner`)

| Decisão | Saída | Rastro | Teste |
| --- | --- | --- | --- |
| Agente desativado / número fora da lista | não responde | agente | `engine.test.ts` "agente desativado não responde…", "allowedPhoneNumbers…" |
| Nova tentativa do turno e a anterior já respondeu | não repete | entrada: "Tentativa N…" | "nova tentativa do turno depois de falha…" |
| Ticket novo dentro da janela pós-encerramento do anterior | herda estágio "closed" | estado: "Ticket novo herdou…" | "ticket novo aberto pelo 'obrigado' herda…" |
| Clique repetido na opção já respondida | sem turno | opções | `interactive.test.ts` |
| Conversa recebida de outro agente de IA | assume; sem boas-vindas/confirmação; contador de repetição e cadeia zerados | agente, entrada, limites | "conversa recebida de outro agente… assume e responde", "…sem boas-vindas…" |
| Fila de pessoas nasceu na transferência do outro agente | não assume, devolve à fila, sem resposta | fila | "o outro agente passou a conversa para pessoa e a fila nasceu…" |
| Mensagem nova do cliente | cadeia de transferências entre IAs zerada | limites | "cadeia longa sem ciclo…" |
| Transferência transparente (`entry.onAiTransfer = continue`) | segue sem se apresentar | agente | "transferência transparente…" |
| Cliente na fila escreve de novo | só avisa (`notify`) ou responde (`respond`) | fila | "cliente na fila escreve de novo…", "cliente na fila, modo responder…" |
| Mensagem sem pedido novo chegou enquanto respondia | sem resposta | entrada | "'?' que chegou enquanto ele respondia…" |
| Cliente já mandou outra depois desta e ela foi respondida | este turno não responde | entrada | "saudação que ficou para trás…" |

## 2. Pós-encerramento (`stage = closed` dentro da janela)

| Decisão | Saída | Teste |
| --- | --- | --- |
| Cortesia ("obrigado") | comportamento configurado (`no_reply` padrão): sem resposta, reencerra | "pós-encerramento no_reply…", "depois de encerrar: 'valeu'…" |
| Cortesia além de `limits.maxCourtesyReplies` | sem resposta, contador salvo, reencerra, registra | "pós-encerramento: cortesia além do limite…" |
| Nova demanda | reabre e roteia (`reopen_and_route`) | `closure.test.ts` |
| Ambígua | pergunta com botões uma vez; não repete na janela | "depois de encerrar: pergunta com botões uma vez…", "…a pergunta não se repete…" |

## 3. Mídia (`media.ts`, `media-turn.ts`)

| Decisão | Saída | Rastro | Teste |
| --- | --- | --- | --- |
| Mídia com política `handoff` | avisa e transfere para o destino padrão (ciclo barrado) | mídia | "imagem com legenda e imagem seguida de texto…" |
| Mídia com `ask_text`, só mídia | pede para escrever | mídia | "só áudio com 'pedir texto'…" |
| Mídia com `ask_text`, com texto junto | responde o texto e avisa que a mídia não foi vista | mídia | "texto + áudio com 'pedir texto'…" |
| `transcribe`/`describe` entendida | transcrição entra no turno | — | "áudio entendido…" |
| `transcribe`/`describe` não entendida, só mídia | mensagem "não entendi" e espera | — | "áudio que o agente tenta entender e não consegue…" |

## 4. Atalhos (regras) — antes do modelo (`rules.ts`)

| Decisão | Saída | Rastro | Teste |
| --- | --- | --- | --- |
| Atalho casou (etiqueta, gatilho, campo…) | ações do atalho sem modelo | regra | "regra contact_tag dispara ação terminal…", `rules.test.ts` |
| Atalho já respondeu nesta conversa / o agente anterior já respondeu a esta mensagem | não repete; segue para o agente | regra | "mesma mensagem pronta pedida de novo…" |
| Limite de parada bloqueia a resposta do atalho | `handoff` → transfere; `silence` → turno sem nada | limites | "send_message vindo de regra respeita limite…", "limite de parada com atalho… ação 'transferir'" |
| Atalho com `handoff` e pedido de pessoa com assunto | responde primeiro; transfere só se não conseguir | regra | "pedido de pessoa: com pergunta responde primeiro…" |
| Atalho com `handoff` e pedido de pessoa sem assunto | pergunta uma vez o que precisa; transfere na próxima | regra | idem; "Cliente disse o que precisa depois do pedido…" (`humanRequestPending`) |
| Atalho com `handoff` (destino próprio) | avisa, transfere para o destino do atalho, dono = pessoa | transferência | "atalho com transferência para destino próprio…" |
| Atalho com `close_conversation` | encerra (motivo `rule`), tabula, resume | encerramento | "atalho que encerra…" |
| Ação terminal do atalho falhou (sem parâmetro) | segue para o agente | regra | "ação terminal da regra que falha…" |

## 5. Identificação e cadastro (`entry`)

| Decisão | Saída | Teste |
| --- | --- | --- |
| Sem negócio e `onDealNotFound = handoff` | transfere | "primeira mensagem sem deal e onDealNotFound=handoff…" |
| Sem negócio e `create_deal` | cria no funil padrão, recarrega e segue; sem funil/etapa → transfere | "sem negócio e 'criar negócio'…" (2 casos) |
| Sem negócio e `ask_identification` | pede e-mail/documento até `entry.maxAttempts`; resposta com e-mail/documento → transfere (a equipe localiza) | "identificação: resposta com e-mail/documento transfere…", "…2ª tentativa…" |
| Confirmação de cadastro (`confirmContact`) | boas-vindas + confirmação (junto ou em turnos separados) | "primeira mensagem com deal…", "confirmationMode separate_turn…" |
| Boas-vindas configuradas | antes da confirmação/identificação; só com cumprimento se não houver confirmação; nunca em resposta a disparo | "boas-vindas configuradas saem antes…", "sem confirmação: só cumprimento recebe as boas-vindas…" |
| Pedido já na primeira mensagem | assunto guardado para depois do "sim" | "pedido na primeira mensagem…" |
| "Não sou eu" | identificação; não chama o modelo com os dados do cadastro | "'não sou eu' com negócio carregado…" |
| Vários negócios (`dealSelection = ask`) | pergunta e guarda o escolhido | "salva negócio escolhido pelo cliente…" |

## 6. Onboarding (`flow = onboarding`)

| Decisão | Saída | Teste |
| --- | --- | --- |
| Passo pendente | modelo com o objetivo do passo | "onboarding: passo concluído avança…" |
| Passo concluído (critério) | avança o estado | idem |
| Passo não concluído no limite de tentativas | transfere para `handoffOnStuck` do passo | "onboarding: passo não concluído no limite…" |
| Sem passo pendente | modelo normal | (engine, `onboardingActive = false`) |

## 7. Chamada do modelo e verificação

| Decisão | Saída | Rastro | Teste |
| --- | --- | --- | --- |
| Teto de custo (`dailyTokenCap`, `costCap`) | transfere sem modelo | — | "teto de custo atingido…" |
| Modelo não respondeu (erro) | mensagem de erro técnico e transfere | llm | "erro do modelo usa a mensagem de erro técnico…" |
| Resposta vazia | pergunta o que o cliente precisa | resposta | "resposta vazia do modelo…" |
| Assunto: atalho > gatilho > significado > assunto atual; modelo indica quando nada casou | assunto do turno | assunto | `theme-semantic.test.ts`, "assunto indicado pelo modelo vale…" |
| Assunto com transferência direta | sem modelo, vai ao destino | assunto | "assunto com transferência direta não chama o modelo" |
| Nada nos materiais e resposta afirma fatos (`groundingCheck`) | "sem material" configurada; transfere quando é procedimento | verificação | "nada nos materiais e resposta com fato…", "consulta vazia e sem dados…", `grounding.test.ts`, `ground-reply.test.ts` |
| Decisão admite que o material não cobre e a resposta instrui mesmo assim | instrução desautorizada → sem fonte | verificação | `ground-reply.test.ts` "admittedMissingInstructions…" |
| Data já passada escrita no futuro (ou o contrário) | corrigida/retirada | verificação | `dates.test.ts`, `llm.test.ts` (tense) |
| Afirmação do modelo sem fonte (`groundingCheck = model`) | checagem por modelo | verificação | `checker-*.test.ts`, `claim-check.test.ts` |
| Modelo quis encerrar, mas o cliente fez pedido | resposta sai, segue aberto | encerramento | "encerrar sem despedida…", "Modelo quis encerrar após 'ok'…" |

## 8. Transferência pedida pelo modelo

| Decisão | Saída | Rastro | Teste |
| --- | --- | --- | --- |
| Handoff como ação | avisa o cliente antes e transfere uma vez | transferência | "handoff pedido como AÇÃO…", "destino pedido na ação…" |
| Promessa de retorno na resposta | vira transferência de verdade | — | "promessa de retorno na resposta vira handoff…" |
| Resposta condiciona ("se … encaminho") | espera o cliente; não transfere | transferência | "transferência condicionada na resposta…" |
| Cliente mostrou que não entendeu | refaz a pergunta em vez de transferir | resposta | "cliente manda só '?'…" |
| Sentimento (`sentiment.action`) | transfere ou só registra | sentimento | "cliente irritado…", "sentimento com 'apenas registrar'…" |
| Pedido de pessoa (`humanRequestKeywords`) | ver §4 | — | "atalho com palavra de pedir atendente…" |
| Orientação dada e o cliente diz que tentou e não deu / cola erro de tela / escolhe "preciso de ajuda" | transfere (`tried_and_failed`) | — | `retry-signal.test.ts`; engine casos `guidanceGiven` |
| Destino = agente que acabou de passar a conversa, ou o próprio agente | destino padrão | transferência | "devolver a conversa para o agente que acabou de passá-la…", "destino… igual ao próprio agente…" |
| Ciclo na mesma mensagem (A → B → A) | destino padrão (ou departamento, se o padrão também já passou) — **sem teto numérico** | transferência | "ciclo na mesma mensagem…", "cadeia longa sem ciclo…" |
| Destino trocado pelo motor | mensagem padrão, não a do assunto | transferência | "destino trocado (ping-pong)…" |
| Transparente de um dos lados | sem aviso de transferência | transferência | "transferir para agente de IA transparente…", "agente que transfere em modo transparente…" |
| Em cadeia logo após receber | o aviso anterior já cobriu | transferência | "transferência em cadeia logo após receber…" |
| Transferir e encerrar no mesmo turno | transfere | encerramento | "transferir e encerrar no mesmo turno…" |
| Uma pessoa assumiu durante o turno | sem transferência, dono = pessoa | transferência | "uma pessoa assumiu a conversa durante o turno…", "…antes do aviso de transferência…" |
| Resumo antes de transferir (`closure.summary`) | resumo gravado | resumo | `summary-state-io.test.ts` |
| Destino inválido / distribuição fora do ar | conversa devolvida à fila da equipe, sem responsável IA | transferência | `handoff.test.ts` |

## 9. Limites de parada (`limits.ts`)

| Decisão | Saída | Teste |
| --- | --- | --- |
| Loop (mesma mensagem `maxLoopCount` vezes) | aviso + silêncio, ou transfere (`nonsenseAction`) | "send_message vindo de regra respeita limite…" |
| Pergunta com conteúdo repetida e o modelo respondeu | a resposta sai no lugar do aviso | (engine 2396) |
| Fora do escopo `nonsenseLimit` | aviso uma vez e silêncio, ou transfere | "fora do escopo: aviso uma vez…", "avisar e silenciar…", "limite de parada no caminho do modelo com ação 'transferir'…" |
| Trocas sem avanço `maxStalledExchanges` | encerra ou sai pela saída do assunto (`stalledExchangesAction`) | "trocas sem avanço no limite…", "…pergunta seguida… conta; orientação ou dado novo zera" |
| Só repetiria a pergunta depois de o cliente dizer o que precisa | idem | "explicação barrada por repetição…" |
| Ofertas de ajuda `maxHelpOffers` | silêncio | `cost-guard.test.ts`/`limits` unitários |

## 10. Ações, mensagens prontas e anexos

| Decisão | Saída | Rastro | Teste |
| --- | --- | --- | --- |
| Ação fora do permitido no assunto/config | descartada | ações | "ações de efeito fora da allowlist…", `action-policy` |
| Mensagem pronta fora da lista liberada | descartada; se o modelo prometeu, transfere | ações | "send_message_model com modelo fora da lista…", "mensagem pronta pedida e não liberada…" |
| Prometeu enviar sem escolher mensagem pronta | sai a liberada cujo nome casa com o pedido | ações | "prometeu enviar e não escolheu mensagem pronta…" |
| Mensagem pronta já enviada há pouco | não reenvia; aponta a de cima | ações | "mesma mensagem pronta pedida de novo…", "…barrada só por repetir uma recente não transfere" |
| Resposta longa + mensagem pronta que a cobre | resposta vira introdução (modo `combine`/`reply_only`/`model_only`) | ações, resposta | "resposta longa + mensagem pronta…", "modo da mensagem pronta…", "modo 'combinar'…" |
| Mensagem pronta anunciada não saiu (erro) | transfere (`message_model_failed`) | ações | "mensagem pronta anunciada que não saiu…" |
| Cliente diz que não recebeu o anexo | reenvia só a mídia uma vez; na segunda, chama a equipe | mídia | "cliente diz que não recebeu o anexo…" |
| Anexo do material já enviado dentro da trava | não reenvia | mídia | `actions-executors.test.ts` "trava de reenvio…" |
| Fecho configurado | no fim da resposta (depois do material); não quando transfere | resposta | "fecho configurado vai no fim…", "fecho vai depois da mensagem pronta…" |
| Opções (botões/lista) | enviadas e guardadas para o próximo turno | opções | `interactive.test.ts` |

## 11. Envio e encerramento

| Decisão | Saída | Teste |
| --- | --- | --- |
| Resposta barrada pela trava anti-repetição | manda outra; o log não finge que enviou | "resposta barrada pela trava anti-repetição…", "resposta barrada por outro motivo…" |
| Cliente mandou outra mensagem enquanto o agente pensava (pergunta/saudação) | a pergunta não sai; o próximo turno decide | "saudação confere de novo depois do 'digitando…'…" |
| Turno retomado por outro processo | esta execução não envia | "turno retomado por outro processo…" |
| Pessoa assumiu durante o turno | para por aqui, sem materiais | "uma pessoa assumiu a conversa durante o turno…" |
| Modelo concluiu (`concluded`) | encerra (motivo `resolved`): tabulação, resumo, atualizações de campo, retomada do fluxo, janela pós-encerramento | "encerramento pelo modelo: aplica as atualizações de campo…", `closure.test.ts`, `tabulation.test.ts` |
| Cliente adiou ("chamo depois") | resposta curta e encerra (`deferred`) | (engine 1498) |
| Resumo corrente (`summary.everyTurn`) | atualizado a cada resposta | "resumo corrente ligado…" |
| Pesquisa de satisfação | pergunta no encerramento; nota registrada | `owner-survey-bridge.test.ts`, `actions-executors.test.ts` |

## 12. Fora do turno — inatividade (`inactivity.ts`)

Vale só quando a **última mensagem enviada é do próprio agente** (pessoa
que falou antes no ticket não segura), inatividade ligada, conversa aberta,
fora da fila de pessoas e não encerrada.

| Decisão | Saída | Teste |
| --- | --- | --- |
| `nudgeAfter` vencido, dentro das 24h do cliente | aviso (variáveis renderizadas; rascunho em modo sugestão) | `inactivity.test.ts` |
| `closeAfter` vencido (ou `closeAfter − nudgeAfter` após o aviso) | encerra (`inactivity`); mensagem de fecho só dentro das 24h | idem; `engine-params.test.ts` (`decideV2Idle`) |
| Config inválida / falha numa conversa | passada segue | idem |

## Casos da semana (regressão)

| Ticket | Causa | Correção | Teste de guarda |
| --- | --- | --- | --- |
| 461983 | Admissão com acento não casava (`\b` depois de vogal acentuada); guarda pulada no handoff | `(?!\p{L})` + `u`; guarda roda antes | `ground-reply.test.ts` "admittedMissingInstructions…" (3 casos) |
| 461990 | "foram realizadas" para data futura; "chamar o time" não era aviso; transparente só do lado de quem recebe | `dates.ts` tense; `announcesTransfer`; transparente dos dois lados | `dates.test.ts`, `dangling-clause.test.ts`, engine "agente que transfere em modo transparente…" |
| 462052 | 1º atendimento pegava ticket pendente na fila fora do horário | fila segura em qualquer horário | `first-attendance.test.ts` "pendente na fila de pessoas…" |
| 462094 | Ping-pong usava a mensagem do assunto no destino trocado | mensagem padrão quando o destino muda | engine "destino trocado (ping-pong)…" |
| 462097 | Vocativo ("Ana, como…") deixava oração solta | `standaloneClause` ignora o vocativo | `dangling-clause.test.ts` |
| 462048 | Teto numérico de transferências entre IAs (5 ≥ 3) mandava ao destino padrão em silêncio | ciclo por mensagem, sem teto | engine "ciclo na mesma mensagem…", "cadeia longa sem ciclo…" |
| 462173 | Erro de tela colado não contava como "tentei e não deu" | `looksLikeSystemError` após orientação | `retry-signal.test.ts`, engine `guidanceGiven` |
| 446207 | Encerramento por inatividade excluía ticket com `hasHumanReply` | chave: última mensagem é do próprio agente | `inactivity.test.ts` "consulta recebe o instante…" |

## Como usar

- Comportamento estranho em produção: pegar o rastro do turno (Auditoria
  do motor / log do turno), achar o passo nesta tabela e abrir o teste
  correspondente — ele é a especificação viva.
- Mudança no motor: a linha desta tabela muda junto, e o teste também.
- Cobertura (`npx vitest run src/services/ai-v2 --coverage`), medida em
  11/10/2026, linhas: engine 88%, handoff 96%, inactivity 100%,
  first-attendance 100%, actions 74%, state 88%, summary 94%, llm 84%,
  owner/survey/automation-bridge 100%, material-attachments 45%.
  `feedback.ts`, `learn.ts`, `listen.ts`, `replay.ts` e `config-review.ts`
  (ferramentas de revisão, fora do caminho do turno) continuam abaixo de 40%.
