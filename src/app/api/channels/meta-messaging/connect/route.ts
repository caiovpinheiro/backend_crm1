/**
 * Conectar canal Facebook Messenger / Instagram Direct via Facebook Login OAuth.
 *
 * Dois modos:
 *   - Body sem `pageId`: troca o `code` por token e devolve `{ pages: [...] }`
 *     para o front mostrar seletor de Pagina.
 *   - Body com `pageId`: executa provisionamento completo (subscribe webhook,
 *     descobrir IG account quando plataforma=instagram, persistir Channel).
 *
 * Espelha o padrao de /api/channels/embedded-signup (WhatsApp Cloud).
 */
import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import {
  MessagingProvisionError,
  listPagesFromCode,
  provisionMessagingChannel,
  type MessagingPlatform,
} from "@/services/channels-messaging-provision";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/channels/meta-messaging/connect");

function parsePlatform(value: unknown): MessagingPlatform | null {
  if (value === "messenger" || value === "instagram") return value;
  return null;
}

export async function POST(request: Request) {
  return withOrgContext(async () => {
    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json({ message: "JSON invalido." }, { status: 400 });
    }

    const code = typeof body.code === "string" ? body.code.trim() : "";
    const pageId = typeof body.pageId === "string" ? body.pageId.trim() : "";
    const channelName =
      typeof body.name === "string" && body.name.trim() ? body.name.trim() : undefined;
    const channelId =
      typeof body.channelId === "string" && body.channelId.trim()
        ? body.channelId.trim()
        : undefined;
    const platform = parsePlatform(body.platform);

    if (!code) {
      return NextResponse.json(
        { message: "Codigo OAuth (code) obrigatorio." },
        { status: 400 },
      );
    }
    if (!platform) {
      return NextResponse.json(
        { message: "platform deve ser 'messenger' ou 'instagram'." },
        { status: 400 },
      );
    }

    try {
      if (!pageId) {
        const { pages } = await listPagesFromCode(code);
        return NextResponse.json({
          needsPageSelection: true,
          pages: pages.map((p) => ({ id: p.id, name: p.name ?? p.id })),
        });
      }

      const result = await provisionMessagingChannel({
        code,
        pageId,
        platform,
        name: channelName,
        channelId,
      });

      return NextResponse.json(
        {
          channel: result.channel,
          pageId: result.pageId,
          pageName: result.pageName,
          instagramAccountId: result.instagramAccountId,
          subscribed: result.subscribed,
        },
        { status: result.created ? 201 : 200 },
      );
    } catch (e: unknown) {
      if (e instanceof MessagingProvisionError) {
        return NextResponse.json({ message: e.message }, { status: e.status });
      }
      log.error({ err: e }, "[meta-messaging/connect] erro");
      const msg = e instanceof Error ? e.message : "Erro ao conectar canal.";
      return NextResponse.json({ message: msg }, { status: 500 });
    }
  });
}
