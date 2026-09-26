import { NextResponse } from "next/server";

import { requireAuth, requirePermission, runInSessionContext } from "@/lib/auth-helpers";
import { getV2Agent } from "@/services/ai-v2/agents";
import { tryGetAgentAnthropicKey, tryGetAgentApiKey } from "@/services/ai/agent-key";
import { v2AuxModel, v2ModelProvider } from "@/lib/ai-v2/models";
import { getModel } from "@/services/ai/provider";
import { ensureV2AgentSchema } from "@/services/ai-v2/ensure-schema";
import { generateText } from "ai";

/**
 * Valida as chaves do agente com uma chamada mínima: a OpenAI sempre (busca
 * nos materiais e transcrição dependem dela) e a Anthropic quando o modelo
 * escolhido é Claude ou quando pedido (`provider: "anthropic"`).
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const denied = await requirePermission(r.session.user, "settings:ai");
  if (denied) return denied;

  return runInSessionContext(r.session, async () => {
    try {
      await ensureV2AgentSchema();
      const body = ((await request.json().catch(() => ({}))) ?? {}) as { provider?: string };
      const agent = await getV2Agent(id, r.session.user.organizationId!);
      if (!agent) return NextResponse.json({ message: "Agente não encontrado." }, { status: 404 });

      const config = agent.draftConfig ?? agent.publishedConfig;
      const wantsAnthropic = body.provider === "anthropic" || v2ModelProvider(config.model) === "anthropic";
      const ping = async (model: string, key: string) => {
        await generateText({ model: getModel(model, key), messages: [{ role: "user", content: "Hi" }], maxOutputTokens: 16, maxRetries: 0 });
      };

      if (body.provider !== "anthropic") {
        const apiKey = await tryGetAgentApiKey(id);
        if (!apiKey) {
          return NextResponse.json({ ok: false, error: "NO_KEY", message: "Este agente não tem chave OpenAI configurada." });
        }
        try {
          await ping(v2AuxModel(config.model), apiKey);
        } catch (err) {
          return NextResponse.json({ ok: false, error: "INVALID_KEY", message: `Chave OpenAI: ${err instanceof Error ? err.message : "inválida"}` });
        }
      }
      if (wantsAnthropic) {
        const anthropicKey = await tryGetAgentAnthropicKey(id);
        if (!anthropicKey) {
          return NextResponse.json({ ok: false, error: "NO_ANTHROPIC_KEY", message: "Este agente usa um modelo Claude e não tem chave Anthropic." });
        }
        try {
          await ping(v2ModelProvider(config.model) === "anthropic" ? config.model : "claude-haiku-4-5", anthropicKey);
        } catch (err) {
          return NextResponse.json({ ok: false, error: "INVALID_ANTHROPIC_KEY", message: `Chave Anthropic: ${err instanceof Error ? err.message : "inválida"}` });
        }
      }
      return NextResponse.json({ ok: true });
    } catch (err) {
      console.error("[POST /api/ai-agents-v2/[id]/validate-key]", err);
      const message = err instanceof Error ? err.message : "Erro ao validar chave.";
      return NextResponse.json({ ok: false, error: "INVALID_KEY", message }, { status: 200 });
    }
  });
}
