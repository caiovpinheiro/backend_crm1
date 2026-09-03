/**
 * Provisionamento de canal WhatsApp Cloud (Meta) — passos compartilhados
 * entre Embedded Signup (OAuth code -> token) e conexão manual (token direto).
 *
 * Faz:
 *   1. Assina o app do CRM ao WABA do cliente (POST /{wabaId}/subscribed_apps).
 *      Isso é o que substitui a "dança manual" no painel Meta: a Meta passa
 *      a entregar webhooks do WABA do cliente no nosso Callback URL global.
 *   2. Registra o número no WhatsApp Business Platform (POST /{phoneNumberId}/register).
 *      Não-fatal: o número pode já estar registrado.
 *   3. Busca metadados do número (display_phone_number, verified_name).
 *   4. Cria/atualiza o Channel no banco com status=CONNECTED.
 *
 * A verificação de assinatura dos webhooks recebidos é feita com o
 * `CRM_META_APP_SECRET` global do CRM (o mesmo App Meta que assinou o WABA).
 * Portanto canais provisionados por aqui NÃO gravam `appSecret` no config.
 */
import type { Channel } from "@prisma/client";

import { createChannel, getChannelById, updateChannel } from "@/services/channels";

const GRAPH_API_VERSION = "v21.0";
const GRAPH_BASE = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

function randomPin(): string {
  return String(Math.floor(100000 + Math.random() * 900000));
}

export type ProvisionMetaCloudChannelInput = {
  accessToken: string;
  phoneNumberId: string;
  wabaId: string;
  /** Nome do canal quando estiver criando um novo. */
  name?: string;
  /** Se informado, ATUALIZA o canal existente em vez de criar. */
  channelId?: string;
  /** Marca `config.embeddedSignup: true` (fluxo OAuth). Default: false (manual). */
  embeddedSignup?: boolean;
  /**
   * Opcional: verify token que o cliente vai colar no painel Meta -> WhatsApp
   * -> Configuracao (fluxo em que o cliente usa seu proprio App Meta em vez
   * do App global do CRM). Persistimos em `config.verifyToken` para o handler
   * do webhook validar o handshake da Meta.
   */
  verifyToken?: string;
  /**
   * Opcional: id aleatorio gerado pelo GET /api/channels/meta/webhook-info
   * usado no path da callback URL (`/api/webhooks/meta/<webhookId>`).
   * Persistimos em `config.webhookId` -- o handler da rota scoped resolve
   * o canal + org por esse id (evita expor slug/nome da org no callback).
   */
  webhookId?: string;
  /**
   * Opcional: App Secret do App Meta do cliente. Necessario no fluxo
   * "webhook manual" (cliente usa o proprio App Meta) pra validar
   * `x-hub-signature-256` dos POSTs recebidos. Persistido encriptado em
   * `config.appSecret` pela `createChannel`/`updateChannel`.
   */
  appSecret?: string;
  /**
   * Opcional: App ID do Meta App **desta organização**. Necessário para
   * criar templates com header IMAGE/VIDEO/DOCUMENT (`POST /{app-id}/uploads`).
   * Persistido em `config.appId`.
   */
  appId?: string;
};

export type ProvisionMetaCloudChannelResult = {
  channel: Channel;
  created: boolean;
  displayPhone: string;
  verifiedName: string;
  /** true se `subscribed_apps` retornou ok (webhook automático ativo). */
  webhookSubscribed: boolean;
  /** true se `/register` retornou ok. Non-fatal quando false. */
  phoneRegistered: boolean;
};

export class MetaProvisionError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "MetaProvisionError";
    this.status = status;
  }
}

/**
 * Executa os passos 1-4 acima. Se `subscribed_apps` falhar, joga erro
 * (o cliente precisa saber que o webhook não foi assinado — do contrário
 * o canal fica "criado" mas mudo). `/register` é non-fatal.
 */
