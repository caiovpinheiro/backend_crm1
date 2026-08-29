/**
 * Hygiene de hostname DigitalOcean (Postgres / Valkey) em produção.
 *
 * Droplets na VPC devem usar o hostname `private-*`. O hostname público
 * (sem prefixo `private-`) sai pela internet. Este módulo só avisa —
 * nunca aborta o boot e nunca loga user/senha.
 */

const DO_MANAGED_SUFFIX = ".db.ondigitalocean.com";

export function hostnameFromConnectionUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const host = new URL(trimmed).hostname.trim().toLowerCase();
    return host || null;
  } catch {
    // Senha com @/# quebra URL(); extrai só host:porta sem logar o raw.
    const at = trimmed.lastIndexOf("@");
    if (at === -1) return null;
    const rest = trimmed.slice(at + 1);
    const hostPort = rest.split("/")[0]?.split("?")[0] ?? "";
    const host = hostPort.startsWith("[")
      ? hostPort.slice(1, hostPort.indexOf("]"))
      : hostPort.split(":")[0];
    return host?.trim().toLowerCase() || null;
  }
}

/** Host DigitalOcean managed (Postgres ou Valkey). */
export function isDigitalOceanManagedHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase();
  if (!host) return false;
  if (host === "db.ondigitalocean.com" || host.endsWith(DO_MANAGED_SUFFIX)) {
    return true;
  }
  return host.includes("valkey") && host.includes("ondigitalocean");
}

/**
 * `true` quando o host é managed DigitalOcean **sem** prefixo `private-`.
 * localhost, IPs e hostnames de docker não entram.
 */
export function isPublicDigitalOceanManagedHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase();
  if (!isDigitalOceanManagedHost(host)) return false;
  return !host.startsWith("private-");
}

export type PublicDoManagedHostFinding = {
  envName: string;
  hostname: string;
};

const CHECKED_ENVS = [
  "DATABASE_URL",
  "DATABASE_URL_REPLICA",
  "REDIS_URL",
  "VALKEY_URL",
] as const;

export function collectPublicDoManagedHosts(
  env: NodeJS.ProcessEnv = process.env,
): PublicDoManagedHostFinding[] {
  const findings: PublicDoManagedHostFinding[] = [];
  for (const envName of CHECKED_ENVS) {
    const raw = env[envName];
    if (!raw?.trim()) continue;
    const hostname = hostnameFromConnectionUrl(raw);
    if (!hostname) continue;
    if (isPublicDigitalOceanManagedHost(hostname)) {
      findings.push({ envName, hostname });
    }
  }
  return findings;
}

function formatWarning(envName: string, hostname: string): string {
  return (
    `[WARN] ${envName} usa hostname público DigitalOcean (sem private-): ${hostname}. ` +
    `Tráfego sai pela internet em vez da VPC. Troque para private-*.db.ondigitalocean.com`
  );
}

let alreadyWarned = false;

/**
 * Em `NODE_ENV=production`, avisa (sem crash) se Postgres/Valkey usam
 * hostname público DigitalOcean. Idempotente por processo.
 */
export function warnPublicDoManagedHosts(
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (alreadyWarned) return;
  alreadyWarned = true;
  if ((env.NODE_ENV ?? "").toLowerCase() !== "production") return;

  for (const { envName, hostname } of collectPublicDoManagedHosts(env)) {
    console.warn(formatWarning(envName, hostname));
  }
}

/** Só para testes. */
export function resetPublicDoManagedHostWarningForTests(): void {
  alreadyWarned = false;
}
