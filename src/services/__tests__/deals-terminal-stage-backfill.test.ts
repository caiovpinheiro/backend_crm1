/**
 * Backfill `20261008130000_deals_terminal_stage_status`: status/closedAt dos
 * negócios em etapa terminal (Ganho/Perdido) e closedAt dos WON/LOST sem data.
 *
 * Duas camadas:
 *  - Estrutura do SQL (sempre roda, inclusive na CI): backup antes de qualquer
 *    UPDATE, um UPDATE por regra, `updatedAt` intocado, só OPEN é convertido.
 *  - Comportamento das regras (só com Postgres LOCAL em DATABASE_URL; na CI
 *    pula): o SELECT do alvo — o mesmo que alimenta o backup e os UPDATEs —
 *    roda contra fixtures em CTEs com os nomes "deals"/"stages"/"deal_events",
 *    que sombreiam as tabelas reais. Só SELECT: nada é gravado no banco.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  hostnameFromConnectionUrl,
  isDigitalOceanManagedHost,
} from "@/lib/warn-public-do-managed-hosts";

const MIGRATION = readFileSync(
  path.resolve(
    __dirname,
    "../../../prisma/migrations/20261008130000_deals_terminal_stage_status/migration.sql",
  ),
  "utf8",
);

/** SQL executável: sem as linhas de comentário (o cabeçalho cita SQL de exemplo). */
const EXEC_SQL = MIGRATION.split("\n")
  .filter((line) => !line.trimStart().startsWith("--"))
  .join("\n");

const STATEMENTS = EXEC_SQL.split(";")
  .map((s) => s.trim())
  .filter(Boolean);

function alvoSelect(): string {
  const m = MIGRATION.match(/^-- @alvo:inicio\r?\n([\s\S]*?)^-- @alvo:fim/m);
  if (!m) throw new Error("marcas @alvo não encontradas na migration");
  return m[1];
}

describe("migration de etapa terminal: estrutura", () => {
  it("o alvo é um SELECT único entre as marcas", () => {
    expect(MIGRATION.match(/^-- @alvo:inicio\r?$/gm)).toHaveLength(1);
    expect(MIGRATION.match(/^-- @alvo:fim\r?$/gm)).toHaveLength(1);
    expect(alvoSelect().trimStart().startsWith("SELECT")).toBe(true);
  });

  it("backup das linhas do alvo vem antes de qualquer UPDATE", () => {
    const backup = STATEMENTS.findIndex((s) =>
      s.startsWith('CREATE TABLE IF NOT EXISTS "_bkp_deals_terminal_20261010" AS'),
    );
    const firstUpdate = STATEMENTS.findIndex((s) => s.startsWith("UPDATE"));
    expect(backup).toBeGreaterThan(-1);
    expect(firstUpdate).toBeGreaterThan(backup);
    expect(STATEMENTS[backup]).toContain(
      'SELECT d."id", d."status", d."closedAt", d."lostReason", d."updatedAt"',
    );
    expect(STATEMENTS[backup]).toContain('FROM pg_temp."_alvo_deals_terminal"');
  });

  it("um UPDATE por regra, nenhum mexe em updatedAt", () => {
    const updates = STATEMENTS.filter((s) => s.startsWith("UPDATE"));
    expect(updates).toHaveLength(2);
    for (const u of updates) {
      const set = u.slice(u.indexOf("SET"), u.indexOf("FROM"));
      expect(set).not.toContain("updatedAt");
    }
    expect(updates[0]).toContain(`a."regra" = 'A_open_em_etapa_terminal'`);
    expect(updates[0]).toContain(`d."status" = 'OPEN'`);
    expect(updates[1]).toContain(`a."regra" = 'B_fechado_sem_closedAt'`);
    expect(updates[1]).toContain(`d."closedAt" IS NULL`);
    // Regra B só preenche a data.
    expect(updates[1].slice(updates[1].indexOf("SET"), updates[1].indexOf("FROM"))).not.toMatch(
      /"status"|"lostReason"/,
    );
  });

  it("só converte OPEN: LOST em Ganho e WON em Perdido ficam como estão", () => {
    expect(EXEC_SQL).not.toMatch(/<>\s*'(LOST|WON)'/);
    expect(EXEC_SQL).not.toMatch(/!=\s*'(LOST|WON)'/);
  });

  it("documenta o rollback pela tabela de backup", () => {
    expect(MIGRATION).toContain(
      'FROM "_bkp_deals_terminal_20261010" b WHERE d.id = b.id;',
    );
  });
});

// ── Comportamento contra Postgres local (só SELECT) ──────────────────────────

