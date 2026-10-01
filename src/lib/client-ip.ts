/**
 * IP do cliente para rate-limit e auditoria, a partir de `X-Forwarded-For`.
 *
 * Quem escreve o quê no cabeçalho
 * ───────────────────────────────
 * Cada proxy ANEXA à direita o endereço de quem conectou nele. Tudo à
 * esquerda do que o proxy de borda anexou veio do próprio cliente e pode
 * ser forjado (o pentest de out/2026 burlou um limite trocando o XFF).
 *
 *   direto na API:      "<forjado>, <cliente>"
 *   via frontend:       "<forjado>, <cliente>, <ip interno do frontend>"
 *
 * Regra
 * ─────
 * Lê da DIREITA para a esquerda. O último valor é sempre de um proxy
 * confiável. Só pulamos um valor quando ele é o endereço de um proxy
 * confiável (rede privada/loopback ou `TRUSTED_PROXY_CIDRS`), e no máximo
 * `TRUSTED_PROXY_HOPS` vezes. O primeiro valor não confiável é o cliente;
 * o que estiver mais à esquerda nunca é lido.
 *
 * A versão anterior devolvia cegamente o (hops+1)-ésimo valor a partir do
 * fim: com `hops=1` e uma chamada direta na API, isso era o valor forjado.
 *
 * Sem dependência de `node:*` — o módulo pode ser importado de qualquer runtime.
 */

const DEFAULT_TRUSTED_PROXY_HOPS = 1;
const MAX_TRUSTED_PROXY_HOPS = 10;
/** Teto de tamanho do identificador (chave de Redis / log). */
const MAX_IP_LENGTH = 64;

export const UNKNOWN_CLIENT_IP = "0.0.0.0";

export function getTrustedProxyHops(): number {
  const raw = process.env.TRUSTED_PROXY_HOPS?.trim();
  if (!raw) return DEFAULT_TRUSTED_PROXY_HOPS;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) return DEFAULT_TRUSTED_PROXY_HOPS;
  return Math.min(n, MAX_TRUSTED_PROXY_HOPS);
}

/** "1.2.3.4:5678" → "1.2.3.4"; "[::1]:443" → "::1"; minúsculas. */
export function normalizeIp(raw: string): string {
  let v = raw.trim().toLowerCase();
  if (v.startsWith("[")) {
    const end = v.indexOf("]");
    if (end > 0) v = v.slice(1, end);
  } else if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(v)) {
    v = v.slice(0, v.lastIndexOf(":"));
  }
  if (v.startsWith("::ffff:") && v.includes(".")) v = v.slice(7);
  return v.slice(0, MAX_IP_LENGTH);
}

function parseIpv4(ip: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const octets = m.slice(1).map(Number);
  if (octets.some((o) => o > 255)) return null;
  return ((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) >>> 0;
}

function ipv4InCidr(ip: number, base: number, bits: number): boolean {
  if (bits <= 0) return true;
  const mask = bits >= 32 ? 0xffffffff : (~0 << (32 - bits)) >>> 0;
  return (ip & mask) >>> 0 === (base & mask) >>> 0;
}

/** Redes internas: quem aparece com esses endereços é infraestrutura nossa. */
const PRIVATE_V4: ReadonlyArray<readonly [string, number]> = [
  ["10.0.0.0", 8],
  ["172.16.0.0", 12],
  ["192.168.0.0", 16],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["100.64.0.0", 10],
];

function isPrivateIp(ip: string): boolean {
  const v4 = parseIpv4(ip);
  if (v4 !== null) {
    return PRIVATE_V4.some(([base, bits]) =>
      ipv4InCidr(v4, parseIpv4(base) as number, bits),
    );
  }
  if (!ip.includes(":")) return false;
  // IPv6: loopback, unique-local (fc00::/7) e link-local (fe80::/10).
  return ip === "::1" || /^f[cd]/.test(ip) || /^fe[89ab]/.test(ip);
}

/**
 * `TRUSTED_PROXY_CIDRS`: lista separada por vírgula de IPs ou CIDRs IPv4
 * (ex.: `203.0.113.7,198.51.100.0/24`) de proxies confiáveis com endereço
 * PÚBLICO (CDN, frontend hospedado fora da rede interna). IPv6: só
 * endereço exato.
 */
function isInTrustedCidrs(ip: string): boolean {
  const raw = process.env.TRUSTED_PROXY_CIDRS?.trim();
  if (!raw) return false;
  const v4 = parseIpv4(ip);
  for (const entry of raw.split(",")) {
    const item = entry.trim().toLowerCase();
    if (!item) continue;
    const [base, bitsRaw] = item.split("/");
    if (bitsRaw === undefined) {
      if (normalizeIp(base) === ip) return true;
      continue;
    }
    const baseV4 = parseIpv4(base);
    const bits = Number(bitsRaw);
    if (v4 === null || baseV4 === null) continue;
    if (!Number.isInteger(bits) || bits < 0 || bits > 32) continue;
    if (ipv4InCidr(v4, baseV4, bits)) return true;
  }
  return false;
}

export function isTrustedProxyIp(ip: string): boolean {
  return isPrivateIp(ip) || isInTrustedCidrs(ip);
}

/** Resolve o IP do cliente a partir do valor cru de `X-Forwarded-For`. */
export function clientIpFromForwardedFor(xff: string, hops: number): string | null {
  const parts = xff
    .split(",")
    .map((p) => normalizeIp(p))
    .filter(Boolean);
  if (parts.length === 0) return null;

  let idx = parts.length - 1;
  let skipped = 0;
  while (idx > 0 && skipped < hops && isTrustedProxyIp(parts[idx])) {
    idx -= 1;
    skipped += 1;
  }
  return parts[idx];
}

/**
 * IP do cliente da requisição. Sem `X-Forwarded-For` usa `X-Real-IP`; sem
 * nenhum dos dois devolve `"0.0.0.0"` (um balde só — o limite continua
 * valendo, com granularidade menor).
 */
export function getClientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) {
    const ip = clientIpFromForwardedFor(xff, getTrustedProxyHops());
    if (ip) return ip;
  }
  const real = req.headers.get("x-real-ip");
  if (real) {
    const ip = normalizeIp(real);
    if (ip) return ip;
  }
  return UNKNOWN_CLIENT_IP;
}
