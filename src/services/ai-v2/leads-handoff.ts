/**
 * Quem pode receber um repasse da IA no modo por leads.
 * O sorteio (peso) continua no motor de leads. Aqui só entra o recorte
 * deste agente: departamento do destino, papéis e pessoas escolhidas.
 * Horário e presença não entram: modo por leads distribui pelo peso.
 */

import { prisma } from "@/lib/prisma";

export type LeadsRoutingScope = {
  departmentId: string;
  roleIds: string[];
  userIds: string[];
};

export function readLeadsScope(raw: unknown): LeadsRoutingScope | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const departmentId = typeof o.departmentId === "string" ? o.departmentId.trim() : "";
  if (!departmentId) return null;
  const list = (v: unknown) =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "") : [];
  return { departmentId, roleIds: list(o.roleIds), userIds: list(o.userIds) };
}

/**
 * Quem pode entrar no sorteio deste repasse: o cargo escolhido (atribuição
 * do papel, na org inteira — não só quem está em department_members) e as
 * pessoas marcadas. Não consulta horário nem presença. Peso zero ou inativo
 * sai depois, no sorteio do modo por leads.
 */
export async function eligibleUserIdsForScope(scope: LeadsRoutingScope): Promise<string[]> {
  const members = await prisma.departmentMember.findMany({
    where: { departmentId: scope.departmentId },
    select: { userId: true },
  });
  const memberIds = [...new Set(members.map((m) => m.userId))];
  let ids = memberIds;
  if (scope.roleIds.length > 0) {
    const roles = await prisma.role.findMany({
      where: { id: { in: scope.roleIds } },
      select: { systemPreset: true },
    });
    const presets = roles
      .map((r) => r.systemPreset)
      .filter((p): p is "ADMIN" | "MANAGER" | "MEMBER" => p === "ADMIN" || p === "MANAGER" || p === "MEMBER");
    const assigned = await prisma.userRoleAssignment.findMany({
      where: { roleId: { in: scope.roleIds } },
      select: { userId: true },
    });
    const byRole = new Set(assigned.map((a) => a.userId));
    if (presets.length > 0 && memberIds.length > 0) {
      const byPreset = await prisma.user.findMany({
        where: { id: { in: memberIds }, role: { in: presets } },
        select: { id: true },
      });
      for (const u of byPreset) byRole.add(u.id);
    }
    ids = [...byRole];
  }
  if (scope.userIds.length > 0) {
    const picked = new Set(scope.userIds);
    ids = ids.filter((id) => picked.has(id));
  }
  return ids;
}
