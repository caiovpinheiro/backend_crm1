/**
 * DEPRECADO — não há mais chave OpenAI global pra testar. A validação
 * agora é por agente (o teste no playground do agente já exercita a
 * chave). Mantido pra não quebrar o frontend legado.
 */

import { NextResponse } from "next/server";

import { requireAdmin } from "@/lib/auth-helpers";

export async function POST() {
  const r = await requireAdmin();
  if (!r.ok) return r.response;
  return NextResponse.json(
    {
      ok: false,
      message:
        "A chave OpenAI agora é por agente. Teste pela tela / playground do agente.",
    },
    { status: 410 },
  );
}
