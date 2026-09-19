/**
 * A identificação é da conversa. Este teste protege as duas decisões que
 * fazem ela ser útil sem virar vazamento: o bloco de prompt não carrega
 * valor de campo, e um palpite do sistema não sobrescreve confirmação.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Stored = {
  aiIdentifiedEntity: string | null;
  aiIdentifiedRecordId: string | null;
  aiIdentifiedRef: string | null;
  aiIdentifiedBy: string | null;
  aiIdentifiedAt?: Date | null;
};

const EMPTY: Stored = {
  aiIdentifiedEntity: null,
  aiIdentifiedRecordId: null,
  aiIdentifiedRef: null,
  aiIdentifiedBy: null,
  aiIdentifiedAt: null,
};

let row: Stored = { ...EMPTY };

vi.mock("@/lib/prisma", () => ({
  prisma: {
    conversation: {
      findUnique: vi.fn(async () => row),
      update: vi.fn(async ({ data }: { data: Partial<Stored> }) => {
        row = { ...row, ...data };
        return row;
      }),
    },
  },
}));

import {
  describeConversationIdentity,
  loadConversationIdentity,
  rememberConversationIdentity,
} from "@/services/ai/conversation-identity";

beforeEach(() => {
  row = { ...EMPTY };
});

describe("loadConversationIdentity", () => {
  it("conversa sem identificação devolve null", async () => {
    expect(await loadConversationIdentity("conv-1")).toBeNull();
  });

  it("sem conversationId nem consulta o banco", async () => {
    expect(await loadConversationIdentity(null)).toBeNull();
  });

  it("cai no id quando a referência amigável está vazia", async () => {
    row = {
      aiIdentifiedEntity: "deal",
      aiIdentifiedRecordId: "deal-1",
      aiIdentifiedRef: null,
      aiIdentifiedBy: null,
    };
    expect((await loadConversationIdentity("conv-1"))?.ref).toBe("deal-1");
  });
});

describe("rememberConversationIdentity", () => {
  const base = {
    conversationId: "conv-1",
    entity: "deal",
    recordId: "deal-1",
    ref: "negócio #1",
  };

  it("grava quando não havia nada", async () => {
    await rememberConversationIdentity({ ...base, by: null, overwrite: false });
    expect(row.aiIdentifiedRecordId).toBe("deal-1");
    expect(row.aiIdentifiedAt ?? null).not.toBeNull();
  });

  it("sem overwrite não mexe no que já existe", async () => {
    row = {
      aiIdentifiedEntity: "deal",
      aiIdentifiedRecordId: "deal-9",
      aiIdentifiedRef: "negócio #9",
      aiIdentifiedBy: "RGM",
    };
    await rememberConversationIdentity({ ...base, by: null, overwrite: false });
    expect(row.aiIdentifiedRecordId).toBe("deal-9");
  });

  it("com overwrite a resposta mais recente manda", async () => {
    row = {
      aiIdentifiedEntity: "deal",
      aiIdentifiedRecordId: "deal-9",
      aiIdentifiedRef: "negócio #9",
      aiIdentifiedBy: null,
    };
    await rememberConversationIdentity({ ...base, by: "RGM", overwrite: true });
    expect(row.aiIdentifiedRecordId).toBe("deal-1");
    expect(row.aiIdentifiedBy).toBe("RGM");
  });
});

describe("describeConversationIdentity", () => {
  it("sem identificação não gera bloco", () => {
    expect(describeConversationIdentity(null)).toBe("");
  });

  it("manda não perguntar de novo e cita o campo usado", () => {
    const txt = describeConversationIdentity({
      entity: "deal",
      recordId: "deal-1",
      ref: "negócio #37514",
      by: "RGM",
    });
    expect(txt).toContain("negócio #37514");
    expect(txt).toContain("RGM");
    expect(txt).toContain("Não peça de novo");
  });

  it("origem passiva não inventa campo informado", () => {
    const txt = describeConversationIdentity({
      entity: "deal",
      recordId: "deal-1",
      ref: "negócio #37514",
      by: null,
    });
    expect(txt).toContain("ligado ao telefone");
    expect(txt).not.toContain("que ela informou");
  });
});
