/**
 * Conexão manual do WhatsApp Cloud API — igual ao Datacrazy.
 *
 * Recebe TOKEN direto (o cliente já tem um token permanente/de sistema no
 * Meta Business), sem OAuth. Provisiona o canal assinando `subscribed_apps`
 * no WABA do cliente para o App Meta global do CRM, então o webhook é
 * automaticamente entregue no nosso Callback URL — sem o cliente tocar no
 * painel `developers.facebook.com`.
 *
 * A verificação de assinatura do webhook recebido usa o `CRM_META_APP_SECRET`
 * global (env `META_APP_SECRET`), portanto NÃO gravamos App Secret por canal.
 *
 * Bug 27/abr/26 (mesma nota do POST /api/channels): precisamos rodar dentro
 * de `withOrgContext` para popular o RequestContext — `createChannel` usa
 * `withOrgFromCtx` internamente para injetar organizationId no payload.
 */
import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import {
  MetaProvisionError,
  provisionMetaCloudChannel,
} from "@/services/channels-meta-provision";

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
      const accessToken =
        typeof b.accessToken === "string" ? b.accessToken.trim() : "";
      const phoneNumberId =
        typeof b.phoneNumberId === "string" ? b.phoneNumberId.trim() : "";
      const wabaId = typeof b.wabaId === "string" ? b.wabaId.trim() : "";
      const channelId =
        typeof b.channelId === "string" && b.channelId.trim()
          ? b.channelId.trim()
          : undefined;
      const verifyToken =
        typeof b.verifyToken === "string" && b.verifyToken.trim()
          ? b.verifyToken.trim()
          : undefined;
      const webhookId =
        typeof b.webhookId === "string" && b.webhookId.trim()
          ? b.webhookId.trim()
          : undefined;
      const appSecret =
        typeof b.appSecret === "string" && b.appSecret.trim()
          ? b.appSecret.trim()
          : undefined;
      const appId =
        typeof b.appId === "string" && b.appId.trim()
          ? b.appId.trim()
          : undefined;

      if (!accessToken || !phoneNumberId || !wabaId) {
        return NextResponse.json(
          {
            message:
              "Preencha Nome da conexão, Token de acesso, ID do número de telefone e WABA ID.",
          },
          { status: 400 },
        );
      }

      if (!channelId && !name) {
        return NextResponse.json(
          { message: "Nome da conexão é obrigatório." },
          { status: 400 },
        );
      }

      const result = await provisionMetaCloudChannel({
        accessToken,
        phoneNumberId,
        wabaId,
        name: name || undefined,
        channelId,
        embeddedSignup: false,
        verifyToken,
        webhookId,
        appSecret,
        appId,
      });

      return NextResponse.json(
        { channel: result.channel },
        { status: result.created ? 201 : 200 },
      );
    } catch (e: unknown) {
      if (e instanceof MetaProvisionError) {
        return NextResponse.json({ message: e.message }, { status: e.status });
      }
      console.error("Manual Cloud connect error:", e);
      const msg =
        e instanceof Error ? e.message : "Erro ao conectar canal manual.";
      return NextResponse.json({ message: msg }, { status: 500 });
    }
  });
}
