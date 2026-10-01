/**
 * PATCH /api/profile/preferences/appearance
 * Body: { theme: "light" | "dark" }
 *
 * Salva o tema UI do usuario autenticado. O `userId` vem SEMPRE da
 * sessao (nunca do body). Upsert parcial — nao apaga sidebar/dashboard.
 */

import { NextResponse } from "next/server";
import { z } from "zod";

import { withOrgContext } from "@/lib/auth-helpers";
import { saveAppearancePreferences } from "@/services/user-preferences";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/profile/preferences/appearance");

const bodySchema = z.object({
  theme: z.enum(["light", "dark"]),
});

export async function PATCH(request: Request) {
  return withOrgContext(async (session) => {
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
      const appearance = await saveAppearancePreferences(
        session.user.id,
        parsed.data.theme,
      );
      return NextResponse.json({ appearance });
    } catch (e) {
      log.error({ err: e }, "[PATCH /api/profile/preferences/appearance] falhou");
      return NextResponse.json(
        { message: "Erro ao salvar preferências." },
        { status: 500 },
      );
    }
  });
}
