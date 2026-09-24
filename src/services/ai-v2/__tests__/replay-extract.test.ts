import { describe, expect, it } from "vitest";
import { extractReplayPoints, type ReplayMessageRow } from "../replay-extract";

let t = 0;
function m(direction: "in" | "out", content: string, authorType = direction === "in" ? "contact" : "human", messageType = "text"): ReplayMessageRow {
  t += 60_000;
  return { direction, content, authorType, messageType, createdAt: new Date(1_800_000_000_000 + t) };
}

describe("extractReplayPoints", () => {
  it("junta bolhas do cliente, pega a resposta humana e o histórico", () => {
    const pts = extractReplayPoints([
      m("in", "Bom dia"),
      m("out", "Olá! Bem vindo", "bot"),
      m("in", "quero cancelar"),
      m("in", "não consigo pagar"),
      m("out", "Por qual motivo?"),
      m("in", "financeiro"),
      m("out", "Segue o passo a passo"),
      m("out", "", "human", "image"),
    ]);
    expect(pts).toHaveLength(2);
    expect(pts[0].clientText).toBe("quero cancelar\nnão consigo pagar");
    expect(pts[0].humanText).toBe("Por qual motivo?");
    expect(pts[0].history.map((h) => h.role)).toEqual(["user", "assistant"]);
    expect(pts[1].humanText).toBe("Segue o passo a passo\n[imagem]");
    expect(pts[1].skipReason).toBeNull();
  });

  it("marca como não avaliável resposta só em áudio e cliente só com mídia", () => {
    const pts = extractReplayPoints([
      m("in", "como faço?"),
      m("out", "", "human", "ptt"),
      m("in", "[Imagem]", "contact", "image"),
      m("out", "Entendi, é isso"),
    ]);
    expect(pts[0].skipReason).toContain("mídia");
    expect(pts[1].skipReason).toContain("Cliente");
  });

  it("mascara dados sensíveis", () => {
    const pts = extractReplayPoints([m("in", "cpf 529.982.247-25"), m("out", "Seu e-mail: ana@x.com Senha: Ana@123")]);
    expect(pts[0].clientText).not.toContain("982.247");
    expect(pts[0].humanText).not.toContain("Ana@123");
  });

  it("ignora resposta só de robô e respeita o limite de pontos", () => {
    const rows: ReplayMessageRow[] = [m("in", "oi"), m("out", "menu", "bot")];
    for (let i = 0; i < 10; i++) rows.push(m("in", `p${i}`), m("out", `r${i}`));
    const pts = extractReplayPoints(rows, { maxPoints: 3 });
    expect(pts).toHaveLength(3);
    expect(pts[0].clientText).toBe("p0");
  });
});
