/**
 * CRUD e resumo das regras de horário por departamento do modo "leads".
 * Só a tela "Distribuição por Leads" e os endpoints
 * `/api/distribution/leads/department-rules*` usam isto. O motor lê
 * `department-rules.ts` direto, dentro da transação do sorteio.
 */

import { prisma } from "@/lib/prisma";
import { getOrgIdOrThrow } from "@/lib/request-context";

import {
  isAnyRuleActiveAt,
  isLeadsDepartmentRulesEnabled,
  localClock,
  nextTransition,
  type LeadsDepartmentRuleInput,
} from "./department-rules";

export interface LeadsDepartmentRuleView {
  id: string;
  departmentId: string;
  departmentName: string;
  startMinute: number;
  endMinute: number;
  weekdays: number[];
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface LeadsDepartmentSummaryView {
  departmentId: string;
  name: string;
  color: string;
  icon: string;
  /** Membros em `DepartmentMember`. */
  totalMembers: number;
  /** Membros com participante ACTIVE e peso > 0 no modo leads. */
  activeMembers: number;
  /** `totalMembers - activeMembers`. */
  inactiveMembers: number;
  /** `activeMembers` quando o departamento está disponível agora; senão 0. */
  eligibleMembers: number;
  /** Tem ao menos uma regra habilitada. */
  hasEnabledRule: boolean;
  /** Alguma regra habilitada está ativa agora (independe da setting). */
  availableNow: boolean;
  nextChangeAt: string | null;
  nextChangeKind: "activates" | "deactivates" | null;
  rules: LeadsDepartmentRuleView[];
}

export interface LeadsDepartmentRulesSummary {
  /** Setting `distribution.leads.departmentRules.enabled`. */
  rulesEnabled: boolean;
  serverNow: string;
  departments: LeadsDepartmentSummaryView[];
}

type RuleRow = {
  id: string;
  departmentId: string;
  startMinute: number;
  endMinute: number;
  weekdays: number[];
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
  department: { name: string };
};

const RULE_SELECT = {
  id: true,
  departmentId: true,
  startMinute: true,
  endMinute: true,
  weekdays: true,
  enabled: true,
  createdAt: true,
  updatedAt: true,
  department: { select: { name: true } },
} as const;

function toView(r: RuleRow): LeadsDepartmentRuleView {
  return {
    id: r.id,
    departmentId: r.departmentId,
    departmentName: r.department.name,
    startMinute: r.startMinute,
    endMinute: r.endMinute,
    weekdays: r.weekdays,
    enabled: r.enabled,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

export async function listLeadsDepartmentRules(): Promise<LeadsDepartmentRuleView[]> {
  const rows = await prisma.distributionLeadsDepartmentRule.findMany({
    orderBy: [{ department: { name: "asc" } }, { startMinute: "asc" }],
    select: RULE_SELECT,
  });
  return rows.map(toView);
}

/** `null` = departamento não existe nesta org. */
export async function createLeadsDepartmentRule(
  input: LeadsDepartmentRuleInput,
): Promise<LeadsDepartmentRuleView | null> {
  const orgId = getOrgIdOrThrow();
  const dept = await prisma.department.findFirst({
    where: { id: input.departmentId, organizationId: orgId },
    select: { id: true },
  });
  if (!dept) return null;
  const row = await prisma.distributionLeadsDepartmentRule.create({
    data: {
      organizationId: orgId,
      departmentId: input.departmentId,
      startMinute: input.startMinute,
      endMinute: input.endMinute,
      weekdays: input.weekdays,
      enabled: input.enabled,
    },
    select: RULE_SELECT,
  });
  return toView(row);
}

/** `null` = regra não existe nesta org. `"DEPARTMENT_NOT_FOUND"` = departamento inválido. */
export async function updateLeadsDepartmentRule(
  id: string,
  patch: Partial<LeadsDepartmentRuleInput>,
): Promise<LeadsDepartmentRuleView | null | "DEPARTMENT_NOT_FOUND" | "SAME_MINUTES"> {
  const orgId = getOrgIdOrThrow();
  const existing = await prisma.distributionLeadsDepartmentRule.findFirst({
    where: { id, organizationId: orgId },
    select: { id: true, startMinute: true, endMinute: true },
  });
  if (!existing) return null;
  if (patch.departmentId) {
    const dept = await prisma.department.findFirst({
      where: { id: patch.departmentId, organizationId: orgId },
      select: { id: true },
    });
    if (!dept) return "DEPARTMENT_NOT_FOUND";
  }
  const start = patch.startMinute ?? existing.startMinute;
  const end = patch.endMinute ?? existing.endMinute;
  if (start === end) return "SAME_MINUTES";
  const row = await prisma.distributionLeadsDepartmentRule.update({
    where: { id: existing.id },
    data: {
      ...(patch.departmentId ? { departmentId: patch.departmentId } : {}),
      ...(patch.startMinute !== undefined ? { startMinute: patch.startMinute } : {}),
      ...(patch.endMinute !== undefined ? { endMinute: patch.endMinute } : {}),
      ...(patch.weekdays ? { weekdays: patch.weekdays } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
    },
    select: RULE_SELECT,
  });
  return toView(row);
}

export async function deleteLeadsDepartmentRule(id: string): Promise<boolean> {
  const orgId = getOrgIdOrThrow();
  const res = await prisma.distributionLeadsDepartmentRule.deleteMany({
    where: { id, organizationId: orgId },
  });
  return res.count === 1;
}

export async function getLeadsDepartmentRulesSummary(
  now: Date = new Date(),
): Promise<LeadsDepartmentRulesSummary> {
  const orgId = getOrgIdOrThrow();
  const [rulesEnabled, departments, rules, members, participants] = await Promise.all([
    isLeadsDepartmentRulesEnabled(),
    prisma.department.findMany({
      where: { organizationId: orgId },
      orderBy: { name: "asc" },
      select: { id: true, name: true, color: true, icon: true },
    }),
    prisma.distributionLeadsDepartmentRule.findMany({
      orderBy: { startMinute: "asc" },
      select: RULE_SELECT,
    }),
    prisma.departmentMember.findMany({
      where: { organizationId: orgId },
      select: { departmentId: true, userId: true },
    }),
    prisma.distributionLeadsParticipant.findMany({
      where: { status: "ACTIVE", weight: { gt: 0 } },
      select: { userId: true },
    }),
  ]);
  const activeUsers = new Set(participants.map((p) => p.userId));
  const membersByDept = new Map<string, string[]>();
  for (const m of members) {
    const arr = membersByDept.get(m.departmentId) ?? [];
    arr.push(m.userId);
    membersByDept.set(m.departmentId, arr);
  }
  const rulesByDept = new Map<string, RuleRow[]>();
  for (const r of rules) {
    const arr = rulesByDept.get(r.departmentId) ?? [];
    arr.push(r);
    rulesByDept.set(r.departmentId, arr);
  }
  const clock = localClock(now);

  return {
    rulesEnabled,
    serverNow: now.toISOString(),
    departments: departments.map((d) => {
      const deptRules = rulesByDept.get(d.id) ?? [];
      const deptMembers = [...new Set(membersByDept.get(d.id) ?? [])];
      const activeMembers = deptMembers.filter((u) => activeUsers.has(u)).length;
      const availableNow = isAnyRuleActiveAt(deptRules, clock);
      const transition = nextTransition(deptRules, now);
      return {
        departmentId: d.id,
        name: d.name,
        color: d.color,
        icon: d.icon,
        totalMembers: deptMembers.length,
        activeMembers,
        inactiveMembers: deptMembers.length - activeMembers,
        eligibleMembers: availableNow ? activeMembers : 0,
        hasEnabledRule: deptRules.some((r) => r.enabled),
        availableNow,
        nextChangeAt: transition ? transition.at.toISOString() : null,
        nextChangeKind: transition ? (transition.becomesActive ? "activates" : "deactivates") : null,
        rules: deptRules.map(toView),
      };
    }),
  };
}
