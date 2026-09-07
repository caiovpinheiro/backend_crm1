import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Sintoma: a base de conhecimento servia TODO documento indexado como verdade
 * atemporal. Um documento com prazos que vencem em 21/12/2026 continuava sendo
 * recuperado (e afirmado como fato) em janeiro de 2027.
 *
 * Aqui o relógio é congelado com fake timers: os mesmos dados dão resultados
 * diferentes antes e depois da validade.
 */

const queryRawUnsafe = vi.fn();
const findFirst = vi.fn();

vi.mock("@/lib/prisma", () => ({
  prisma: {
    $queryRawUnsafe: (...args: unknown[]) => queryRawUnsafe(...args),
    aIAgentKnowledgeDoc: { findFirst: (...a: unknown[]) => findFirst(...a) },
  },
}));

vi.mock("@/lib/request-context", () => ({
  getOrgIdOrThrow: () => "org-1",
}));

vi.mock("@/services/ai/provider", () => ({
  embedTexts: vi.fn(async () => ({ embeddings: [[0.1, 0.2, 0.3]] })),
}));

import {
  formatZonedDay,
  resolveZonedDayEnd,
  resolveZonedDayStart,
} from "@/lib/zoned-date";
import {
  formatExpiredKnowledgeBlock,
  retrieveAgentKnowledge,
} from "@/services/ai/retrieval";

const VALID_UNTIL = new Date("2026-12-21T23:59:59.999-03:00");

/** Doc vencido, com orientação própria, que casaria com a pergunta. */
const EXPIRED_ROW = {
  docId: "doc-prazos",
  title: "Prazos da campanha",
  instruction: "Diga que o próximo período ainda não foi divulgado.",
  distance: 0.12,
};

beforeEach(() => {
  vi.clearAllMocks();
  findFirst.mockResolvedValue({ validUntil: VALID_UNTIL });
  queryRawUnsafe.mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("corte por validade na recuperação", () => {
  it("a consulta filtra a janela de validade no SQL, não depois", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2027-01-05T12:00:00-03:00"));

    await retrieveAgentKnowledge("agente-1", "quando abre o prazo?", "key");

    const [sql, , , , , now] = queryRawUnsafe.mock.calls[0] as [
      string,
      string,
      string,
      number,
      string,
      Date,
    ];
    // O corte precisa estar no WHERE: doc fora da janela não pode nem
    // disputar as vagas do topK com os documentos válidos.
    expect(sql).toContain('d."validFrom" IS NULL OR d."validFrom" <=');
    expect(sql).toContain('d."validUntil" IS NULL OR d."validUntil" >=');
    expect(sql).toContain("LIMIT");
    expect(now).toEqual(new Date("2027-01-05T12:00:00-03:00"));
    // Multi-tenant: organizationId em docs e chunks, e o agentId da URL.
    expect(sql).toContain('d."organizationId" = $4');
    expect(sql).toContain('c."organizationId" = $4');
    expect(sql).toContain('d."agentId" = $2');
  });

  it("vencido: devolve a orientação do documento em vez do fato", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2027-01-05T12:00:00-03:00"));
    // 1ª consulta (docs válidos) vazia; 2ª consulta traz o doc vencido.
    queryRawUnsafe
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([EXPIRED_ROW]);

    const out = await retrieveAgentKnowledge(
      "agente-1",
      "quando abre o prazo?",
      "key",
    );

    expect(out.chunks).toEqual([]);
    expect(out.expired).toEqual([
      {
        docId: "doc-prazos",
        title: "Prazos da campanha",
        instruction: "Diga que o próximo período ainda não foi divulgado.",
      },
    ]);
    // Só documentos marcados para orientar entram na segunda consulta.
    const expiredSql = queryRawUnsafe.mock.calls[1]?.[0] as string;
    expect(expiredSql).toContain(`d."expiredBehavior" = 'instruct'`);
    expect(expiredSql).toContain('d."validUntil" <');
  });

  it("dentro da validade: nem procura documento vencido", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-12-20T12:00:00-03:00"));

    const out = await retrieveAgentKnowledge(
      "agente-1",
      "quando abre o prazo?",
      "key",
    );

    expect(queryRawUnsafe).toHaveBeenCalledTimes(1);
    expect(out.expired).toEqual([]);
  });

  it("agente sem documento nenhum não gasta embedding", async () => {
    findFirst.mockResolvedValue(null);
    const out = await retrieveAgentKnowledge("agente-1", "oi", "key");
    expect(queryRawUnsafe).not.toHaveBeenCalled();
    expect(out).toEqual({ chunks: [], expired: [] });
  });
});

