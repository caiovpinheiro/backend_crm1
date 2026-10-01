/**
 * Fonte única dos headers de segurança (SEC-15).
 *
 * Consumido por `next.config.ts` (headers estáticos) e por
 * `src/middleware.ts` (Edge). Precisa ser puro — sem imports Node.
 *
 * - `X-Frame-Options: SAMEORIGIN` em ambos os lugares (antes: DENY no
 *   next.config e SAMEORIGIN no middleware → header ambíguo). SAMEORIGIN
 *   porque o frontend faz rewrite de `/cockpit-agente.html` para este
 *   backend e embute em iframe same-origin — DENY quebraria o cockpit.
 * - CSP em **Report-Only**: baseada no rascunho do frontend
 *   (`frontend/next.config.ts`). Sem nonce/`strict-dynamic` porque este
 *   serviço não gera nonces; inline scripts das páginas HTML mínimas
 *   (callback OAuth Instagram, cockpit) vão aparecer nos relatórios — é
 *   exatamente o inventário que precisamos antes de considerar enforcing.
 *   `report-uri` aponta para `/api/csp-report` (interno, só loga).
 * - CSP **enforced** mínima (`buildCspEnforced`) — ver comentário lá.
 */

export const FRAME_OPTIONS_VALUE = "SAMEORIGIN";

export const CSP_REPORT_PATH = "/api/csp-report";

const CSP_REPORT_ONLY_DIRECTIVES: readonly string[] = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data:",
  "connect-src 'self' https: wss:",
  "frame-src 'self' blob: https:",
  "worker-src 'self' blob:",
  "media-src 'self' blob: https:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
  `report-uri ${CSP_REPORT_PATH}`,
];

/** Valor do header `Content-Security-Policy-Report-Only`. */
export function buildCspReportOnly(): string {
  return CSP_REPORT_ONLY_DIRECTIVES.join("; ");
}

/**
 * CSP **enforced**, mínima de propósito (achado do pentest: resposta sem
 * `Content-Security-Policy`). Só diretivas que não mudam o que já funciona:
 *
 * - `frame-ancestors 'self'` — mesma regra do `X-Frame-Options: SAMEORIGIN`
 *   que já saía (o cockpit é embutido same-origin via rewrite do frontend).
 * - `base-uri 'self'` — nenhuma página deste serviço usa `<base>`.
 *
 * `script-src`/`default-src` continuam só no Report-Only acima: as páginas
 * HTML mínimas (callback OAuth, cockpit, /health) têm script/estilo inline
 * e este serviço não gera nonce. O HTML do app é do frontend (outro repo),
 * é lá que a CSP de script precisa existir.
 */
const CSP_ENFORCED_DIRECTIVES: readonly string[] = [
  "base-uri 'self'",
  "frame-ancestors 'self'",
];

/** Valor do header `Content-Security-Policy`. */
export function buildCspEnforced(): string {
  return CSP_ENFORCED_DIRECTIVES.join("; ");
}

export const PERMISSIONS_POLICY_VALUE = "payment=(), usb=(), geolocation=()";

/**
 * Headers aplicados em toda resposta (Edge e estático). Não inclui HSTS
 * (depende de env/protocolo — cada consumidor decide).
 */
export function baseSecurityHeaders(): { key: string; value: string }[] {
  return [
    { key: "X-Frame-Options", value: FRAME_OPTIONS_VALUE },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "Permissions-Policy", value: PERMISSIONS_POLICY_VALUE },
    { key: "Content-Security-Policy", value: buildCspEnforced() },
    { key: "Content-Security-Policy-Report-Only", value: buildCspReportOnly() },
  ];
}

/** Escreve `baseSecurityHeaders()` num `Headers` (middleware e rotas). */
export function applySecurityHeaders(headers: Headers): void {
  for (const { key, value } of baseSecurityHeaders()) {
    headers.set(key, value);
  }
}
