import type { ChannelProvider, ChannelType } from "@prisma/client";
import { NextResponse } from "next/server";

import { requireAuth, withOrgContext } from "@/lib/auth-helpers";
import { createChannel } from "@/services/channels";

const TYPES = new Set<string>(["WHATSAPP", "INSTAGRAM", "FACEBOOK", "EMAIL", "WEBCHAT"]);
const PROVIDERS = new Set<string>(["META_CLOUD_API", "BAILEYS_MD", "WEBCHAT"]);

export async function POST(request: Request) {
  const r = await requireAuth();
  if (!r.ok) return r.response;
  if (!r.session.user.organizationId) {
    return NextResponse.json({ message: "Sem organização." }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ message: "JSON inválido." }, { status: 400 });
  }
  const b = body as Record<string, unknown>;
  const name = typeof b.name === "string" ? b.name.trim() : "";
  const type = typeof b.type === "string" ? b.type : "";
  // Webchat não tem provedor externo: type=WEBCHAT é sempre provider=WEBCHAT.
  const provider =
    type === "WEBCHAT" ? "WEBCHAT" : typeof b.provider === "string" ? b.provider : "";

  if (!name) {
    return NextResponse.json({ message: "Nome do canal é obrigatório." }, { status: 400 });
  }
  if (!TYPES.has(type)) {
    return NextResponse.json({ message: "Tipo inválido." }, { status: 400 });
  }
  if (!PROVIDERS.has(provider) || (provider === "WEBCHAT" && type !== "WEBCHAT")) {
    return NextResponse.json({ message: "Provedor inválido." }, { status: 400 });
  }

  return withOrgContext(async () => {
    const phoneNumber =
      typeof b.phoneNumber === "string" && b.phoneNumber.trim() !== ""
        ? b.phoneNumber.trim()
        : undefined;
    try {
      const channel = await createChannel({
        name,
        type: type as ChannelType,
        provider: provider as ChannelProvider,
        phoneNumber,
      });
      return NextResponse.json({ channel }, { status: 201 });
    } catch (e) {
      const msg = e instanceof Error ? e.message : "Erro ao criar canal.";
      return NextResponse.json({ message: msg }, { status: 400 });
    }
  });
}
