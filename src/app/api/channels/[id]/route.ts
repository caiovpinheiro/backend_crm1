import type { ChannelProvider, ChannelType } from "@prisma/client";
import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { requireChannelScope } from "@/lib/authz/resource-policy";
import { enqueueBaileysControl } from "@/lib/queue";
import { deleteChannel, getChannelById, updateChannel } from "@/services/channels";

type RouteContext = { params: Promise<{ id: string }> };

const CHANNEL_TYPES = new Set<string>([
  "WHATSAPP",
  "INSTAGRAM",
  "FACEBOOK",
  "EMAIL",
  "WEBCHAT",
]);

const CHANNEL_PROVIDERS = new Set<string>([
  "META_CLOUD_API",
]);

function isChannelType(v: unknown): v is ChannelType {
  return typeof v === "string" && CHANNEL_TYPES.has(v);
}

function isChannelProvider(v: unknown): v is ChannelProvider {
  return typeof v === "string" && CHANNEL_PROVIDERS.has(v);
}

export async function GET(_request: Request, context: RouteContext) {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ message: "Não autorizado." }, { status: 401 });
    }

    const { id } = await context.params;
    const channel = await getChannelById(id);
    if (!channel) {
      return NextResponse.json({ message: "Canal não encontrado." }, { status: 404 });
    }

    return NextResponse.json({ channel });
  } catch (e: unknown) {
    console.error(e);
    const msg = e instanceof Error ? e.message : "Erro ao carregar canal.";
    return NextResponse.json({ message: msg }, { status: 500 });
  }
}

export async function PUT(request: Request, context: RouteContext) {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ message: "Não autorizado." }, { status: 401 });
    }

    const { id } = await context.params;
    const existing = await getChannelById(id);
    if (!existing) {
      return NextResponse.json({ message: "Canal não encontrado." }, { status: 404 });
    }

    // Bloco B (25/jun/26): PUT exige `manage` do canal.
    const manageDenied = await requireChannelScope(session.user, "manage", id);
    if (manageDenied) return manageDenied;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ message: "JSON inválido." }, { status: 400 });
    }

    const b = body as Record<string, unknown>;
    const patch: Parameters<typeof updateChannel>[1] = {};

    if (b.name !== undefined) {
      const name = typeof b.name === "string" ? b.name.trim() : "";
      if (!name) {
        return NextResponse.json({ message: "Nome inválido." }, { status: 400 });
      }
      patch.name = name;
    }
    if (b.type !== undefined) {
      if (!isChannelType(b.type)) {
        return NextResponse.json({ message: "Tipo de canal inválido." }, { status: 400 });
      }
      patch.type = b.type;
    }
    if (b.provider !== undefined) {
      if (!isChannelProvider(b.provider)) {
        return NextResponse.json({ message: "Provedor inválido." }, { status: 400 });
      }
      patch.provider = b.provider;
    }
    if (b.config !== undefined) {
      if (b.config !== null && typeof b.config !== "object") {
        return NextResponse.json({ message: "config deve ser um objeto." }, { status: 400 });
      }
      patch.config = b.config === null ? {} : (b.config as object);
    }
    if (b.phoneNumber !== undefined) {
      patch.phoneNumber =
        typeof b.phoneNumber === "string" && b.phoneNumber.trim() !== ""
          ? b.phoneNumber.trim()
          : null;
    }
    if (b.defaultPipelineId !== undefined) {
      if (
        b.defaultPipelineId !== null &&
        typeof b.defaultPipelineId !== "string"
      ) {
        return NextResponse.json(
          { message: "defaultPipelineId deve ser string ou null." },
          { status: 400 },
        );
      }
      patch.defaultPipelineId =
        typeof b.defaultPipelineId === "string" && b.defaultPipelineId.trim() !== ""
          ? b.defaultPipelineId.trim()
          : null;
    }
    if (b.resetSessionWindow === true) {
      patch.resetSessionWindow = true;
    }

    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ message: "Nenhum campo para atualizar." }, { status: 400 });
    }

    const channel = await updateChannel(id, patch);
    return NextResponse.json({ channel });
  } catch (e: unknown) {
    console.error(e);
    const msg = e instanceof Error ? e.message : "Erro ao atualizar canal.";
    return NextResponse.json({ message: msg }, { status: 500 });
  }
}

export async function DELETE(_request: Request, context: RouteContext) {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ message: "Não autorizado." }, { status: 401 });
    }

    const { id } = await context.params;

    // Bloco B (25/jun/26): DELETE exige `manage` do canal. Resolvido
    // antes do try interno pra responder 403 antes de tentar deletar.
    const manageDenied = await requireChannelScope(session.user, "manage", id);
    if (manageDenied) return manageDenied;

    try {
      const existing = await getChannelById(id);
      if (existing?.provider === "BAILEYS_MD") {
        await enqueueBaileysControl({ channelId: id, action: "logout" });
      }
      const channel = await deleteChannel(id);
      return NextResponse.json({ channel });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Erro ao excluir.";
      if (msg.includes("não encontrado")) {
        return NextResponse.json({ message: msg }, { status: 404 });
      }
      if (msg.includes("desconectado")) {
        return NextResponse.json({ message: msg }, { status: 400 });
      }
      throw err;
    }
  } catch (e: unknown) {
    console.error(e);
    const msg = e instanceof Error ? e.message : "Erro ao excluir canal.";
    return NextResponse.json({ message: msg }, { status: 500 });
  }
}
