import { NextResponse } from "next/server";

import { authenticateApiRequest, runWithApiUserContext } from "@/lib/api-auth";
import { getMyCredentials } from "@/services/sip-extensions";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/sip-extensions/me/credentials");

/**
 * GET /api/sip-extensions/me/credentials
 *
 * Retorna as credenciais SIP DESCRIPTOGRAFADAS do ramal do usuário autenticado.
 *
 * SEGURANÇA:
 *  - Autorização = ser o dono (session.userId). Sem permission key adicional.
 *  - NUNCA logar o corpo da resposta.
 *  - Não registrar o valor de authPassword em nenhum log.
 *  - Apenas usuários com ramal próprio recebem dados; caso contrário
 *    200 com `{ credentials: null }` (antes era 404, mas o browser loga
 *    qualquer resposta de erro no console — o frontend consulta este
 *    endpoint como "feature gate" em toda navegação, então o 404 virava
 *    ruído permanente no console dos operadores sem telefonia).
 */
export async function GET(request: Request) {
  const authResult = await authenticateApiRequest(request);
  if (!authResult.ok) return authResult.response;

  return runWithApiUserContext(authResult.user, async () => {
    try {
      // Autorização: o caller SÓ pode ver as próprias credenciais.
      // A checagem é implícita: getMyCredentials usa session.userId.
      const credentials = await getMyCredentials(authResult.user.id);

      // NUNCA logar credentials — contém authPassword em plaintext
      return NextResponse.json({ credentials });
    } catch (e) {
      // Log sem incluir os dados da resposta
      log.error(
        { err: (e as Error)?.message ?? e },
        "[sip-extensions/me/credentials] Erro ao obter credenciais",
      );
      return NextResponse.json(
        { message: "Erro ao obter credenciais." },
        { status: 500 },
      );
    }
  });
}
