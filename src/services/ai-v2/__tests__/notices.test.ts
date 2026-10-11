import { describe, expect, it } from "vitest";

import { normalizeV2Config } from "@/lib/ai-v2/config";
import {
  activeNotices,
  noticeCoversTheme,
  noticeExplainingFailure,
  noticeInstant,
  noticesForTurn,
  noticesPromptSection,
  noticeTriggered,
  noticeWindow,
} from "../notices";

const NOW = new Date("2026-10-11T15:00:00.000Z"); // 12:00 em Brasília

const config = (notices: unknown[], extra: Record<string, unknown> = {}) =>
  normalizeV2Config({
    name: "A",
    tone: "t",
    themes: [
      { id: "t-pag", name: "Pagamento", instructions: "x", when: ["pagamento"] },
      { id: "t-doc", name: "Documentos", instructions: "x", when: ["documento"] },
    ],
    notices,
    ...extra,
  });

const maintenance = {
  id: "n1",
  title: "Sistema em manutenção",
  message: "O sistema está em manutenção. Pagamentos feitos no próximo dia útil mantêm os descontos. Aguarde e tente mais tarde.",
  startsAt: "2026-10-11T08:00",
  endsAt: "2026-10-13T08:00",
  when: ["sistema", "fora do ar"],
};

describe("data e hora do aviso", () => {
  it("hora local no fuso do agente vira o instante certo; ISO com fuso vale como veio", () => {
    expect(noticeInstant("2026-10-11T08:00")?.toISOString()).toBe("2026-10-11T11:00:00.000Z");
    expect(noticeInstant("2026-10-11")?.toISOString()).toBe("2026-10-11T03:00:00.000Z");
    expect(noticeInstant("2026-10-11T08:00", "America/Manaus")?.toISOString()).toBe("2026-10-11T12:00:00.000Z");
    expect(noticeInstant("2026-10-11T08:00:00Z")?.toISOString()).toBe("2026-10-11T08:00:00.000Z");
    expect(noticeInstant("amanhã")).toBeNull();
    expect(noticeInstant(undefined)).toBeNull();
  });

  it("sem fim (ou fim antes do início): vale 24 h e marca que o fim foi suposto", () => {
    const w = noticeWindow({ startsAt: "2026-10-11T08:00" });
    expect(w?.end.toISOString()).toBe("2026-10-12T11:00:00.000Z");
    expect(w?.endGuessed).toBe(true);
    expect(noticeWindow({ startsAt: "2026-10-11T08:00", endsAt: "2026-10-10T08:00" })?.endGuessed).toBe(true);
    expect(noticeWindow({ startsAt: "2026-10-11T08:00", endsAt: "2026-10-13T08:00" })?.endGuessed).toBe(false);
  });
});

describe("avisos em vigor", () => {
  it("só dentro da janela; antes e depois não existem para o motor", () => {
    const c = config([maintenance, { ...maintenance, id: "old", startsAt: "2026-10-01T08:00", endsAt: "2026-10-02T08:00" }, { ...maintenance, id: "future", startsAt: "2026-10-20T08:00" }]);
    expect(activeNotices(c, NOW).map((n) => n.id)).toEqual(["n1"]);
    expect(activeNotices(c, new Date("2026-10-13T11:00:00.000Z"))).toEqual([]);
  });

  it("vale para o assunto escolhido (ou todos) e pelos gatilhos em qualquer assunto", () => {
    const scoped = { ...maintenance, themeIds: ["t-pag"] };
    expect(noticeCoversTheme(scoped as never, "t-pag")).toBe(true);
    expect(noticeCoversTheme(scoped as never, "t-doc")).toBe(false);
    expect(noticeCoversTheme(maintenance as never, undefined)).toBe(true);
    expect(noticeTriggered(scoped as never, "o sistema não abre")).toBe(true);
    expect(noticeTriggered(scoped as never, "quero a declaração")).toBe(false);

    const c = config([scoped]);
    expect(noticesForTurn(c, { themeId: "t-pag", message: "oi", now: NOW })).toHaveLength(1);
    expect(noticesForTurn(c, { themeId: "t-doc", message: "quero a declaração", now: NOW })).toHaveLength(0);
    expect(noticesForTurn(c, { themeId: "t-doc", message: "o sistema está fora do ar?", now: NOW })).toHaveLength(1);
  });

  it("seção do prompt: título, até quando, o texto e a regra de prioridade; vazia sem aviso", () => {
    const c = config([maintenance]);
    const s = noticesPromptSection(activeNotices(c, NOW), c);
    expect(s).toContain("# Avisos em vigor (prioridade)");
    expect(s).toContain("- Sistema em manutenção (até 13/10 08:00): O sistema está em manutenção.");
    expect(s).toContain("não transfira por causa da situação descrita no aviso");
    expect(s).toContain("Não acrescente prazo, valor ou condição que o aviso não diz");
    expect(noticesPromptSection([], c)).toBe("");
    // Sem fim informado: sem "até".
    const open = config([{ ...maintenance, endsAt: undefined }]);
    expect(noticesPromptSection(activeNotices(open, NOW), open)).toContain("- Sistema em manutenção: O sistema");
  });

  it("aviso que explica a falha: só com segurar ligado, do assunto ou citado, e uma vez por conversa", () => {
    const c = config([maintenance]);
    expect(noticeExplainingFailure(c, { themeId: "t-pag", message: "deu erro", now: NOW })?.id).toBe("n1");
    expect(noticeExplainingFailure(c, { themeId: "t-pag", message: "deu erro", now: NOW, alreadyShown: ["n1"] })).toBeNull();
    expect(noticeExplainingFailure(config([{ ...maintenance, holdTransfers: false }]), { themeId: "t-pag", message: "deu erro", now: NOW })).toBeNull();
    expect(noticeExplainingFailure(config([{ ...maintenance, themeIds: ["t-doc"], when: [] }]), { themeId: "t-pag", message: "deu erro", now: NOW })).toBeNull();
    expect(noticeExplainingFailure(c, { themeId: "t-pag", message: "deu erro", now: new Date("2026-10-14T12:00:00Z") })).toBeNull();
  });

  it("linha incompleta da tela (sem texto ou sem início) é descartada pelo schema; padrão segura transferência", () => {
    const c = config([{ id: "x", message: " ", startsAt: "2026-10-11T08:00" }, { id: "y", message: "Algo", startsAt: "" }, { message: "Sem id", startsAt: "2026-10-11T08:00" }]);
    expect(c.notices).toHaveLength(1);
    expect(c.notices?.[0]).toMatchObject({ message: "Sem id", holdTransfers: true, themeIds: [], when: [] });
    expect(c.notices?.[0].id).toBeTruthy();
  });
});
