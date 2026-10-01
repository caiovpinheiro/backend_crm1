/**
 * Cliente HTTP minimo para as Meta Messaging APIs (Messenger e Instagram),
 * complementar ao cliente WhatsApp em `../meta-whatsapp/client.ts`.
 *
 * Endpoints:
 *   - Messenger:  POST /{pageId}/messages  { recipient: { id: PSID },  message: {...} }
 *   - Instagram:  POST /{pageId}/messages  { recipient: { id: IGSID }, message: {...} }
 *     (Instagram Messaging usa o mesmo endpoint da Pagina vinculada.)
 *
 * Reaproveita a tipagem/formatacao de erro do WhatsApp
 * (`MetaGraphError`/`formatMetaSendError`) para consistencia nos logs e
 * em `Message.sendError`.
 */
import {
  MetaGraphError,
  type MetaGraphErrorPayload,
} from "@/lib/meta-whatsapp/client";
import { decryptSecret, isEncryptedSecret } from "@/lib/crypto/secrets";
import { getLogger } from "@/lib/logger";

const log = getLogger("meta-messaging.client");

const GRAPH_VERSION = "v21.0";
const GRAPH_TIMEOUT_MS = 20_000;

type SendResult = { message_id?: string; recipient_id?: string };

/**
 * Modo do cliente:
 *   - "messenger" -> POST graph.facebook.com/v21.0/{pageId}/messages
 *   - "instagram" -> POST graph.instagram.com/v21.0/me/messages (IG Direct Login)
 */
export type MessagingMode = "messenger" | "instagram";

export class MetaMessagingClient {
  constructor(
    private readonly accessToken: string,
    /** pageId (messenger) ou instagramUserId (instagram). */
    private readonly senderId: string,
    private readonly mode: MessagingMode = "messenger",
  ) {}

  get configured(): boolean {
    return Boolean(this.accessToken?.trim() && this.senderId?.trim());
  }

  private baseUrl(): string {
    return this.mode === "instagram"
      ? `https://graph.instagram.com/${GRAPH_VERSION}`
      : `https://graph.facebook.com/${GRAPH_VERSION}`;
  }

  private endpointPath(): string {
    // IG Direct: /me/messages (o proprio token identifica a conta)
    // Messenger: /{pageId}/messages
    return this.mode === "instagram"
      ? "me/messages"
      : `${this.senderId}/messages`;
  }

  static buildGraphUrl(path: string): string {
    const p = path.startsWith("/") ? path.slice(1) : path;
    return `https://graph.facebook.com/${GRAPH_VERSION}/${p}`;
  }

  private async graphPost<T>(path: string, body: unknown): Promise<T> {
    const url = `${this.baseUrl()}/${path.startsWith("/") ? path.slice(1) : path}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        cache: "no-store",
        signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS),
      });
    } catch (err) {
      if (
        err instanceof Error &&
        (err.name === "TimeoutError" || err.name === "AbortError")
      ) {
        throw new Error(
          `Tempo limite ao comunicar com a Meta (${GRAPH_TIMEOUT_MS}ms) em ${path}.`,
        );
      }
      throw err;
    }

    const text = await res.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }

    if (!res.ok) {
      const payload =
        data && typeof data === "object"
          ? ((data as { error?: MetaGraphErrorPayload }).error ?? null)
          : null;
      throw new MetaGraphError({ httpStatus: res.status, path, payload });
    }
    return data as T;
  }

  /**
   * Envia mensagem de texto. `recipientId` = PSID (Messenger) ou IGSID
   * (Instagram). O endpoint e o mesmo em ambos os casos.
   *
   * MESSAGE_TAG e' opcional: quando setado (ex.: HUMAN_AGENT), amplia a
   * janela de 24h padrao. Sem tag, a Meta recusa envios fora da janela.
   */
  async sendText(
    recipientId: string,
    text: string,
    opts?: { messagingType?: "RESPONSE" | "UPDATE" | "MESSAGE_TAG"; tag?: string },
  ): Promise<SendResult> {
    const body: Record<string, unknown> = {
      recipient: { id: recipientId },
      message: { text },
      messaging_type: opts?.messagingType ?? "RESPONSE",
    };
    if (opts?.tag) body.tag = opts.tag;
    return this.graphPost<SendResult>(this.endpointPath(), body);
  }

  /**
   * Envia anexo por URL. `type` = image | video | audio | file.
   */
  async sendAttachment(
    recipientId: string,
    type: "image" | "video" | "audio" | "file",
    url: string,
    opts?: { messagingType?: "RESPONSE" | "UPDATE" | "MESSAGE_TAG"; tag?: string },
  ): Promise<SendResult> {
    const body: Record<string, unknown> = {
      recipient: { id: recipientId },
      message: {
        attachment: { type, payload: { url, is_reusable: false } },
      },
      messaging_type: opts?.messagingType ?? "RESPONSE",
    };
    if (opts?.tag) body.tag = opts.tag;
    return this.graphPost<SendResult>(this.endpointPath(), body);
  }
}

/**
 * Constroi o client a partir do `Channel.config` (formato gravado pelo
 * provisionamento em `channels-messaging-provision.ts`). Decripta o
 * `accessToken` (Page Access Token) transparentemente.
 */
/**
 * Constroi o client a partir do `Channel.config`. Detecta o modo pelo
 * campo `platform`:
 *   - "instagram" + instagramUserId  -> IG Direct (graph.instagram.com/me/messages)
 *   - "messenger" + pageId (ou config sem platform) -> Messenger
 */
export function messagingClientFromConfig(
  config: Record<string, unknown> | null | undefined,
): MetaMessagingClient {
  if (!config) return new MetaMessagingClient("", "", "messenger");

  const rawToken = typeof config.accessToken === "string" ? config.accessToken.trim() : "";
  const pageId = typeof config.pageId === "string" ? config.pageId.trim() : "";
  const instagramUserId =
    typeof config.instagramUserId === "string" ? config.instagramUserId.trim() : "";
  const platform = typeof config.platform === "string" ? config.platform.trim() : "";

  let token = rawToken;
  if (rawToken && isEncryptedSecret(rawToken)) {
    try {
      token = decryptSecret(rawToken);
    } catch (err) {
      log.error(
        { err: err instanceof Error ? err.message : err },
        "[meta-messaging/client] falha ao decriptar accessToken",
      );
      token = "";
    }
  }

  // IG Direct: platform === "instagram" e existe instagramUserId (nao pageId)
  if (platform === "instagram" && instagramUserId && !pageId) {
    return new MetaMessagingClient(token, instagramUserId, "instagram");
  }
  // Fallback / Messenger / IG-via-FB legacy
  return new MetaMessagingClient(token, pageId || instagramUserId, "messenger");
}
