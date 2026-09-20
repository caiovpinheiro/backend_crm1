/**
 * POST /api/ai-simple/test
 *
 * Chat de teste para agentes v2 simples. Não envia WhatsApp, não altera
 * estado da conversa e não executa ações — apenas monta o prompt e chama
 * o LLM, devolvendo o JSON bruto e interpretado.
 */

import { NextResponse } from "next/server";
import { z } from "zod";
import { requireAuth, requirePermission, withOrgContext } from "@/lib/auth-helpers";
import { getOrgIdOrThrow } from "@/lib/request-context";
import { prisma } from "@/lib/prisma";
import { validateSimpleConfig } from "@/lib/ai-simple/config";
import { buildSimpleSystemPrompt } from "@/lib/ai-simple/prompt";
import { generateSimpleResponse } from "@/services/ai-simple/llm";
import { loadContactAndDeal } from "@/services/ai-simple/engine";
import type { SimpleStage } from "@/lib/ai-simple/types";

const testBodySchema = z.object({
  agentId: z.string().min(1),
  contactId: z.string().min(1).optional(),
  userMessage: z.string().min(1),
  history: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string(),
      }),
    )
    .default([]),
  stage: z.enum(["new", "awaiting_identification", "awaiting_confirmation", "active"]).default("active"),
});

export async function POST(request: Request) {
  const auth = await requireAuth();
  if (!auth.ok) return auth.response;
  const denied = await requirePermission(auth.session.user, "ai_agent:edit");
  if (denied) return denied;

  const body = await request.json().catch(() => ({}));
  const parsed = testBodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { message: "Body inválido.", errors: parsed.error.flatten() },
      { status: 400 },
    );
  }

  return withOrgContext(async () => {
    const organizationId = getOrgIdOrThrow();
    const { agentId, contactId, userMessage, history, stage } = parsed.data;

    const agent = (await (prisma as unknown as {
      aIAgentConfig: {
        findUnique: (args: unknown) => Promise<{
          id: string;
          engine?: string;
          simpleConfig?: unknown;
          model: string;
          temperature: number;
          user?: { id: string; name: string } | null;
        } | null>;
      };
    }).aIAgentConfig.findUnique({
      where: { id: agentId, organizationId },
      select: {
        id: true,
        engine: true,
        simpleConfig: true,
        model: true,
        temperature: true,
        user: { select: { id: true, name: true } },
      },
    })) as {
      id: string;
      engine?: string;
      simpleConfig?: unknown;
      model: string;
      temperature: number;
      user?: { id: string; name: string } | null;
    } | null;

    if (!agent || agent.engine !== "simple") {
      return NextResponse.json(
        { message: "Agente não encontrado ou não usa engine=simple." },
        { status: 404 },
      );
    }

    const configResult = validateSimpleConfig(agent.simpleConfig ?? {});
    if (!configResult.ok) {
      return NextResponse.json(
        { message: "Configuração do agente inválida.", errors: configResult.errors.flatten() },
        { status: 400 },
      );
    }
    const config = configResult.config;

    let contact: Record<string, unknown> | null = null;
    let deal: Record<string, unknown> | null = null;
    if (contactId) {
      const loaded = await loadContactAndDeal(organizationId, contactId, config);
      contact = loaded.contact;
      deal = loaded.deal;
    }

    const ctx = {
      organizationId,
      conversationId: "test",
      contactId: contactId ?? "test",
      agentId: agent.id,
      agentName: agent.user?.name ?? "Agente",
      userMessage,
      turnId: null,
      history,
      state: { stage: stage as SimpleStage, mode: null, humanActive: false, identificationAttempts: 0 },
      contact,
      deal,
    };

    const prompt = buildSimpleSystemPrompt(config, ctx);

    const result = await generateSimpleResponse({
      agentId: agent.id,
      model: agent.model,
      temperature: agent.temperature,
      system: prompt,
      messages: [...history, { role: "user", content: userMessage }],
    });

    return NextResponse.json({
      prompt,
      ...result,
    });
  });
}
