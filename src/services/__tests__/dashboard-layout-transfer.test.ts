/**
 * Exportar / importar dashboard entre gestores da mesma org: formato do
 * arquivo, recusa de outra empresa e de arquivo inválido, backup e desfazer.
 * Tabela `user_dashboard_layouts` simulada em memória.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = {
  id: string;
  userId: string;
  organizationId: string;
  name: string;
  isDefault: boolean;
  preset: string;
  data: unknown;
  updatedAt: Date;
};

const db = vi.hoisted(() => ({ rows: [] as Row[], seq: 0 }));

vi.mock("@/lib/prisma-base", () => {
  const matches = (r: Row, where: Record<string, unknown>) =>
    Object.entries(where).every(([k, v]) => {
      if (k === "NOT") {
        const not = v as Record<string, unknown>;
        return !Object.entries(not).every(([nk, nv]) => (r as Record<string, unknown>)[nk] === nv);
      }
      return (r as Record<string, unknown>)[k] === v;
    });
  const pick = (r: Row | undefined, select?: Record<string, boolean>) => {
    if (!r) return null;
    if (!select) return { ...r };
    return Object.fromEntries(Object.keys(select).map((k) => [k, (r as Record<string, unknown>)[k]]));
  };
  const table = {
    findFirst: async ({ where, select }: { where: Record<string, unknown>; select?: Record<string, boolean> }) =>
      pick(
        db.rows
          .filter((r) => matches(r, where))
          .sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime())[0],
        select,
      ),
    create: async ({ data }: { data: Omit<Row, "id" | "updatedAt"> }) => {
      if (db.rows.some((r) => r.userId === data.userId && r.name === data.name)) {
        throw Object.assign(new Error("unique"), { code: "P2002" });
      }
      const row = { ...data, id: `row-${++db.seq}`, updatedAt: new Date(Date.now() + db.seq) };
      db.rows.push(row);
      return row;
    },
    update: async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
      const row = db.rows.find((r) => r.id === where.id)!;
      Object.assign(row, data, { updatedAt: new Date(Date.now() + ++db.seq) });
      return row;
    },
    delete: async ({ where }: { where: { id: string } }) => {
      db.rows = db.rows.filter((r) => r.id !== where.id);
    },
  };
  const client = { userDashboardLayout: table };
  return {
    prismaBase: { ...client, $transaction: (fn: (tx: typeof client) => unknown) => fn(client) },
  };
});

import {
  buildDashboardExportFile,
  DASHBOARD_IMPORT_BACKUP_NAME,
  getActiveDashboardLayout,
  getDashboardImportBackup,
  importDashboardLayout,
  parseDashboardImportFile,
  undoDashboardImport,
} from "@/services/dashboard-layout-transfer";

const layoutA = {
  visibleWidgets: ["funil", "mensagens"],
  layout: { funil: { i: "funil", x: 0, y: 0, w: 12, h: 4 } },
  meta: {
    v: 2,
    filters: { period: "today", pipelineId: "pipe-1", actorUserIds: ["u-9"] },
    negocios: { version: 2, cards: ["msg-atendimento", "msg-inscricao"] },
    ui: { tab: "negocios" },
  },
};
const layoutB = {
  visibleWidgets: ["kpis"],
  layout: {},
  meta: { v: 2, filters: { period: "month" } },
};

function seed(row: Partial<Row> & Pick<Row, "userId" | "name">) {
  db.rows.push({
    id: `row-${++db.seq}`,
    organizationId: "org-1",
    isDefault: true,
    preset: "custom",
    data: {},
    updatedAt: new Date(1_000 + db.seq),
    ...row,
  });
}

async function exportFor(userId: string, name: string, org = "org-1") {
  const record = await getActiveDashboardLayout(userId);
  return JSON.parse(
    JSON.stringify(buildDashboardExportFile({ organizationId: org, user: { id: userId, name }, record })),
  );
}

beforeEach(() => {
  db.rows = [];
  db.seq = 0;
  seed({ userId: "gestor-a", name: "Padrão", preset: "comercial", data: layoutA });
  seed({ userId: "gestor-b", name: "Padrão", data: layoutB });
});

describe("arquivo de exportação", () => {
  it("leva formato, versão, org, autor e a configuração completa", async () => {
    const file = await exportFor("gestor-a", "Ana");
    expect(file).toMatchObject({
      format: "bwipo.dashboard",
      version: 1,
      organizationId: "org-1",
      exportedBy: { id: "gestor-a", name: "Ana" },
      preset: "comercial",
      data: layoutA,
    });
  });

  it("usuário sem layout salvo exporta o padrão vazio", async () => {
    const file = await exportFor("gestor-novo", "Novo");
    expect(file.preset).toBe("default");
    expect(file.data).toEqual({ visibleWidgets: [], layout: {}, meta: {} });
  });
});

describe("parseDashboardImportFile", () => {
  it("aceita o arquivo da mesma org", async () => {
    const r = parseDashboardImportFile(await exportFor("gestor-a", "Ana"), "org-1");
    expect(r.ok).toBe(true);
  });

  it("recusa arquivo de outra empresa", async () => {
    const r = parseDashboardImportFile(await exportFor("gestor-a", "Ana"), "org-2");
    expect(r).toMatchObject({ ok: false, message: expect.stringContaining("outra empresa") });
  });

  it("recusa arquivo que não é dashboard, corrompido, de versão futura ou grande demais", async () => {
    const good = await exportFor("gestor-a", "Ana");
    expect(parseDashboardImportFile({ foo: 1 }, "org-1").ok).toBe(false);
    expect(parseDashboardImportFile("texto", "org-1").ok).toBe(false);
    expect(
      parseDashboardImportFile({ ...good, data: { ...good.data, visibleWidgets: "x" } }, "org-1").ok,
    ).toBe(false);
    expect(parseDashboardImportFile({ ...good, version: 99 }, "org-1")).toMatchObject({
      ok: false,
      message: expect.stringContaining("versão mais nova"),
    });
    const huge = { ...good, data: { ...good.data, meta: { blob: "x".repeat(200_000) } } };
    expect(parseDashboardImportFile(huge, "org-1")).toMatchObject({
      ok: false,
      message: expect.stringContaining("grande demais"),
    });
  });

  it("preset desconhecido vira custom", async () => {
    const good = await exportFor("gestor-a", "Ana");
    const r = parseDashboardImportFile({ ...good, preset: "hackeado" }, "org-1");
    expect(r.ok && r.preset).toBe("custom");
  });
});

describe("importar e desfazer", () => {
  async function importAtoB() {
    const parsed = parseDashboardImportFile(await exportFor("gestor-a", "Ana"), "org-1");
    if (!parsed.ok) throw new Error(parsed.message);
    return importDashboardLayout({
      userId: "gestor-b",
      organizationId: "org-1",
      preset: parsed.preset,
      data: parsed.data,
      source: parsed.source,
    });
  }

  it("o gestor B fica com o dashboard igual ao do A, e o A não muda", async () => {
    await importAtoB();
    const b = await getActiveDashboardLayout("gestor-b");
    expect(b?.data).toEqual(layoutA);
    expect(b?.preset).toBe("comercial");
    expect((await getActiveDashboardLayout("gestor-a"))?.data).toEqual(layoutA);
  });

  it("guarda o anterior e mostra de quem veio; o backup nunca é o layout ativo", async () => {
    const info = await importAtoB();
    expect(info.source.exportedByName).toBe("Ana");
    expect(await getDashboardImportBackup("gestor-b")).toMatchObject({
      source: { exportedByName: "Ana" },
    });
    const backup = db.rows.find((r) => r.userId === "gestor-b" && r.name === DASHBOARD_IMPORT_BACKUP_NAME);
    expect(backup?.isDefault).toBe(false);
    expect(await getDashboardImportBackup("gestor-a")).toBeNull();
  });

  it("desfazer volta exatamente ao dashboard anterior e some com o backup", async () => {
    await importAtoB();
    expect(await undoDashboardImport({ userId: "gestor-b", organizationId: "org-1" })).toBe(true);
    expect((await getActiveDashboardLayout("gestor-b"))?.data).toEqual(layoutB);
    expect(await getDashboardImportBackup("gestor-b")).toBeNull();
    expect(await undoDashboardImport({ userId: "gestor-b", organizationId: "org-1" })).toBe(false);
  });

  it("importar duas vezes: desfazer volta ao que havia antes da última importação", async () => {
    await importAtoB();
    const parsed = parseDashboardImportFile(await exportFor("gestor-a", "Ana"), "org-1");
    if (!parsed.ok) throw new Error();
    await importDashboardLayout({ userId: "gestor-b", organizationId: "org-1", ...parsed });
    expect(db.rows.filter((r) => r.userId === "gestor-b")).toHaveLength(2);
    await undoDashboardImport({ userId: "gestor-b", organizationId: "org-1" });
    expect((await getActiveDashboardLayout("gestor-b"))?.data).toEqual(layoutA);
  });

  it("quem não tinha layout: importar cria; desfazer volta ao padrão (sem registro)", async () => {
    const parsed = parseDashboardImportFile(await exportFor("gestor-a", "Ana"), "org-1");
    if (!parsed.ok) throw new Error();
    await importDashboardLayout({ userId: "gestor-c", organizationId: "org-1", ...parsed });
    expect((await getActiveDashboardLayout("gestor-c"))?.data).toEqual(layoutA);
    await undoDashboardImport({ userId: "gestor-c", organizationId: "org-1" });
    expect(db.rows.filter((r) => r.userId === "gestor-c")).toHaveLength(0);
  });
});
