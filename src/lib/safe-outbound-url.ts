import { lookup } from "node:dns/promises";

/**
 * Bloqueia SSRF em URLs de saída controladas pelo operador (webhooks de
 * automação, webhooks de integração, mídia por URL etc.).
 *
 * Regras:
 *  - só http(s);
 *  - porta precisa estar na allowlist (80/443 por padrão; `OUTBOUND_ALLOWED_PORTS`
 *    substitui a lista, ex.: `80,443,5678`);
 *  - recusa hostnames internos (localhost, *.local, *.internal, metadata…);
 *  - recusa IP literal ou IP resolvido em faixa reservada/privada (IPv4 e IPv6,
 *    inclusive IPv4 embutido em IPv6: mapped, NAT64, 6to4);
 *  - resolução DNS com timeout.
 *
 * Limitação conhecida (DNS rebinding): validamos o IP resolvido, mas o `fetch`
 * nativo refaz a resolução ao conectar. Sem `undici` como dependência direta
 * não dá pra fixar o IP validado na conexão; `safeFetch` (safe-fetch.ts)
 * reduz a janela validando imediatamente antes de cada requisição/salto.
 */

const BLOCKED_HOSTS = new Set([
  "localhost",
  "localhost.localdomain",
  "metadata.google.internal",
  "metadata.goog",
]);

const DEFAULT_ALLOWED_PORTS = [80, 443];
const DEFAULT_DNS_TIMEOUT_MS = 5_000;

export type SafeOutboundUrlOptions = {
  /** Portas permitidas além do padrão (80/443 ou `OUTBOUND_ALLOWED_PORTS`). */
  allowedPorts?: number[];
  /** Timeout da resolução DNS. Padrão 5s. */
  dnsTimeoutMs?: number;
};

function ipv4ToInt(ip: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((n) => n > 255)) return null;
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

function inCidr(ip: number, base: number, bits: number): boolean {
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (ip & mask) === (base & mask);
}

/** Faixas IPv4 reservadas/não roteáveis (RFC 6890 e afins). */
const BLOCKED_IPV4_CIDRS: Array<[string, number]> = [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // RFC1918
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local (inclui metadata 169.254.169.254)
  ["172.16.0.0", 12], // RFC1918
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.168.0.0", 16], // RFC1918
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reservado + broadcast 255.255.255.255
];

function isBlockedIpv4Int(n: number): boolean {
  return BLOCKED_IPV4_CIDRS.some(([base, bits]) => inCidr(n, ipv4ToInt(base)!, bits));
}

function isBlockedIpv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n == null) return false;
  return isBlockedIpv4Int(n);
}

/**
 * Expande um literal IPv6 para 8 grupos de 16 bits. Aceita `::`, IPv4 embutido
 * no final (`::ffff:1.2.3.4`) e zone id (`fe80::1%eth0`). Retorna null se inválido.
 */
