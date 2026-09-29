import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma-base", () => ({ prismaBase: {} }));

import { attachmentKind, attachmentsPromptSection, resendSince } from "../material-attachments";

describe("anexos dos materiais", () => {
  it("tipo pelo mime", () => {
    expect(attachmentKind("video/mp4")).toBe("video");
    expect(attachmentKind("image/png")).toBe("image");
    expect(attachmentKind("audio/ogg")).toBe("audio");
    expect(attachmentKind("application/pdf")).toBe("document");
    expect(attachmentKind(null)).toBe("document");
  });

  it("seção do prompt: id, tipo, nome, material e quando enviar", () => {
    expect(attachmentsPromptSection([])).toBe("");
    const s = attachmentsPromptSection([
      { id: "a1", kind: "document", name: "Tabela de preços", description: "quando pedirem os valores por escrito", docTitle: "Preços" },
      { id: "a2", kind: "image", name: "Tela de login", description: "", docTitle: "Acesso" },
    ]);
    expect(s).toContain('- a1: documento "Tabela de preços" (material "Preços") — enviar quando: quando pedirem os valores por escrito');
    expect(s).toContain('- a2: imagem "Tela de login" (material "Acesso")');
    expect(s).toContain('attachments: ["<id>"]');
  });

  it("trava de repetição por anexo", () => {
    const now = new Date("2026-09-26T12:00:00Z");
    const reset = new Date("2026-09-26T11:50:00Z");
    expect(resendSince("always", reset, now).toISOString()).toBe(now.toISOString());
    // 30 min atrás é antes do #reset: vale o #reset.
    expect(resendSince("30m", reset, now).toISOString()).toBe(reset.toISOString());
    expect(resendSince("30m", null, now).toISOString()).toBe("2026-09-26T11:30:00.000Z");
    expect(resendSince("7d", null, now).toISOString()).toBe("2026-09-19T12:00:00.000Z");
  });
});
