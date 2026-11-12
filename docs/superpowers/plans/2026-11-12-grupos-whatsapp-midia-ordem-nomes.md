# Grupos WhatsApp — ordem, mídia e nomes · Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lista de grupos ordenada pela última mensagem, envio/recebimento de áudio e arquivos como no CRM, e nome do perfil nos participantes.

**Architecture:** Amplia `WhatsAppGroup`/`WhatsAppGroupMessage` (migração), o serviço `services/whatsapp-groups.ts`, o handler Baileys e uma rota nova de anexo. No front, a página reaproveita `MessageContent` e os botões de áudio/anexo do inbox com um envio alternativo.

**Tech Stack:** Next.js 15, Prisma 6.19, BullMQ (Baileys outbound), React Query, Vitest.

**Spec:** `docs/superpowers/specs/2026-11-12-grupos-whatsapp-midia-ordem-nomes-design.md`

## Global Constraints

- Grupo não vira `Conversation`; nada no inbox muda de comportamento.
- Mídia recebida é baixada e guardada no storage da org (como o inbox); a tela só carrega ao tocar.
- Limite de anexo: 16 MB (vídeo: `WHATSAPP_VIDEO_MAX_BYTES`).
- Envio responde sem esperar o worker; falha ao gravar histórico não vira 500.
- Nome do contato do CRM só na leitura, nunca gravado no participante.
- Nunca rodar `db:migrate`/`db:push` contra banco real; a migração vai no deploy (`migrate deploy`).

## Review Focus

1. Mensagem de participante com `key.participant` LID e `participantAlt` telefone — o nome cai no participante gravado com jid de telefone.
2. Resync de grupo depois de nomes aprendidos — nomes continuam.
3. Áudio gravado no navegador (webm) sai como voz — `messageType: "ptt"` com `mime` e `originalName` no payload.
4. Download de mídia recebida falha — mensagem gravada com `mediaUrl: null` e rótulo.
5. `lastMessageAt` nunca volta (mensagem antiga do histórico chegando depois).

---

### Task 1: Migração e serviço (backend)

**Files:** `prisma/schema.prisma`, `prisma/migrations/20261112120000_whatsapp_group_media/migration.sql`, `src/services/whatsapp-groups.ts`, test `src/services/__tests__/whatsapp-groups-media.test.ts`

**Produces:**
- `WhatsAppGroupMessageDto` + `messageType: string; mediaUrl: string | null; mimeType: string | null; fileName: string | null`
- `WhatsAppGroupListItem` + `lastMessageAt: string | null`
- `appendWhatsAppGroupMessage(input & { messageType?, mediaUrl?, mimeType?, fileName? })` — também avança `lastMessageAt` (`updateMany where lastMessageAt null or < createdAt`).
- `learnGroupMemberName(input: { groupId: string; jids: string[]; phone: string | null; name: string }): Promise<number>`
- `writeGroupSnapshot` preserva nomes (por jid ou telefone).
- `getWhatsAppGroup` preenche `name` vazio com o contato do CRM (telefone).
- `listWhatsAppGroups` ordena `lastMessageAt desc nulls last, name asc`.

Testes: lastMessageAt só avança; nome aprendido por jid alternativo; resync mantém nome; fallback do contato; ordem da lista.

### Task 2: Recebimento de mídia e nomes (worker Baileys)

**Files:** `src/workers/baileys/message-handler.ts`, test `src/workers/baileys/__tests__/group-media.test.ts`

- `persistIncomingGroupMessage(channelId, groupJid, msg, sock)`: acha o grupo antes; mídia (`image|video|audio|ptt|document|sticker`) via `parseMessage` (baixa com `downloadAndSave`); grava `messageType`, `mediaUrl`, `mimeType`, `fileName`; `pushName` de quem não é `fromMe` → `learnGroupMemberName` com `[key.participant, key.participantAlt]`.
- Export puro `groupMediaMeta(msg): { mimeType: string | null; fileName: string | null }` testado.

### Task 3: Rota de anexo do grupo

**Files:** `src/app/api/whatsapp-groups/[id]/attachments/route.ts` + test

`POST` multipart `file`, `caption?`. Permissão `whatsapp_group:send`. `sniffAttachment`/limites, `saveFile({ bucket: "attachments" })`, `messageType` = image/video/document; áudio → `ptt` (gravação) ou `audio`. `enqueueBaileysOutbound({ to: group.jid, mediaUrl, messageType, content: caption (documento: nome do arquivo), mime, originalName })`. Grava histórico; responde `{ ok, groupId, message }`.
Testes: 400 sem arquivo, 413 grande, áudio webm → ptt, documento usa nome.

### Task 4: Frontend

**Files:** `src/features/whatsapp-groups/{types,api,hooks,thread}.ts`, `src/app/(app)/grupos-whatsapp/client-page.tsx`, `src/features/inbox-v2/extras/{audio-recorder-button,file-picker-button}.tsx`, tests

- Tipos com campos novos; `sendWhatsAppGroupAttachment(id, file, fileName, caption?)`.
- `sendFile?: (file: Blob, fileName: string) => Promise<unknown>` nos dois botões do inbox; sem a prop, nada muda.
- Hook `sendAttachment` com bolha otimista ("[anexo]" pendente) e invalidação da lista.
- Lista: horário `lastMessageAt`, poll 30 s com aba visível.
- Bolha: mídia via `MessageContent` (adaptador `toBubbleMessage(msg)`).
- Testes: adaptador, poll da lista, botões com `sendFile`.

### Task 5: Verificação e entrega

tsc baseline sem erro novo, eslint nos arquivos, vitest das áreas, AGENTS.md (back), commits e patches.
