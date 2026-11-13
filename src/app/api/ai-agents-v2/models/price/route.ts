import { NextResponse } from "next/server";

import { isAdmin, isSuperAdmin, requireAuth, requirePermission, runInSessionContext } from "@/lib/auth-helpers";
import { parsePriceInput, setOrgModelPrice } from "@/services/ai-v2/model-catalog";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/ai-agents-v2/models/price");

/**
 * Preço de um modelo para a organização (US$ por 1M tokens de entrada e de
 * saída). Os dois vazios voltam ao preço da tabela do código — ou a
 * "desconhecido" para modelo descoberto. Só admin da organização.
 */
export async function PUT(request: Request) {
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const denied = await requirePermission(r.session.user, "settings:ai");
  if (denied) return denied;
  if (!isAdmin(r.session) && !isSuperAdmin(r.session)) {
    return NextResponse.json({ message: "Só o admin da organização pode mudar o preço dos modelos." }, { status: 403 });
  }
  return runInSessionContext(r.session, async () => {
    try {
      const body = ((await request.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
      const modelId = typeof body.modelId === "string" ? body.modelId.trim() : "";
      const inputPer1M = parsePriceInput(body.inputPer1M);
      const outputPer1M = parsePriceInput(body.outputPer1M);
      if (!modelId) return NextResponse.json({ message: "Informe o modelo." }, { status: 400 });
      if (inputPer1M === undefined || outputPer1M === undefined) {
        return NextResponse.json({ message: "Preço inválido: use um número entre 0 e 10.000 (US$ por 1 milhão de tokens)." }, { status: 400 });
      }
      const models = await setOrgModelPrice({
        organizationId: r.session.user.organizationId!,
        userId: r.session.user.id,
        modelId,
        inputPer1M,
        outputPer1M,
      });
      return NextResponse.json({ models });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Erro ao salvar o preço.";
      if (message.startsWith("Modelo fora") || message.startsWith("Preencha")) return NextResponse.json({ message }, { status: 400 });
      log.error({ err }, "[PUT /api/ai-agents-v2/models/price]");
      return NextResponse.json({ message: "Erro ao salvar o preço." }, { status: 500 });
    }
  });
}
