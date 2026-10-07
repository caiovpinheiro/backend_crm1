import type { ChannelProvider, ChannelType } from "@prisma/client";
import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { createChannel, getChannels } from "@/services/channels";
import { getLogger } from "@/lib/logger";
import { ServerTiming } from "@/lib/server-timing";
import { timedJson } from "@/lib/server-timing-response";

const log = getLogger("api/channels");

const CHANNEL_TYPES = new Set<string>([
  "WHATSAPP",
  "INSTAGRAM",
  "FACEBOOK",
  "EMAIL",
  "WEBCHAT",
]);

const CHANNEL_PROVIDERS = new Set<string>([
  "META_CLOUD_API",
  "BAILEYS_MD",
]);

function isChannelType(v: unknown): v is ChannelType {
  return typeof v === "string" && CHANNEL_TYPES.has(v);
}

function isChannelProvider(v: unknown): v is ChannelProvider {
  return typeof v === "string" && CHANNEL_PROVIDERS.has(v);
}

// Bug 27/abr/26: usavamos `auth()` direto. createChannel chama
// `withOrgFromCtx` no payload do prisma.channel.create — avaliado ANTES
// da Prisma extension popular o ctx via fallback de cookie. UI exibia
// "[withOrgFromCtx] RequestContext sem organizationId" ao criar canal.
// Migrado para withOrgContext.
export async function GET() {
  // `Server-Timing`: auth, query, serialize, total.
  const timing = new ServerTiming();
  return withOrgContext(async () => {
    timing.add("auth", timing.totalMs());
    try {
      const channels = await timing.time("query", () => getChannels());
      return timedJson(timing, { channels });
    } catch (e: unknown) {
      log.error({ err: e }, "GET falhou");
      const msg = e instanceof Error ? e.message : "Erro ao listar canais.";
      return NextResponse.json({ message: msg }, { status: 500 });
    }
  });
}

export async function POST(request: Request) {
  return withOrgContext(async () => {
    try {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return NextResponse.json({ message: "JSON inválido." }, { status: 400 });
      }

      const b = body as Record<string, unknown>;
      const name = typeof b.name === "string" ? b.name.trim() : "";
      if (!name) {
        return NextResponse.json({ message: "Nome do canal é obrigatório." }, { status: 400 });
      }
      if (!isChannelType(b.type)) {
        return NextResponse.json({ message: "Tipo de canal inválido." }, { status: 400 });
      }
      if (!isChannelProvider(b.provider)) {
        return NextResponse.json({ message: "Provedor inválido." }, { status: 400 });
      }

      const phoneNumber =
        typeof b.phoneNumber === "string" && b.phoneNumber.trim() !== ""
          ? b.phoneNumber.trim()
          : undefined;
      const config =
        b.config !== undefined && b.config !== null && typeof b.config === "object"
          ? (b.config as object)
          : undefined;

      const channel = await createChannel({
        name,
        type: b.type,
        provider: b.provider,
        config,
        phoneNumber,
      });

      return NextResponse.json({ channel }, { status: 201 });
    } catch (e: unknown) {
      log.error({ err: e }, "POST falhou");
      const msg = e instanceof Error ? e.message : "Erro ao criar canal.";
      return NextResponse.json({ message: msg }, { status: 500 });
    }
  });
}
