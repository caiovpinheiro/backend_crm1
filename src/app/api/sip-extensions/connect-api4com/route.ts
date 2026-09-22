import { NextResponse } from "next/server";

import { authenticateApiRequest, runWithApiUserContext } from "@/lib/api-auth";
import { requirePermissionForUser } from "@/lib/authz/resource-policy";
import { getOrCreateApi4ComProviderConfig } from "@/services/call-provider-configs";
import { createOrUpdateExtension } from "@/services/sip-extensions";
import { buildApi4ComProviderMeta } from "@/services/sip-extension-provider-meta";
import {
  buildSipParamsFromApi4ComExtension,
  listApi4ComExtensions,
  loginApi4Com,
  pickExtensionForEmail,
  resolveApi4ComGateway,
  upsertApi4ComWebhookWithUserToken,
} from "@/services/telephony-providers/api4com";

/**
 * POST /api/sip-extensions/connect-api4com
 *
 * Conecta conta Api4Com (e-mail + senha) e provisiona o ramal SIP no CRM.
 * O usuário não precisa digitar wss/ramal/senha SIP — o backend resolve via API.
 * O softphone no navegador (JsSIP) usa as credenciais persistidas em SipExtension.
 *
 * RBAC: sip_extension:manage (próprio ramal ou admin).
 */
export async function POST(request: Request) {
  const authResult = await authenticateApiRequest(request);
  if (!authResult.ok) return authResult.response;

  return runWithApiUserContext(authResult.user, async () => {
    const denied = await requirePermissionForUser(authResult.user, "sip_extension:manage");
    if (denied) return denied;

    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json({ message: "JSON inválido." }, { status: 400 });
    }

    const email = typeof body.email === "string" ? body.email.trim() : "";
    if (!email) {
      return NextResponse.json(
        { ok: false, field: "email", message: "E-mail Api4Com é obrigatório." },
        { status: 400 },
      );
    }

    const password = typeof body.password === "string" ? body.password : "";
    if (!password) {
      return NextResponse.json(
        { ok: false, field: "password", message: "Senha Api4Com é obrigatória." },
        { status: 400 },
      );
    }

    const userId =
      typeof body.userId === "string" && body.userId.trim()
        ? body.userId.trim()
        : authResult.user.id;

    const login = await loginApi4Com(email, password);
    if (!login.ok) {
      return NextResponse.json(login, { status: 400 });
    }

    const listed = await listApi4ComExtensions(login.token);
    if (!listed.ok) {
      return NextResponse.json(listed, { status: 400 });
    }

    const apiExt = pickExtensionForEmail(listed.extensions, email);
    if (!apiExt) {
      return NextResponse.json(
        {
          ok: false,
          field: "email",
          message:
            "Nenhum ramal Api4Com encontrado para este e-mail. Verifique no portal Api4Com se o ramal está vinculado ao seu usuário.",
        },
        { status: 400 },
      );
    }

    const sip = buildSipParamsFromApi4ComExtension(apiExt);

    try {
      const extension = await createOrUpdateExtension({
        userId,
        ...sip,
        status: "ACTIVE",
        providerMeta: buildApi4ComProviderMeta(login.token, email, password),
      });

      // ── Setup do webhook de chamadas (histórico em /calls) ─────────────
      // Sem isso, o backend nunca recebe `channel-hangup` da Api4com e
      // nenhum Call é registrado. Tenta automático com o user token; se
      // a Api4com rejeitar (403 — depende do perfil/plano), devolve a
      // URL pra o operador colar manual no portal.
      const providerConfig = await getOrCreateApi4ComProviderConfig();
      const baseUrl = (process.env.NEXT_PUBLIC_APP_URL ?? process.env.APP_URL ?? "")
        .trim()
        .replace(/\/$/, "");
      const webhookUrl = baseUrl
        ? `${baseUrl}/api/webhooks/calls/api4com?token=${providerConfig.webhookToken}`
        : `/api/webhooks/calls/api4com?token=${providerConfig.webhookToken}`;
      const gateway = resolveApi4ComGateway(extension.organizationId);

      let webhook:
        | { configured: true }
        | { configured: false; webhookUrl: string; manualSetupRequired: true; reason: string };

      if (!baseUrl) {
        webhook = {
          configured: false,
          webhookUrl,
          manualSetupRequired: true,
          reason:
            "APP_URL (env do backend) não está definida. Configure-a e refaça a conexão.",
        };
      } else {
        // Tokens de USUÁRIO comum não conseguem cadastrar integration com
        // gateway customizado (a Api4com normaliza silenciosamente pra
        // "webhook" sem constraint, resultando em integration que NÃO
        // dispara). Usamos o token ADMIN (env API4COM_SERVICE_TOKEN) sempre
        // que disponível; fallback no user token só pra ambientes sem
        // service token configurado (vai falhar visivelmente, sem ficar
        // mudo como antes).
        const adminToken = process.env.API4COM_SERVICE_TOKEN?.trim();
        const webhookToken = adminToken || login.token;
        const setupResult = await upsertApi4ComWebhookWithUserToken(webhookToken, {
          gateway,
          webhookUrl,
        });
        if (setupResult.ok) {
          webhook = { configured: true };
        } else {
          webhook = {
            configured: false,
            webhookUrl,
            manualSetupRequired: true,
            reason: adminToken
              ? setupResult.message
              : `${setupResult.message} (Dica: defina API4COM_SERVICE_TOKEN no .env do backend pra setup automático.)`,
          };
        }
      }

      return NextResponse.json(
        {
          extension,
          api4com: {
            domain: apiExt.domain,
            ramal: String(apiExt.ramal ?? sip.authUser),
            wsServer: sip.wsServer,
          },
          webhook,
        },
        { status: 200 },
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const status = (e as { status?: number }).status;
      if (status === 400) {
        return NextResponse.json({ message: msg }, { status: 400 });
      }
      console.error("[sip-extensions/connect-api4com]:", msg);

      if (/sip_extensions/i.test(msg) && /does not exist/i.test(msg)) {
        return NextResponse.json(
          {
            message:
              "Tabela sip_extensions ausente. Aplique a migration 20260616110000_add_softphone_module e reinicie o backend.",
          },
          { status: 503 },
        );
      }

      return NextResponse.json(
        {
          message:
            process.env.NODE_ENV === "development"
              ? `Erro ao provisionar ramal Api4Com: ${msg}`
              : "Erro ao provisionar ramal Api4Com.",
        },
        { status: 500 },
      );
    }
  });
}
