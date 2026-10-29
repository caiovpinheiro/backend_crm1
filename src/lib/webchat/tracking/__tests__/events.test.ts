/**
 * Linha do tempo do site — validação do lote e texto da nota (puro).
 * Dados neutros.
 */
import { describe, expect, it } from "vitest";

import {
  buildImportantEventNote,
  resolveEventTime,
  sanitizeEventData,
  sanitizeWebchatEventBatch,
  WEBCHAT_EVENT_MAX_AGE_MS,
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

describe("buildImportantEventNote", () => {
  it("texto neutro com rótulo da config ou a chave", () => {
    expect(
      buildImportantEventNote(
        { name: "passo_concluido", data: { etapa: 2, ok: false } },
        { etapa: "Etapa atual" },
      ),
    ).toBe("Evento no site: passo_concluido\nEtapa atual: 2\nok: false");
  });

  it("sem dados, só o título", () => {
    expect(buildImportantEventNote({ name: "ajuda", data: null }, {})).toBe("Evento no site: ajuda");
  });
});
