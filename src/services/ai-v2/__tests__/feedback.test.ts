import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/prisma-base", () => ({ prismaBase: {} }));

import { normalizeV2Config } from "@/lib/ai-v2/config";
import { mentionsHumanRequest } from "../engine";
import {
  clusterByVectors,
  factsFromReplayItems,
  factsFromTurnLogs,
  maskEvidenceText,
  selectCandidates,
  type TurnLogRow,
} from "../feedback-extract";
import { contactIdentityMasker } from "../log";
import { noteV2Fact, runWithV2Trace, takeV2Facts } from "../trace";

const config = normalizeV2Config({
  name: "A",
  tone: "t",
  themes: [{ id: "t1", name: "Assunto 1", instructions: "x", when: ["segunda via"] }],
} as never);

const row = (extra: Partial<TurnLogRow>): TurnLogRow => ({
  id: "r1",
  conversationId: "c1",
  createdAt: new Date("2026-09-01T10:00:00Z"),
  inboundText: "como faço para emitir a segunda via do documento",
  reply: "Aqui está.",
  handoff: false,
  error: null,
  prompt: "p",
  contextSnapshot: {},
  llmOutput: { reason: "respondeu" },
  discardedActions: [],
  feedback: null,
  ...extra,
});

describe("fatos do turno", () => {
  it("logs antigos: lê busca vazia e verificação do rastro", () => {
    const [f] = factsFromTurnLogs(
      [
        row({
          handoff: true,
          reply: null,
          llmOutput: { reason: 'Citava "Menu X", que não está no material.' },
          contextSnapshot: {
            trace: [
              { step: "base", detail: "Nenhum trecho relevante em 3 material(is)" },
              { step: "verificação", detail: 'Resposta cita "Menu X", que não está no material nem na conversa — pedindo reescrita' },
              { step: "verificação", detail: "A reescrita ainda cita o que não está no material — transferindo" },
            ],
          },
        }),
      ],
      () => false,
    );
    expect(f.prefetch).toMatchObject({ searched: true, found: 0 });
    expect(f.unsupported).toEqual(['"Menu X"']);
    expect(f.forcedHandoff).toBe(true);
    expect(f.handoffCause).toBe("verification");
  });

  it("logs novos: usa os fatos gravados e monta o histórico da conversa", () => {
    const facts = factsFromTurnLogs(
      [
        row({ id: "a", createdAt: new Date("2026-09-01T10:00:00Z"), inboundText: "oi", reply: "Olá!" }),
        row({
          id: "b",
          createdAt: new Date("2026-09-01T10:01:00Z"),
          handoff: true,
          contextSnapshot: { facts: { source: "test", handoffCause: "no_source", prefetch: { searched: true, found: 0, docIds: [] } } },
        }),
        row({ id: "x", error: "Phone number not in allowed test list", reply: null }),
      ],
      (_id, source) => source === "test",
    );
    expect(facts.map((f) => f.sourceId)).toEqual(["a", "b"]);
    expect(facts[1]).toMatchObject({ sourceType: "test_turn", handoffCause: "no_source" });
    expect(facts[1].previous).toEqual([
      { role: "user", content: "oi" },
      { role: "assistant", content: "Olá!" },
    ]);
  });
});

describe("candidatos", () => {
  it("turno sem problema não é candidato; descarte vira item determinístico", () => {
    const facts = factsFromTurnLogs(
      [
        row({ id: "ok", inboundText: "oi" }),
        row({ id: "d", conversationId: "c2", discardedActions: [{ type: "add_tag", tag: "x" }] }),
      ],
      () => false,
    );
    const c = selectCandidates(facts, config);
    expect(c).toHaveLength(1);
    expect(c[0].deterministic).toMatchObject({ category: "acao_nao_liberada", key: "acao:add_tag" });
  });

  it("comparação: acerto fica de fora, invenção é grave, mídia sai por regra", () => {
    const base = { conversationId: "c", at: null, clientText: "q", humanText: "h", agentText: "a", agentHandoff: false, sources: [], skipReason: null, error: null, history: [], facts: null };
    const facts = factsFromReplayItems([
      { ...base, id: "1", verdict: { causa: "ok" }, outcome: "igual" },
      { ...base, id: "2", verdict: { causa: "material", inventou: true }, outcome: "inventou" },
      { ...base, id: "3", verdict: { causa: "midia" }, outcome: "diferente" },
    ]);
    const c = selectCandidates(facts, config);
    expect(c.map((x) => x.sourceId)).toEqual(["2", "3"]);
    expect(c[0].severity).toBe(5);
    expect(c[1].deterministic?.category).toBe("midia");
  });
});

describe("agrupamento e máscara", () => {
  it("junta necessidades parecidas", () => {
    expect(clusterByVectors([[1, 0], [0.99, 0.05], [0, 1]], 0.9).map((g) => g.sort())).toEqual([[0, 1], [2]]);
  });

  it("evidência sem nome e telefone do contato", () => {
    expect(maskEvidenceText("Oi Maria Souza, ligue 11 98888-7777", ["Maria Souza"])).toBe("Oi [nome], ligue [telefone]");
  });

  it("log: nome e telefone saem do contexto gravado", () => {
    const mask = contactIdentityMasker({ contactRaw: { name: "Ana Paula", phone: "+55 11 97777-6666" } } as never);
    expect(mask("Contato: Ana Paula, tel 11977776666, banana")).toBe("Contato: [nome], tel [telefone], banana");
  });
});

describe("fatos do motor", () => {
  it("primeira causa de transferência vence", async () => {
    const facts = await runWithV2Trace(async () => {
      noteV2Fact("handoffCause", "verification", { keepFirst: true });
      noteV2Fact("handoffCause", "model", { keepFirst: true });
      return takeV2Facts();
    });
    expect(facts?.handoffCause).toBe("verification");
  });

  it("palavras de pedir atendente da configuração", () => {
    const c = normalizeV2Config({ name: "A", tone: "t" } as never);
    expect(mentionsHumanRequest(c, "quero falar com um atendente")).toBe(true);
    expect(mentionsHumanRequest(c, "quero cancelar")).toBe(false);
  });
});
