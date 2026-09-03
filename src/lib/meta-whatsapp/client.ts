import { decryptSecret, isEncryptedSecret } from "@/lib/crypto/secrets";
import { isVerboseLogging } from "@/lib/debug-log";
import { CRM_META_APP_ID, CRM_META_APP_SECRET } from "@/lib/meta-constants";
import { isMetaFlowEnrichError } from "@/lib/meta-whatsapp/meta-flow-enrich-error";
import {
  isMetaTransientServiceCode,
  metaErrorReason,
} from "@/lib/meta-whatsapp/error-catalog";
import { metrics, templatizeRoute } from "@/lib/metrics";
import { whatsappUploadAudioMime } from "@/lib/audio-convert";

/**
 * Emite métricas Prometheus de uma chamada à Graph API (contador + latência).
 * `endpoint` é templatizado (ids viram :id) pra controlar cardinalidade.
 * Resiliente: nunca lança. Alimenta o gráfico "Meta /min" do /admin/monitoring.
 */
function recordMetaCall(path: string, status: string, t0: number): void {
  try {
    const endpoint = templatizeRoute(path.startsWith("/") ? path : `/${path}`);
    metrics.meta.calls.inc({ endpoint, status, organization: "all" });
    metrics.meta.duration.observe({ endpoint, status }, Math.max(0, Date.now() - t0) / 1000);
  } catch {
    // métrica nunca derruba o envio
  }
}

const GRAPH_VERSION = "v21.0";

/**
 * Timeout das chamadas à Graph/Cloud API da Meta.
 *
 * Por que existe: sem timeout, um envio (ex.: POST de template) podia ficar
 * pendurado esperando a Meta e estourar o tempo limite do proxy reverso
 * (EasyPanel/Traefik) — que então devolve um 502 com HTML, sem JSON tratável.
 * Falhando aqui antes (com Error claro), o handler responde JSON 502/500 e o
 * erro é persistido em `Message.sendError` de forma legível.
 *
 * 20s fica bem abaixo do timeout típico de gateway (30–60s) e folgado para a
 * latência normal da Meta (< 2s na maioria dos envios).
 */
const GRAPH_TIMEOUT_MS = 20_000;

/** Retries curtos no Graph para code 2 / 5xx transitórios (antes de falhar a bolha). */
const GRAPH_TRANSIENT_BACKOFF_MS = 1_000;

/**
 * Tentativas do retry interno do graphFetch. Default 3 (histórico);
 * META_GRAPH_MAX_ATTEMPTS ajusta sem rebuild — o circuit breaker por
 * phoneNumberId (meta-circuit-breaker.ts) é a proteção fleet-wide que
 * permite baixar isto sem perder resiliência por mensagem.
 */