function isSafeLocalPostgres(url: string | undefined): boolean {
  if (!url?.trim()) return false;
  const host = hostnameFromConnectionUrl(url);
  if (!host || isDigitalOceanManagedHost(host)) return false;
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

const LOCAL = isSafeLocalPostgres(process.env.DATABASE_URL);

type Stage = { id: string; isWon: boolean; isLost: boolean };
type Deal = {
  id: string;
  stageId: string;
  status: "OPEN" | "WON" | "LOST";
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
  lostReason: string | null;
};
type Ev = { id: string; dealId: string; type: string; meta: unknown; createdAt: string };
type AlvoRow = { id: string; regra: string; novoStatus: string; fonte: string; novoClosedAt: string };

const STAGES: Stage[] = [
  { id: "ganho", isWon: true, isLost: false },
  { id: "perdido", isWon: false, isLost: true },
  { id: "comum", isWon: false, isLost: false },
];

const CREATED = "2026-07-21 10:00:00";
const UPDATED = "2026-10-01 09:00:00";

function deal(id: string, stageId: string, status: Deal["status"], closedAt: string | null = null): Deal {
  return { id, stageId, status, closedAt, createdAt: CREATED, updatedAt: UPDATED, lostReason: null };
}

let seq = 0;
function ev(dealId: string, type: string, meta: unknown, createdAt: string): Ev {
  seq += 1;
  return { id: `e${seq}`, dealId, type, meta, createdAt };
}
const toStage = (id: string) => ({ from: { id: "comum" }, to: { id, name: id } });

const DEALS: Deal[] = [
  deal("open_ganho", "ganho", "OPEN"),
  deal("open_perdido_nasceu", "perdido", "OPEN"),
  deal("open_perdido_legado", "perdido", "OPEN"),
  deal("open_perdido_sem_evento", "perdido", "OPEN"),
  deal("open_perdido_reaberto", "perdido", "OPEN"),
  deal("open_perdido_reaberto_antes", "perdido", "OPEN"),
  deal("open_comum", "comum", "OPEN"),
  deal("lost_ganho", "ganho", "LOST", "2026-08-01 12:00:00"),
  deal("won_perdido", "perdido", "WON", "2026-08-02 12:00:00"),
  deal("won_ok", "ganho", "WON", "2026-08-03 12:00:00"),
  deal("won_sem_data_status", "comum", "WON"),
  deal("won_ganho_sem_data_etapa", "ganho", "WON"),
  deal("lost_comum_sem_evento", "comum", "LOST"),
  deal("lost_ganho_sem_data", "ganho", "LOST"),
];

const EVENTS: Ev[] = [
  ev("open_ganho", "STAGE_CHANGED", toStage("ganho"), "2026-08-10 08:00:00"),
  ev("open_ganho", "STAGE_CHANGED", toStage("comum"), "2026-08-05 08:00:00"),
  // formato antigo: `to` é o id da etapa
  ev("open_perdido_legado", "STAGE_CHANGED", { from: "comum", to: "perdido" }, "2026-08-11 08:00:00"),
  ev("open_perdido_sem_evento", "STAGE_CHANGED", toStage("comum"), "2026-08-12 08:00:00"),
  ev("open_perdido_reaberto", "STAGE_CHANGED", toStage("perdido"), "2026-08-13 08:00:00"),
  ev("open_perdido_reaberto", "STATUS_CHANGED", { from: "LOST", to: "OPEN" }, "2026-08-14 08:00:00"),
  ev("open_perdido_reaberto_antes", "STATUS_CHANGED", { from: "LOST", to: "OPEN" }, "2026-08-15 08:00:00"),
  ev("open_perdido_reaberto_antes", "STAGE_CHANGED", toStage("perdido"), "2026-08-16 08:00:00"),
  ev("won_sem_data_status", "STATUS_CHANGED", { from: "OPEN", to: "WON" }, "2026-08-17 08:00:00"),
  ev("won_sem_data_status", "STATUS_CHANGED", { from: "OPEN", to: "WON" }, "2026-08-20 08:00:00"),
  ev("won_sem_data_status", "STATUS_CHANGED", { from: "WON", to: "LOST" }, "2026-08-25 08:00:00"),
  ev("won_ganho_sem_data_etapa", "STAGE_CHANGED", toStage("ganho"), "2026-08-18 08:00:00"),
  // etapa comum não é terminal: STAGE_CHANGED não serve de data de fechamento
  ev("lost_comum_sem_evento", "STAGE_CHANGED", toStage("comum"), "2026-08-19 08:00:00"),
  ev("lost_ganho_sem_data", "STAGE_CHANGED", toStage("ganho"), "2026-08-21 08:00:00"),
];

describe.skipIf(!LOCAL)("migration de etapa terminal: regras (Postgres local, só SELECT)", () => {
  type PgClient = {
    connect(): Promise<void>;
    end(): Promise<void>;
    query<R>(sql: string, params?: unknown[]): Promise<{ rows: R[] }>;
  };
  let client: PgClient;

  beforeAll(async () => {
    const pg = (await import("pg")).default;
    client = new pg.Client({ connectionString: process.env.DATABASE_URL }) as unknown as PgClient;
    await client.connect();
  });

  afterAll(async () => {
    await client?.end();
  });

  async function alvo(deals: Deal[], events: Ev[] = EVENTS): Promise<Map<string, AlvoRow>> {
    const sql = `
      WITH "stages" AS (
        SELECT * FROM json_to_recordset($1::json)
          AS t("id" text, "isWon" boolean, "isLost" boolean)
      ),
      "deals" AS (
        SELECT * FROM json_to_recordset($2::json)
          AS t("id" text, "stageId" text, "status" text, "closedAt" timestamp(3),
               "createdAt" timestamp(3), "updatedAt" timestamp(3), "lostReason" text)
      ),
      "deal_events" AS (
        SELECT * FROM json_to_recordset($3::json)
          AS t("id" text, "dealId" text, "type" text, "meta" jsonb, "createdAt" timestamp(3))
      )
      SELECT x."id", x."regra", x."novoStatus", x."fonte",
             to_char(x."novoClosedAt", 'YYYY-MM-DD HH24:MI:SS') AS "novoClosedAt"
      FROM (${alvoSelect()}) x
      ORDER BY x."id"`;
    const { rows } = await client.query<AlvoRow>(sql, [
      JSON.stringify(STAGES),
      JSON.stringify(deals),
      JSON.stringify(events),
    ]);
    return new Map(rows.map((r) => [r.id, r]));
  }

  /** Aplica o alvo como os dois UPDATEs da migration. */
  function aplicar(deals: Deal[], rows: Map<string, AlvoRow>): Deal[] {
    return deals.map((d) => {
      const a = rows.get(d.id);
      if (!a) return d;
      if (a.regra === "A_open_em_etapa_terminal") {
        return {
          ...d,
          status: a.novoStatus as Deal["status"],
          closedAt: a.novoClosedAt,
          lostReason: a.novoStatus === "WON" ? null : d.lostReason,
        };
      }
      return { ...d, closedAt: a.novoClosedAt };
    });
  }

  it("OPEN em Ganho → WON com a data do último STAGE_CHANGED para a etapa", async () => {
    const r = (await alvo(DEALS)).get("open_ganho");
    expect(r).toMatchObject({
      regra: "A_open_em_etapa_terminal",
      novoStatus: "WON",
      fonte: "STAGE_CHANGED",
      novoClosedAt: "2026-08-10 08:00:00",
    });
  });

  it("OPEN em Perdido → LOST (nasceu na etapa: createdAt; formato antigo do evento; sem evento: updatedAt)", async () => {
    const rows = await alvo(DEALS);
    expect(rows.get("open_perdido_nasceu")).toMatchObject({
      novoStatus: "LOST",
      fonte: "createdAt",
      novoClosedAt: CREATED,
    });
    expect(rows.get("open_perdido_legado")).toMatchObject({
      novoStatus: "LOST",
      fonte: "STAGE_CHANGED",
      novoClosedAt: "2026-08-11 08:00:00",
    });
    expect(rows.get("open_perdido_sem_evento")).toMatchObject({
      novoStatus: "LOST",
      fonte: "updatedAt",
      novoClosedAt: UPDATED,
    });
  });

  it("LOST em Ganho, WON em Perdido, fechados com data e OPEN em etapa comum ficam intocados", async () => {
    const rows = await alvo(DEALS);
    for (const id of ["lost_ganho", "won_perdido", "won_ok", "open_comum"]) {
      expect(rows.has(id), id).toBe(false);
    }
  });

  it("reaberto de propósito depois de entrar na etapa fica intocado; reabertura anterior ao move não", async () => {
    const rows = await alvo(DEALS);
    expect(rows.has("open_perdido_reaberto")).toBe(false);
    expect(rows.get("open_perdido_reaberto_antes")).toMatchObject({
      novoStatus: "LOST",
      novoClosedAt: "2026-08-16 08:00:00",
    });
  });

  it("WON sem data recebe a data do último STATUS_CHANGED para WON", async () => {
    expect((await alvo(DEALS)).get("won_sem_data_status")).toMatchObject({
      regra: "B_fechado_sem_closedAt",
      novoStatus: "WON",
      fonte: "STATUS_CHANGED",
      novoClosedAt: "2026-08-20 08:00:00",
    });
  });

  it("sem STATUS_CHANGED: STAGE_CHANGED se a etapa é terminal, senão updatedAt", async () => {
    const rows = await alvo(DEALS);
    expect(rows.get("won_ganho_sem_data_etapa")).toMatchObject({
      fonte: "STAGE_CHANGED",
      novoClosedAt: "2026-08-18 08:00:00",
    });
    expect(rows.get("lost_ganho_sem_data")).toMatchObject({
      novoStatus: "LOST",
      fonte: "STAGE_CHANGED",
      novoClosedAt: "2026-08-21 08:00:00",
    });
    expect(rows.get("lost_comum_sem_evento")).toMatchObject({
      novoStatus: "LOST",
      fonte: "updatedAt",
      novoClosedAt: UPDATED,
    });
  });

  it("nenhuma linha do alvo fica sem data", async () => {
    for (const r of (await alvo(DEALS)).values()) {
      expect(r.novoClosedAt, r.id).toBeTruthy();
    }
  });

  it("idempotente: depois de aplicada, o alvo fica vazio", async () => {
    const depois = aplicar(DEALS, await alvo(DEALS));
    expect(depois.find((d) => d.id === "open_ganho")).toMatchObject({ status: "WON" });
    expect([...(await alvo(depois)).keys()]).toEqual([]);
  });
});
