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
 * Headers aplicados em toda resposta (Edge e estático). Não inclui HSTS
 * (depende de env/protocolo — cada consumidor decide).
 */
export function baseSecurityHeaders(): { key: string; value: string }[] {
  return [
    { key: "X-Frame-Options", value: FRAME_OPTIONS_VALUE },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "Content-Security-Policy-Report-Only", value: buildCspReportOnly() },
  ];
}
