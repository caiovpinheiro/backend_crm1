/**
 * Abstracao de provider de secrets.
 *
 * Hoje (PR 3.3): default `env` le `process.env`. Comportamento identico
 * ao app pre-abstracao.
 *
 * Futuro:
 *  - Self-host: SECRETS_PROVIDER=infisical aponta pra Infisical
 *    container no compose interno.
 *  - SaaS: SECRETS_PROVIDER=doppler aponta pra Doppler API.
 *
 * O provider so e consultado em tempo de "boot" pra secrets de
 * infraestrutura (DATABASE_URL, REDIS_URL, KEYRING_SECRET, etc.). Para
 * dados runtime (Channel.config) seguimos com app-layer encryption
 * (PR 1.2) — Infisical/Doppler nao substitui isso.
 *
 * @see docs/secrets-management.md
 */

/**
 * Chaves de secrets que o app conhece. Usado pra autocomplete/typing
 * e pra documentar o "contrato" entre app e secrets manager.
 *
 * Mantenha em sync com .env.example.
 */
export type SecretKey =
  // ── Infra core ─────────────────────────────────────────────
  | "DATABASE_URL"
  | "REDIS_URL"
  | "KEYRING_SECRET"
  | "NEXTAUTH_SECRET"
  | "METRICS_TOKEN"
  // ── Auth providers ──────────────────────────────────────────
  | "GOOGLE_CLIENT_ID"
  | "GOOGLE_CLIENT_SECRET"
  // ── Meta WhatsApp (legacy global; tenant-scoped vai via DB encriptado) 
  | "META_APP_SECRET"
  | "META_VERIFY_TOKEN"
  | "META_ACCESS_TOKEN"
  // ── Email/SMS ─────────────────────────────────────────────
  | "SMTP_HOST"
  | "SMTP_PORT"
  | "SMTP_USER"
  | "SMTP_PASS"
  | "SMTP_FROM"
  | "SMTP_FROM_EMAIL"
  | "SMTP_FROM_NAME"
  // ── AI ───────────────────────────────────────────────────
  | "OPENAI_API_KEY"
  | "ANTHROPIC_API_KEY"
  // ── Observability ────────────────────────────────────────
  | "OTEL_EXPORTER_OTLP_ENDPOINT";

/**
 * Provider de secrets. Implementacoes concretas: env, infisical, doppler.
 *
 * Notas:
 *  - `get` deve ser SINCRONO no caminho hot (secrets sao "warm" depois
 *    do boot). Providers remotos devem cachear na memoria depois do
 *    primeiro hit/`prefetch`.
 *  - `prefetch` e chamado uma vez no startup pra forcar todos os
 *    secrets conhecidos ja caregados em memoria — assim nenhum I/O
 *    acontece em request paths.
 */
export interface SecretsProvider {
  /** Identificador legivel (envia em logs / metricas). */
  readonly name: string;

  /**
   * Retorna o valor do secret ou `undefined` se nao definido.
   * Implementacoes podem normalizar (trim) mas NAO devem decodificar
   * base64/JSON — isso e responsabilidade do consumidor.
   */
  get(key: SecretKey | string): string | undefined;

  /**
   * Pre-carrega todos os secrets conhecidos pra memoria. Idempotente.
   * Para `env` provider e no-op. Para Infisical/Doppler faz 1 chamada
   * remota e cacheia.
   */
  prefetch(keys?: ReadonlyArray<SecretKey | string>): Promise<void>;

  /**
   * Health check raso. `env` sempre OK; remoto verifica conexao.
   * Usado em `/api/health/secrets` (futuro) e no startup.
   */
  health(): Promise<{ ok: boolean; detail?: string }>;
}
