/**
 * Recusa iframeUrl de widget que rodaria JS no cookie/domain do CRM.
 * Parceiros são hosts externos (não TENANT_BASE_DOMAIN).
 */
export function isSafePartnerIframeSrc(
  raw: string,
  opts: { tenantBaseDomain: string; apiOrigin?: string },
): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  if (url.username || url.password || !url.hostname) return false;
  if (opts.apiOrigin && url.origin === opts.apiOrigin) return false;

  const base = opts.tenantBaseDomain.trim().toLowerCase();
  const host = url.hostname.toLowerCase();
  if (base && base !== "localhost" && (host === base || host.endsWith(`.${base}`))) {
    return false;
  }
  return true;
}
