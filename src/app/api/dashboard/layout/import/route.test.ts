/**
 * POST /api/dashboard/layout/import: usuário e org vêm da sessão; arquivo
 * recusado devolve a mensagem para a tela; erro inesperado vira 500.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const sessionUser = vi.hoisted(() => ({ id: "user-b", organizationId: "org-1" as string | null }));
const svc = vi.hoisted(() => ({
  importDashboardLayout: vi.fn(),
  getDashboardImportBackup: vi.fn(),
}));

vi.mock("@/lib/auth-helpers", () => ({
  withOrgContext: (handler: (s: { user: typeof sessionUser }) => Promise<Response>) =>
    handler({ user: sessionUser }),
}));
vi.mock("@/lib/logger", () => ({ getLogger: () => ({ error: vi.fn() }) }));
vi.mock("@/lib/prisma-base", () => ({ prismaBase: {} }));
vi.mock("@/services/dashboard-layout-transfer", async (orig) => ({
  ...(await orig<typeof import("@/services/dashboard-layout-transfer")>()),
  importDashboardLayout: svc.importDashboardLayout,
  getDashboardImportBackup: svc.getDashboardImportBackup,
}));

import { GET, POST } from "@/app/api/dashboard/layout/import/route";

const file = {
  format: "bwipo.dashboard",
  version: 1,
  exportedAt: "2026-11-05T10:00:00.000Z",
  organizationId: "org-1",
  exportedBy: { id: "user-a", name: "Ana" },
  preset: "custom",
  data: { visibleWidgets: ["funil"], layout: {}, meta: { v: 2 } },
};

function post(body: unknown): Request {
  return new Request("https://api.test/api/dashboard/layout/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionUser.id = "user-b";
  sessionUser.organizationId = "org-1";
  svc.importDashboardLayout.mockResolvedValue({
    importedAt: "2026-11-05T11:00:00.000Z",
    source: { exportedByName: "Ana", exportedAt: file.exportedAt },
  });
});

describe("POST /api/dashboard/layout/import", () => {
  it("importa no usuário e org da sessão", async () => {
    const res = await POST(post({ ...file, userId: "user-x" }));
    expect(res.status).toBe(200);
    expect(svc.importDashboardLayout).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "user-b", organizationId: "org-1" }),
    );
  });

  it("arquivo de outra empresa: 400 com mensagem e nada gravado", async () => {
    const res = await POST(post({ ...file, organizationId: "org-2" }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toContain("outra empresa");
    expect(svc.importDashboardLayout).not.toHaveBeenCalled();
  });

  it("corpo que não é JSON: 400", async () => {
    const res = await POST(post("não é json"));
    expect(res.status).toBe(400);
  });

  it("falha ao gravar: 500 com mensagem", async () => {
    svc.importDashboardLayout.mockRejectedValueOnce(new Error("db"));
    const res = await POST(post(file));
    expect(res.status).toBe(500);
    expect(((await res.json()) as { message: string }).message).toBe(
      "Não foi possível importar o dashboard.",
    );
  });
});

describe("GET /api/dashboard/layout/import", () => {
  it("devolve o backup pendente do usuário da sessão", async () => {
    svc.getDashboardImportBackup.mockResolvedValue(null);
    const res = await GET();
    expect(await res.json()).toEqual({ backup: null });
    expect(svc.getDashboardImportBackup).toHaveBeenCalledWith("user-b");
  });
});
