/**
 * Linha do tempo do site — validação do lote e texto da nota (puro).
 * Dados neutros.
 */
import { describe, expect, it } from "vitest";

import {
  buildImportantEventNote,
  humanizeWebchatKey,
  resolveEventTime,
  sanitizeEventData,
  sanitizeWebchatEventBatch,
  WEBCHAT_EVENT_MAX_AGE_MS,
  WEBCHAT_NOTE_MAX_DATA_LINES,
  webchatKeyLabel,
} from "@/lib/webchat/tracking/events";

const NOW = new Date("2026-10-28T12:00:00.000Z");
const LIMITS = { maxPerBatch: 3, maxValueChars: 5 };

describe("sanitizeWebchatEventBatch", () => {
  it("lote acima de maxPerBatch é recusado inteiro", () => {
    const res = sanitizeWebchatEventBatch(
      [{ name: "a" }, { name: "b" }, { name: "c" }, { name: "d" }],
      LIMITS,
      NOW,
    );
    expect(res).toEqual({ ok: false, code: "TOO_MANY_EVENTS" });
  });

  it("events que não é lista → INVALID_BODY", () => {
    expect(sanitizeWebchatEventBatch({ name: "a" }, LIMITS, NOW)).toEqual({ ok: false, code: "INVALID_BODY" });
    expect(sanitizeWebchatEventBatch(undefined, LIMITS, NOW)).toEqual({ ok: false, code: "INVALID_BODY" });
  });

  it("aceita os válidos e ignora os inválidos com o motivo e o índice", () => {
    const res = sanitizeWebchatEventBatch(
      [
        { name: "passo_concluido", data: { etapa: 2, ok: true, nota: "abcdefgh" }, important: true },
        { name: "-ruim" },
        "texto",
      ],
      LIMITS,
      NOW,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.events).toEqual([
      {
        index: 0,
        name: "passo_concluido",
        data: { etapa: 2, ok: true, nota: "abcde" },
        flaggedImportant: true,
        occurredAt: NOW,
      },
    ]);
    expect(res.ignored).toEqual([
      { index: 1, reason: "INVALID_NAME" },
      { index: 2, reason: "INVALID_EVENT" },
    ]);
  });

  it("lote vazio é válido", () => {
    expect(sanitizeWebchatEventBatch([], LIMITS, NOW)).toEqual({ ok: true, events: [], ignored: [] });
  });

  it("`at` velho demais e inválido são ignorados", () => {
    const res = sanitizeWebchatEventBatch(
      [
        { name: "a", at: NOW.getTime() - WEBCHAT_EVENT_MAX_AGE_MS - 1 },
        { name: "b", at: "não é data" },
      ],
      LIMITS,
      NOW,
    );
    expect(res.ok && res.ignored).toEqual([
      { index: 0, reason: "AT_OUT_OF_RANGE" },
      { index: 1, reason: "INVALID_AT" },
    ]);
  });
});

describe("sanitizeEventData", () => {
  it("sem data → null; objeto vazio ou só nulls → null", () => {
    expect(sanitizeEventData(undefined, 10)).toBeNull();
    expect(sanitizeEventData({ a: null }, 10)).toBeNull();
  });

  it("mais de 10 chaves, chave inválida ou valor não simples invalidam o evento", () => {
    const big = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`k${i}`, i]));
    expect(sanitizeEventData(big, 10)).toBeUndefined();
    expect(sanitizeEventData({ "chave inválida": 1 }, 10)).toBeUndefined();
    expect(sanitizeEventData({ obj: { x: 1 } }, 10)).toBeUndefined();
    expect(sanitizeEventData({ n: Number.NaN }, 10)).toBeUndefined();
    expect(sanitizeEventData([1, 2], 10)).toBeUndefined();
  });

  it("limpa caracteres de controle", () => {
    expect(sanitizeEventData({ t: "a\nb" }, 10)).toEqual({ t: "a b" });
  });
});

