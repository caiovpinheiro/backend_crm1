import { describe, expect, it } from "vitest";

import { buildWebchatS2SNote, isValidIdempotencyKey, parseWebchatS2SBody } from "@/lib/webchat/s2s/body";

describe("corpo do S2S", () => {
  it("normaliza o pedido completo", () => {
    const r = parseWebchatS2SBody({
      external_id: " ext-1 ",
      ref: "REF-1",
      category: " suporte ",
      priority: "alta",
      text: "linha 1\r\nlinha 2",
      fields: { etapa: "2" },
      links: [{ label: "Ver histórico", url: "https://sistema.example.test/h/1" }],
    });
    expect(r).toEqual({
      ok: true,
      request: {
        externalId: "ext-1",
        ref: "REF-1",
        category: "suporte",
        priority: "alta",
        text: "linha 1\nlinha 2",
        fields: { etapa: "2" },
        links: [{ label: "Ver histórico", url: "https://sistema.example.test/h/1" }],
      },
    });
  });

  it("exige external_id e text ou fields", () => {
    expect(parseWebchatS2SBody({ text: "oi" }).ok).toBe(false);
    expect(parseWebchatS2SBody({ external_id: "ext-1" }).ok).toBe(false);
    expect(parseWebchatS2SBody({ external_id: "ext-1", fields: {} }).ok).toBe(false);
    expect(parseWebchatS2SBody({ external_id: "ext-1", fields: { etapa: 1 } }).ok).toBe(true);
    expect(parseWebchatS2SBody([]).ok).toBe(false);
  });

  it("recusa limites e tipos errados", () => {
    const base = { external_id: "ext-1", text: "oi" };
    expect(parseWebchatS2SBody({ ...base, external_id: "x".repeat(129) }).ok).toBe(false);
    expect(parseWebchatS2SBody({ ...base, ref: "x".repeat(129) }).ok).toBe(false);
    expect(parseWebchatS2SBody({ ...base, category: "x".repeat(65) }).ok).toBe(false);
    expect(parseWebchatS2SBody({ ...base, priority: 3 }).ok).toBe(false);
    expect(parseWebchatS2SBody({ ...base, text: "x".repeat(4001) }).ok).toBe(false);
    expect(parseWebchatS2SBody({ ...base, fields: "etapa" }).ok).toBe(false);
  });

  it("links: só https, sem credenciais, até 5", () => {
    const base = { external_id: "ext-1", text: "oi" };
    const link = { label: "Abrir", url: "https://sistema.example.test/x" };
    expect(parseWebchatS2SBody({ ...base, links: [link] }).ok).toBe(true);
    expect(parseWebchatS2SBody({ ...base, links: [{ ...link, url: "http://sistema.example.test/x" }] }).ok).toBe(false);
    expect(parseWebchatS2SBody({ ...base, links: [{ ...link, url: "javascript:alert(1)" }] }).ok).toBe(false);
    expect(parseWebchatS2SBody({ ...base, links: [{ ...link, url: "https://u:p@sistema.example.test/" }] }).ok).toBe(false);
    expect(parseWebchatS2SBody({ ...base, links: [{ ...link, label: "" }] }).ok).toBe(false);
    expect(parseWebchatS2SBody({ ...base, links: new Array(6).fill(link) }).ok).toBe(false);
  });

  it("nota: texto + uma linha `label — url` por link", () => {
    expect(
      buildWebchatS2SNote("Precisa de ajuda", [
        { label: "Ver histórico", url: "https://sistema.example.test/h/1" },
        { label: "Abrir item", url: "https://sistema.example.test/i/2" },
      ]),
    ).toBe(
      "Precisa de ajuda\n\nVer histórico — https://sistema.example.test/h/1\nAbrir item — https://sistema.example.test/i/2",
    );
    expect(buildWebchatS2SNote(null, [])).toBeNull();
    expect(buildWebchatS2SNote(null, [{ label: "A", url: "https://a.example.test/" }])).toBe(
      "A — https://a.example.test/",
    );
  });

  it("Idempotency-Key", () => {
    expect(isValidIdempotencyKey("pedido:2026-10-28.1_a-b")).toBe(true);
    expect(isValidIdempotencyKey("")).toBe(false);
    expect(isValidIdempotencyKey(null)).toBe(false);
    expect(isValidIdempotencyKey("x".repeat(129))).toBe(false);
    expect(isValidIdempotencyKey("com espaço")).toBe(false);
  });
});
