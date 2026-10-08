import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  replicaActive: false,
  replicaTripped: false,
  queryRaw: vi.fn(),
  count: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("@/lib/analytics", () => ({
  analyticsClient: () => ({ $queryRaw: h.queryRaw, conversation: { count: h.count } }),
  isReplicaConnectionError: () => false,
  tripReplica: vi.fn(),
}));
vi.mock("@/lib/prisma-replica", () => ({
  isReplicaActive: () => h.replicaActive,
  isReplicaTripped: () => h.replicaTripped,
}));
vi.mock("@/lib/request-context", () => ({ getOrgIdOrThrow: () => "org_1" }));
vi.mock("@/lib/logger", () => ({
  getLogger: () => ({
    error: h.logError,
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));
vi.mock("@/services/painel-agora", () => ({ getPainelAgora: vi.fn() }));
vi.mock("@/services/painel-hours", () => ({
  loadPainelHours: async () => DEFAULT_BUSINESS_HOURS,
}));

import { DEFAULT_BUSINESS_HOURS, computePainelRange } from "@/services/painel-period";
import {
  PAINEL_NO_REPLICA_MESSAGE,
  getPainelService,
  type PainelServiceSection,
} from "@/services/painel-service";

const RANGE = computePainelRange("last_30", null, null);
const REPLICA_ONLY: PainelServiceSection[] = [
  "tempo",
  "heatmap",
  "byDepartment",
  "connections",
  "attendants",
  "channels",
];

beforeEach(() => {
  h.replicaActive = false;
  h.replicaTripped = false;
  h.queryRaw.mockReset();
  h.count.mockReset();
  h.logError.mockReset();
});

describe("getPainelService sem réplica de leitura", () => {
  it("seção pedida e pulada por falta de réplica volta com reason no_replica", async () => {
    const out = await getPainelService(RANGE, "elapsed", REPLICA_ONLY);
    for (const key of REPLICA_ONLY) {
      expect(out[key]).toEqual({
        ok: false,
        error: PAINEL_NO_REPLICA_MESSAGE,
        reason: "no_replica",
      });
    }
    expect(h.queryRaw).not.toHaveBeenCalled();
  });

  it("seção NÃO pedida continua omitida, sem reason", async () => {
    const out = await getPainelService(RANGE, "elapsed", ["heatmap", "connections"]);
    expect(out.heatmap).toMatchObject({ ok: false, reason: "no_replica" });
    expect(out.connections).toMatchObject({ ok: false, reason: "no_replica" });
    for (const key of ["tempo", "byDepartment", "attendants", "channels", "agora", "volume", "exceptions"] as const) {
      expect(out[key]).toEqual({ ok: false, error: "omitido" });
    }
  });

  it("réplica derrubada (circuito aberto) também vira no_replica", async () => {
    h.replicaActive = true;
    h.replicaTripped = true;
    const out = await getPainelService(RANGE, "elapsed", ["heatmap", "tempo"]);
    expect(out.heatmap).toMatchObject({ ok: false, reason: "no_replica" });
    expect(out.tempo).toMatchObject({ ok: false, reason: "no_replica" });
  });

  it("seção que roda no primário continua rodando sem réplica", async () => {
    h.count.mockResolvedValue(0);
    const out = await getPainelService(RANGE, "elapsed", ["exceptions"]);
    expect(out.exceptions.ok).toBe(true);
  });
});

describe("getPainelService com réplica", () => {
  it("roda heatmap e connections na réplica", async () => {
    h.replicaActive = true;
    h.queryRaw.mockResolvedValue([]);
    const out = await getPainelService(RANGE, "elapsed", ["heatmap", "connections"]);
    expect(out.heatmap.ok).toBe(true);
    expect(out.connections.ok).toBe(true);
  });
});

describe("erro do banco não vai ao cliente", () => {
  it("devolve mensagem genérica e registra o detalhe no log", async () => {
    h.count.mockRejectedValue(
      new Error('relation "conversations" does not exist: SELECT secret FROM x'),
    );
    const out = await getPainelService(RANGE, "elapsed", ["exceptions"]);
    expect(out.exceptions).toEqual({ ok: false, error: "Falha ao carregar este bloco." });
    expect(JSON.stringify(out)).not.toContain("SELECT");
    expect(h.logError).toHaveBeenCalledWith(
      expect.objectContaining({ block: "exceptions", err: expect.any(Error) }),
      expect.any(String),
    );
  });
});
