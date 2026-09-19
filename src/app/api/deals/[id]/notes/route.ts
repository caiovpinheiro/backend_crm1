/**
 * Notas vinculadas a um Deal.
 *
 * Existe porque o frontend (deal-workspace, deal-detail, contact-panel)
 * faz fallback para esta rota quando o deal não tem `contactId`. Antes
 * estava 404 e a nota silenciosamente não era criada. Agora roteamos
 * a mesma lógica de `/api/contacts/[id]/notes` com `dealId` direto.
 *
 * Autenticação híbrida (Bearer OU session): permite integrações (n8n)
 * criarem notas em deals sem precisar de session NextAuth. A camada
 * `runWithApiUserContext` propaga o `organizationId` do token pra
 * Prisma Extension, então todas as queries continuam tenant-scoped.
 *
 * Comportamento do POST (mudança 30/jul/26):
 *   1. Cria `Note` linkada ao `dealId` (e ao `contactId` se existir).
 *      → aparece na aba "Notas" do deal em /pipeline.
 *   2. Se o contato tem conversa vigente (a mais recente por updatedAt),
 *      também cria uma `Message` `messageType=note, isPrivate=true` na
 *      conversa → aparece na timeline do /inbox como nota interna.
 *   3. Emite SSE `new_message` pra que o /inbox atualize em tempo real.
 *   4. Log de `NOTE_ADDED` no activity feed.
 *
 * Fluxo espelha o `POST /api/conversations/:id/messages` quando body
 * inclui `messageType: "note"` — evita divergência entre "nota criada
 * pelo chat" e "nota criada pelo painel do deal / integração n8n".
 */

import { NextResponse } from "next/server";

import { authenticateApiRequest, runWithApiUserContext } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { withOrgFromCtx } from "@/lib/prisma-helpers";
import { sseBus } from "@/lib/sse-bus";
import { logEvent } from "@/services/activity-log";
import { createDealEvent } from "@/services/deals";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(request: Request, ctx: Ctx) {
  const authResult = await authenticateApiRequest(request);
  if (!authResult.ok) return authResult.response;

  return await runWithApiUserContext(authResult.user, async () => {
    try {
      const { id: dealId } = await ctx.params;
      // Notas exibidas no deal: tudo que tem `dealId = id` OU `contactId`
      // pertencente ao contato dono do deal. O Prisma OR retorna o
      // conjunto unido — frontend já desempata por createdAt.
      const deal = await prisma.deal.findUnique({
        where: { id: dealId },
        select: { contactId: true },
      });
      if (!deal) {
        return NextResponse.json({ message: "Deal não encontrado." }, { status: 404 });
      }

      const notes = await prisma.note.findMany({
        where: {
          OR: [
            { dealId },
            ...(deal.contactId ? [{ contactId: deal.contactId }] : []),
          ],
        },
        orderBy: { createdAt: "desc" },
        take: 50,
        include: { user: { select: { id: true, name: true } } },
      });
      return NextResponse.json(notes);
    } catch (e) {
      return NextResponse.json(
        { message: e instanceof Error ? e.message : "Erro." },
        { status: 500 },
      );
    }
  });
}

export async function POST(request: Request, ctx: Ctx) {
  const authResult = await authenticateApiRequest(request);
  if (!authResult.ok) return authResult.response;

  return await runWithApiUserContext(authResult.user, async () => {
    try {
      const { id: dealId } = await ctx.params;
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      const content = typeof body.content === "string" ? body.content.trim() : "";
      if (!content) {
        return NextResponse.json({ message: "Conteúdo obrigatório." }, { status: 400 });
      }

      const deal = await prisma.deal.findUnique({
        where: { id: dealId },
        select: { id: true, contactId: true, organizationId: true },
      });
      if (!deal) {
        // 404 (não 403) para não vazar existência entre orgs — a Prisma
        // Extension já filtrou por organizationId, então "não encontrei"
        // pode significar "não existe" OU "existe em outra org".
        return NextResponse.json({ message: "Deal não encontrado." }, { status: 404 });
      }

      const userId = authResult.user.id;
      const senderName =
        authResult.user.name?.trim() ||
        authResult.user.email?.trim() ||
        "API";

      const note = await prisma.note.create({
        data: withOrgFromCtx({
          content,
          dealId: deal.id,
          contactId: deal.contactId ?? undefined,
          userId,
        }),
        include: { user: { select: { id: true, name: true } } },
      });

      // Espelhar na conversa vigente do contato (a mais recente) para
      // que a nota apareça também na timeline do /inbox. Se o deal não
      // tem contactId ou o contato não tem nenhuma conversa, pulamos
      // silenciosamente — a nota continua em /pipeline via `Note`.
      let mirroredMessageId: string | null = null;
      let mirroredConversationId: string | null = null;
      if (deal.contactId) {
        const conv = await prisma.conversation.findFirst({
          where: { contactId: deal.contactId },
          orderBy: { updatedAt: "desc" },
          select: { id: true, organizationId: true, contactId: true },
        });
        if (conv) {
          const savedMsg = await prisma.message.create({
            data: withOrgFromCtx({
              conversationId: conv.id,
              content,
              direction: "out",
              messageType: "note",
              isPrivate: true,
              senderName,
            }),
            select: { id: true, createdAt: true },
          });
          mirroredMessageId = savedMsg.id;
          mirroredConversationId = conv.id;

          // Notifica o inbox aberto em tempo real (mesmo padrão do
          // handler de messages/route.ts no envio outbound normal).
          try {
            sseBus.publish("new_message", {
              organizationId: conv.organizationId,
              conversationId: conv.id,
              contactId: conv.contactId,
              direction: "out",
              content,
              timestamp: savedMsg.createdAt,
            });
          } catch {
            // best-effort: nunca derruba a criação da nota por falha de SSE.
          }
        }
      }

      // Preserva o comportamento antigo: cria deal event pra timeline
      // pre-activity-log (fan-out interno logEvent + dealEvent).
      createDealEvent(deal.id, userId, "NOTE_ADDED", {
        noteId: note.id,
        preview: content.slice(0, 200),
        source: "deal_notes_endpoint",
      }).catch(() => {});

      // Activity log unificado — mesma chave usada pelo composer do
      // inbox, para o /logs mostrar a nota independente de onde foi
      // criada (chat vs painel do deal vs n8n).
      void logEvent({
        type: "NOTE_ADDED",
      actorType: "HUMAN",
        entityType: mirroredMessageId ? "MESSAGE" : "DEAL",
        entityId: mirroredMessageId ?? deal.id,
        entityLabel: senderName,
        conversationId: mirroredConversationId,
        contactId: deal.contactId,
        dealId: deal.id,
        meta: {
          preview: content.slice(0, 200),
          source: "deal_notes_endpoint",
          isPrivate: true,
          noteId: note.id,
        },
      }).catch(() => {});

      return NextResponse.json(
        {
          ...note,
          mirroredMessageId,
          mirroredConversationId,
        },
        { status: 201 },
      );
    } catch (e) {
      return NextResponse.json(
        { message: e instanceof Error ? e.message : "Erro." },
        { status: 500 },
      );
    }
  });
}
