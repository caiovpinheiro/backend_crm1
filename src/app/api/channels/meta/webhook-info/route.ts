/**
 * POST /api/channels/meta/webhook-info
 *
 * Pre-cria um Channel em status CONNECTING com webhookId + verifyToken
 * aleatorios, retornando Callback URL pra o cliente colar no painel Meta.
 *
 * Por que pre-criar: no momento do "Verify and save" na Meta, a Meta faz
 * um GET no callback com o verifyToken -- se o canal nao existe ainda,
 * /api/webhooks/meta/<webhookId> retorna 404. Criando o canal ja com o
 * webhookId+verifyToken persistidos, o handshake funciona.
 *
 * Fluxo:
 *   1. Usuario clica "Webhook" -> POST este endpoint -> cria Channel CONNECTING.
 *   2. Retorna { channelId, callbackUrl, verifyToken, webhookId }.
 *   3. Cliente cola callbackUrl + verifyToken no painel Meta -> Verify OK.
 *   4. Cliente clica "Criar canal" -> POST /api/channels/manual-cloud com
 *      channelId -> ATUALIZA o canal pra CONNECTED, popula accessToken,
 *      phoneNumberId, wabaId etc.
 *
 * GET continua existindo pra backward compat (nao cria canal, so retorna
 * ids aleatorios -- util pra clientes que ja tem canal e querem re-gerar
 * um webhookId).
 */
import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { createChannel } from "@/services/channels";

const CHARSET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

function generateRandomId(length: number): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += CHARSET[bytes[i] % CHARSET.length];
  }
  return out;
}

function backendBaseUrl(request: Request): { base: string; source: string } {
  // Prioridade: env explicita do BACKEND. Em Easypanel / proxy reverso,
  // a request pode vir pelo rewrite do frontend, entao `x-forwarded-host`
  // e o dominio do frontend -- errado pra Meta chamar de volta.
  //
  // Setar no deploy do backend uma dessas envs (aponta pra si mesmo):
  //   BACKEND_PUBLIC_URL=https://seu-backend.easypanel.host
  //   ou NEXT_PUBLIC_API_BASE_URL=https://seu-backend.easypanel.host
  const envBackend = process.env.BACKEND_PUBLIC_URL?.trim();
  if (envBackend) return { base: envBackend.replace(/\/$/, ""), source: "env:BACKEND_PUBLIC_URL" };

  const envApi = process.env.NEXT_PUBLIC_API_BASE_URL?.trim();
  if (envApi) return { base: envApi.replace(/\/$/, ""), source: "env:NEXT_PUBLIC_API_BASE_URL" };

  const forwardedHost = request.headers.get("x-forwarded-host");
  const forwardedProto = request.headers.get("x-forwarded-proto");
  if (forwardedHost) {
    const proto = forwardedProto?.split(",")[0]?.trim() || "https";
    return {
      base: `${proto}://${forwardedHost.split(",")[0]?.trim()}`,
      source: "header:x-forwarded-host",
    };
  }

  const hostHeader = request.headers.get("host");
  if (hostHeader && !hostHeader.startsWith("0.0.0.0") && !hostHeader.startsWith("127.")) {
    const proto = forwardedProto || "https";
    return { base: `${proto}://${hostHeader}`, source: "header:host" };
  }

  try {
    const url = new URL(request.url);
    return { base: `${url.protocol}//${url.host}`, source: "request.url" };
  } catch {
    return { base: "", source: "none" };
  }
}

function buildResponse(request: Request, opts: {
  webhookId: string;
  verifyToken: string;
  channelId?: string;
}) {
  const { base, source } = backendBaseUrl(request);
  const callbackUrl = `${base}/api/webhooks/meta/${opts.webhookId}`;
  const isFromHeader = source.startsWith("header:") || source === "request.url";
  return NextResponse.json({
    channelId: opts.channelId ?? null,
    callbackUrl,
    verifyToken: opts.verifyToken,
    webhookId: opts.webhookId,
    resolvedFrom: source,
    warning: isFromHeader
      ? "URL derivada de header HTTP. Se apontar pro dominio errado, configure BACKEND_PUBLIC_URL no deploy do backend."
      : null,
  });
}

export async function POST(request: Request) {
  return withOrgContext(async (session) => {
    const orgId = session.user.organizationId;
    if (!orgId) {
      return NextResponse.json(
        { message: "Sem organizacao no contexto." },
        { status: 403 },
      );
    }

    let name = "";
    let channelKind: "WHATSAPP" | "INSTAGRAM" = "WHATSAPP";
    try {
      const body = (await request.json()) as { name?: unknown; type?: unknown };
      if (typeof body.name === "string") name = body.name.trim();
      if (body.type === "INSTAGRAM") channelKind = "INSTAGRAM";
    } catch {
      // body opcional; se nao vier, usa nome padrao
    }

    const webhookId = generateRandomId(24);
    const verifyToken = generateRandomId(40);

    // Cria canal pra que o handshake Meta encontre o webhookId no banco.
    // Credenciais reais entram depois (manual-cloud / instagram/manual)
    // e movem status pra CONNECTED.
    try {
      const channel = await createChannel({
        name:
          name ||
          (channelKind === "INSTAGRAM"
            ? "Nova conexao Instagram"
            : "Nova conexao WhatsApp"),
        type: channelKind,
        provider:
          channelKind === "INSTAGRAM"
            ? "META_INSTAGRAM_LOGIN"
            : "META_CLOUD_API",
        config: {
          webhookId,
          verifyToken,
          ...(channelKind === "INSTAGRAM" ? { platform: "instagram" } : {}),
        },
      });

      return buildResponse(request, {
        webhookId,
        verifyToken,
        channelId: channel.id,
      });
    } catch (e: unknown) {
      // Sem este catch a excecao sobe pro Next, que responde 500 com corpo
      // VAZIO — o cliente estoura em `res.json()` ("Unexpected end of JSON
      // input") e a causa real (KEYRING_SECRET ausente, migration faltando,
      // Redis fora) nunca chega ao operador.
      console.error("webhook-info: falha ao pre-criar canal:", e);
      const msg =
        e instanceof Error ? e.message : "Erro ao pre-criar canal Meta.";
      return NextResponse.json(
        { message: msg, code: "CHANNEL_PRECREATE_FAILED" },
        { status: 500 },
      );
    }
  });
}

// GET (legacy / preview): nao cria canal, so devolve ids. Uso: ferramentas
// de dev, ou UI que so quer preview antes de comprometer com criacao.
export async function GET(request: Request) {
  return withOrgContext(async (session) => {
    const orgId = session.user.organizationId;
    if (!orgId) {
      return NextResponse.json(
        { message: "Sem organizacao no contexto." },
        { status: 403 },
      );
    }
    return buildResponse(request, {
      webhookId: generateRandomId(24),
      verifyToken: generateRandomId(40),
    });
  });
}
