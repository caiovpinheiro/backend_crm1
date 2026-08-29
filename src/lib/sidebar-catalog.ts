/**
 * Catalogo oficial dos itens da sidebar (nav rail) do CRM — lado backend.
 *
 * Fonte de verdade para VALIDACAO e ORDEM PADRAO. O frontend tem o seu
 * proprio catalogo com metadados de render (icone como componente, etc.);
 * as `key`s precisam ser identicas entre os dois (repos separados).
 *
 * Regras:
 *  - `key` e estavel e nunca deve mudar (e gravado na preferencia do user).
 *  - `locked: true` => item nao pode ser ocultado pelo usuario (mas pode
 *    ser reordenado). Ex.: Dashboard (home essencial).
 *  - `requiredPermission` (opcional) => so aparece/pode ser salvo se o user
 *    tiver a permission. Hoje nenhum item exige; o gancho fica pronto pra
 *    quando a nav passar a ser gateada por permissao.
 */

import type { PermissionKey } from "@/lib/authz";

export interface SidebarCatalogItem {
  key: string;
  /** Apenas referencia/documentacao no backend; o render usa o catalogo FE. */
  title: string;
  href: string;
  locked: boolean;
  requiredPermission?: PermissionKey;
  /** Slug de widget que precisa estar ATIVO na org para o item existir.
   *  Itens com este campo so entram em `availableKeys` se o widget estiver
   *  instalado (ex.: "smart_distribution" habilita o item "distribution"). */
  requiredWidgetSlug?: string;
}

/** Ordem do array = ordem padrao da sidebar. */
export const SIDEBAR_CATALOG: readonly SidebarCatalogItem[] = [
  { key: "dashboard", title: "Dashboard", href: "/dashboard", locked: true },
  { key: "pipeline", title: "Pipeline", href: "/pipeline", locked: false },
  { key: "contacts", title: "Contatos", href: "/contacts", locked: false },
  { key: "companies", title: "Empresas", href: "/companies", locked: false },
  { key: "inbox", title: "Inbox", href: "/inbox", locked: false },
  { key: "activities", title: "Atividades", href: "/activities", locked: false },
  { key: "automations", title: "Automações", href: "/automations", locked: false },
  {
    key: "campaigns",
    title: "Campanhas",
    href: "/campaigns",
    locked: false,
    requiredPermission: "campaign:view",
  },
  {
    key: "distribution",
    title: "Distribuição",
    href: "/widgets/distribution",
    locked: false,
    requiredPermission: "distribution:view",
    requiredWidgetSlug: "smart_distribution",
  },
  { key: "logs", title: "Logs", href: "/logs", locked: false },
  { key: "widgets", title: "Integrações", href: "/widgets", locked: false },
  {
    key: "job-openings",
    title: "Vagas",
    href: "/job-openings",
    locked: false,
    requiredPermission: "job_opening:view",
  },
  {
    key: "demands",
    title: "Demandas",
    href: "/demands",
    locked: false,
    requiredPermission: "nav:demands",
  },
  {
    key: "team-chat",
    title: "Bwipo Chat",
    href: "/bwipo-chat",
    locked: false,
    requiredPermission: "nav:team-chat",
  },
  // "Chamadas" foi movido do trilho para dentro de Logs (aba "Chamadas").
  // O histórico segue acessível via /widgets/calls (gate `calls_history`),
  // mas deixou de ser um item independente/customizável da sidebar.
] as const;

export const SIDEBAR_KEYS: ReadonlySet<string> = new Set(
  SIDEBAR_CATALOG.map((i) => i.key),
);

export const SIDEBAR_LOCKED_KEYS: ReadonlySet<string> = new Set(
  SIDEBAR_CATALOG.filter((i) => i.locked).map((i) => i.key),
);

export function getSidebarItem(key: string): SidebarCatalogItem | undefined {
  return SIDEBAR_CATALOG.find((i) => i.key === key);
}
