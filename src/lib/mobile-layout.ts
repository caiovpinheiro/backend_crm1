/**
 * Catalogo CENTRAL dos modulos do app mobile.
 *
 * Fonte unica da verdade — usado tanto pela pagina de configuracao
 * (/settings/mobile-layout) quanto pelo runtime do MobileBottomNav
 * e MobileMoreSheet. Adicionar um modulo novo ao app significa
 * adicionar uma entrada AQUI, e ele automaticamente vira opcao no
 * Layout Builder.
 *
 * Nao importamos icons aqui (server-safe) — apenas o nome do icone
 * lucide-react. A resolucao do componente Icon acontece no client.
 */

export type MobileModuleId =
  | "dashboard"
  | "inbox"
  | "pipeline"
  | "tasks"
  | "contacts"
  | "companies"
  | "campaigns"
  | "automations"
  | "distribution"
  | "team-chat"
  | "reports"
  | "monitor"
  | "settings"
  | "profile";

export interface MobileModuleDescriptor {
  id: MobileModuleId;
  /** Rotulo exibido no bottom nav e no MoreSheet. */
  label: string;
  /** Rota Next a navegar ao clicar. */
  href: string;
  /** Nome do icone lucide-react (PascalCase). */
  iconName: string;
  /** Descricao curta — exibida no Layout Builder. */
  description: string;
  /** Categoria — agrupa modulos no Builder. */
  category: "core" | "growth" | "analytics" | "config";
  /** Pode ser desabilitado pelo admin? Inbox NAO (default obrigatorio). */
  required?: boolean;
  /** Restringe o modulo a papeis especificos (ex.: Distribuicao = ADMIN/MANAGER). */
  allowedRoles?: Array<"ADMIN" | "MANAGER" | "MEMBER">;
}

export const MOBILE_MODULES: MobileModuleDescriptor[] = [
  {
    id: "dashboard",
    label: "Dashboard",
    href: "/dashboard",
    iconName: "LayoutDashboard",
    description: "Painel principal e métricas",
    category: "core",
  },
  {
    id: "inbox",
    label: "Inbox",
    href: "/inbox",
    iconName: "MessageSquare",
    description: "Conversas WhatsApp, e-mail e redes",
    category: "core",
    required: true,
  },
  {
    id: "pipeline",
    label: "Pipeline",
    href: "/pipeline",
    iconName: "Kanban",
    description: "Funil de vendas (Kanban)",
    category: "core",
  },
  {
    id: "tasks",
    label: "Tarefas",
    href: "/activities",
    iconName: "CheckSquare",
    description: "Tarefas atribuidas ao agente",
    category: "core",
  },
  {
    id: "contacts",
    label: "Contatos",
    href: "/contacts",
    iconName: "Users",
    description: "Base de contatos e leads",
    category: "core",
  },
  {
    id: "companies",
    label: "Empresas",
    href: "/companies",
    iconName: "Building2",
    description: "Empresas vinculadas",
    category: "core",
  },
  {
    id: "campaigns",
    label: "Campanhas",
    href: "/campaigns",
    iconName: "Megaphone",
    description: "Disparo em massa via templates",
    category: "growth",
  },
  {
    id: "automations",
    label: "Automações",
    href: "/automations",
    iconName: "Zap",
    description: "Salesbot, fluxos e gatilhos",
    category: "growth",
    // Paridade com a sidebar desktop (nav:automations).
    allowedRoles: ["ADMIN", "MANAGER"],
  },
  {
    id: "distribution",
    label: "Distribuição",
    href: "/widgets/distribution",
    iconName: "Shuffle",
    description: "Distribuição inteligente de leads entre consultores",
    category: "growth",
    allowedRoles: ["ADMIN", "MANAGER"],
  },
  {
    id: "team-chat",
    label: "Chat",
    href: "/bwipo-chat",
    iconName: "MessagesSquare",
    description: "Bwipo Chat — diretas e canais do time",
    category: "core",
  },
  {
    id: "reports",
    label: "Relatórios",
    href: "/reports",
    iconName: "BarChart3",
    description: "Mensagens, conversões e equipe",
    category: "analytics",
  },
  {
    // O antigo /monitor foi absorvido pelo dashboard principal como
    // preset + TV Wall. Mantemos o id no union pra não quebrar o tipo
    // de preferências antigas gravadas no banco, mas redirecionamos
    // pra home com o preset apropriado.
    id: "monitor",
    label: "Monitor",
    href: "/?preset=monitor",
    iconName: "Activity",
    description: "Dashboard em modo supervisão em tempo real",
    category: "analytics",
  },
  {
    id: "settings",
    label: "Configurações",
    href: "/settings",
    iconName: "Settings",
    description: "Canais, equipe, templates",
    category: "config",
  },
  {
    id: "profile",
    label: "Meu perfil",
    href: "/settings/profile",
    iconName: "UserCircle2",
    description: "Conta do operador",
    category: "config",
  },
];