function graphTransientMaxAttempts(): number {
  const raw = Number(process.env.META_GRAPH_MAX_ATTEMPTS ?? "");
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 3;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Estrutura oficial de erro do Graph/Cloud API (v16+), documentada em
 * https://developers.facebook.com/docs/graph-api/guides/error-handling/
 * e https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes
 *
 * A recomendação oficial da Meta é:
 * - Construir lógica de error-handling em cima de `code` (numérico).
 * - Usar `error_data.details` pra contexto acionável (texto human-readable
 *   com o motivo real, ex.: "Message failed to send because more than 24 hours
 *   have passed since the customer last replied to this number").
 * - Sempre logar `fbtrace_id` — é a chave que Meta Support usa pra investigar.
 * - `error_subcode` está deprecated em v16+, não confiar.
 * - `error_user_title`/`error_user_msg` aparecem em alguns erros do Graph
 *   com texto já pronto pra mostrar ao usuário final.
 */
export type MetaGraphErrorPayload = {
  message?: string;
  type?: string;
  code?: number;
  error_subcode?: number;
  error_user_title?: string;
  error_user_msg?: string;
  fbtrace_id?: string;
  error_data?: {
    messaging_product?: string;
    details?: string;
  };
};

type GraphErrorEnvelope = { error?: MetaGraphErrorPayload };

/**
 * Resposta de `pricing_analytics` (WABA fields). Cada `data_points[i]`
 * representa um bucket por (pricing_type, pricing_category, country,
 * phone, tier, start, end). `cost` vem em USD (Meta documenta como
 * "currency = USD" no recurso WABA).
 */
export type MetaPricingAnalyticsDataPoint = {
  /// Unix segundos UTC do inicio do bucket (DAILY = 00:00).
  start: number;
  /// Unix segundos UTC do fim do bucket.
  end: number;
  /// REGULAR | FREE_CUSTOMER_SERVICE | FREE_ENTRY_POINT
  pricing_type?: string;
  /// MARKETING | UTILITY | AUTHENTICATION | SERVICE | AUTHENTICATION_INTERNATIONAL
  pricing_category?: string;
  /// ISO-2 ou null
  country?: string | null;
  /// Telefone E.164 (com '+'), ex: "+5551..."
  phone?: string | null;
  /// "TIER_*" ou null
  tier?: string | null;
  /// Quantidade de mensagens cobradas neste bucket.
  volume: number;
  /// Custo em USD (numero decimal).
  cost: number;
};

export type MetaPricingAnalyticsResponse = {
  pricing_analytics?: {
    data_points?: MetaPricingAnalyticsDataPoint[];
  };
  id?: string;
};

/** SDP session (RFC 8866) — WhatsApp Cloud API Calling. */
export type WhatsAppCallSession = {
  sdp_type: "offer" | "answer" | string;
  sdp: string;
};

/** Resposta de `GET /{phone-number-id}?fields=...` — estado de saúde do número WABA. */
export type MetaPhoneNumberHealth = {
  id?: string;
  display_phone_number?: string;
  verified_name?: string;
  /** APPROVED | PENDING_REVIEW | DECLINED | EXPIRED | NONE */
  name_status?: string;
  /** VERIFIED | EXPIRED | NOT_VERIFIED */
  code_verification_status?: string;
  /** GREEN | YELLOW | RED | UNKNOWN */
  quality_rating?: string;
  /** CONNECTED | FLAGGED | RESTRICTED | PENDING | DISCONNECTED (nem sempre presente) */
  status?: string;
  platform_type?: string;
  /** TIER_50 | TIER_250 | TIER_1K | TIER_10K | TIER_100K | TIER_UNLIMITED */
  messaging_limit_tier?: string;
  /** LIVE | SANDBOX — "SANDBOX" pode significar número de teste. */
  account_mode?: string;
  throughput?: { level?: string };
};

/**
 * Erro estruturado ao chamar a Graph/Cloud API. Preserva todos os campos
 * documentados pela Meta (ver `MetaGraphErrorPayload`) pra que camadas
 * acima (persistência em `Message.sendError`, logs, UI) decidam o que
 * expor sem precisar re-parsear strings.
 */
export class MetaGraphError extends Error {
  readonly name = "MetaGraphError";
  readonly httpStatus: number;
  readonly code: number | null;
  readonly subcode: number | null;
  readonly type: string | null;
  readonly fbtraceId: string | null;
  readonly details: string | null;
  readonly userTitle: string | null;
  readonly userMsg: string | null;
  readonly rawPayload: MetaGraphErrorPayload | null;

  constructor(init: {
    httpStatus: number;
    path: string;
    payload: MetaGraphErrorPayload | null;
  }) {
    const p = init.payload ?? {};
    const code = typeof p.code === "number" ? p.code : null;
    const subcode =
      typeof p.error_subcode === "number" ? p.error_subcode : null;
    const details = p.error_data?.details?.trim() || null;
    const userMsg = p.error_user_msg?.trim() || null;
    const baseMsg =
      details ||
      userMsg ||
      p.message?.trim() ||
      `Meta Graph HTTP ${init.httpStatus}`;

    const parts = [baseMsg];
    if (code != null) parts.push(`(code ${code}${subcode != null ? `/${subcode}` : ""})`);

    super(parts.join(" "));
    this.httpStatus = init.httpStatus;
    this.code = code;
    this.subcode = subcode;
    this.type = p.type?.trim() || null;
    this.fbtraceId = p.fbtrace_id?.trim() || null;
    this.details = details;
    this.userTitle = p.error_user_title?.trim() || null;
    this.userMsg = userMsg;
    this.rawPayload = init.payload;
  }

  /**
   * Representação canônica pra persistir em `Message.sendError`.
   * Formato: `${detailsOrMsg} (code CODE[/SUBCODE], fbtrace=XYZ)`.
   * O prefixo descritivo vai primeiro pra que a UI (que trunca) mostre
   * a parte acionável antes dos metadados técnicos.
   */
  toPersistedString(): string {
    const rawHuman =
      this.details ||
      this.userMsg ||
      this.message.replace(/\s*\(code [^)]+\)\s*$/i, "");
    // Prefixa o motivo PT-BR catalogado (quando o code e conhecido) para
    // que o operador entenda a causa sem consultar a doc da Meta.
    const ptReason = metaErrorReason(this.code);
    const human = ptReason ? `${ptReason} (Meta: ${rawHuman})` : rawHuman;
    const meta: string[] = [];
    if (this.code != null) {
      meta.push(`code ${this.code}${this.subcode != null ? `/${this.subcode}` : ""}`);
    }
    if (this.fbtraceId) meta.push(`fbtrace=${this.fbtraceId}`);
    return meta.length > 0 ? `${human} (${meta.join(", ")})` : human;
  }
}

export function isMetaGraphError(err: unknown): err is MetaGraphError {
  return err instanceof MetaGraphError;
}

/** CTA do Flow: máx. 20 caracteres, sem emoji (exigência da Cloud API). */
export function sanitizeFlowCta(raw: string): string {
  const stripped = raw
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  return (stripped || "Continuar").slice(0, 20);
}

/**
 * Timeout da chamada à Graph (AbortSignal.timeout em graphFetchOnce). Tipo
 * dedicado para o circuit breaker por phoneNumberId contar como falha de
 * infra sem depender de string matching. A mensagem é idêntica à versão
 * anterior (Error simples) — nada muda em Message.sendError.
 */
export class MetaGraphTimeoutError extends Error {
  readonly name = "MetaGraphTimeoutError";
}

/**
 * Falha de transporte na chamada à Graph (DNS, conexão recusada/resetada —
 * o `fetch` rejeita antes de haver resposta HTTP). Mesmo papel do
 * MetaGraphTimeoutError para o circuit breaker; mensagem preservada.
 */
export class MetaGraphNetworkError extends Error {
  readonly name = "MetaGraphNetworkError";
}

/**
 * Formata qualquer erro para persistir em `Message.sendError` /
 * `CampaignRecipient.errorMessage`. Se for `MetaGraphError`, preserva
 * `code` + `fbtrace_id` + `details` conforme recomendação oficial.
 * Caso contrário, devolve `err.message` (ou a string crua).
 */
export function formatMetaSendError(err: unknown): string {
  if (isMetaGraphError(err)) return err.toPersistedString();
  if (isMetaFlowEnrichError(err)) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

export class MetaWhatsAppClient {
  constructor(
    private readonly accessToken: string,
    private readonly phoneNumberId: string,
    private readonly businessAccountId: string
  ) {}

  get configured(): boolean {
    return Boolean(this.accessToken?.trim() && this.phoneNumberId?.trim());
  }

  /** Token + número + WABA — necessário para API de templates na conta comercial. */
  get templatesConfigured(): boolean {
    return this.configured && Boolean(this.businessAccountId?.trim());
  }

  /** WABA ID usado nas rotas de message_templates (comparar origem/destino no clone). */
  get wabaId(): string {
    return this.businessAccountId?.trim() ?? "";
  }

  static buildGraphUrl(path: string): string {
    const p = path.startsWith("/") ? path.slice(1) : path;
    return `https://graph.facebook.com/${GRAPH_VERSION}/${p}`;
  }

  /** Destino Cloud API: `to` (telefone em dígitos) e/ou `recipient` (BSUID). Se ambos, a Meta prioriza o telefone. */
  private static recipientFields(to?: string, recipient?: string): { to?: string; recipient?: string } {
    const digits = (to ?? "").replace(/\D/g, "");
    const out: { to?: string; recipient?: string } = {};
    if (digits.length >= 8) out.to = digits;
    const r = recipient?.trim();
    if (r) out.recipient = r;
    if (!out.to && !out.recipient) {
      throw new Error("Meta WhatsApp: defina telefone (to) ou BSUID (recipient).");
    }
    return out;
  }

  private async graphFetch<T>(
    path: string,
    init: RequestInit & { maxAttempts?: number } = {},
  ): Promise<T> {
    const { maxAttempts = graphTransientMaxAttempts(), ...fetchInit } = init;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await this.graphFetchOnce<T>(path, fetchInit);
      } catch (err) {
        lastErr = err;
        const transient =
          isMetaGraphError(err) &&
          (isMetaTransientServiceCode(err.code) ||
            err.httpStatus === 502 ||
            err.httpStatus === 503);
        if (!transient || attempt >= maxAttempts) {
          throw err;
        }
        // Jitter 50–100% do backoff linear: sem ele, dezenas de runners
        // re-tentam em lockstep e a recuperação da Meta vira rajada
        // sincronizada (thundering herd).
        const base = GRAPH_TRANSIENT_BACKOFF_MS * attempt;
        const delay = Math.floor(base * (0.5 + Math.random() * 0.5));
        console.warn(
          `[MetaWA] transient code=${isMetaGraphError(err) ? err.code : "?"} http=${isMetaGraphError(err) ? err.httpStatus : "?"} — retry ${attempt}/${maxAttempts - 1} em ${delay}ms (${path})`,
        );
        await sleep(delay);
      }
    }
    throw lastErr;
  }

  private async graphFetchOnce<T>(path: string, init: RequestInit = {}): Promise<T> {
    const url = MetaWhatsAppClient.buildGraphUrl(path);
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${this.accessToken}`);
    if (!headers.has("Content-Type") && init.body && typeof init.body === "string") {
      headers.set("Content-Type", "application/json");
    }

    const t0 = Date.now();
    let res: Response;
    try {
      res = await fetch(url, {
        ...init,
        headers,
        cache: "no-store",
        signal: init.signal ?? AbortSignal.timeout(GRAPH_TIMEOUT_MS),
      });
    } catch (err) {
      recordMetaCall(path, "error", t0);
      // AbortSignal.timeout dispara TimeoutError; AbortController, AbortError.
      if (
        err instanceof Error &&
        (err.name === "TimeoutError" || err.name === "AbortError")
      ) {
        console.error(`[MetaWA] timeout ${GRAPH_TIMEOUT_MS}ms em ${path}`);
        throw new MetaGraphTimeoutError(
          `Tempo limite ao comunicar com a Meta (${GRAPH_TIMEOUT_MS}ms) em ${path}. Tente novamente.`,
        );
      }
      // Demais rejeições do fetch são de transporte (DNS/ECONNRESET/...) —
      // empacota em tipo próprio p/ o circuit breaker contar como infra.
      throw new MetaGraphNetworkError(
        err instanceof Error ? err.message : String(err),
      );
    }
    recordMetaCall(path, String(res.status), t0);
    const text = await res.text();
    let data: unknown;
    try { data = JSON.parse(text); } catch { data = text; }

    if (!res.ok) {
      const payload =
        data && typeof data === "object"
          ? ((data as GraphErrorEnvelope).error ?? null)
          : null;
      const err = new MetaGraphError({
        httpStatus: res.status,
        path,
        payload,
      });
      // Log estruturado — seguindo recomendação oficial:
      // sempre incluir fbtrace_id + code pra correlação com Meta Support.
      console.error(
        `[MetaWA] ${res.status} ${path} code=${err.code ?? "?"} subcode=${err.subcode ?? "?"} fbtrace=${err.fbtraceId ?? "?"} type=${err.type ?? "?"}: ${err.details ?? err.message}`,
      );
      throw err;
    }

    // [meta-graph] loga o corpo INTEIRO de cada chamada Graph. Para
    // `message_templates?limit=500` isso é um JSON.stringify de centenas de
    // templates com todos os componentes — caro em CPU e ruidoso em prod.
    // Gate por verbosidade (ver lib/debug-log). Erros continuam sempre logados.
    if (isVerboseLogging()) {
      console.log(
        "[meta-graph]",
        JSON.stringify({ path, httpStatus: res.status, body: data }),
      );
    }
    return data as T;
  }

  // ── Business profile ──────────────────────────

  async getBusinessProfile(): Promise<unknown> {
    return this.graphFetch(`${this.phoneNumberId}/whatsapp_business_profile`);
  }

  // ── Send text ─────────────────────────────────

  /**
   * @param to Telefone em dígitos (pode ser vazio se houver `recipient`).
   * @param recipient BSUID (ex. US.xxx). Envio só por BSUID depende da versão da API Meta (ver changelog).
   */
  /**
   * @param contextMessageId wamid da mensagem citada (resposta no fio do WhatsApp).
   */
  async sendText(
    to: string | undefined,
    text: string,
    recipient?: string,
    contextMessageId?: string | null
  ): Promise<{ messages: Array<{ id: string }> }> {
    const dest = MetaWhatsAppClient.recipientFields(to, recipient);
    const payload: Record<string, unknown> = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      ...dest,
      type: "text",
      text: { preview_url: true, body: text },
    };
    if (contextMessageId?.trim()) {
      payload.context = { message_id: contextMessageId.trim() };
    }
    return this.graphFetch(`${this.phoneNumberId}/messages`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  // ── Send image ────────────────────────────────

  async sendImage(
    to: string | undefined,
    imageUrl: string,
    caption?: string,
    recipient?: string
  ): Promise<{ messages: Array<{ id: string }> }> {
    const dest = MetaWhatsAppClient.recipientFields(to, recipient);
    return this.graphFetch(`${this.phoneNumberId}/messages`, {
      method: "POST",
      body: JSON.stringify({
        messaging_product: "whatsapp",
        ...dest,
        type: "image",
        image: { link: imageUrl, ...(caption ? { caption } : {}) },
      }),
    });
  }

  // ── Send document ─────────────────────────────

  async sendDocument(
    to: string | undefined,
    docUrl: string,
    filename: string,
    caption?: string,
    recipient?: string
  ): Promise<{ messages: Array<{ id: string }> }> {
    const dest = MetaWhatsAppClient.recipientFields(to, recipient);
    return this.graphFetch(`${this.phoneNumberId}/messages`, {
      method: "POST",
      body: JSON.stringify({
        messaging_product: "whatsapp",
        ...dest,
        type: "document",
        document: { link: docUrl, filename, ...(caption ? { caption } : {}) },
      }),
    });
  }

  // ── Send video ────────────────────────────────

  async sendVideo(
    to: string | undefined,
    videoUrl: string,
    caption?: string,
    recipient?: string
  ): Promise<{ messages: Array<{ id: string }> }> {
    const dest = MetaWhatsAppClient.recipientFields(to, recipient);
    return this.graphFetch(`${this.phoneNumberId}/messages`, {
      method: "POST",
      body: JSON.stringify({
        messaging_product: "whatsapp",
        ...dest,
        type: "video",
        video: { link: videoUrl, ...(caption ? { caption } : {}) },
      }),
    });
  }

  // ── Send audio ────────────────────────────────

  async sendAudio(
    to: string | undefined,
    audioUrl: string,
    recipient?: string,
    voice = false,
  ): Promise<{ messages: Array<{ id: string }> }> {
    const dest = MetaWhatsAppClient.recipientFields(to, recipient);
    return this.graphFetch(`${this.phoneNumberId}/messages`, {
      method: "POST",
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        ...dest,
        type: "audio",
        audio: { link: audioUrl, ...(voice ? { voice: true } : {}) },
      }),
    });
  }

  // ── Send interactive list ─────────────────────
  //
  // Interactive List Message da Cloud API: até 10 opções em 1 ou mais sections.
  // A mensagem aparece com um botão único (`action.button`, ex.: "Ver opções")
  // que, ao ser tocado, abre uma lista rolável. É o caminho oficial da Meta
  // para menus com >3 opções — `type=button` está limitado a 3 reply buttons.
  //
  // Limites Meta:
  //   body.text       ≤ 4096 chars, obrigatório
  //   action.button   ≤ 20 chars, obrigatório (rótulo do botão que abre a lista)
  //   sections        1-10, cada section com title opcional ≤ 24
  //   rows            total 1-10 across sections; id ≤ 200, title ≤ 24, description ≤ 72
  //   header.text     ≤ 60 chars, opcional
  //   footer.text     ≤ 60 chars, opcional
  //
  // Ao clicar, o webhook recebe `interactive.list_reply.{id,title,description}` —
  // já processado hoje em `lib/meta-webhook/handler.ts`.
  async sendInteractiveList(
    to: string | undefined,
    body: string,
    button: string,
    sections: {
      title?: string | null;
      rows: { id: string; title: string; description?: string | null }[];
    }[],
    header?: string,
    footer?: string,
    recipient?: string
  ): Promise<{ messages: Array<{ id: string }> }> {
    const dest = MetaWhatsAppClient.recipientFields(to, recipient);
    const interactive: Record<string, unknown> = {
      type: "list",
      body: { text: body },
      action: {
        button: button.slice(0, 20),
        sections: sections.slice(0, 10).map((s) => ({
          ...(s.title?.trim() ? { title: s.title.trim().slice(0, 24) } : {}),
          rows: s.rows.slice(0, 10).map((r) => ({
            id: r.id.slice(0, 200),
            title: r.title.slice(0, 24),
            ...(r.description?.trim()
              ? { description: r.description.trim().slice(0, 72) }
              : {}),
          })),
        })),
      },
    };
    if (header) interactive.header = { type: "text", text: header };
    if (footer) interactive.footer = { text: footer };

    return this.graphFetch(`${this.phoneNumberId}/messages`, {
      method: "POST",
      body: JSON.stringify({
        messaging_product: "whatsapp",
        ...dest,
        type: "interactive",
        interactive,
      }),
    });
  }

  // ── Send interactive buttons ──────────────────

  async sendInteractiveButtons(
    to: string | undefined,
    body: string,
    buttons: { id: string; title: string }[],
    header?: string,
    footer?: string,
    recipient?: string
  ): Promise<{ messages: Array<{ id: string }> }> {
    const dest = MetaWhatsAppClient.recipientFields(to, recipient);
    const interactive: Record<string, unknown> = {
      type: "button",
      body: { text: body },
      action: {
        buttons: buttons.slice(0, 3).map((b) => ({
          type: "reply",
          reply: { id: b.id, title: b.title.slice(0, 20) },
        })),
      },
    };
    if (header) interactive.header = { type: "text", text: header };
    if (footer) interactive.footer = { text: footer };

    return this.graphFetch(`${this.phoneNumberId}/messages`, {
      method: "POST",
      body: JSON.stringify({
        messaging_product: "whatsapp",
        ...dest,
        type: "interactive",
        interactive,
      }),
    });
  }

  /**
   * Envia WhatsApp Flow como mensagem de sessão (janela 24h).
   * Fora da janela a Graph recusa — aí o caminho é template com botão FLOW.
   */
  async sendInteractiveFlow(
    to: string | undefined,
    body: string,
    params: {
      flowId: string;
      flowCta: string;
      flowToken: string;
      flowAction?: "navigate" | "data_exchange";
    },
    header?: string,
    footer?: string,
    recipient?: string,
  ): Promise<{ messages: Array<{ id: string }> }> {
    const dest = MetaWhatsAppClient.recipientFields(to, recipient);
    const cta = sanitizeFlowCta(params.flowCta);
    const interactive: Record<string, unknown> = {
      type: "flow",
      body: { text: body },
      action: {
        name: "flow",
        parameters: {
          flow_message_version: "3",
          flow_token: params.flowToken,
          flow_id: params.flowId.trim(),
          flow_cta: cta,
          flow_action: params.flowAction ?? "navigate",
        },
      },
    };
    if (header) interactive.header = { type: "text", text: header };
    if (footer) interactive.footer = { type: "text", text: footer };

    return this.graphFetch(`${this.phoneNumberId}/messages`, {
      method: "POST",
      body: JSON.stringify({
        messaging_product: "whatsapp",
        ...dest,
        type: "interactive",
        interactive,
      }),
    });
  }

  // ── Upload media ──────────────────────────────

  async uploadMedia(buffer: Buffer, mimeType: string, filename: string): Promise<string> {
    const uploadType = whatsappUploadAudioMime(mimeType, filename);
    const form = new FormData();
    form.append("messaging_product", "whatsapp");
    form.append(
      "file",
      new Blob([new Uint8Array(buffer)], { type: uploadType }),
      filename
    );
    form.append("type", uploadType);

    const url = MetaWhatsAppClient.buildGraphUrl(`${this.phoneNumberId}/media`);
    const res = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.accessToken}` },
      body: form,
      cache: "no-store",
    });

    const text = await res.text();
    let data: unknown;
    try { data = JSON.parse(text); } catch { data = text; }

    const parsed = (data && typeof data === "object" ? data : {}) as {
      id?: string;
      error?: MetaGraphErrorPayload;
    };

    if (!res.ok || !parsed.id) {
      const payload = parsed.error ?? null;
      const err = new MetaGraphError({
        httpStatus: res.status,
        path: `${this.phoneNumberId}/media`,
        payload,
      });
      console.error(
        `[MetaWA] upload ${res.status} code=${err.code ?? "?"} fbtrace=${err.fbtraceId ?? "?"}: ${err.details ?? err.message}`,
      );
      throw err;
    }
    return parsed.id;
  }

  // ── Resumable Upload API (header_handle p/ criação de template) ─
  // @see https://developers.facebook.com/docs/graph-api/guides/upload
  //
  // A Meta NÃO aceita `link`/`id` de mídia comum como exemplo de header
  // ao CRIAR um template — exige um `header_handle` obtido via Resumable
  // Upload API (fluxo em 2 passos: cria sessão no App, depois envia os
  // bytes). O handle (`h`) resultante vai em `example.header_handle`.

  /**
   * Token para `POST /{APP_ID}/uploads` (header_handle na criação de template).
   *
   * O token do canal (System User / embedded signup) costuma gerenciar a WABA
   * mas NÃO ter o App como asset — a Meta responde 100/33 em
   * `Object with ID '<app-id>'` (fácil confundir com Phone Number ID).
   * App Access Token (`appId|appSecret`) é o caminho suportado pra essa borda.
   */
  private resolveResumableUploadToken(): string {
    const appId = CRM_META_APP_ID?.trim();
    const secret = CRM_META_APP_SECRET?.trim();
    if (appId && secret) return `${appId}|${secret}`;
    return this.accessToken;
  }

  /**
   * Sobe um arquivo via Resumable Upload API e devolve o `header_handle`
   * (campo `h`) exigido por `example.header_handle` no HEADER de mídia
   * ao criar um template.
   */
  async uploadResumableHandle(
    buffer: Buffer,
    mimeType: string,
    fileName: string,
  ): Promise<string> {
    const appId = CRM_META_APP_ID?.trim();
    if (!appId) {
      throw new Error(
        "Meta: App ID não configurado (CRM_META_APP_ID / NEXT_PUBLIC_META_APP_ID) — necessário para mídia de exemplo do cabeçalho IMAGE/VIDEO/DOCUMENT.",
      );
    }
    if (!CRM_META_APP_SECRET?.trim()) {
      throw new Error(
        "Meta: META_APP_SECRET não configurado — necessário para subir a mídia de exemplo do cabeçalho (Resumable Upload usa App Access Token).",
      );
    }

    const uploadToken = this.resolveResumableUploadToken();

    // Passo 1 — cria a sessão de upload (JSON body; query-string quebra com
    // espaços no file_name e alguns tokens rejeitam o formato antigo).
    const sessionUrl = MetaWhatsAppClient.buildGraphUrl(`${appId}/uploads`);
    let sessionRes: Response;
    try {
      sessionRes = await fetch(sessionUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${uploadToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          file_name: fileName,
          file_length: buffer.length,
          file_type: mimeType,
        }),
        cache: "no-store",
        signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS),
      });
    } catch (err) {
      throw new Error(
        `Falha ao iniciar upload da mídia de exemplo do cabeçalho: ${err instanceof Error ? err.message : err}`,
      );
    }
    const sessionText = await sessionRes.text();
    let sessionData: unknown;
    try { sessionData = JSON.parse(sessionText); } catch { sessionData = sessionText; }

    if (!sessionRes.ok) {
      const payload =
        sessionData && typeof sessionData === "object"
          ? ((sessionData as GraphErrorEnvelope).error ?? null)
          : null;
      const err = new MetaGraphError({
        httpStatus: sessionRes.status,
        path: `${appId}/uploads`,
        payload,
      });
      console.error(
        `[MetaWA] resumable-upload sessão ${sessionRes.status} code=${err.code ?? "?"} fbtrace=${err.fbtraceId ?? "?"}: ${err.details ?? err.message}`,
      );
      if (err.code === 100 && err.subcode === 33) {
        throw new Error(
          `Falha ao subir mídia de exemplo do cabeçalho IMAGE (App ID ${appId}): token sem permissão no App Meta do CRM (code 100/33). Confira META_APP_SECRET e NEXT_PUBLIC_META_APP_ID — não é o Phone Number ID do canal. Detalhe Meta: ${err.message}`,
        );
      }
      throw err;
    }
    const sessionId = (sessionData as { id?: string } | undefined)?.id?.trim();
    if (!sessionId) {
      throw new Error(
        "Meta: resposta inesperada ao criar sessão de upload da mídia de exemplo (sem id de sessão).",
      );
    }

    // Passo 2 — envia os bytes do arquivo.
    const uploadUrl = MetaWhatsAppClient.buildGraphUrl(sessionId);
    let uploadRes: Response;
    try {
      uploadRes = await fetch(uploadUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${uploadToken}`,
          file_offset: "0",
          "Content-Type": "application/octet-stream",
        },
        body: new Uint8Array(buffer),
        cache: "no-store",
        signal: AbortSignal.timeout(GRAPH_TIMEOUT_MS),
      });
    } catch (err) {
      throw new Error(
        `Falha ao enviar os bytes da mídia de exemplo do cabeçalho: ${err instanceof Error ? err.message : err}`,
      );
    }
    const uploadText = await uploadRes.text();
    let uploadData: unknown;
    try { uploadData = JSON.parse(uploadText); } catch { uploadData = uploadText; }

    if (!uploadRes.ok) {
      const payload =
        uploadData && typeof uploadData === "object"
          ? ((uploadData as GraphErrorEnvelope).error ?? null)
          : null;
      const err = new MetaGraphError({
        httpStatus: uploadRes.status,
        path: sessionId,
        payload,
      });
      console.error(
        `[MetaWA] resumable-upload bytes ${uploadRes.status} code=${err.code ?? "?"} fbtrace=${err.fbtraceId ?? "?"}: ${err.details ?? err.message}`,
      );
      throw err;
    }
    const handle = (uploadData as { h?: string } | undefined)?.h?.trim();
    if (!handle) {
      throw new Error(
        "Meta: resposta inesperada ao enviar a mídia de exemplo do cabeçalho (sem handle 'h').",
      );
    }
    return handle;
  }

  // ── Send media by ID ──────────────────────────

  async sendMediaById(
    to: string | undefined,
    mediaId: string,
    type: "image" | "audio" | "video" | "document",
    caption?: string,
    filename?: string,
    voice?: boolean,
    recipient?: string,
  ): Promise<{ messages: Array<{ id: string }> }> {
    const mediaPayload: Record<string, string | boolean> = { id: mediaId };
    if (caption) mediaPayload.caption = caption;
    // Meta Cloud API: `filename` só é válido em `document`. Em image/video/audio
    // devolve (#100) Unexpected key "filename" on param "<type>".
    if (type === "document" && filename) mediaPayload.filename = filename;
    if (type === "audio" && voice) mediaPayload.voice = true;

    const dest = MetaWhatsAppClient.recipientFields(to, recipient);

    return this.graphFetch(`${this.phoneNumberId}/messages`, {
      method: "POST",
      body: JSON.stringify({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        ...dest,
        type,
        [type]: mediaPayload,
      }),
    });
  }

  // ── Typing indicator + mark as read ────────────

  async sendTypingIndicator(messageId: string): Promise<void> {
    try {
      await this.graphFetch(`${this.phoneNumberId}/messages`, {
        method: "POST",
        body: JSON.stringify({
          messaging_product: "whatsapp",
          status: "read",
          message_id: messageId,
          typing_indicator: { type: "text" },
        }),
      });
    } catch (err) {
      console.warn("[MetaWA] typing indicator failed:", err instanceof Error ? err.message : err);
    }
  }

  // ── Send template ─────────────────────────────

  async sendTemplate(
    to: string | undefined,
    templateName: string,
    languageCode: string = "pt_BR",
    components?: unknown[],
    recipient?: string,
    options?: { maxAttempts?: number; timeoutMs?: number },
  ): Promise<{ messages: Array<{ id: string }> }> {
    const dest = MetaWhatsAppClient.recipientFields(to, recipient);
    const payload = {
      messaging_product: "whatsapp",
      ...dest,
      type: "template",
      template: {
        name: templateName,
        language: { code: languageCode },
        // Array vazio (template sem parâmetro válido) sai do payload: mandar
        // `components: []` é ruído e confunde o diagnóstico de 132000.
        ...(Array.isArray(components) && components.length > 0 ? { components } : {}),
      },
    };
    // Caminho quente de blast: 1 JSON.stringify + write no stdout por
    // mensagem. Mesmo gate do `[meta-graph]` acima (ver lib/debug-log).
    if (isVerboseLogging()) {
      console.log("[meta-send-template]", JSON.stringify(payload));
    }
    return this.graphFetch(`${this.phoneNumberId}/messages`, {
      method: "POST",
      body: JSON.stringify(payload),
      ...(options?.maxAttempts != null ? { maxAttempts: options.maxAttempts } : {}),
      ...(options?.timeoutMs != null
        ? { signal: AbortSignal.timeout(options.timeoutMs) }
        : {}),
    });
  }

  // ── Mark as read ──────────────────────────────

  async markAsRead(messageId: string): Promise<void> {
    await this.graphFetch(`${this.phoneNumberId}/messages`, {
      method: "POST",
      body: JSON.stringify({
        messaging_product: "whatsapp",
        status: "read",
        message_id: messageId,
      }),
    });
  }

  // ── Calling API (Cloud API) ───────────────────
  // @see https://developers.facebook.com/docs/whatsapp/cloud-api/calling

  /**
   * Calling: uma tentativa só. O graphFetch default (3×20s) estoura o
   * timeout do Traefik/EasyPanel e o operador vê HTML 502 no inbox.
   */
  private async postCall(body: Record<string, unknown>): Promise<unknown> {
    return this.graphFetch(`${this.phoneNumberId}/calls`, {
      method: "POST",
      maxAttempts: 1,
      body: JSON.stringify({
        messaging_product: "whatsapp",
        ...body,
      }),
    });
  }

  /**
   * Ligação iniciada pelo negócio: envia SDP offer; resposta inclui `calls[].id`.
   */
  async initiateVoiceCall(
    toDigits: string,
    session: WhatsAppCallSession,
    bizOpaqueCallbackData?: string
  ): Promise<{ calls?: Array<{ id: string }> }> {
    const to = toDigits.replace(/\D/g, "");
    if (to.length < 8) throw new Error("Meta WhatsApp: telefone inválido para chamada.");
    const payload: Record<string, unknown> = {
      to,
      action: "connect",
      session,
    };
    if (bizOpaqueCallbackData) {
      payload.biz_opaque_callback_data = bizOpaqueCallbackData.slice(0, 512);
    }
    return this.postCall(payload) as Promise<{ calls?: Array<{ id: string }> }>;
  }

  async preAcceptCall(callId: string, session: WhatsAppCallSession): Promise<{ success?: boolean }> {
    return this.postCall({
      call_id: callId,
      action: "pre_accept",
      session,
    }) as Promise<{ success?: boolean }>;
  }

  async acceptCall(
    callId: string,
    session: WhatsAppCallSession,
    bizOpaqueCallbackData?: string
  ): Promise<{ success?: boolean }> {
    const payload: Record<string, unknown> = {
      call_id: callId,
      action: "accept",
      session,
    };
    if (bizOpaqueCallbackData) {
      payload.biz_opaque_callback_data = bizOpaqueCallbackData.slice(0, 512);
    }
    return this.postCall(payload) as Promise<{ success?: boolean }>;
  }

  async rejectCall(callId: string): Promise<{ success?: boolean }> {
    return this.postCall({
      call_id: callId,
      action: "reject",
    }) as Promise<{ success?: boolean }>;
  }

  async terminateCall(callId: string): Promise<{ success?: boolean }> {
    return this.postCall({
      call_id: callId,
      action: "terminate",
    }) as Promise<{ success?: boolean }>;
  }

  // ── Send reaction ─────────────────────────────

  async sendReaction(
    to: string | undefined,
    messageId: string,
    emoji: string,
    recipient?: string,
  ): Promise<unknown> {
    const dest = MetaWhatsAppClient.recipientFields(to, recipient);
    return this.graphFetch(`${this.phoneNumberId}/messages`, {
      method: "POST",
      body: JSON.stringify({
        messaging_product: "whatsapp",
        ...dest,
        type: "reaction",
        reaction: { message_id: messageId, emoji },
      }),
    });
  }

  // ── Get media URL ─────────────────────────────

  async getMediaUrl(mediaId: string): Promise<string> {
    const data = await this.graphFetch<{ url: string }>(`${mediaId}`);
    return data.url;
  }

  // ── Download media ────────────────────────────

  async downloadMedia(mediaUrl: string): Promise<Buffer> {
    const res = await fetch(mediaUrl, {
      headers: { Authorization: `Bearer ${this.accessToken}` },
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`Download failed: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  // ── Phone numbers ─────────────────────────────

  async getPhoneNumbers(businessAccountId?: string): Promise<unknown> {
    const waba = businessAccountId ?? this.businessAccountId;
    return this.graphFetch(`${waba}/phone_numbers`);
  }

  /**
   * Retorna o estado de saúde do phone number configurado — usado pelo
   * healthcheck global do CRM pra detectar numero pausado/flagged/qualidade
   * baixa antes que operadores percam envios em silêncio.
   *
   * Campos documentados em
   * https://developers.facebook.com/docs/whatsapp/cloud-api/reference/phone-numbers
   * Nem todos os tenants expõem todos os campos (ex: `throughput` exige
   * opt-in). Tratamos tudo como opcional.
   */
  async getPhoneNumberHealth(): Promise<MetaPhoneNumberHealth> {
    const fields = [
      "id",
      "display_phone_number",
      "verified_name",
      "name_status",
      "code_verification_status",
      "quality_rating",
      "status",
      "platform_type",
      "messaging_limit_tier",
      "throughput",
      "account_mode",
    ].join(",");
    return this.graphFetch<MetaPhoneNumberHealth>(
      `${this.phoneNumberId}?fields=${fields}`,
    );
  }

  /**
   * Lista os apps assinados ao WABA (`GET /{waba}/subscribed_apps`). Usado no
   * health-check pos Embedded Signup para confirmar que o App do CRM esta
   * recebendo webhooks desse WABA. Retorna `{ data: [...] }`.
   */
  async getSubscribedApps(): Promise<{ data?: Array<Record<string, unknown>> }> {
    const waba = this.wabaOrThrow();
    return this.graphFetch<{ data?: Array<Record<string, unknown>> }>(
      `${waba}/subscribed_apps`,
    );
  }

  // ── Message templates (Business Management API) ─────────────────
  // @see https://developers.facebook.com/docs/graph-api/reference/whats-app-business-account/message_templates/

  private wabaOrThrow(): string {
    const waba = this.businessAccountId?.trim();
    if (!waba) {
      throw new Error(
        "Meta: defina META_WHATSAPP_BUSINESS_ACCOUNT_ID (WABA) para gerir templates.",
      );
    }
    return waba;
  }

  /**
   * Detalhe de um template pelo ID Graph retornado em `message_templates`
   * (campo `id` de cada linha). Preferível a listar centenas de templates
   * para descobrir `components` (botão FLOW, índice, etc.).
   */
  async getMessageTemplateByGraphId(graphTemplateId: string): Promise<unknown> {
    const id = graphTemplateId.trim();
    if (!id) throw new Error("Meta: ID do template (Graph) inválido.");
    const params = new URLSearchParams();
    params.set(
      "fields",
      ["name", "language", "status", "category", "components"].join(","),
    );
    return this.graphFetch(`${id}?${params.toString()}`);
  }

  /** Lista templates aprovados/pendentes da conta WhatsApp Business. */
  async listMessageTemplates(options?: {
    limit?: number;
    after?: string;
  }): Promise<unknown> {
    const waba = this.wabaOrThrow();
    const params = new URLSearchParams();
    params.set(
      "fields",
      [
        "name",
        "status",
        "category",
        "sub_category",
        "language",
        "id",
        "parameter_format",
        "components",
        "quality_score",
        "rejected_reason",
        "last_updated_time",
      ].join(","),
    );
    params.set("limit", String(Math.min(options?.limit ?? 100, 500)));
    if (options?.after) params.set("after", options.after);
    return this.graphFetch(`${waba}/message_templates?${params.toString()}`);
  }

  /** Cria template (submete à análise da Meta). `payload` = corpo JSON oficial. */
  async createMessageTemplate(payload: Record<string, unknown>): Promise<unknown> {
    const waba = this.wabaOrThrow();
    return this.graphFetch(`${waba}/message_templates`, {
      method: "POST",
      body: JSON.stringify(payload),
    });
  }

  /**
   * Remove template na coleção da WABA.
   *
   * `DELETE /{template_id}` NÃO existe na Graph — devolve
   * `(#100) Unsupported delete request`, que era a causa do "Erro ao excluir"
   * na tela de templates. A exclusão é sempre em
   * `DELETE /{WABA_ID}/message_templates`, e `name` é obrigatório nos dois
   * modos:
   *  - só `name`: apaga o template em TODOS os idiomas;
   *  - `name` + `hsm_id`: apaga apenas aquela versão/idioma.
   *
   * @param name Nome canônico do template (campo `name` da listagem).
   * @param templateGraphId `id` da listagem, enviado como `hsm_id`. Ausente =
   *   apaga todos os idiomas daquele nome.
   */
  async deleteMessageTemplate(args: {
    name: string;
    templateGraphId?: string | null;
  }): Promise<unknown> {
    const waba = this.wabaOrThrow();
    const name = args.name?.trim() ?? "";
    if (!name) {
      throw new Error(
        "Meta: nome do template é obrigatório para excluir (a Graph exige `name` em message_templates).",
      );
    }
    const params = new URLSearchParams();
    params.set("name", name);
    const hsmId = args.templateGraphId?.trim();
    if (hsmId) params.set("hsm_id", hsmId);
    return this.graphFetch(`${waba}/message_templates?${params.toString()}`, {
      method: "DELETE",
    });
  }

  // ── WhatsApp Flows (Flows API) ─────────────────────────────────
  // @see https://developers.facebook.com/docs/whatsapp/flows/reference/flowsapi/

  /** Lista flows da WABA. */
  async listFlows(): Promise<unknown> {
    const waba = this.wabaOrThrow();
    return this.graphFetch(`${waba}/flows`);
  }

  /**
   * Cria flow (rascunho ou publicado). Corpo típico:
   * `{ name, categories: ["LEAD_GENERATION"], flow_json: "<string>", publish: true }`
   */
  async createFlow(payload: Record<string, unknown>): Promise<unknown> {
    const waba = this.wabaOrThrow();
    return this.graphFetch(`${waba}/flows`, {
      method: "POST",
      body: JSON.stringify(payload),
      // 1 tentativa / 45s: create+publish na Meta é lento. 3×20s estourava o
      // proxy e o frontend só via HTML 502 («Erro ao publicar.»).
      maxAttempts: 1,
      signal: AbortSignal.timeout(45_000),
    });
  }

  /** Detalhe de um flow por ID Graph. */
  async getFlowById(
    flowGraphId: string,
    fields = "id,name,status,categories,validation_errors,json_version,preview",
  ): Promise<unknown> {
    const id = flowGraphId.trim();
    if (!id) throw new Error("Meta: ID do Flow inválido.");
    const params = new URLSearchParams({ fields });
    return this.graphFetch(`${id}?${params.toString()}`);
  }

  /** Lista assets do flow (inclui FLOW_JSON com download_url). */
  async listFlowAssets(flowGraphId: string): Promise<unknown> {
    const id = flowGraphId.trim();
    if (!id) throw new Error("Meta: ID do Flow inválido.");
    return this.graphFetch(`${id}/assets`);
  }

  /** Baixa e parseia o FLOW_JSON publicado na Meta. */
  async downloadFlowJson(flowGraphId: string): Promise<Record<string, unknown>> {
    const raw = (await this.listFlowAssets(flowGraphId)) as {
      data?: Array<{ asset_type?: string; download_url?: string }>;
    };
    const asset = raw.data?.find((a) => a.asset_type === "FLOW_JSON");
    const url = asset?.download_url?.trim();
    if (!url) {
      throw new Error("Meta não devolveu FLOW_JSON para este flow (asset ausente).");
    }

    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${this.accessToken}` },
    });
    if (!res.ok) {
      throw new Error(`Falha ao baixar FLOW_JSON (${res.status}).`);
    }
    const text = await res.text();
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("FLOW_JSON inválido.");
    }
    return parsed as Record<string, unknown>;
  }

  /** Apaga flow em estado DRAFT. */
  async deleteFlow(flowGraphId: string): Promise<unknown> {
    const id = flowGraphId.trim();
    if (!id) throw new Error("Meta: ID do Flow inválido.");
    return this.graphFetch(id, { method: "DELETE" });
  }

  // ── Pricing analytics (oficial Meta — usado em /reports) ───────
  // @see https://developers.facebook.com/docs/whatsapp/business-management-api/analytics
  // Retorna o CUSTO REAL cobrado pela Meta no periodo, quebrado por
  // pricing_type (REGULAR | FREE_CUSTOMER_SERVICE | FREE_ENTRY_POINT)
  // x pricing_category (MARKETING | UTILITY | AUTHENTICATION |
  // SERVICE | AUTHENTICATION_INTERNATIONAL) x dimensao (COUNTRY,
  // PHONE, TIER). Granularity DAILY = 1 ponto por dia.
  //
  // A Meta espera unix timestamps em segundos (UTC) e tem um teto
  // de ~90 dias por chamada. Pra periodos maiores chamamos varias
  // vezes no service de sync.
  async getPricingAnalytics(input: {
    startUnix: number;
    endUnix: number;
    granularity?: "DAILY" | "MONTHLY" | "HALF_HOUR";
  }): Promise<MetaPricingAnalyticsResponse> {
    const waba = this.wabaOrThrow();
    const granularity = input.granularity ?? "DAILY";
    const fields =
      `pricing_analytics` +
      `.start(${input.startUnix})` +
      `.end(${input.endUnix})` +
      `.granularity(${granularity})` +
      `.pricing_types(["REGULAR","FREE_CUSTOMER_SERVICE","FREE_ENTRY_POINT"])` +
      `.pricing_categories(["MARKETING","UTILITY","AUTHENTICATION","SERVICE","AUTHENTICATION_INTERNATIONAL"])` +
      `.dimensions(["COUNTRY","PHONE","TIER"])`;
    const params = new URLSearchParams({ fields });
    return this.graphFetch<MetaPricingAnalyticsResponse>(
      `${waba}?${params.toString()}`,
    );
  }

  // ── Legacy aliases ────────────────────────────

  async sendMessage(
    to: string | undefined,
    text: string,
    recipient?: string,
    contextMessageId?: string | null
  ) {
    return this.sendText(to, text, recipient, contextMessageId);
  }

  async getQRCode(phoneNumberId?: string): Promise<unknown> {
    return this.graphFetch(`${phoneNumberId ?? this.phoneNumberId}/message_qrdls`);
  }

  async getMessageQrDlByCode(phoneNumberId: string, code: string): Promise<unknown> {
    return this.graphFetch(`${phoneNumberId}/message_qrdls/${encodeURIComponent(code)}`);
  }

  async generateQRCode(phoneNumberId: string, prefilledMessage: string): Promise<unknown> {
    return this.graphFetch(`${phoneNumberId}/message_qrdls`, {
      method: "POST",
      body: JSON.stringify({
        prefilled_message: prefilledMessage,
        generate_qr_image: "PNG",
      }),
    });
  }
}

// ── Singleton from env ──────────────────────────

export const metaWhatsApp = new MetaWhatsAppClient(
  process.env.META_WHATSAPP_ACCESS_TOKEN?.trim() ?? "",
  process.env.META_WHATSAPP_PHONE_NUMBER_ID?.trim() ?? "",
  process.env.META_WHATSAPP_BUSINESS_ACCOUNT_ID?.trim() ?? ""
);

/**
 * Build a MetaWhatsAppClient from a channel's stored config (Embedded Signup).
 * Falls back to the env-var singleton if config is missing required fields
 * (quando `allowEnvFallback` é true, default — compatível com código legado).
 *
 * PR-1.2: aceita config tanto encriptado quanto plaintext (back-compat
 * durante migracao). Se detectar valores com prefixo `enc:v1:`, decripta
 * via `decryptSecret` antes de usar. Apos backfill completo, todos os
 * valores chegam encriptados — `decryptSecret` em plaintext e no-op.
 */
const emptyMetaClient = (): MetaWhatsAppClient => new MetaWhatsAppClient("", "", "");

export function metaClientFromConfig(
  config: Record<string, unknown> | null | undefined,
  options?: { allowEnvFallback?: boolean },
): MetaWhatsAppClient {
  const allowEnvFallback = options?.allowEnvFallback !== false;

  if (!config) return allowEnvFallback ? metaWhatsApp : emptyMetaClient();

  const rawToken = typeof config.accessToken === "string" ? config.accessToken.trim() : "";
  const phoneId = typeof config.phoneNumberId === "string" ? config.phoneNumberId.trim() : "";
  const wabaId = typeof config.businessAccountId === "string" ? config.businessAccountId.trim() : "";

  let token = rawToken;
  if (rawToken && isEncryptedSecret(rawToken)) {
    try {
      token = decryptSecret(rawToken);
    } catch (err) {
      console.error(
        "[meta-whatsapp/client] falha ao decriptar accessToken; caindo para singleton:",
        err instanceof Error ? err.message : err,
      );
      return allowEnvFallback ? metaWhatsApp : emptyMetaClient();
    }
  }

  if (!token || !phoneId) return allowEnvFallback ? metaWhatsApp : emptyMetaClient();
  return new MetaWhatsAppClient(token, phoneId, wabaId);
}
