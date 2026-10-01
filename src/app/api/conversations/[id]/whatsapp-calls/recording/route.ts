import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { requireConversationAccess } from "@/lib/conversation-access";
import { prisma } from "@/lib/prisma";
import { wasWhatsappCallPickedUp } from "@/lib/whatsapp-call-chat";
import { withOrgFromCtx } from "@/lib/prisma-helpers";
import { publishNewMessage } from "@/lib/realtime-events";
import { generateFileName, saveFile } from "@/lib/storage/local";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/conversations/[id]/whatsapp-calls/recording");

type RouteContext = { params: Promise<{ id: string }> };

const MAX_RECORDING_BYTES = 64 * 1024 * 1024;
/** `audio/...` vindo do MediaRecorder do browser é o que aceitamos. */
const ALLOWED_MIME_PREFIX = "audio/";

function isFileLike(v: unknown): v is Blob & { name?: string } {
  return (
    v instanceof Blob ||
    (typeof v === "object" &&
      v !== null &&
      typeof (v as Blob).arrayBuffer === "function" &&
      typeof (v as Blob).size === "number")
  );
}

async function blobToBuffer(blob: Blob): Promise<Buffer> {
  return Buffer.from(await blob.arrayBuffer());
}

function safeStr(v: FormDataEntryValue | null): string {
  return typeof v === "string" ? v.trim() : "";
}

function parseDate(raw: string): Date | null {
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isFinite(d.getTime()) ? d : null;
}

function extFromMime(mime: string): string {
  const base = (mime.split(";")[0] || "").trim().toLowerCase();
  if (base === "audio/webm") return "webm";
  if (base === "audio/ogg") return "ogg";
  if (base === "audio/mp4") return "m4a";
  if (base === "audio/mpeg") return "mp3";
  return "webm";
}

/**
 * Recebe o blob de áudio gravado no browser do agente durante uma
 * WhatsApp outbound call. A Meta não grava chamadas do lado dela, então
 * este é o único caminho para ter gravação.
 *
 * O arquivo é salvo em `public/uploads/call-recordings/` e uma mensagem
 * `whatsapp_call_recording` é criada (ou atualizada, se já existir com
 * o mesmo `externalId`) na timeline da conversa. O `externalId` usa o
 * mesmo padrão `call_timeline:{callId}` que o webhook da Meta usaria —
 * mantém compat caso algum dia a Meta passe a enviar recording_url.
 */