describe("dia digitado pelo operador no fuso do agente", () => {
  it("vale até o fim do último dia, não até a meia-noite UTC", () => {
    const end = resolveZonedDayEnd("2026-12-21", "America/Sao_Paulo");
    // 23:59:59.999 em BRT = 02:59:59.999 UTC do dia seguinte. Guardar o dia
    // como UTC faria o documento vencer às 21h do próprio 21/12.
    expect(end?.toISOString()).toBe("2026-12-22T02:59:59.999Z");
    expect(end!.getTime()).toBeGreaterThan(
      new Date("2026-12-21T20:00:00-03:00").getTime(),
    );
  });

  it("início do dia e ida e volta preservam a data", () => {
    const start = resolveZonedDayStart("2026-12-21", "America/Sao_Paulo");
    expect(start?.toISOString()).toBe("2026-12-21T03:00:00.000Z");
    expect(formatZonedDay(start!, "America/Sao_Paulo")).toBe("2026-12-21");
  });

  it("respeita outro fuso da organização", () => {
    expect(
      resolveZonedDayStart("2026-12-21", "America/Manaus")?.toISOString(),
    ).toBe("2026-12-21T04:00:00.000Z");
  });

  it("data inválida devolve null", () => {
    expect(resolveZonedDayStart("21/12/2026", "America/Sao_Paulo")).toBeNull();
    expect(resolveZonedDayStart("", "America/Sao_Paulo")).toBeNull();
  });
});

describe("formatExpiredKnowledgeBlock", () => {
  const doc = (instruction: string | null) => ({
    docId: "d1",
    title: "Prazos da campanha",
    instruction,
  });

  it("usa o texto do próprio documento", () => {
    const block = formatExpiredKnowledgeBlock(
      [doc("Oriente o cliente a aguardar o novo comunicado.")],
      "default do agente",
    );
    expect(block).toContain("CONHECIMENTO FORA DE VALIDADE");
    expect(block).toContain("Prazos da campanha");
    expect(block).toContain("Oriente o cliente a aguardar o novo comunicado.");
    expect(block).not.toContain("default do agente");
  });

  it("cai no default do agente quando o documento não tem texto", () => {
    const block = formatExpiredKnowledgeBlock(
      [doc(null)],
      "Transfira para a equipe responsável.",
    );
    expect(block).toContain("Transfira para a equipe responsável.");
  });

  it("sem texto em lugar nenhum não acrescenta bloco ao prompt", () => {
    expect(formatExpiredKnowledgeBlock([doc(null)], null)).toBe("");
    expect(formatExpiredKnowledgeBlock([], "texto")).toBe("");
  });

  it("agrupa documentos com a mesma orientação em uma linha", () => {
    const block = formatExpiredKnowledgeBlock(
      [
        { docId: "a", title: "Tabela 2026", instruction: null },
        { docId: "b", title: "Promoção de janeiro", instruction: null },
      ],
      "Confirme com a equipe antes de informar.",
    );
    const bullets = block.split("\n").filter((l) => l.startsWith("- "));
    expect(bullets).toHaveLength(1);
    expect(bullets[0]).toContain("Tabela 2026; Promoção de janeiro");
  });

  it("bloco é curto: o prompt do agente já passa de 42 mil caracteres", () => {
    const block = formatExpiredKnowledgeBlock(
      Array.from({ length: 10 }, (_, i) => ({
        docId: String(i),
        title: `Documento ${i}`,
        instruction: `Orientação ${i}`,
      })),
      null,
    );
    expect(block.split("\n").filter((l) => l.startsWith("- "))).toHaveLength(3);
    expect(block.length).toBeLessThan(600);
  });
});
