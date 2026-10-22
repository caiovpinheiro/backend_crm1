import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { CRM_META_APP_SECRET } from "@/lib/meta-constants";
import {
  MetaProvisionError,
  provisionMetaCloudChannel,
} from "@/services/channels-meta-provision";
import { exchangeEmbeddedSignupCode } from "@/services/meta-embedded-signup-token";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/channels/embedded-signup");

// Bug 27/abr/26 (mesma nota do POST /api/channels): precisamos rodar dentro
// de `withOrgContext` para popular o RequestContext — `createChannel` usa
// `withOrgFromCtx` internamente para injetar organizationId no payload.
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
      const code = typeof b.code === "string" ? b.code.trim() : "";
      const phoneNumberId =
        typeof b.phoneNumberId === "string" ? b.phoneNumberId.trim() : "";
      const wabaId = typeof b.wabaId === "string" ? b.wabaId.trim() : "";
      const channelName =
        typeof b.name === "string" && b.name.trim() ? b.name.trim() : undefined;
      const channelId =
        typeof b.channelId === "string" && b.channelId.trim()
          ? b.channelId.trim()
          : undefined;
      const reqAppSecret =
        typeof b.appSecret === "string" && b.appSecret.trim()
          ? b.appSecret.trim()
          : undefined;

      if (!code) {
        return NextResponse.json(
          { message: "Código de autorização (code) é obrigatório." },
          { status: 400 },
        );
      }
      if (!phoneNumberId || !wabaId) {
        return NextResponse.json(
          { message: "phoneNumberId e wabaId são obrigatórios." },
          { status: 400 },
        );
      }

      const appSecret = reqAppSecret || CRM_META_APP_SECRET;
      const accessToken = await exchangeEmbeddedSignupCode({ code, appSecret });

      // Passos 2-5: subscribed_apps + register + fetch phone + persist.
      // O helper compartilha esta lógica com a conexão manual.
      const result = await provisionMetaCloudChannel({
        accessToken,
        phoneNumberId,
        wabaId,
        name: channelName,
        channelId,
        embeddedSignup: true,
      });

      return NextResponse.json(
        {
          channel: result.channel,
          webhookSubscribed: result.webhookSubscribed,
          phoneRegistered: result.phoneRegistered,
          displayPhone: result.displayPhone,
          verifiedName: result.verifiedName,
        },
        { status: result.created ? 201 : 200 },
      );
    } catch (e: unknown) {
      if (e instanceof MetaProvisionError) {
        return NextResponse.json({ message: e.message }, { status: e.status });
      }
      log.error({ err: e }, "Embedded Signup error");
      const msg =
        e instanceof Error ? e.message : "Erro no Embedded Signup.";
      return NextResponse.json({ message: msg }, { status: 500 });
    }
  });
}
