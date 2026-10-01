import { NextResponse } from "next/server";

import { authenticateApiRequest, runWithApiUserContext } from "@/lib/api-auth";
import { getMyApi4ComStatus } from "@/services/sip-extensions";
import { prisma } from "@/lib/prisma";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/sip-extensions/me/api4com-status");

/**
 * GET /api/sip-extensions/me/api4com-status
 *
 * Estado compacto da conexão Api4com do usuário corrente — usado pela
 * UI do Api4ComConnectForm pra mostrar "Conectado como X • Ramal Y"
 * ao montar (em vez do form vazio toda vez que o operador entra na
 * tela). Cobre 3 cenários:
 *
 *  1. Nunca conectou: `{ connected: false }`. UI mostra o form normal.
 *  2. Conectou mas sem webhook configurado: `{ connected: true,
 *     webhook: { configured: false, webhookUrl } }`. UI mostra resumo
 *     verde + caixa amarela com URL pra colar no portal.
 *  3. Conectou com webhook: `{ connected: true, webhook: { configured:
 *     true } }`. UI mostra resumo verde + check de webhook.
 *
 * SEGURANÇA:
 *  - Autorização = ser o dono (session.userId).
 *  - O e-mail decifrado é retornado SÓ pro próprio dono (necessário pra
 *    pré-preencher reconexão). Senha e token de API NUNCA são expostos.
 *  - Status do webhook é por org (CallProviderConfig), não por usuário —
 *    propositalmente: vários operadores na mesma org compartilham um
 *    único webhook.
 */
export async function GET(request: Request) {
  const authResult = await authenticateApiRequest(request);
  if (!authResult.ok) return authResult.response;

  return runWithApiUserContext(authResult.user, async () => {
    try {
      const status = await getMyApi4ComStatus(authResult.user.id);

      // Webhook status — não falha o endpoint se a consulta der ruim
      // (apenas retorna "não configurado" defensivamente).
      let webhook: { configured: boolean; webhookUrl: string | null } = {
        configured: false,
        webhookUrl: null,
      };
      try {
        const config = await prisma.callProviderConfig.findFirst({
          where: { providerKey: "api4com" },
          select: { webhookToken: true, isActive: true },
        });
        if (config?.webhookToken) {
          const baseUrl = (process.env.NEXT_PUBLIC_APP_URL ?? process.env.APP_URL ?? "")
            .trim()
            .replace(/\/$/, "");
          const url = baseUrl
            ? `${baseUrl}/api/webhooks/calls/api4com?token=${config.webhookToken}`
            : `/api/webhooks/calls/api4com?token=${config.webhookToken}`;
          webhook = {
            // `configured` aqui = "existe um config no banco com webhookToken
            // ativo". Não confirma que a Api4com está disparando webhook —
            // pra isso, o operador precisaria fazer uma chamada teste. UI
            // documenta esse limite no copy.
            configured: Boolean(config.isActive),
            webhookUrl: url,
          };
        }
      } catch (e) {
        log.error(
          { err: (e as Error)?.message ?? e },
          "[sip-extensions/me/api4com-status] Falha ao consultar webhook",
        );
      }

      return NextResponse.json({ ...status, webhook });
    } catch (e) {
      log.error({ err: (e as Error)?.message ?? e }, "[sip-extensions/me/api4com-status] Erro");
      return NextResponse.json(
        { message: "Erro ao obter status da conexão Api4Com." },
        { status: 500 },
      );
    }
  });
}
