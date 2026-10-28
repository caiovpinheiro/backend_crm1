/**
 * Conversa webchat nunca sai pela Meta/WhatsApp.
 *
 * O canal WEBCHAT não tem `accessToken`/`phoneNumberId`; quem montava o
 * cliente Meta a partir do `config` dele caía no cliente global do .env e
 * mandava WhatsApp para o telefone que o VISITANTE digitou (que pode ser de
 * qualquer pessoa). A única entrega de uma conversa webchat é gravar a
 * mensagem para o widget buscar (`POST /api/conversations/:id/messages`,
 * ramo webchat). Tudo o mais (anexo, template, encaminhar, interativos, IA,
 * passos de automação de WhatsApp) recusa com 4xx/erro claro.
 *
 * Sem dependências: importado por `meta-whatsapp/client` e `send-whatsapp`.
 */

export const WEBCHAT_PROVIDER = "WEBCHAT";
export const WEBCHAT_CHANNEL = "webchat";

/** Mensagem única para o operador (4xx das rotas / erro dos serviços). */
export const WEBCHAT_UNSUPPORTED_SEND_MESSAGE =
  "Conversa do webchat: só texto pelo chat do inbox. Anexo, modelo, encaminhamento, mensagem interativa e envio por WhatsApp não estão disponíveis neste canal.";

export const WEBCHAT_UNSUPPORTED_STATUS = 422;

export function isWebchatChannelRef(
  ref: { provider?: string | null } | null | undefined,
): boolean {
  return ref?.provider === WEBCHAT_PROVIDER;
}

export function isWebchatConversation(
  conv:
    | { channel?: string | null; channelRef?: { provider?: string | null } | null }
    | null
    | undefined,
): boolean {
  if (!conv) return false;
  return (
    (conv.channel ?? "").toLowerCase() === WEBCHAT_CHANNEL || isWebchatChannelRef(conv.channelRef)
  );
}

/**
 * `Channel.config` de um canal WEBCHAT (`publicKey` "wc_…" e
 * `allowedOrigins`). Usado por `metaClientFromConfig`, que só recebe o
 * config, para nunca cair no cliente global.
 */
export function looksLikeWebchatChannelConfig(
  config: Record<string, unknown> | null | undefined,
): boolean {
  if (!config) return false;
  const key = config.publicKey;
  return (
    (typeof key === "string" && key.startsWith("wc_")) ||
    Array.isArray(config.allowedOrigins)
  );
}