describe("resolveEventTime", () => {
  it("ISO e ms epoch; futuro vira agora", () => {
    const past = new Date(NOW.getTime() - 60_000);
    expect(resolveEventTime(past.toISOString(), NOW)).toEqual({ ok: true, at: past });
    expect(resolveEventTime(past.getTime(), NOW)).toEqual({ ok: true, at: past });
    expect(resolveEventTime(NOW.getTime() + 60_000, NOW)).toEqual({ ok: true, at: NOW });
    expect(resolveEventTime(undefined, NOW)).toEqual({ ok: true, at: NOW });
  });
});

describe("humanizeWebchatKey / webchatKeyLabel", () => {
  it("snake, kebab e camelCase viram texto com a primeira maiúscula", () => {
    expect(humanizeWebchatKey("nivel_titulo")).toBe("Nivel titulo");
    expect(humanizeWebchatKey("tela-aberta")).toBe("Tela aberta");
    expect(humanizeWebchatKey("pageView")).toBe("Page view");
    expect(humanizeWebchatKey("pageURL")).toBe("Page URL");
    expect(humanizeWebchatKey("passo2_ok")).toBe("Passo2 ok");
    expect(humanizeWebchatKey("__x__")).toBe("X");
  });

  it("rótulo da config tem precedência; sem rótulo (ou vazio), a chave legível", () => {
    expect(webchatKeyLabel("etapa", { etapa: "Etapa atual" })).toBe("Etapa atual");
    expect(webchatKeyLabel("etapa", { etapa: "  " })).toBe("Etapa");
    expect(webchatKeyLabel("secao_atual", {})).toBe("Secao atual");
    expect(webchatKeyLabel("constructor", {})).toBe("Constructor");
  });
});

describe("buildImportantEventNote", () => {
  it("título com o nome legível e uma linha por dado com rótulo ou chave legível", () => {
    expect(
      buildImportantEventNote(
        { name: "passo_concluido", data: { etapa: 2, ok: false, secao_atual: "Inicio" } },
        { etapa: "Etapa atual" },
      ),
    ).toBe("📍 Evento no site · Passo concluido\nEtapa atual: 2\nOk: não\nSecao atual: Inicio");
  });

  it("nome do evento também usa o rótulo da config", () => {
    expect(buildImportantEventNote({ name: "pediu_ajuda", data: null }, { pediu_ajuda: "Pedido de ajuda" })).toBe(
      "📍 Evento no site · Pedido de ajuda",
    );
  });

  it("texto repetido de outra chave sai uma vez; números iguais continuam", () => {
    expect(
      buildImportantEventNote(
        {
          name: "trilha_avancou",
          data: { etapa: 1, parte: 1, etapa_titulo: "Primeiro passo", parte_titulo: "Primeiro passo" },
        },
        {},
      ),
    ).toBe("📍 Evento no site · Trilha avancou\nEtapa: 1\nParte: 1\nEtapa titulo: Primeiro passo");
  });

  it("corta em WEBCHAT_NOTE_MAX_DATA_LINES linhas de dados e resume o resto", () => {
    const data = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`campo_${i}`, `valor ${i}`]));
    const note = buildImportantEventNote({ name: "formulario", data }, {});
    const lines = note.split("\n");
    expect(lines).toHaveLength(1 + WEBCHAT_NOTE_MAX_DATA_LINES + 1);
    expect(lines[1]).toBe("Campo 0: valor 0");
    expect(lines.at(-1)).toBe("+3 outros dados");
    const one = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`c${i}`, `v${i}`]));
    expect(buildImportantEventNote({ name: "f", data: one }, {}).split("\n").at(-1)).toBe("+1 outro dado");
  });

  it("sem dados, só o título", () => {
    expect(buildImportantEventNote({ name: "ajuda", data: null }, {})).toBe("📍 Evento no site · Ajuda");
  });
});
