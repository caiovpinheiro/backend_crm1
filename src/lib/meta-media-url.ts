/**
 * Allowlist compartilhada para URLs de mídia servidas pelos endpoints
 * Meta (WhatsApp Cloud API). Centraliza a validação para evitar
 * divergência entre rotas de mídia (media/proxy, media/audio-mp3,
 * transcribe).
 *
 * Regras:
 *   1. Aceita apenas HTTPS. HTTP puro é recusado (Meta nunca serve por http).
 *   2. Host precisa ser IGUAL a um dos domínios oficiais, ou um
 *      subdomínio genuíno (sufixo com separador ".") — nunca sufixo cru
 *      via endsWith, que casaria hosts como "xgraph.facebook.com".
 *
 * Estas rotas anexam o token da Meta (`META_WHATSAPP_ACCESS_TOKEN` ou
 * o token do canal) no fetch, portanto qualquer falha de allowlist é
 * um vetor de SSRF autenticado + vazamento de credencial.
 */

const META_HOSTS = ["lookaside.fbsbx.com", "scontent.whatsapp.net", "graph.facebook.com"] as const;

export function isAllowedMetaMediaUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase();
  return META_HOSTS.some((d) => host === d || host.endsWith(`.${d}`));
}
