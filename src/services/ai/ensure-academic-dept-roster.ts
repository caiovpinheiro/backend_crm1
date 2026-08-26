/**
 * Garante roster acadêmico de departamentos + membros (idempotente).
 *
 * Regras de membership (produção):
 *  - Wesley, Danúbia → Acolhimento + Retenção
 *  - Marília → Acolhimento
 *  - Demais consultores do roster → Atendimento (- SAC)
 *
 * Também liga `distributionEnabled` nos 3 departamentos para o motor
 * filtrar por dept no handoff da IA.
 *
 * Memo por org (processo): no máx. 1 sync a cada 5 min.
 */

import { prisma } from "@/lib/prisma";
import { getOrgIdOrNull } from "@/lib/request-context";

/** Limite de fila alinhado ao seed de consultores (~volume DataCrazy). */
const QUEUE_LIMIT = 25;

const DEPT_DEFS = [
  { key: "acolhimento", names: ["Acolhimento"], color: "#8B5CF6", icon: "🤝" },
  { key: "retencao", names: ["Retenção", "Retencao"], color: "#EF4444", icon: "🔁" },
  {
    key: "atendimento",
    names: ["Atendimento - SAC", "Atendimento"],
    color: "#3B82F6",
    icon: "🎧",
  },
] as const;

type DeptKey = (typeof DEPT_DEFS)[number]["key"];

/** Email → departamentos canônicos. */
const ROSTER: Array<{ email: string; depts: DeptKey[] }> = [
  {
    email: "wesley.guerreiro@cruzeiroead.com.br",
    depts: ["acolhimento", "retencao"],
  },
  {
    email: "danubia.sousa@cruzeiroead.com.br",
    depts: ["acolhimento", "retencao"],
  },
  {
    email: "marilia.nascimento@cruzeiroead.com.br",
    depts: ["acolhimento"],
  },
  { email: "beatriz.andrade@cruzeiroead.com.br", depts: ["atendimento"] },
  { email: "breno.silva@cruzeiroead.com.br", depts: ["atendimento"] },
  { email: "erica.ferreira@cruzeiroead.com.br", depts: ["atendimento"] },
  { email: "emanuel.felipe@cruzeiroead.com.br", depts: ["atendimento"] },
  { email: "felipe.guimaraes@cruzeiroead.com.br", depts: ["atendimento"] },
  { email: "joyce.pereira@cruzeiroead.com.br", depts: ["atendimento"] },
  { email: "julia.rodrigues@cruzeiroead.com.br", depts: ["atendimento"] },
  { email: "mariana.vecoso@cruzeiroead.com.br", depts: ["atendimento"] },
];

const lastSyncAt = new Map<string, number>();
const SYNC_TTL_MS = 5 * 60 * 1000;

function normalizeDeptName(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .trim();
}

async function ensureDeptMap(
  orgId: string,
): Promise<Record<DeptKey, string>> {
  const existing = await prisma.department.findMany({
    where: { organizationId: orgId },
    select: { id: true, name: true, distributionEnabled: true },
  });

  const map = {} as Record<DeptKey, string>;

  for (const def of DEPT_DEFS) {
    const hit = existing.find((d) => {
      const dn = normalizeDeptName(d.name);
      return def.names.some((n) => {
        const nn = normalizeDeptName(n);
        return dn === nn || dn.includes(nn) || nn.includes(dn);
      });
    });

    if (hit) {
      map[def.key] = hit.id;
      if (!hit.distributionEnabled) {
        await prisma.department.update({
          where: { id: hit.id },
          data: { distributionEnabled: true },
        });
      }
      continue;
    }

    const created = await prisma.department.create({
      data: {
        organizationId: orgId,
        name: def.names[0]!,
        color: def.color,
        icon: def.icon,
        distributionEnabled: true,
      },
      select: { id: true },
    });
    map[def.key] = created.id;
  }

  return map;
}