export const MOBILE_MODULE_IDS = MOBILE_MODULES.map((m) => m.id) as MobileModuleId[];

export const DEFAULT_BOTTOM_NAV: MobileModuleId[] = [
  "dashboard",
  "pipeline",
  "contacts",
  "inbox",
  "distribution",
  "team-chat",
];

export const DEFAULT_ENABLED: MobileModuleId[] = [
  "dashboard",
  "pipeline",
  "contacts",
  "inbox",
  "companies",
  "tasks",
  "automations",
  "settings",
  "profile",
  "distribution",
  "team-chat",
];

/**
 * Módulos que entram em "Mais" mesmo em layouts já salvos sem eles
 * (onboard de feature — evita depender de re-salvar o Layout Builder).
 */
export const MORE_SHEET_ENSURE: MobileModuleId[] = ["automations"];

/**
 * Módulos pinados na barra mesmo em layouts já salvos sem eles
 * (onboard de feature — evita depender de re-salvar o Layout Builder).
 * Entram à direita de Distribuição quando ela está na barra.
 */
export const BOTTOM_NAV_ENSURE: MobileModuleId[] = ["team-chat"];

export function ensurePinnedBottomNav(ids: MobileModuleId[]): MobileModuleId[] {
  const out = [...ids];
  const seen = new Set(out);
  for (const id of BOTTOM_NAV_ENSURE) {
    if (seen.has(id)) continue;
    const distIdx = out.indexOf("distribution");
    if (distIdx >= 0) out.splice(distIdx + 1, 0, id);
    else out.push(id);
    seen.add(id);
  }
  return out;
}

export function ensureEnabledModules(ids: MobileModuleId[]): MobileModuleId[] {
  const out = [...ids];
  const seen = new Set(out);
  for (const id of BOTTOM_NAV_ENSURE) {
    if (seen.has(id)) continue;
    out.push(id);
    seen.add(id);
  }
  return out;
}

/**
 * Limite de itens no bottom nav. Nao ha mais corte visual em N —
 * o catalogo inteiro pode ser pinado e a barra faz scroll horizontal
 * quando os icones nao cabem na largura da tela. O "limite" aqui so
 * existe pra sanitizar contra IDs duplicados/invalidos.
 */
export const BOTTOM_NAV_MAX = MOBILE_MODULES.length;

export interface MobileLayoutConfigDto {
  bottomNav: MobileModuleId[];
  enabled: MobileModuleId[];
  startRoute: string;
  brandColor: string | null;
  /** @deprecated Feature "Visual Chrome" removida — mantido só por compat com API antiga. */
  visualChrome?: boolean;
  version: number;
}

/**
 * Sanitiza um array de IDs:
 *  - Remove duplicatas.
 *  - Remove IDs invalidos (nao existem no catalogo).
 *  - Garante que modulos `required: true` estao presentes.
 *  - Trunca pra `maxItems` se especificado.
 */
export function sanitizeModuleIds(
  raw: string | string[] | null | undefined,
  options: { ensureRequired?: boolean; maxItems?: number } = {},
): MobileModuleId[] {
  const arr = Array.isArray(raw)
    ? raw
    : (raw ?? "").split(",").map((s) => s.trim());

  const valid = arr.filter((id): id is MobileModuleId =>
    MOBILE_MODULE_IDS.includes(id as MobileModuleId),
  );
  const seen = new Set<MobileModuleId>();
  const dedup: MobileModuleId[] = [];
  for (const id of valid) {
    if (seen.has(id)) continue;
    seen.add(id);
    dedup.push(id);
  }

  if (options.ensureRequired) {
    for (const m of MOBILE_MODULES) {
      if (m.required && !seen.has(m.id)) {
        dedup.unshift(m.id);
        seen.add(m.id);
      }
    }
  }

  if (options.maxItems && dedup.length > options.maxItems) {
    return dedup.slice(0, options.maxItems);
  }
  return dedup;
}

export function serializeModuleIds(ids: MobileModuleId[]): string {
  return ids.join(",");
}
