/**
 * Cliente Api4Com — login + resolução de ramal SIP para webphone próprio.
 *
 * Fluxo "tudo dentro do CRM":
 *  1. Usuário informa e-mail + senha da conta Api4Com (UX familiar).
 *  2. Backend autentica na API REST e busca o ramal vinculado ao e-mail.
 *  3. Persiste credenciais SIP (wss://{domain}:6443, ramal, senha) em SipExtension.
 *  4. O front registra via JsSIP (useSoftphone) — áudio no navegador, sem extensão.
 *
 * Ref: https://developers.api4com.com/authentication.html
 *      https://developers.api4com.com/sip-architecture.html
 *      https://developers.api4com.com/integration-own-webphone.html
 */

import { normalizePhone } from "@/lib/phone";
import { getLogger } from "@/lib/logger";

const log = getLogger("telephony-providers.api4com");

const API4COM_BASE = "https://api.api4com.com/api/v1";

const DEFAULT_STUN = ["stun:stun.l.google.com:19302"];

export type Api4ComFieldError = {
  ok: false;
  field: string;
  message: string;
};

export type Api4ComExtension = {
  id: number;
  domain: string;
  ramal: string;
  senha: string;
  email_address?: string;
  first_name?: string;
  last_name?: string;
};

/** Normaliza um registro de ramal da API (campos em PT ou EN). */
function normalizeExtensionRecord(raw: unknown): Api4ComExtension | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;

  const ramal = r.ramal ?? r.extension ?? r.username;
  const senha = r.senha ?? r.password;
  const domain = r.domain;

  if (!ramal || !senha || !domain) return null;

  return {
    id: typeof r.id === "number" ? r.id : Number(r.id ?? 0),
    domain: String(domain).trim(),
    ramal: String(ramal).trim(),
    senha: String(senha),
    email_address:
      typeof r.email_address === "string"
        ? r.email_address
        : typeof r.emailAddress === "string"
          ? r.emailAddress
          : undefined,
    first_name: typeof r.first_name === "string" ? r.first_name : undefined,
    last_name: typeof r.last_name === "string" ? r.last_name : undefined,
  };
}

/** Aceita array direto, `{ data: [] }`, `{ items: [] }` ou objeto único. */
export function parseApi4ComExtensionsList(payload: unknown): Api4ComExtension[] {
  if (Array.isArray(payload)) {
    return payload.map(normalizeExtensionRecord).filter((e): e is Api4ComExtension => e !== null);
  }
  if (payload && typeof payload === "object") {
    const o = payload as Record<string, unknown>;
    if (Array.isArray(o.data)) {
      return o.data.map(normalizeExtensionRecord).filter((e): e is Api4ComExtension => e !== null);
    }
    if (Array.isArray(o.items)) {
      return o.items.map(normalizeExtensionRecord).filter((e): e is Api4ComExtension => e !== null);
    }
    const single = normalizeExtensionRecord(o);
    if (single) return [single];
  }
  return [];
}

type LoginResponse = {
  id: string;
};

async function api4comFetch<T>(
  path: string,
  init: RequestInit & { token?: string } = {},
): Promise<{ ok: true; data: T } | Api4ComFieldError> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(init.headers as Record<string, string>),
  };
  if (init.token) {
    headers.Authorization = init.token;
  }

  const { token: _token, ...fetchInit } = init;

  let res: Response;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      res = await fetch(`${API4COM_BASE}${path}`, {
        method: fetchInit.method ?? "GET",
        body: fetchInit.body,
        headers,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log.error({ path, detail }, "[api4com] fetch failed");
    return {
      ok: false,
      field: path === "/dialer" ? "phone" : "email",
      message:
        process.env.NODE_ENV === "development"
          ? `Falha ao contactar Api4Com: ${detail}`
          : "Não foi possível conectar à Api4Com. Verifique sua rede.",
    };
  }

  if (res.status === 401 || res.status === 403) {
    return {
      ok: false,
      field: "password",
      message: "E-mail ou senha Api4Com inválidos ou token expirado.",
    };
  }

  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    return {
      ok: false,
      field: path === "/dialer" ? "phone" : "email",
      message: `Api4Com retornou erro (${res.status}). ${errBody.slice(0, 180)}`.trim(),
    };
  }

  const data = (await res.json()) as T;
  return { ok: true, data };
}

/** Login REST — retorna token de API (não persistimos; só para buscar o ramal). */
export async function loginApi4Com(
  email: string,
  password: string,
): Promise<{ ok: true; token: string } | Api4ComFieldError> {
  const result = await api4comFetch<LoginResponse>("/users/login", {
    method: "POST",
    body: JSON.stringify({ email: email.trim(), password }),
  });

  if (!result.ok) return result;
  if (!result.data.id) {
    return { ok: false, field: "password", message: "Resposta de login Api4Com inválida." };
  }
  return { ok: true, token: result.data.id };
}