function parseIpv6(raw: string): number[] | null {
  let ip = raw.toLowerCase();
  const zone = ip.indexOf("%");
  if (zone !== -1) ip = ip.slice(0, zone);
  if (ip.startsWith("[") && ip.endsWith("]")) ip = ip.slice(1, -1);
  if (!ip.includes(":")) return null;

  // IPv4 embutido nos últimos 32 bits.
  const lastColon = ip.lastIndexOf(":");
  const tail = ip.slice(lastColon + 1);
  if (tail.includes(".")) {
    const v4 = ipv4ToInt(tail);
    if (v4 == null) return null;
    ip = `${ip.slice(0, lastColon + 1)}${((v4 >>> 16) & 0xffff).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }

  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const parseGroups = (s: string): number[] | null => {
    if (s === "") return [];
    const out: number[] = [];
    for (const g of s.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };
  const head = parseGroups(halves[0]!);
  if (!head) return null;
  if (halves.length === 1) {
    return head.length === 8 ? head : null;
  }
  const rest = parseGroups(halves[1]!);
  if (!rest) return null;
  const missing = 8 - head.length - rest.length;
  if (missing < 1) return null;
  return [...head, ...new Array<number>(missing).fill(0), ...rest];
}

function ipv4FromGroups(hi: number, lo: number): number {
  return ((hi << 16) | lo) >>> 0;
}

function isBlockedIpv6(ip: string): boolean {
  const g = parseIpv6(ip);
  if (!g) return true; // literal IPv6 malformado: não arriscar
  const [g0, g1, g2, g3, g4, g5, g6, g7] = g as [
    number, number, number, number, number, number, number, number,
  ];

  const isZeroPrefix = (n: number) => g.slice(0, n).every((x) => x === 0);

  // :: (unspecified) e ::1 (loopback)
  if (isZeroPrefix(7) && (g7 === 0 || g7 === 1)) return true;
  // ::ffff:a.b.c.d (IPv4-mapped) e ::ffff:0:a.b.c.d (IPv4-translated, RFC 2765)
  if (isZeroPrefix(4) && ((g4 === 0 && g5 === 0xffff) || (g4 === 0xffff && g5 === 0))) {
    return isBlockedIpv4Int(ipv4FromGroups(g6, g7));
  }
  // ::a.b.c.d (IPv4-compatible, obsoleto) — trata como o IPv4 embutido
  if (isZeroPrefix(6)) return isBlockedIpv4Int(ipv4FromGroups(g6, g7));
  // 64:ff9b::/96 (NAT64) e 64:ff9b:1::/48 (NAT64 local)
  if (g0 === 0x64 && g1 === 0xff9b) {
    if (g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
      return isBlockedIpv4Int(ipv4FromGroups(g6, g7));
    }
    if (g2 === 1) return true;
  }
  // 2002::/16 (6to4): IPv4 embutido nos bits 16..47
  if (g0 === 0x2002) return isBlockedIpv4Int(ipv4FromGroups(g1, g2));
  // fe80::/10 link-local, fec0::/10 site-local (obsoleto)
  if ((g0 & 0xffc0) === 0xfe80 || (g0 & 0xffc0) === 0xfec0) return true;
  // fc00::/7 unique local
  if ((g0 & 0xfe00) === 0xfc00) return true;
  // ff00::/8 multicast
  if ((g0 & 0xff00) === 0xff00) return true;
  // 2001:db8::/32 documentação
  if (g0 === 0x2001 && g1 === 0xdb8) return true;
  // 100::/64 discard-only
  if (g0 === 0x100 && g1 === 0 && g2 === 0 && g3 === 0) return true;
  return false;
}

export function isBlockedIp(ip: string): boolean {
  return ip.includes(":") ? isBlockedIpv6(ip) : isBlockedIpv4(ip);
}

function isBlockedHostname(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "");
  if (BLOCKED_HOSTS.has(h)) return true;
  if (
    h.endsWith(".localhost") ||
    h.endsWith(".local") ||
    h.endsWith(".internal") ||
    h.endsWith(".lan") ||
    h.endsWith(".home.arpa")
  ) {
    return true;
  }
  return isBlockedIp(h);
}

function parseEnvPorts(raw: string | undefined): number[] | null {
  if (!raw || !raw.trim()) return null;
  const out: number[] = [];
  for (const piece of raw.split(",")) {
    const n = Number(piece.trim());
    if (Number.isInteger(n) && n > 0 && n <= 65535) out.push(n);
  }
  return out.length > 0 ? out : null;
}

export function allowedOutboundPorts(extra?: number[]): Set<number> {
  const base = parseEnvPorts(process.env.OUTBOUND_ALLOWED_PORTS) ?? DEFAULT_ALLOWED_PORTS;
  return new Set([...base, ...(extra ?? [])]);
}

function effectivePort(parsed: URL): number {
  if (parsed.port) return Number(parsed.port);
  return parsed.protocol === "https:" ? 443 : 80;
}

async function lookupWithTimeout(
  host: string,
  timeoutMs: number,
): Promise<Array<{ address: string }>> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("dns timeout")), timeoutMs);
  });
  try {
    return await Promise.race([lookup(host, { all: true }), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Valida a URL (sintaxe, protocolo, porta, hostname) sem DNS.
 * Lança com mensagem legível quando bloqueada; devolve a URL parseada.
 */
export function assertSafeOutboundUrlSync(raw: string, opts?: SafeOutboundUrlOptions): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error("webhook: URL inválida");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("webhook: só http/https são permitidos");
  }
  if (parsed.username || parsed.password) {
    throw new Error("webhook: credenciais na URL não são permitidas");
  }
  const port = effectivePort(parsed);
  if (!allowedOutboundPorts(opts?.allowedPorts).has(port)) {
    throw new Error(`webhook: porta ${port} não permitida`);
  }
  // `URL.hostname` devolve IPv6 entre colchetes.
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (!host || isBlockedHostname(host)) {
    throw new Error("webhook: destino interno/privado bloqueado");
  }
  return parsed;
}

export async function assertSafeOutboundUrl(
  raw: string,
  opts?: SafeOutboundUrlOptions,
): Promise<void> {
  const parsed = assertSafeOutboundUrlSync(raw, opts);
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  // IP literal já foi validado; não precisa de DNS.
  if (ipv4ToInt(host) != null || host.includes(":")) return;

  let records: Array<{ address: string }>;
  try {
    records = await lookupWithTimeout(host, opts?.dnsTimeoutMs ?? DEFAULT_DNS_TIMEOUT_MS);
  } catch {
    throw new Error("webhook: host não resolvido");
  }
  if (records.length === 0 || records.some((r) => isBlockedIp(r.address))) {
    throw new Error("webhook: destino interno/privado bloqueado");
  }
}
