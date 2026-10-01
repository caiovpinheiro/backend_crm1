import { readResponseBodyLimited } from "@/lib/media-byte-limits";
import { assertSafeOutboundUrl, type SafeOutboundUrlOptions } from "@/lib/safe-outbound-url";

/**
 * `fetch` endurecido contra SSRF para URLs que vêm do operador ou de
 * terceiros (webhooks, CDNs, mídia por URL):
 *
 *  - valida a URL com `assertSafeOutboundUrl` (protocolo, porta, host,
 *    IP resolvido) antes de CADA requisição, inclusive em cada salto de
 *    redirect (`redirect: "manual"` + revalidação; máx. `maxRedirects`);
 *  - `maxRedirects: 0` (padrão) recusa qualquer 3xx;
 *  - allowlist opcional de hosts (`"pps.whatsapp.net"`, `"*.fbcdn.net"`);
 *  - timeout total (`timeoutMs`) cobrindo conexão, resposta e leitura do corpo;
 *  - `safeFetchBytes` lê o corpo com limite de bytes.
 *
 * Risco residual (DNS rebinding): o `fetch` nativo refaz a resolução DNS ao
 * conectar; sem `undici` como dependência direta não fixamos o IP validado.
 * A janela é reduzida validando imediatamente antes de cada requisição.
 */

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS_HARD_CAP = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export type SafeFetchOptions = SafeOutboundUrlOptions & {
  /** Timeout total em ms (conexão + resposta + corpo). Padrão 15s. */
  timeoutMs?: number;
  /** Saltos de redirect permitidos (cada um revalidado). 0 = recusa 3xx. Padrão 0. */
  maxRedirects?: number;
  /**
   * Hosts permitidos. Entrada exata (`"graph.facebook.com"`) ou curinga de
   * subdomínio (`"*.fbcdn.net"`, que NÃO casa `fbcdn.net`). Vazio = qualquer
   * host público.
   */
  allowedHosts?: string[];
};

export class SafeFetchError extends Error {
  readonly code:
    | "blocked_url"
    | "host_not_allowed"
    | "redirect_refused"
    | "too_many_redirects"
    | "bad_redirect";

  constructor(code: SafeFetchError["code"], message: string) {
    super(message);
    this.name = "SafeFetchError";
    this.code = code;
  }
}

function normalizeHost(h: string): string {
  return h.toLowerCase().replace(/\.$/, "");
}

/** Exportado para testes. */
export function hostMatchesAllowlist(hostname: string, allowedHosts: string[]): boolean {
  const host = normalizeHost(hostname);
  for (const raw of allowedHosts) {
    const pattern = normalizeHost(raw.trim());
    if (!pattern) continue;
    if (pattern.startsWith("*.")) {
      const suffix = pattern.slice(1); // ".fbcdn.net"
      if (host.endsWith(suffix) && host.length > suffix.length) return true;
    } else if (host === pattern) {
      return true;
    }
  }
  return false;
}

async function validateHop(url: string, opts: SafeFetchOptions, hop: number): Promise<URL> {
  let parsed: URL;
  try {
    await assertSafeOutboundUrl(url, opts);
    parsed = new URL(url);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new SafeFetchError(
      hop === 0 ? "blocked_url" : "redirect_refused",
      hop === 0 ? msg : `redirect bloqueado: ${msg}`,
    );
  }
  if (opts.allowedHosts && opts.allowedHosts.length > 0) {
    if (!hostMatchesAllowlist(parsed.hostname, opts.allowedHosts)) {
      throw new SafeFetchError(
        hop === 0 ? "host_not_allowed" : "redirect_refused",
        `host não permitido: ${parsed.hostname}`,
      );
    }
  }
  return parsed;
}

function stripHeaders(headers: HeadersInit | undefined, names: string[]): Headers {
  const h = new Headers(headers);
  for (const n of names) h.delete(n);
  return h;
}

/**
 * Faz o fetch validando a URL e cada salto de redirect. Lança `SafeFetchError`
 * quando bloqueado, ou o erro do próprio `fetch` (timeout, rede).
 *
 * A resposta devolvida já é a final (não-3xx). Lembre-se de consumir ou
 * cancelar o corpo.
 */
export async function safeFetch(
  url: string,
  init: RequestInit = {},
  opts: SafeFetchOptions = {},
): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRedirects = Math.min(Math.max(opts.maxRedirects ?? 0, 0), MAX_REDIRECTS_HARD_CAP);

  // Sinal único: timeout total + sinal do chamador (se houver).
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException(`safeFetch: timeout de ${timeoutMs}ms`, "TimeoutError")),
    timeoutMs,
  );
  const callerSignal = init.signal;
  const onCallerAbort = () => controller.abort(callerSignal?.reason);
  if (callerSignal) {
    if (callerSignal.aborted) onCallerAbort();
    else callerSignal.addEventListener("abort", onCallerAbort, { once: true });
  }
  const cleanup = () => {
    clearTimeout(timer);
    callerSignal?.removeEventListener("abort", onCallerAbort);
  };

  let currentUrl = url;
  let method = (init.method ?? "GET").toUpperCase();
  let body = init.body;
  let headers: Headers = new Headers(init.headers);
  let origin: string | null = null;

  try {
    for (let hop = 0; ; hop++) {
      const parsed = await validateHop(currentUrl, opts, hop);
      if (origin === null) origin = parsed.origin;

      const res = await fetch(currentUrl, {
        ...init,
        method,
        body,
        headers,
        redirect: "manual",
        signal: controller.signal,
      });

      if (!REDIRECT_STATUSES.has(res.status)) {
        // O timer segue ativo para cobrir a leitura do corpo (o sinal aborta o
        // stream se estourar). Abortar depois do corpo consumido é inócuo, e
        // `unref` evita segurar o processo só por causa dele.
        timer.unref?.();
        return res;
      }

      const location = res.headers.get("location");
      await res.body?.cancel().catch(() => undefined);

      if (hop >= maxRedirects) {
        throw new SafeFetchError(
          maxRedirects === 0 ? "redirect_refused" : "too_many_redirects",
          maxRedirects === 0
            ? `redirect não permitido (HTTP ${res.status})`
            : `redirects demais (> ${maxRedirects})`,
        );
      }
      if (!location) {
        throw new SafeFetchError("bad_redirect", `HTTP ${res.status} sem Location`);
      }
      let next: URL;
      try {
        next = new URL(location, currentUrl);
      } catch {
        throw new SafeFetchError("bad_redirect", "Location inválido");
      }

      // Semântica do fetch: 303 (e 301/302 com POST) viram GET sem corpo.
      if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === "POST")) {
        method = "GET";
        body = undefined;
        headers = stripHeaders(headers, ["content-type", "content-length", "content-encoding"]);
      }
      // Não vaza credenciais para outra origem.
      if (next.origin !== origin) {
        headers = stripHeaders(headers, ["authorization", "cookie", "proxy-authorization"]);
      }
      currentUrl = next.toString();
    }
  } catch (err) {
    cleanup();
    throw err;
  }
}

/**
 * `safeFetch` + leitura do corpo limitada a `maxBytes` (lança
 * `MediaTooLargeError` se exceder). Sempre consome/cancela o corpo.
 */
export async function safeFetchBytes(
  url: string,
  init: RequestInit = {},
  opts: SafeFetchOptions & { maxBytes: number },
): Promise<{ response: Response; buffer: Buffer }> {
  const response = await safeFetch(url, init, opts);
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    return { response, buffer: Buffer.alloc(0) };
  }
  const buffer = await readResponseBodyLimited(response, opts.maxBytes);
  return { response, buffer };
}
