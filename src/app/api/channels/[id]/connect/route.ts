import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { requireChannelScope } from "@/lib/authz/resource-policy";
import { MetaWhatsAppClient } from "@/lib/meta-whatsapp/client";
import { enqueueBaileysControl } from "@/lib/queue";
import {
  getChannelById,
  parseChannelConfigDecrypted,
  updateChannel,
  updateChannelStatus,
} from "@/services/channels";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/channels/[id]/connect");

type RouteContext = { params: Promise<{ id: string }> };

function str(cfg: Record<string, unknown>, key: string): string | undefined {
  const v = cfg[key];
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

export async function POST(_request: Request, context: RouteContext) {
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

    // Bloco B (25/jun/26): POST connect exige `manage` do canal.
    const manageDenied = await requireChannelScope(session.user, "manage", id);
    if (manageDenied) return manageDenied;

    const cfg = parseChannelConfigDecrypted({
      provider: channel.provider,
      config: channel.config,
    });

    await updateChannelStatus(id, "CONNECTING");

    if (channel.provider === "META_CLOUD_API") {
      const accessToken = str(cfg, "accessToken");
      const phoneNumberId = str(cfg, "phoneNumberId") ?? channel.phoneNumber ?? undefined;
      const businessAccountId = str(cfg, "businessAccountId");
      if (!accessToken || !phoneNumberId || !businessAccountId) {
        await updateChannelStatus(id, "FAILED");
        return NextResponse.json(
          {
            message:
              "Para Meta Cloud API informe em config: accessToken, phoneNumberId e businessAccountId (WABA).",
          },
          { status: 400 }
        );
      }

      const meta = new MetaWhatsAppClient(accessToken, phoneNumberId, businessAccountId);
      await meta.getBusinessProfile();

      const updated = await updateChannel(id, {
        status: "CONNECTED",
        lastConnectedAt: new Date(),
        qrCode: null,
        phoneNumber: channel.phoneNumber ?? phoneNumberId,
      });

      return NextResponse.json({
        status: updated.status,
        qrCode: undefined as string | undefined,
      });
    }

    if (channel.provider === "BAILEYS_MD") {
      await enqueueBaileysControl({ channelId: id, action: "connect" });
      return NextResponse.json({
        status: "CONNECTING",
        qrCode: undefined as string | undefined,
      });
    }

    if (channel.provider === "META_INSTAGRAM_LOGIN") {
      const accessToken = str(cfg, "accessToken");
      const instagramUserId = str(cfg, "instagramUserId");
      if (!accessToken || !instagramUserId) {
        await updateChannelStatus(id, "FAILED");
        return NextResponse.json(
          {
            message:
              "Canal Instagram sem token. Use Conectar Instagram para autorizar de novo.",
          },
          { status: 400 },
        );
      }

      const updated = await updateChannel(id, {
        status: "CONNECTED",
        lastConnectedAt: new Date(),
        qrCode: null,
      });

      return NextResponse.json({
        status: updated.status,
        qrCode: undefined as string | undefined,
      });
    }

    await updateChannelStatus(id, "FAILED");
    return NextResponse.json({ message: "Provedor de canal não suportado para conexão." }, {
      status: 400,
    });
  } catch (e: unknown) {
    log.error({ err: e }, "POST falhou");
    try {
      const { id } = await context.params;
      await updateChannelStatus(id, "FAILED");
    } catch {
      /* ignore */
    }
    const msg = e instanceof Error ? e.message : "Erro ao conectar canal.";
    return NextResponse.json({ message: msg }, { status: 500 });
  }
}