/** Lista ramais da conta autenticada. */
export async function listApi4ComExtensions(
  token: string,
): Promise<{ ok: true; extensions: Api4ComExtension[] } | Api4ComFieldError> {
  const result = await api4comFetch<Api4ComExtension[]>("/extensions", {
    method: "GET",
    token,
  });

  if (!result.ok) return result;
  const list = parseApi4ComExtensionsList(result.data);
  return { ok: true, extensions: list };
}

/**
 * Encontra o ramal cujo email_address corresponde ao usuário logado.
 * Se houver apenas um ramal na conta, usa esse como fallback.
 */
export function pickExtensionForEmail(
  extensions: Api4ComExtension[],
  email: string,
): Api4ComExtension | null {
  const normalized = email.trim().toLowerCase();
  const byEmail = extensions.filter(
    (e) => e.email_address?.trim().toLowerCase() === normalized,
  );
  if (byEmail.length === 1) return byEmail[0];
  if (byEmail.length > 1) return byEmail[0];

  if (extensions.length === 1) return extensions[0];
  return null;
}

/** Monta parâmetros SIP a partir de um ramal Api4Com (porta WSS 6443). */
export function buildSipParamsFromApi4ComExtension(ext: Api4ComExtension) {
  const domain = ext.domain.trim();
  const ramal = String(ext.ramal).trim();
  return {
    label: `Api4Com — Ramal ${ramal}`,
    sipUri: `sip:${ramal}@${domain}`,
    authUser: ramal,
    authPassword: ext.senha,
    wsServer: `wss://${domain}:6443`,
    stunServers: DEFAULT_STUN,
  };
}

type DialerResponse = {
  id?: string;
  message?: string;
};

/** Api4Com /dialer pode demorar a responder (conexão aberta durante a chamada). */
const DIALER_ACK_MS = 5_000;

/**
 * Resolve o `gateway` enviado no `metadata.gateway` da chamada /dialer e
 * cadastrado em `webhookConstraint.metadata.gateway` na integration.
 *
 * INVARIANTE CRÍTICA: o valor retornado aqui DEVE ser idêntico nos dois
 * lados (cadastro do webhook + disparo da chamada). Se divergir, a Api4com
 * cadastra o webhook mas NUNCA o dispara — chamadas viram fantasmas. Por
 * isso a função aceita opcional `organizationId` mas garante um default
 * único (não muda entre chamadas com a mesma config).
 *
 * Preferência (em ordem):
 *   1. env `API4COM_GATEWAY` (override explícito)
 *   2. `crm-<orgId.slice(0,8)>` quando orgId disponível (multi-tenant)
 *   3. `crm-integrado` (fallback legacy; mantido pra compat com instalações
 *      single-tenant antigas onde o webhook já está cadastrado nesse nome)
 */
export function resolveApi4ComGateway(organizationId?: string | null): string {
  const envOverride = process.env.API4COM_GATEWAY?.trim();
  if (envOverride) return envOverride;
  const orgPrefix = organizationId?.trim().slice(0, 8);
  if (orgPrefix) return `crm-${orgPrefix}`;
  return "crm-integrado";
}

/**
 * Inicia chamada de saída via REST (webphone próprio Api4Com).
 * O PBX liga para o ramal do usuário; o JsSIP deve auto-atender a sessão SIP.
 *
 * Ref: https://developers.api4com.com/integration-own-webphone.html#realizando-uma-chamada
 *
 * `extraMetadata` é mesclada à metadata enviada à Api4com — todos os campos
 * voltam no webhook (caminho de correlação CRM ↔ chamada). Convenção do PBX:
 * snake_case (`crm_user_id`, `deal_id`, `contact_id`).
 *
 * Passe `organizationId` quando souber (sempre que possível) — a resolução
 * do gateway depende disso pra casar com o webhookConstraint cadastrado.
 */
