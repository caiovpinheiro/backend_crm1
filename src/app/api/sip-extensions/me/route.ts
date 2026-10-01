/**
 * DELETE /api/sip-extensions/me
 *
 * Desconecta a conta Api4com do operador autenticado:
 *  - Apaga o `SipExtension` dele (libera o organizationId_userId pra
 *    reconexão com outra conta).
 *  - NÃO toca em CallProviderConfig da org (webhook é compartilhado
 *    entre operadores; desconectar 1 operador não pode quebrar
 *    a recepção de chamadas dos outros).
 *  - NÃO revoga o token de admin Api4com (esse é cadastrado pelo
 *    admin da org, fora de escopo desta rota).
 *
 * SEGURANÇA: usuário só pode apagar o PRÓPRIO ramal. Sem permission
 * key adicional — é ownership puro (session.userId == extension.userId).
 */

import { NextResponse } from "next/server";

import { authenticateApiRequest, runWithApiUserContext } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { getOrgIdOrThrow } from "@/lib/request-context";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/sip-extensions/me");

export async function DELETE(request: Request) {
  const authResult = await authenticateApiRequest(request);
  if (!authResult.ok) return authResult.response;

  return runWithApiUserContext(authResult.user, async () => {
    try {
      const organizationId = getOrgIdOrThrow();
      const userId = authResult.user.id;

      const result = await prisma.sipExtension.deleteMany({
        where: { organizationId, userId },
      });

      if (result.count === 0) {
        return NextResponse.json(
          { message: "Nenhum ramal configurado para este usuário." },
          { status: 404 },
        );
      }

      return NextResponse.json({ disconnected: true }, { status: 200 });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      log.error({ err: msg }, "[sip-extensions/me DELETE] falhou");
      return NextResponse.json(
        { message: "Erro ao desconectar a conta Api4Com." },
        { status: 500 },
      );
    }
  });
}
