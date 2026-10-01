/**
 * PATCH /api/profile/preferences/dashboard
 * Body: { blocks: [{ key: string, enabled: boolean, order: number }] }
 *
 * Salva o layout do dashboard comercial do usuario autenticado. O `userId`
 * vem SEMPRE da sessao (nunca do body). O service normaliza contra o
 * catalogo: descarta keys invalidas, forca blocos `locked`, anexa blocos
 * novos e reescreve a ordem. Retorna a versao final normalizada.
 */

import { NextResponse } from "next/server";
import { z } from "zod";

import { auth } from "@/lib/auth";
import { saveDashboardPreferences } from "@/services/user-preferences";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/profile/preferences/dashboard");

const bodySchema = z.object({
  blocks: z
    .array(
      z.object({
        key: z.string().min(1).max(100),
        enabled: z.boolean(),
        order: z.number().int().min(0).max(1000),
      }),
    )
    .max(100),
});

export async function PATCH(request: Request) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ message: "Não autorizado." }, { status: 401 });
  }

  let json: unknown;
  try {
    json = await request.json();
  } catch {
    return NextResponse.json({ message: "JSON inválido." }, { status: 400 });
  }

  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json(
      { message: "Dados inválidos.", issues: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const dashboard = await saveDashboardPreferences(
      session.user.id,
      parsed.data.blocks,
    );
    return NextResponse.json({ dashboard });
  } catch (e) {
    log.error({ err: e }, "[PATCH /api/profile/preferences/dashboard] falhou");
    return NextResponse.json(
      { message: "Erro ao salvar preferências." },
      { status: 500 },
    );
  }
}
