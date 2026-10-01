import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { metaClientFromConfig } from "@/lib/meta-whatsapp/client";
import { CRM_META_APP_ID } from "@/lib/meta-constants";
import { getChannelById } from "@/services/channels";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/channels/[id]/meta-health");

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Health-check pos Embedded Signup para um canal Meta Cloud API.
 * Consulta a Graph API para confirmar:
 *  - subscribed_apps: o App do CRM esta assinado ao WABA (webhooks chegam).
 *  - phone number health: numero registrado/verificado e qualidade.
 * Nao persiste nada; e apenas diagnostico sob demanda pela UI.
 */
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
    if (channel.provider !== "META_CLOUD_API") {
      return NextResponse.json(
        { message: "Health-check disponível apenas para canais Meta Cloud API." },
        { status: 400 },
      );
    }

    const config = (channel.config ?? {}) as Record<string, unknown>;
    const client = metaClientFromConfig(config, { allowEnvFallback: false });

    let webhookSubscribed = false;
    let subscribedAppsError: string | null = null;
    try {
      const subs = await client.getSubscribedApps();
      const apps = Array.isArray(subs.data) ? subs.data : [];
      // Sem CRM_META_APP_ID configurado nao ha como distinguir qual app; nesse
      // caso consideramos assinado se houver qualquer app na lista.
      webhookSubscribed = CRM_META_APP_ID
        ? apps.some((app) => {
            const w = app?.whatsapp_business_api_data as
              | Record<string, unknown>
              | undefined;
            return String(w?.id ?? "") === CRM_META_APP_ID;
          }) || apps.length > 0
        : apps.length > 0;
    } catch (e: unknown) {
      subscribedAppsError = e instanceof Error ? e.message : "Falha ao consultar subscribed_apps.";
    }

    let phoneHealth: Record<string, unknown> | null = null;
    let phoneError: string | null = null;
    try {
      phoneHealth = (await client.getPhoneNumberHealth()) as Record<string, unknown>;
    } catch (e: unknown) {
      phoneError = e instanceof Error ? e.message : "Falha ao consultar saúde do número.";
    }

    return NextResponse.json({
      channelId: channel.id,
      status: channel.status,
      webhookSubscribed,
      subscribedAppsError,
      phone: phoneHealth,
      phoneError,
    });
  } catch (e: unknown) {
    log.error({ err: e }, "meta-health error");
    const msg = e instanceof Error ? e.message : "Erro no health-check.";
    return NextResponse.json({ message: msg }, { status: 500 });
  }
}
