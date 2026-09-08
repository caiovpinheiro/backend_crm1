/**
 * DEPRECADO — a chave OpenAI agora é **por agente**
 * (`AIAgentConfig.openaiApiKeyEnc`, configurada na tela do agente).
 * CRM multi-tenant: não há chave global nem em `.env`.
 *
 * GET mantém o contrato `{ configured, source }` pro frontend legado
 * (`/settings/ai`) não quebrar — sempre `configured: false` +
 * `perAgent: true`. PUT/DELETE respondem 410.
 */

import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth-helpers";

const GONE = {
  message:
    "A chave OpenAI agora é configurada por agente, na tela do agente. Não há mais chave global.",
} as const;

export async function GET() {
  const r = await requireAuth();
  if (!r.ok) return r.response;
  return NextResponse.json({
    configured: false,
    source: "none" as const,
    preview: null,
    updatedAt: null,
    perAgent: true,
  });
}

export function PUT() {
  return NextResponse.json(GONE, { status: 410 });
}

export function DELETE() {
  return NextResponse.json(GONE, { status: 410 });
}
