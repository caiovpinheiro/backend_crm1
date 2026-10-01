import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { CRM_META_APP_ID, CRM_META_APP_SECRET } from "@/lib/meta-constants";
import {
  MetaProvisionError,
  provisionMetaCloudChannel,
} from "@/services/channels-meta-provision";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/channels/embedded-signup");

const GRAPH_API_VERSION = "v21.0";
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

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

      const appId = CRM_META_APP_ID;
      const appSecret = reqAppSecret || CRM_META_APP_SECRET;

      // Troca o code por access_token (30s TTL no code).
      const tokenUrl = new URL(`${GRAPH_BASE}/oauth/access_token`);
      tokenUrl.searchParams.set("client_id", appId);
      tokenUrl.searchParams.set("client_secret", appSecret);
      tokenUrl.searchParams.set("code", code);

      const tokenRes = await fetch(tokenUrl.toString());
      const tokenData = (await tokenRes.json()) as Record<string, unknown>;

      if (!tokenRes.ok || tokenData.error) {
        const errMsg =
          typeof tokenData.error === "object" && tokenData.error !== null
            ? ((tokenData.error as Record<string, unknown>).message as string)
            : "Falha ao trocar código por token.";
        // SEC2-5: só código/tipo do erro — o corpo da Meta pode carregar
        // fragmentos do fluxo OAuth (code, trace) que não devem ir pro log.
        const metaErr =
          typeof tokenData.error === "object" && tokenData.error !== null
            ? (tokenData.error as Record<string, unknown>)
            : {};
        log.error(
          {
            status: tokenRes.status,
            code: metaErr.code ?? null,
            type: metaErr.type ?? null,
            subcode: metaErr.error_subcode ?? null,
          },
          "Embedded Signup token exchange error",
        );
        return NextResponse.json({ message: errMsg }, { status: 400 });
      }

      const accessToken =
        typeof tokenData.access_token === "string"
          ? tokenData.access_token
          : "";
      if (!accessToken) {
        return NextResponse.json(
          { message: "Token de acesso não retornado pela Meta." },
          { status: 502 },
        );
      }

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
