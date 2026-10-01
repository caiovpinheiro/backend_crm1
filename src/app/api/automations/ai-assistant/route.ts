/**
 * POST /api/automations/ai-assistant
 *
 * Copilot de Automações — conversa com o operador dentro do editor.
 * O cliente envia o estado ao vivo da automação (o que está na tela,
 * inclusive mudanças não salvas) + histórico de mensagens + nova
 * pergunta. Devolve resposta em texto e (possivelmente) patches
 * sugeridos pra aprovação manual.
 *
 * Body:
 *   {
 *     currentAutomation: { id?, name, triggerType, triggerConfig?, steps: [...] },
 *     messages: [{ role: "user"|"assistant", content }],
 *     model?: string
 *   }
 *
 * Response:
 *   { text, patches, inputTokens, outputTokens, toolCallsCount }
 */
import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { requirePermission } from "@/lib/authz";
// Copilot roda no Anthropic (Claude) — checar a key correta. Se o
// admin tiver só OPENAI_API_KEY, o copilot fica indisponível mas o
// agente de conversa com contato segue funcionando normalmente.
import { isAnthropicConfigured } from "@/services/ai/anthropic-provider";
import {
  runAutomationCopilot,
  type CopilotCurrentAutomation,
  type CopilotMessage,
} from "@/services/ai/automation-copilot";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/automations/ai-assistant");

// 27/abr/26: envolvido em withOrgContext por consistencia com os
// outros endpoints de /api/automations. O copilot pode chamar tools
// que tocam Prisma scoped (busca de pipelines/stages/templates pra
// sugerir patches) — sem o ctx essas tools quebrariam silenciosamente
// no fallback de cookie quando rodando em um worker (futuramente).
export async function POST(request: Request) {
  return withOrgContext(async (session) => {
    const denied = await requirePermission(session.user, "automation:edit");
    if (denied) return denied;
    try {
      if (!(await isAnthropicConfigured())) {
        return NextResponse.json(
          {
            message:
              "Copilot indisponível: ANTHROPIC_API_KEY não configurada. Declare no .env (ou cadastre em Configurações → IA quando estiver disponível na UI).",
          },
          { status: 412 },
        );
      }

      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

      const rawCurrent = body.currentAutomation;
      if (!rawCurrent || typeof rawCurrent !== "object") {
        return NextResponse.json(
          { message: "currentAutomation obrigatório." },
          { status: 400 },
        );
      }
      const curr = rawCurrent as Record<string, unknown>;
      if (typeof curr.name !== "string" || typeof curr.triggerType !== "string") {
        return NextResponse.json(
          { message: "currentAutomation.name e triggerType são obrigatórios." },
          { status: 400 },
        );
      }
      if (!Array.isArray(curr.steps)) {
        return NextResponse.json(
          { message: "currentAutomation.steps deve ser um array." },
          { status: 400 },
        );
      }

      const currentAutomation: CopilotCurrentAutomation = {
        id: typeof curr.id === "string" ? curr.id : null,
        name: curr.name,
        description: typeof curr.description === "string" ? curr.description : null,
        triggerType: curr.triggerType,
        triggerConfig: curr.triggerConfig,
        active: typeof curr.active === "boolean" ? curr.active : false,
        steps: (curr.steps as Array<Record<string, unknown>>).map((s) => ({
          id: typeof s.id === "string" ? s.id : "",
          type: typeof s.type === "string" ? s.type : "",
          config:
            s.config && typeof s.config === "object" && !Array.isArray(s.config)
              ? (s.config as Record<string, unknown>)
              : {},
        })),
      };

      const rawMessages = Array.isArray(body.messages) ? body.messages : [];
      const messages: CopilotMessage[] = rawMessages
        .filter(
          (m): m is CopilotMessage =>
            !!m &&
            typeof m === "object" &&
            (m as { role?: string }).role !== undefined &&
            ((m as { role: string }).role === "user" ||
              (m as { role: string }).role === "assistant") &&
            typeof (m as { content?: unknown }).content === "string",
        )
        .map((m) => ({ role: m.role, content: m.content }));

      if (messages.length === 0 || messages[messages.length - 1].role !== "user") {
        return NextResponse.json(
          { message: "Histórico deve terminar com uma mensagem do usuário." },
          { status: 400 },
        );
      }

      const model = typeof body.model === "string" ? body.model : undefined;

      const result = await runAutomationCopilot({
        currentAutomation,
        messages,
        model,
      });

      return NextResponse.json(result);
    } catch (e) {
      log.error({ err: e }, "[ai-assistant] falhou");
      const msg = e instanceof Error ? e.message : "Erro desconhecido.";
      return NextResponse.json({ message: msg }, { status: 500 });
    }
  });
}