export async function provisionMetaCloudChannel(
  input: ProvisionMetaCloudChannelInput,
): Promise<ProvisionMetaCloudChannelResult> {
  const accessToken = input.accessToken.trim();
  const phoneNumberId = input.phoneNumberId.trim();
  const wabaId = input.wabaId.trim();

  if (!accessToken || !phoneNumberId || !wabaId) {
    throw new MetaProvisionError(
      "accessToken, phoneNumberId e wabaId são obrigatórios.",
      400,
    );
  }

  if (input.channelId) {
    const existing = await getChannelById(input.channelId);
    if (!existing) {
      throw new MetaProvisionError("Canal não encontrado.", 404);
    }
  }

  // 1. Assina o app do CRM ao WABA do cliente. Sem isso, a Meta não
  // envia eventos desse número para o nosso Callback URL.
  let webhookSubscribed = false;
  const subRes = await fetch(`${GRAPH_BASE}/${wabaId}/subscribed_apps`, {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (subRes.ok) {
    webhookSubscribed = true;
  } else {
    const subErr = (await subRes.json().catch(() => ({}))) as Record<string, unknown>;
    const errObj = (subErr.error ?? {}) as Record<string, unknown>;
    const msg =
      typeof errObj.message === "string"
        ? errObj.message
        : "Falha ao assinar o app ao WABA (subscribed_apps).";
    console.error("[provisionMetaCloudChannel] subscribed_apps error:", subErr);
    throw new MetaProvisionError(
      `Não foi possível assinar o webhook no WABA: ${msg}. Verifique o Token de acesso e as permissões (whatsapp_business_management).`,
      400,
    );
  }

  // 2. Registra o número. Non-fatal: pode já estar registrado.
  let phoneRegistered = false;
  const pin = randomPin();
  try {
    const regRes = await fetch(`${GRAPH_BASE}/${phoneNumberId}/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ messaging_product: "whatsapp", pin }),
    });
    if (regRes.ok) {
      phoneRegistered = true;
    } else {
      const regErr = (await regRes.json().catch(() => ({}))) as Record<string, unknown>;
      console.warn(
        "[provisionMetaCloudChannel] phone register non-fatal error:",
        regErr,
      );
    }
  } catch (err) {
    console.warn("[provisionMetaCloudChannel] phone register threw (non-fatal):", err);
  }

  // 3. Metadados do número (display_phone_number / verified_name).
  let displayPhone = phoneNumberId;
  let verifiedName = "";
  try {
    const phoneRes = await fetch(
      `${GRAPH_BASE}/${phoneNumberId}?fields=display_phone_number,verified_name`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (phoneRes.ok) {
      const phoneData = (await phoneRes.json()) as Record<string, unknown>;
      if (typeof phoneData.display_phone_number === "string") {
        displayPhone = phoneData.display_phone_number;
      }
      if (typeof phoneData.verified_name === "string") {
        verifiedName = phoneData.verified_name;
      }
    }
  } catch {
    // Non-fatal: exibimos phoneNumberId como fallback.
  }

  // 4. Persiste. SEM appSecret — assinatura do webhook usa o secret global
  // do CRM (CRM_META_APP_SECRET no env).
  const config: Record<string, unknown> = {
    accessToken,
    phoneNumberId,
    businessAccountId: wabaId,
    twoStepPin: pin,
  };
  if (verifiedName) config.verifiedName = verifiedName;
  if (input.embeddedSignup) config.embeddedSignup = true;
  if (input.verifyToken && input.verifyToken.trim()) {
    config.verifyToken = input.verifyToken.trim();
  }
  if (input.webhookId && input.webhookId.trim()) {
    config.webhookId = input.webhookId.trim();
  }
  if (input.appSecret && input.appSecret.trim()) {
    config.appSecret = input.appSecret.trim();
  }
  if (input.appId && input.appId.trim()) {
    config.appId = input.appId.trim();
  }

  let channel: Channel;
  let created = false;
  if (input.channelId) {
    // Se o cliente pre-criou o canal (fluxo do botao "Webhook") ha um
    // webhookId em config -- preservamos ao mesclar com o config novo.
    channel = await updateChannel(input.channelId, {
      name: input.name?.trim() || undefined,
      config,
      phoneNumber: displayPhone,
      status: "CONNECTED",
      lastConnectedAt: new Date(),
      qrCode: null,
    });
  } else {
    channel = await createChannel({
      name: input.name?.trim() || verifiedName || `WhatsApp ${displayPhone}`,
      type: "WHATSAPP",
      provider: "META_CLOUD_API",
      config,
      phoneNumber: displayPhone,
    });
    channel = await updateChannel(channel.id, {
      status: "CONNECTED",
      lastConnectedAt: new Date(),
    });
    created = true;
  }

  return {
    channel,
    created,
    displayPhone,
    verifiedName,
    webhookSubscribed,
    phoneRegistered,
  };
}