export async function dialApi4ComCall(
  token: string,
  extension: string,
  phoneRaw: string,
  extraMetadata: Record<string, string | number | boolean | null | undefined> = {},
  organizationId?: string | null,
): Promise<{ ok: true; callId?: string } | Api4ComFieldError> {
  const phone = normalizePhone(phoneRaw);
  if (!phone) {
    return {
      ok: false,
      field: "phone",
      message: "Número inválido. Informe DDD + número ou E.164 (+55…).",
    };
  }

  const baseMetadata: Record<string, string | number | boolean> = {
    gateway: resolveApi4ComGateway(organizationId),
  };
  for (const [k, v] of Object.entries(extraMetadata)) {
    if (v === undefined || v === null) continue;
    baseMetadata[k] = v;
  }

  const body = JSON.stringify({
    extension: String(extension).trim(),
    phone,
    metadata: baseMetadata,
  });

  const dialPromise = fetch(`${API4COM_BASE}/dialer`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: token,
    },
    body,
  }).then(async (res) => {
    const text = await res.text().catch(() => "");
    return { res, text };
  });

  const raced = await Promise.race([
    dialPromise,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), DIALER_ACK_MS)),
  ]);

  // Sem resposta HTTP em DIALER_ACK_MS: discagem provavelmente em andamento (long-poll).
  if (raced === null) {
    return { ok: true };
  }

  const { res, text } = raced;

  if (res.status === 401 || res.status === 403) {
    return {
      ok: false,
      field: "password",
      message: "Token Api4Com expirado. Reconecte em Configurações → Softphone.",
    };
  }

  if (!res.ok) {
    return {
      ok: false,
      field: "phone",
      message: `Api4Com recusou a discagem (${res.status}). ${text.slice(0, 180)}`.trim(),
    };
  }

  try {
    const data = JSON.parse(text) as DialerResponse;
    return { ok: true, callId: data.id };
  } catch {
    return { ok: true };
  }
}

/**
 * PATCH /integrations — configura o webhook que a Api4com vai disparar
 * a cada `channel-answer` / `channel-hangup`.
 *
 * IMPORTANTE — qual token usar:
 *   - Tokens DE USUÁRIO comum (login email/senha) NÃO têm permissão pra
 *     cadastrar integration com `gateway` customizado. A Api4com aceita
 *     o PATCH (200 OK) mas SILENCIOSAMENTE normaliza pra `gateway: "webhook"`
 *     e descarta o `webhookConstraint` — resultando em integration inútil
 *     (catch-all que não dispara em chamadas reais).
 *   - Tokens ADMIN (criados via /users/accessTokens ttl:-1, lidos do env
 *     `API4COM_SERVICE_TOKEN`) aceitam `gateway` customizado e gravam o
 *     `webhookConstraint` corretamente — fazendo o webhook disparar nas
 *     chamadas do CRM (que enviam `metadata.gateway = "crm-<orgId>"`).
 *
 * Esta função:
 *   1. Faz o PATCH com o token informado
 *   2. VALIDA a response: se a Api4com NÃO persistiu `gateway` correto,
 *      retorna erro pra o caller usar fallback (token admin ou manual)
 *
 * Esta função substitui silenciosa downgrade por erro explícito — preferimos
 * falhar visivelmente a entregar integration quebrada. Caller deve tentar
 * com `API4COM_SERVICE_TOKEN` antes do user token.
 *
 * `webhookConstraint.metadata.gateway` filtra os eventos que a Api4com
 * envia — só dispara webhook quando o `metadata.gateway` da chamada
 * (definido em `dialApi4ComCall`) bate com esse valor. Sem isso, a
 * integração receberia webhooks de TODA chamada da org na Api4com.
 */
export async function upsertApi4ComWebhookWithUserToken(
  token: string,
  payload: {
    gateway: string;
    webhookUrl: string;
    webhookVersion?: string;
    webhookTypes?: string[];
  },
): Promise<{ ok: true } | Api4ComFieldError> {
  const body = {
    gateway: payload.gateway,
    webhook: true,
    webhookConstraint: { metadata: { gateway: payload.gateway } },
    metadata: {
      webhookUrl: payload.webhookUrl,
      webhookVersion: payload.webhookVersion ?? "v1.4",
      webhookTypes: payload.webhookTypes ?? ["channel-answer", "channel-hangup"],
    },
  };

  const result = await api4comFetch<unknown>("/integrations", {
    method: "PATCH",
    body: JSON.stringify(body),
    token,
  });

  if (!result.ok) return result;

  // ── Validação: Api4com aceita PATCH com user token mas pode normalizar
  // silenciosamente pra `gateway: "webhook"` (sem permissão pra gateway
  // custom). Detectamos isso lendo a response e comparando com o esperado.
  const persisted = result.data as
    | { gateway?: string; webhookConstraint?: unknown }
    | null
    | undefined;
  const persistedGateway = persisted?.gateway?.trim();
  if (persistedGateway && persistedGateway !== payload.gateway) {
    return {
      ok: false,
      field: "email",
      message:
        `Api4com aceitou o webhook mas gravou como "${persistedGateway}" em vez de "${payload.gateway}". ` +
        "Provavelmente o token usado não tem permissão pra criar integration custom. " +
        "Configure API4COM_SERVICE_TOKEN (token admin) no .env do backend.",
    };
  }
  return { ok: true };
}
