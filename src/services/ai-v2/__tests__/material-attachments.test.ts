import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma-base", () => ({ prismaBase: {} }));

import { attachmentKind, attachmentsPromptSection } from "../material-attachments";

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
});
