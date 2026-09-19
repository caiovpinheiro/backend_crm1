/**
 * Versão da Graph API usada pelo CRM. Um único ponto configurável —
 * não hardcodar `vXX.Y` em clients novos.
 *
 * Override: `META_GRAPH_API_VERSION=v21.0` (formato `v<major>.<minor>`).
 */
const DEFAULT_GRAPH_API_VERSION = "v21.0";
const VERSION_RE = /^v\d+\.\d+$/;

export function getMetaGraphApiVersion(): string {
  const raw = process.env.META_GRAPH_API_VERSION?.trim();
  if (raw && VERSION_RE.test(raw)) return raw;
  return DEFAULT_GRAPH_API_VERSION;
}

export function buildMetaGraphUrl(path: string): string {
  const p = path.startsWith("/") ? path.slice(1) : path;
  return `https://graph.facebook.com/${getMetaGraphApiVersion()}/${p}`;
}
