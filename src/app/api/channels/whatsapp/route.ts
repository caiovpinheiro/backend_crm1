import { NextResponse } from "next/server";

import { withApiAuthContext } from "@/lib/api-auth";
import { listWhatsAppChannels } from "@/services/channels";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/channels/whatsapp");

/**
 * GET /api/channels/whatsapp
 *
 * WhatsApps da org para o seletor do node (n8n) e outras integrações.
 * Auth híbrida (Bearer ou sessão), igual a `/api/tags`. Devolve só
 * id, nome, telefone, provedor e status — sem config, sessão ou QR.
 */
export async function GET(request: Request) {
  return withApiAuthContext(request, async (user) => {
    try {
      if (!user.organizationId) {
        return NextResponse.json({ message: "Sem organização." }, { status: 400 });
      }
      const channels = await listWhatsAppChannels();
      return NextResponse.json({ channels });
    } catch (e: unknown) {
      log.error({ err: e }, "GET falhou");
      const msg = e instanceof Error ? e.message : "Erro ao listar canais.";
      return NextResponse.json({ message: msg }, { status: 500 });
    }
  });
}
