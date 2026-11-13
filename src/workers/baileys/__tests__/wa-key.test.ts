import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/prisma-base", () => ({ prismaBase: {} }));

const { waKeyFor } = await import("../outbound-consumer");

describe("waKeyFor (citar/reagir)", () => {
  it("mensagem de participante em grupo leva o participant", () => {
    expect(waKeyFor("1@g.us", { id: "WA1", fromMe: false, participant: "77@lid" })).toEqual({
      remoteJid: "1@g.us",
      id: "WA1",
      fromMe: false,
      participant: "77@lid",
    });
  });

  it("mensagem do próprio número ou conversa 1:1: sem participant", () => {
    expect(waKeyFor("1@g.us", { id: "WA2", fromMe: true, participant: "x" })).toEqual({
      remoteJid: "1@g.us",
      id: "WA2",
      fromMe: true,
    });
    expect(waKeyFor("55@s.whatsapp.net", { id: "WA3", fromMe: false, participant: "x" })).not.toHaveProperty(
      "participant",
    );
  });
});
