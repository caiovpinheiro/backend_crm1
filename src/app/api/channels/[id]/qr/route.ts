import { NextResponse } from "next/server";
import QRCode from "qrcode";

import { auth } from "@/lib/auth";
import { requireChannelScope } from "@/lib/authz/resource-policy";
import { MetaWhatsAppClient } from "@/lib/meta-whatsapp/client";
import { safeFetchBytes } from "@/lib/safe-fetch";
import {
  getChannelById,
  parseChannelConfigDecrypted,
  updateChannel,
} from "@/services/channels";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/channels/[id]/qr");

type RouteContext = { params: Promise<{ id: string }> };

function str(cfg: Record<string, unknown>, key: string): string | undefined {
  const v = cfg[key];
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
}

/** Hosts de onde a Meta serve `qr_image_url` (Graph API / CDNs do grupo). */
const QR_IMAGE_HOSTS = ["graph.facebook.com", "*.facebook.com", "*.whatsapp.net", "*.fbcdn.net"];
const QR_IMAGE_TIMEOUT_MS = 10_000;
const QR_IMAGE_MAX_BYTES = 2 * 1024 * 1024;

async function imageUrlToDataUri(url: string): Promise<string | null> {
  try {
    // A URL vem da resposta da Meta, mas é dado externo: allowlist de host,
    // sem redirect, timeout e limite de bytes.
    const { response: res, buffer: buf } = await safeFetchBytes(
      url,
      { cache: "no-store" },
      {
        allowedHosts: QR_IMAGE_HOSTS,
        maxRedirects: 0,
        timeoutMs: QR_IMAGE_TIMEOUT_MS,
        maxBytes: QR_IMAGE_MAX_BYTES,
      },
    );
    if (!res.ok || buf.length === 0) return null;
    const mime = res.headers.get("content-type")?.split(";")[0]?.trim() || "image/png";
    if (!mime.startsWith("image/")) return null;
    return `data:${mime};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

type MetaQrdlItem = {
  code?: string;
  prefilled_message?: string;
  deep_link_url?: string;
  qr_image_url?: string;
};

function firstMetaQrdl(payload: unknown): MetaQrdlItem | null {
  if (!payload || typeof payload !== "object") return null;
  const o = payload as Record<string, unknown>;
  if (Array.isArray(o.data) && o.data.length > 0) {
    const first = o.data[0];
    if (first && typeof first === "object") return first as MetaQrdlItem;
  }
  if (typeof o.code === "string" || typeof o.deep_link_url === "string") {
    return o as MetaQrdlItem;
  }
  return null;
}

export async function GET(request: Request, context: RouteContext) {
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

    // Bloco B (25/jun/26): GET qr exige `manage` (operação de pareamento,
    // não é leitura inofensiva — expõe credencial visual do canal).
    const manageDenied = await requireChannelScope(session.user, "manage", id);
    if (manageDenied) return manageDenied;

    if (channel.provider === "BAILEYS_MD") {
      return NextResponse.json({
        qrCode: channel.qrCode ?? null,
        status: channel.status,
      });
    }

    if (channel.provider !== "META_CLOUD_API") {
      return NextResponse.json(
        { message: "QR code não disponível para este provedor.", qrCode: null, status: channel.status },
        { status: 404 }
      );
    }

    const cfg = parseChannelConfigDecrypted({
      provider: channel.provider,
      config: channel.config,
    });
    const accessToken = str(cfg, "accessToken");
    const phoneNumberId = str(cfg, "phoneNumberId") ?? channel.phoneNumber ?? undefined;
    const businessAccountId = str(cfg, "businessAccountId");
    if (!accessToken || !phoneNumberId || !businessAccountId) {
      return NextResponse.json(
        { message: "Config Meta incompleta (accessToken, phoneNumberId, businessAccountId).", status: channel.status },
        { status: 400 }
      );
    }

    const meta = new MetaWhatsAppClient(accessToken, phoneNumberId, businessAccountId);
    const { searchParams } = new URL(request.url);
    const prefilledRaw = searchParams.get("prefilled_message");
    const prefilled =
      typeof prefilledRaw === "string" && prefilledRaw.trim() !== ""
        ? prefilledRaw.trim().slice(0, 140)
        : "Oi";

    const storedId = str(cfg, "metaQrCodeId");
    let item: MetaQrdlItem | null = null;

    if (storedId) {
      try {
        const one = await meta.getMessageQrDlByCode(phoneNumberId, storedId);
        item = firstMetaQrdl(one) ?? (one as MetaQrdlItem);
      } catch {
        item = null;
      }
    }

    if (!item?.qr_image_url && !item?.deep_link_url) {
      const listPayload = await meta.getQRCode(phoneNumberId);
      item = firstMetaQrdl(listPayload);
    }

    if (!item?.qr_image_url && !item?.deep_link_url) {
      const created = await meta.generateQRCode(phoneNumberId, prefilled || "Oi");
      item = firstMetaQrdl(created) ?? (created as MetaQrdlItem);
      if (item?.code) {
        await updateChannel(id, {
          config: { ...cfg, metaQrCodeId: item.code },
        });
      }
    }

    let qrCode: string | null = null;
    if (item?.qr_image_url) {
      qrCode = await imageUrlToDataUri(item.qr_image_url);
    }
    if (!qrCode && item?.deep_link_url) {
      qrCode = await QRCode.toDataURL(item.deep_link_url, { margin: 1 });
    }

    return NextResponse.json({
      qrCode,
      status: channel.status,
    });
  } catch (e: unknown) {
    log.error({ err: e }, "GET falhou");
    const msg = e instanceof Error ? e.message : "Erro ao obter QR code.";
    return NextResponse.json({ message: msg }, { status: 500 });
  }
}
