/**
 * Config de tenant do pack acadêmico — nome da instituição, URLs oficiais,
 * lista de polos e roster de e-mails.
 *
 * Nada disso pode viver em `.ts` nem em variável de ambiente: são dados de
 * UMA organização, e o mesmo processo atende várias. A fonte é
 * `OrganizationSetting` (prefixo `vertical.academic.`), editável pelo admin.
 *
 * Os textos de prompt são montados de forma síncrona em dezenas de pontos,
 * então a leitura do banco fica em duas etapas: `loadAcademicTenantConfig()`
 * (async, no começo do turno) preenche o cache por org, e
 * `academicTenantConfig()` (sync) devolve o que já está carregado para a org
 * do contexto atual. Sem config carregada o retorno é vazio — quem monta o
 * prompt omite o trecho em vez de inventar um default de tenant.
 */

import { getOrgIdOrNull } from "@/lib/request-context";
import { getOrgSettingsByPrefix } from "@/lib/org-settings";

export const ACADEMIC_SETTING_PREFIX = "vertical.academic.";

export type AcademicDeptKey = "acolhimento" | "retencao" | "atendimento";

export type AcademicTenantConfig = {
  institutionName: string;
  portalUrl: string;
  inauguralCertificateUrl: string;
  firstAccessVideoUrl: string;
  appAndroidUrl: string;
  appIosUrl: string;
  poloList: string;
  /** Domínios da instituição liberados no guard de URL de saída. */
  allowedUrlSuffixes: string[];
  deptRoster: Array<{ email: string; depts: AcademicDeptKey[] }>;
};

export const EMPTY_ACADEMIC_TENANT_CONFIG: AcademicTenantConfig = {
  institutionName: "",
  portalUrl: "",
  inauguralCertificateUrl: "",
  firstAccessVideoUrl: "",
  appAndroidUrl: "",
  appIosUrl: "",
  poloList: "",
  allowedUrlSuffixes: [],
  deptRoster: [],
};

const SETTING_KEYS = {
  institutionName: "institutionName",
  portalUrl: "portalUrl",
  inauguralCertificateUrl: "inauguralCertificateUrl",
  firstAccessVideoUrl: "firstAccessVideoUrl",
  appAndroidUrl: "appAndroidUrl",
  appIosUrl: "appIosUrl",
  poloList: "poloList",
  allowedUrlSuffixes: "allowedUrlSuffixes",
  deptRoster: "deptRoster",
} as const;

const byOrg = new Map<string, AcademicTenantConfig>();
const warnedOrgs = new Set<string>();

const DEPT_KEYS = new Set<AcademicDeptKey>([
  "acolhimento",
  "retencao",
  "atendimento",
]);

function parseRoster(raw: string | undefined): AcademicTenantConfig["deptRoster"] {
  if (!raw?.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as Array<{ email?: string; depts?: string[] }>;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((r) => r.email && Array.isArray(r.depts))
      .map((r) => ({
        email: String(r.email).toLowerCase(),
        depts: (r.depts ?? []).filter((d): d is AcademicDeptKey =>
          DEPT_KEYS.has(d as AcademicDeptKey),
        ),
      }))
      .filter((r) => r.depts.length > 0);
  } catch {
    console.warn("[academic] vertical.academic.deptRoster inválido (JSON)");
    return [];
  }
}

function fromSettings(rows: Map<string, string>): AcademicTenantConfig {
  const get = (k: string) =>
    rows.get(`${ACADEMIC_SETTING_PREFIX}${k}`)?.trim() ?? "";
  return {
    institutionName: get(SETTING_KEYS.institutionName),
    portalUrl: get(SETTING_KEYS.portalUrl),
    inauguralCertificateUrl: get(SETTING_KEYS.inauguralCertificateUrl),
    firstAccessVideoUrl: get(SETTING_KEYS.firstAccessVideoUrl),
    appAndroidUrl: get(SETTING_KEYS.appAndroidUrl),
    appIosUrl: get(SETTING_KEYS.appIosUrl),
    poloList: get(SETTING_KEYS.poloList),
    allowedUrlSuffixes: get(SETTING_KEYS.allowedUrlSuffixes)
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    deptRoster: parseRoster(get(SETTING_KEYS.deptRoster)),
  };
}

/**
 * Carrega a config da org do contexto para o cache do processo. Chamar no
 * começo do turno, antes de montar prompt. Best-effort: falha de banco
 * mantém a org sem config (trechos omitidos), nunca derruba o atendimento.
 */
export async function loadAcademicTenantConfig(): Promise<AcademicTenantConfig> {
  const orgId = getOrgIdOrNull();
  if (!orgId) return EMPTY_ACADEMIC_TENANT_CONFIG;
  try {
    const rows = await getOrgSettingsByPrefix(ACADEMIC_SETTING_PREFIX);
    const cfg = fromSettings(rows);
    byOrg.set(orgId, cfg);
    if (!cfg.institutionName && !warnedOrgs.has(orgId)) {
      warnedOrgs.add(orgId);
      console.warn(
        "[academic]",
        JSON.stringify({
          event: "tenant_config_missing",
          orgId,
          key: `${ACADEMIC_SETTING_PREFIX}${SETTING_KEYS.institutionName}`,
        }),
      );
    }
    return cfg;
  } catch (e) {
    console.warn(
      "[academic] loadAcademicTenantConfig failed:",
      e instanceof Error ? e.message : e,
    );
    return byOrg.get(orgId) ?? EMPTY_ACADEMIC_TENANT_CONFIG;
  }
}

/** Config já carregada para a org do contexto. Vazia = omitir o trecho. */
export function academicTenantConfig(): AcademicTenantConfig {
  const orgId = getOrgIdOrNull();
  if (!orgId) return EMPTY_ACADEMIC_TENANT_CONFIG;
  return byOrg.get(orgId) ?? EMPTY_ACADEMIC_TENANT_CONFIG;
}

/** Popula o cache sem passar pelo banco (testes, scripts de replay). */
export function primeAcademicTenantConfig(
  orgId: string,
  cfg: Partial<AcademicTenantConfig>,
): void {
  byOrg.set(orgId, { ...EMPTY_ACADEMIC_TENANT_CONFIG, ...cfg });
}

export function clearAcademicTenantConfigCache(): void {
  byOrg.clear();
  warnedOrgs.clear();
}