async function syncUserDepts(args: {
  orgId: string;
  userId: string;
  deptIds: string[];
  academicIdSet: Set<string>;
}): Promise<void> {
  const existingAcademic = await prisma.departmentMember.findMany({
    where: {
      userId: args.userId,
      organizationId: args.orgId,
      departmentId: { in: [...args.academicIdSet] },
    },
    select: { id: true, departmentId: true },
  });

  const want = new Set(args.deptIds);
  for (const row of existingAcademic) {
    if (!want.has(row.departmentId)) {
      await prisma.departmentMember.delete({ where: { id: row.id } });
    }
  }
  for (const deptId of args.deptIds) {
    const has = existingAcademic.some((e) => e.departmentId === deptId);
    if (!has) {
      await prisma.departmentMember.create({
        data: {
          organizationId: args.orgId,
          userId: args.userId,
          departmentId: deptId,
        },
      });
    }
  }

  await prisma.agentPermission.upsert({
    where: {
      organizationId_userId: {
        organizationId: args.orgId,
        userId: args.userId,
      },
    },
    create: {
      organizationId: args.orgId,
      userId: args.userId,
      allowedDepartmentIds: args.deptIds,
    },
    update: { allowedDepartmentIds: args.deptIds },
  });

  // Motor de distribuição: entra no pool na 1ª vez. NÃO reescreve
  // queueLimit no update — senão o teto que o admin baixou na tela
  // (ex.: 25 → 15) volta a 25 a cada sync de 5 min / 1º atendimento.
  await prisma.distributionResponsible.upsert({
    where: {
      organizationId_userId: {
        organizationId: args.orgId,
        userId: args.userId,
      },
    },
    create: {
      organizationId: args.orgId,
      userId: args.userId,
      participates: true,
      queueLimit: QUEUE_LIMIT,
    },
    update: { participates: true },
  });
}

/**
 * Só a org acadêmica (Cruzeiro) tem esses e-mails. Sem isso, o 1º
 * atendimento — ligado por default em qualquer tenant — criava
 * Acolhimento / Retenção / Atendimento - SAC na org errada (ex.: DnaWork).
 */
async function orgHasAcademicRosterUsers(orgId: string): Promise<boolean> {
  const hit = await prisma.user.findFirst({
    where: {
      organizationId: orgId,
      type: "HUMAN",
      OR: ROSTER.map((row) => ({
        email: { equals: row.email, mode: "insensitive" as const },
      })),
    },
    select: { id: true },
  });
  return !!hit;
}

/**
 * Sincroniza roster acadêmico. Best-effort — nunca derruba o fluxo.
 * @param opts.force — ignora o TTL de 5 min (uso admin / handoff crítico).
 */
export async function ensureAcademicDepartmentRoster(opts?: {
  force?: boolean;
}): Promise<{ synced: number; missing: string[] } | null> {
  const orgId = getOrgIdOrNull();
  if (!orgId) return null;

  const last = lastSyncAt.get(orgId) ?? 0;
  if (!opts?.force && Date.now() - last < SYNC_TTL_MS) {
    return null;
  }
  lastSyncAt.set(orgId, Date.now());

  try {
    if (!(await orgHasAcademicRosterUsers(orgId))) {
      return { synced: 0, missing: [] };
    }

    const deptMap = await ensureDeptMap(orgId);
    const academicIdSet = new Set(Object.values(deptMap));

    let synced = 0;
    const missing: string[] = [];

    for (const row of ROSTER) {
      const user = await prisma.user.findFirst({
        where: {
          organizationId: orgId,
          type: "HUMAN",
          email: { equals: row.email, mode: "insensitive" },
        },
        select: { id: true },
      });
      if (!user) {
        missing.push(row.email);
        continue;
      }

      const deptIds = row.depts.map((k) => deptMap[k]).filter(Boolean);
      if (deptIds.length === 0) continue;
      await syncUserDepts({
        orgId,
        userId: user.id,
        deptIds,
        academicIdSet,
      });
      synced += 1;
    }

    console.info(
      "[ai-attend]",
      JSON.stringify({
        event: "academic_dept_roster_synced",
        orgId,
        roster: ROSTER.length,
        synced,
        missing,
        depts: Object.fromEntries(
          Object.entries(deptMap).map(([k, id]) => [k, id]),
        ),
      }),
    );
    return { synced, missing };
  } catch (e) {
    console.warn(
      "[ai-attend] ensureAcademicDepartmentRoster failed:",
      e instanceof Error ? e.message : e,
    );
    lastSyncAt.delete(orgId);
    return null;
  }
}
