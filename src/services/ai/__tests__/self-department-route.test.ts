import { beforeEach, describe, expect, it, vi } from "vitest";

const findFirst = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: {
    departmentMember: { findFirst: (...a: unknown[]) => findFirst(...a) },
  },
}));

import {
  SELF_DEPARTMENT_ROUTE_ERROR,
  selfDepartmentRouteError,
} from "@/services/ai/department-handoff";

beforeEach(() => {
  findFirst.mockReset();
});

describe("selfDepartmentRouteError", () => {
  it("recusa quando o agente é membro do departamento de destino", async () => {
    findFirst.mockResolvedValue({ id: "dm-1" });
    await expect(
      selfDepartmentRouteError({
        agentUserId: "agent-user-1",
        departmentId: "dept-1",
      }),
    ).resolves.toBe(SELF_DEPARTMENT_ROUTE_ERROR);
  });

  it("libera destino de outro departamento", async () => {
    findFirst.mockResolvedValue(null);
    await expect(
      selfDepartmentRouteError({
        agentUserId: "agent-user-1",
        departmentId: "dept-2",
      }),
    ).resolves.toBeNull();
  });

  // Agente sem usuário no contexto (replay/teste) não pode travar o roteamento.
  it("não consulta o banco sem agentUserId", async () => {
    await expect(
      selfDepartmentRouteError({ agentUserId: null, departmentId: "dept-1" }),
    ).resolves.toBeNull();
    expect(findFirst).not.toHaveBeenCalled();
  });
});