// Bug 27/abr/26: usavamos `auth()` direto. A rota chama `withOrgFromCtx`
// (direto ou via service), avaliado ANTES da Prisma extension popular
// o ctx. Migrado para withOrgContext.
export async function POST(request: Request, context: RouteContext) {
  return withOrgContext(async (session) => {
    try {
      const { id } = await context.params;
      const denied = await requireConversationAccess(session, id);
      if (denied) return denied;

      const conv = await prisma.conversation.findUnique({
        where: { id },
        select: { id: true, contactId: true, organizationId: true },
      });
      if (!conv) {
        return NextResponse.json({ message: "Conversa não encontrada." }, { status: 404 });
      }

      let form: FormData;
      try {
        form = await request.formData();
      } catch (err) {
        log.error({ err }, "[call-recording] formData parse error");
        return NextResponse.json({ message: "Upload inválido." }, { status: 400 });
      }

      const raw = form.get("file");
      if (!raw || !isFileLike(raw) || raw.size === 0) {
        return NextResponse.json({ message: "Gravação vazia." }, { status: 400 });
      }
      if (raw.size > MAX_RECORDING_BYTES) {
        return NextResponse.json(
          { message: "Gravação excede 64 MB." },
          { status: 413 },
        );
      }

      const rawMime = (raw.type || "").toLowerCase();
      // MediaRecorder eventualmente serializa sem MIME — aceita se o nome
      // indica áudio; caso contrário rejeita (evita upload acidental).
      if (rawMime && !rawMime.startsWith(ALLOWED_MIME_PREFIX)) {
        return NextResponse.json(
          { message: `MIME não suportado: ${rawMime}` },
          { status: 400 },
        );
      }

      const callId = safeStr(form.get("callId")) || null;
      if (callId) {
        const evs = await prisma.whatsappCallEvent.findMany({
          where: { metaCallId: callId },
          select: {
            signalingStatus: true,
            durationSec: true,
            startTime: true,
            endTime: true,
          },
        });
        const pickedUp = wasWhatsappCallPickedUp({
          durationSec: evs.reduce<number | null>(
            (acc, e) => (e.durationSec != null && e.durationSec > (acc ?? 0) ? e.durationSec : acc),
            null,
          ),
          startTime: evs.find((e) => e.startTime)?.startTime ?? null,
          endTime: evs.find((e) => e.endTime)?.endTime ?? null,
          signalingStatuses: evs.map((e) => e.signalingStatus),
        });
        if (!pickedUp) {
          return NextResponse.json(
            { message: "Gravação só é guardada depois do cliente atender." },
            { status: 409 },
          );
        }
      }
      const directionRaw = safeStr(form.get("direction"));
      const direction =
        directionRaw === "BUSINESS_INITIATED" || directionRaw === "USER_INITIATED"
          ? directionRaw
          : "BUSINESS_INITIATED";
      const startedAt = parseDate(safeStr(form.get("startedAt"))) ?? new Date();
      const endedAt = parseDate(safeStr(form.get("endedAt"))) ?? new Date();
      const durationSec = Math.max(
        0,
        Math.round((endedAt.getTime() - startedAt.getTime()) / 1000),
      );

      const ext = extFromMime(rawMime);
      const safeFileName = generateFileName({ prefix: "call", ext });

      let buffer: Buffer;
      try {
        buffer = await blobToBuffer(raw);
      } catch (err) {
        log.error({ err }, "[call-recording] buffer read error");
        return NextResponse.json(
          { message: "Falha ao ler arquivo." },
          { status: 500 },
        );
      }

      // PR 1.3: storage tenant-scoped (antes: `public/uploads/call-recordings/`).
      const saved = await saveFile({
        orgId: conv.organizationId,
        bucket: "recordings",
        fileName: safeFileName,
        buffer,
      });
      const publicUrl = saved.url;

      const agentName = session.user.name ?? session.user.email ?? "Agente";
      const senderName =
        direction === "BUSINESS_INITIATED"
          ? `WhatsApp · chamada · ${agentName}`
          : "WhatsApp · chamada";

      // Legenda enxuta (não confundir com o bloco verboso antigo do webhook).
      const hmS = new Intl.DateTimeFormat("pt-BR", {
        timeZone: process.env.DEFAULT_TIMEZONE ?? "America/Sao_Paulo",
        hour: "2-digit",
        minute: "2-digit",
      }).format(startedAt);
      const hmE = new Intl.DateTimeFormat("pt-BR", {
        timeZone: process.env.DEFAULT_TIMEZONE ?? "America/Sao_Paulo",
        hour: "2-digit",
        minute: "2-digit",
      }).format(endedAt);
      const durStr =
        durationSec >= 60
          ? `${Math.floor(durationSec / 60)}m${String(durationSec % 60).padStart(2, "0")}s`
          : `${durationSec}s`;
      const content = `Gravação da chamada · ${hmS}–${hmE} · ${durStr}`;

      const externalId = callId ? `call_timeline:${callId}` : null;

      // Lateralização da gravação acompanha o lado de quem iniciou a
      // chamada — se foi o agente (BUSINESS_INITIATED), bolha vai pra
      // direita. Antes era hardcoded `"in"` e a gravação aparecia à
      // esquerda mesmo pra chamadas outbound feitas pelo próprio agente.
      const recordingDirection: "in" | "out" =
        direction === "BUSINESS_INITIATED" ? "out" : "in";

      let msg;
      if (externalId) {
        const existing = await prisma.message.findFirst({
          where: { conversationId: conv.id, externalId },
          select: { id: true },
        });
        if (existing) {
          msg = await prisma.message.update({
            where: { id: existing.id },
            data: {
              content,
              mediaUrl: publicUrl,
              messageType: "whatsapp_call_recording",
              senderName,
              direction: recordingDirection,
              // Garante que não vai ser pega pelo sweeper de mensagens
              // stale: gravação é artefato interno, nunca passa pela Meta.
              sendStatus: "delivered",
              sendError: null,
            },
          });
        } else {
          msg = await prisma.message.create({
            data: withOrgFromCtx({
              conversationId: conv.id,
              content,
              direction: recordingDirection,
              messageType: "whatsapp_call_recording",
              senderName,
              externalId,
              mediaUrl: publicUrl,
              createdAt: endedAt,
              sendStatus: "delivered",
            }),
          });
        }
      } else {
        msg = await prisma.message.create({
          data: withOrgFromCtx({
            conversationId: conv.id,
            content,
            direction: recordingDirection,
            messageType: "whatsapp_call_recording",
            senderName,
            mediaUrl: publicUrl,
            createdAt: endedAt,
            sendStatus: "delivered",
          }),
        });
      }

      try {
        await prisma.conversation.update({
          where: { id: conv.id },
          data: { updatedAt: new Date(), lastMessageDirection: recordingDirection },
        });
      } catch {
        /* ignore */
      }

      publishNewMessage({
        organizationId: conv.organizationId,
        conversationId: conv.id,
        contactId: conv.contactId,
        direction: recordingDirection,
        content,
        mediaUrl: publicUrl,
        messageType: "whatsapp_call_recording",
        timestamp: endedAt,
      });

      return NextResponse.json({
        ok: true,
        messageId: msg.id,
        mediaUrl: publicUrl,
        durationSec,
      });
    } catch (err) {
      log.error({ err }, "[call-recording] fatal");
      return NextResponse.json(
        { message: "Erro ao salvar gravação." },
        { status: 500 },
      );
    }
  });
}
