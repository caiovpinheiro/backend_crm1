# Grupos WhatsApp: ordem da lista, áudio e arquivos, nome dos participantes

Data: 12/11/2026 · Pedido: William (Eduit) · Página `/grupos-whatsapp` (canal Baileys/QR)

## Por quê

A página Grupos WhatsApp é usada como um WhatsApp dentro do CRM para os grupos do
número QR (DNA Work: "Grupos - Empresas"). Hoje ela não se comporta como um mensageiro:

- a lista é alfabética e o horário mostrado é o da última sincronização;
- só sai texto; áudio e arquivo recebidos viram "[áudio]" / "📎 arquivo" sem conteúdo;
- os participantes aparecem só pelo número, embora o WhatsApp mande o nome do perfil
  em cada mensagem (é o mesmo dado que preenche o nome dos candidatos no CRM).

## Objetivos

1. **Ordem**: o grupo com a mensagem mais recente (recebida ou enviada) fica no topo,
   como no WhatsApp. O horário da linha é o da última mensagem.
2. **Mídia como no CRM**: enviar áudio gravado e arquivos (imagem, vídeo, documento,
   áudio) pelo grupo; mídia recebida é guardada e aparece no balão como no inbox —
   só carrega/baixa quando a pessoa toca nela.
3. **Nome dos participantes**: mostrar o nome do perfil do WhatsApp; sem ele, o nome
   do contato do CRM com o mesmo telefone; sem nenhum, o número (como hoje).

## Fora do escopo (decidido)

- Grupo **não** vira conversa do inbox (sem distribuição, responsável, SLA, deal).
  Grupos são outra coisa, fora do tratamento de negócios do CRM.
- Não baixar mídia do WhatsApp sob demanda no clique (os links expiram).
- Sem SSE/tempo real novo: continua poll.

## Anti-objetivos

- Mexer no comportamento do inbox/conversas ao reaproveitar componentes.
- A sincronização de grupos apagar nomes já aprendidos.

## Abordagens consideradas

| | Abordagem | Decisão |
|---|---|---|
| A | Ampliar as tabelas e rotas de grupo; reaproveitar o balão de mídia, o gravador e o anexo do CRM | **Escolhida** |
| B | Cada grupo vira uma `Conversation` do inbox | Descartada: grupos são fora do fluxo de deals/distribuição |
| C | Guardar só a referência e baixar do WhatsApp no clique | Descartada: links expiram; o CRM guarda no storage e o clique só carrega do nosso storage |

## Como (decidido)

### Banco (uma migração)

- `WhatsAppGroup.lastMessageAt DateTime?` + índice `(channelId, lastMessageAt)`.
  Backfill na migração: `max(createdAt)` das mensagens de cada grupo.
- `WhatsAppGroupMessage`:
  - `messageType String @default("text")` — `text | image | video | audio | ptt | document | sticker`
  - `mediaUrl String?`, `mimeType String?`, `fileName String?`
  - `text` continua obrigatório: legenda, ou o rótulo atual (`[áudio]`, `📎 nome.pdf`).

### Backend

- `appendWhatsAppGroupMessage` aceita os campos de mídia e atualiza
  `WhatsAppGroup.lastMessageAt` (só avança, nunca volta).
- **Recebimento** (`message-handler.ts`, `persistIncomingGroupMessage`): para
  imagem/vídeo/áudio/ptt/documento/sticker, baixa com o mesmo `downloadAndSave` do
  inbox e grava `mediaUrl`, `messageType`, `mimeType`, `fileName`. Falha no download
  grava a mensagem sem `mediaUrl` (o balão mostra "indisponível", como no inbox).
- **Envio**: nova rota `POST /api/whatsapp-groups/[id]/attachments` (multipart: `file`,
  `caption?`), permissão `whatsapp_group:send`. Mesmo limite e verificação de tipo do
  anexo do inbox (16 MB; vídeo no limite do WhatsApp; `sniffAttachment`), salva no
  bucket `attachments` da org, enfileira `enqueueBaileysOutbound` com `mediaUrl` e o
  `messageType` (áudio gravado sai como voz/ptt — a conversão webm→ogg já existe no
  `outbound-consumer`), grava a mensagem no histórico e devolve o DTO. Mesmas
  proteções da rota de texto (não espera o worker; falha ao gravar histórico não vira 500).
- DTO de mensagem ganha `messageType`, `mediaUrl`, `mimeType`, `fileName`.
- Lista: `orderBy lastMessageAt desc (nulls last), name asc`; item ganha `lastMessageAt`.
- **Nomes**:
  - Ao receber mensagem de grupo com `pushName` (não `fromMe`), grava o nome no
    participante do grupo que casar por `jid` (`key.participant` ou `key.participantAlt`,
    cobre LID) ou por telefone.
  - `writeGroupSnapshot` preserva o nome já gravado ao recriar os participantes
    (casando por jid ou telefone) quando o WhatsApp não mandar nome.
  - `getWhatsAppGroup`: participante sem nome recebe o nome do contato do CRM com o
    mesmo telefone (variantes de `phoneMatchVariants`), só na leitura, sem gravar.

### Frontend

- Lista: horário = `lastMessageAt` (sem mensagem, sem horário); poll de 30 s só com aba
  visível; envio invalida a lista para o grupo subir na hora.
- Balão do grupo usa o `MessageContent` do CRM (mesmo `Lazy*`/`AudioPlayer`: só carrega
  ao tocar), adaptando a mensagem do grupo para o formato `Message`.
- Composer do grupo ganha o botão de anexo e o gravador de áudio do inbox. Esses
  componentes passam a aceitar uma função de envio alternativa; sem ela, seguem
  exatamente como hoje (inbox intocado).
- Bolha otimista para anexo ("enviando…") como já existe para texto.

## Fica para quem implementar

- Nome exato das props novas do gravador/anexo e do helper de envio do grupo.
- Formato do rótulo de mídia sem legenda (seguir o do inbox).
- Testes: serviço (lastMessageAt, nomes preservados, fallback do CRM), rota de anexo,
  handler de mídia recebida, adaptação da mensagem no front, componentes do inbox
  sem regressão.

## Riscos

- Migração roda no boot da API (`migrate deploy`). Só adiciona colunas nulas/default e
  um backfill por `UPDATE ... FROM (SELECT groupId, max(createdAt))` — rápido no volume atual.
- Grupos grandes com muita mídia aumentam o storage, igual ao inbox.
