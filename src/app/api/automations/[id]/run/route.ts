import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { prisma } from "@/lib/prisma";
import { enqueueAutomation, getAutomationById } from "@/services/automations";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/automations/[id]/run");

type RouteContext = { params: Promise<{ id: string }> };

/**
 * POST /api/automations/[id]/run
 *
 * Dispara uma automacao manualmente a partir de uma conversa (inbox) ou
 * detalhe de negocio (kanban). E o unico ponto de entrada para o gatilho
 * `manual`; nao expomos disparo manual de automacoes reativas
 * (`message_received`, `stage_changed`, etc.) para evitar:
 *
 * 1. Duplo-disparo: a propria interacao do operador (mover stage, enviar
 *    mensagem) ja seria suficiente para acionar o gatilho original.
 * 2. Contornar filtros: o operador conseguiria pular validacoes (canal,
 *    estagio, dealStatus) que o gatilho original respeita.
 *
 * Body:
 *   contactId        (obrigatorio) - contato/lead alvo
 *   conversationId   (opcional)    - conversa onde o operador clicou
 *   dealId           (opcional)    - negocio aberto associado
 *
 * 27/mai/26
 */
export async function POST(request: Request, context: RouteContext) {
  return withOrgContext(async (session) => {
    try {
      const { id } = await context.params;
      if (!id) {
        return NextResponse.json({ message: "ID invalido." }, { status: 400 });
      }

      const body = (await request.json().catch(() => ({}))) as {
        contactId?: string;
        conversationId?: string;
        dealId?: string;
      };

      const contactId = typeof body.contactId === "string" ? body.contactId.trim() : "";
      const conversationId =
        typeof body.conversationId === "string" && body.conversationId.trim()
          ? body.conversationId.trim()
          : undefined;
      const dealId =
        typeof body.dealId === "string" && body.dealId.trim() ? body.dealId.trim() : undefined;

      if (!contactId) {
        return NextResponse.json(
          { message: "contactId e obrigatorio." },
          { status: 400 },
        );
      }

      // withOrgContext ja escopa as queries Prisma por organizacao do
      // usuario logado — se a automacao for de outra org, o findUnique
      // (em getAutomationById) retorna null e caimos no 404 abaixo.
      const automation = await getAutomationById(id);
      if (!automation) {
        return NextResponse.json(
          { message: "Automacao nao encontrada." },
          { status: 404 },
        );
      }
      if (!automation.active) {
        return NextResponse.json(
          { message: "Esta automacao esta inativa. Ative-a antes de executar." },
          { status: 409 },
        );
      }
      if (automation.triggerType !== "manual" && !automation.allowManualRun) {
        return NextResponse.json(
          {
            message:
              "Esta automacao nao esta habilitada para disparo manual pelo agente.",
          },
          { status: 409 },
        );
      }

      // Valida que o contato existe e e da mesma organizacao. O Prisma
      // extension ligado em withOrgContext ja filtra por organizationId,
      // entao um contactId de outra org devolve null aqui.
      const contact = await prisma.contact.findUnique({
        where: { id: contactId },
        select: { id: true },
      });
      if (!contact) {
        return NextResponse.json(
          { message: "Contato nao encontrado." },
          { status: 404 },
        );
      }

      // Se o operador passou dealId, conferimos. Se nao, deixamos
      // undefined — o enrichContext do worker pode tentar localizar um
      // deal aberto se algum step precisar; aqui nao bloqueamos.
      let resolvedDealId = dealId;
      if (resolvedDealId) {
        const deal = await prisma.deal.findUnique({
          where: { id: resolvedDealId },
          select: { id: true, contactId: true },
        });
        if (!deal || deal.contactId !== contactId) {
          // Nao falha o disparo por causa de dealId invalido — ignora.
          // Isso e tolerante porque a UI pode mandar um dealId stale
          // (operador alternou conversas em paralelo).
          resolvedDealId = undefined;
        }
      }

      await enqueueAutomation(automation.id, {
        contactId,
        dealId: resolvedDealId,
        event: "manual",
        data: {
          conversationId,
          dealId: resolvedDealId,
          manuallyTriggered: true,
          // Quem clicou em "Rodar automação" — usado para exibir o avatar
          // do agente ao lado do robô na confirmação no chat (colab).
          triggeredByUserId: session.user.id,
          triggeredByName: session.user.name ?? null,
        },
      });

      return NextResponse.json({
        ok: true,
        automationId: automation.id,
        automationName: automation.name,
      });
    } catch (e) {
      log.error({ err: e }, "[automations/run] erro");
      return NextResponse.json(
        { message: "Erro ao executar automacao." },
        { status: 500 },
      );
    }
  });
}
