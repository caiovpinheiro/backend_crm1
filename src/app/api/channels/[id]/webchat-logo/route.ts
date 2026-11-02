import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { requireChannelScope } from "@/lib/authz/resource-policy";
import { readBrandingImageUpload } from "@/lib/branding-image-upload";
import { getLogger } from "@/lib/logger";
import { generateFileName, saveFile } from "@/lib/storage/local";
import { getChannelById } from "@/services/channels";

const log = getLogger("api/channels/[id]/webchat-logo");

type RouteContext = { params: Promise<{ id: string }> };

/** O avatar aparece pequeno e a imagem é servida a todo visitante. */
const MAX_WEBCHAT_LOGO_SIZE = 2 * 1024 * 1024;

/**
 * POST /api/channels/:id/webchat-logo — guarda a imagem do avatar do canal WEBCHAT
 * (multipart, campo `file`) no bucket `branding` da organização do canal e devolve
 * `{ url }`. Exige `manage` no canal. Só grava o arquivo: ele vale, e fica público,
 * quando o painel salvar o canal com `theme.avatarUrl = url`.
 * docs/decisoes/webchat-widget.md §9.14.
 */
export async function POST(request: Request, context: RouteContext) {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ message: "Não autorizado." }, { status: 401 });
    }
    const { id } = await context.params;
    const channel = await getChannelById(id);
    if (!channel || channel.provider !== "WEBCHAT") {
      return NextResponse.json({ message: "Canal Webchat não encontrado." }, { status: 404 });
    }
    const denied = await requireChannelScope(session.user, "manage", id);
    if (denied) return denied;

    const upload = await readBrandingImageUpload(request, MAX_WEBCHAT_LOGO_SIZE);
    if (!upload.ok) {
      return NextResponse.json({ message: upload.message }, { status: upload.status });
    }
    const fileName = generateFileName({ prefix: "webchat_logo", ext: upload.ext });
    await saveFile({
      orgId: channel.organizationId,
      bucket: "branding",
      fileName,
      buffer: upload.buffer,
    });
    return NextResponse.json(
      { url: `/api/storage/${channel.organizationId}/branding/${fileName}` },
      { status: 201, headers: { "Cache-Control": "no-store" } },
    );
  } catch (e: unknown) {
    log.error({ err: e }, "POST falhou");
    return NextResponse.json({ message: "Erro ao enviar a imagem." }, { status: 500 });
  }
}
