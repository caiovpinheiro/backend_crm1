import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/services/deals", () => ({ createDealEventsMany: vi.fn() }));

import {
  diffPriceChanges,
  isRegisteredPrice,
  planStaleFix,
  readPriceOptions,
} from "@/services/deal-product-price-sync";

describe("readPriceOptions", () => {
  it("curso: lê as cotas (preço, desconto, canal)", () => {
    expect(
      readPriceOptions(210.5, [{ price: 210.5, discountPercent: 30, channel: "Esquenta Black" }]),
    ).toEqual([{ price: 210.5, discount: 30, channel: "Esquenta Black" }]);
  });

  it("cota com preço 0 usa o preço base do produto", () => {
    expect(readPriceOptions("150", [{ price: 0, discountPercent: 10, channel: null }])).toEqual([
      { price: 150, discount: 10, channel: null },
    ]);
  });

  it("sem cotas: só o preço base, desconto livre (null)", () => {
    expect(readPriceOptions("99.9", null)).toEqual([{ price: 99.9, discount: null, channel: null }]);
    expect(readPriceOptions("99.9", [])).toEqual([{ price: 99.9, discount: null, channel: null }]);
  });
});

describe("diffPriceChanges", () => {
  it("Gestão de Turismo: 199,90 → 210,50 mantendo 30%", () => {
    const before = [{ price: 199.9, discount: 30, channel: "Esquenta Black" }];
    const after = [{ price: 210.5, discount: 30, channel: "Esquenta Black" }];
    expect(diffPriceChanges(before, after)).toEqual([
      { from: { price: 199.9, discount: 30 }, to: { price: 210.5, discount: 30 } },
    ]);
  });

  it("sem mudança de valores: nada a propagar", () => {
    const opts = [{ price: 100, discount: 10, channel: "A" }];
    expect(diffPriceChanges(opts, [...opts])).toEqual([]);
  });

  it("casa pelo canal mesmo com a ordem trocada", () => {
    const before = [
      { price: 100, discount: 10, channel: "A" },
      { price: 200, discount: 20, channel: "B" },
    ];
    const after = [
      { price: 250, discount: 20, channel: "B" },
      { price: 100, discount: 10, channel: "A" },
    ];
    expect(diffPriceChanges(before, after)).toEqual([
      { from: { price: 200, discount: 20 }, to: { price: 250, discount: 20 } },
    ]);
  });

  it("sem canal: casa pela posição", () => {
    const before = [
      { price: 100, discount: 0, channel: null },
      { price: 200, discount: 5, channel: null },
    ];
    const after = [
      { price: 110, discount: 0, channel: null },
      { price: 200, discount: 5, channel: null },
    ];
    expect(diffPriceChanges(before, after)).toEqual([
      { from: { price: 100, discount: 0 }, to: { price: 110, discount: 0 } },
    ]);
  });

  it("par antigo que continua existindo como outra cota não é propagado", () => {
    const before = [
      { price: 100, discount: 0, channel: null },
      { price: 200, discount: 0, channel: null },
    ];
    const after = [
      { price: 200, discount: 0, channel: null },
      { price: 300, discount: 0, channel: null },
    ];
    // 100→200 propaga; 200→300 não, porque 200/0 ainda é uma cota válida.
    expect(diffPriceChanges(before, after)).toEqual([
      { from: { price: 100, discount: 0 }, to: { price: 200, discount: 0 } },
    ]);
  });

  it("cota removida sem correspondente: não propaga", () => {
    const before = [
      { price: 100, discount: 0, channel: "A" },
      { price: 200, discount: 0, channel: "B" },
    ];
    const after = [{ price: 100, discount: 0, channel: "A" }];
    expect(diffPriceChanges(before, after)).toEqual([]);
  });

  it("produto sem cotas: muda só o preço, desconto do item fica", () => {
    expect(
      diffPriceChanges(
        [{ price: 50, discount: null, channel: null }],
        [{ price: 60, discount: null, channel: null }],
      ),
    ).toEqual([{ from: { price: 50, discount: null }, to: { price: 60, discount: null } }]);
  });
});

describe("isRegisteredPrice", () => {
  const opts = [
    { price: 210.5, discount: 30, channel: "Esquenta Black" },
    { price: 300, discount: 0, channel: null },
  ];

  it("aceita o par de uma cota cadastrada", () => {
    expect(isRegisteredPrice(opts, 210.5, 30)).toBe(true);
    expect(isRegisteredPrice(opts, 300, 0)).toBe(true);
  });

  it("recusa preço ou desconto digitado", () => {
    expect(isRegisteredPrice(opts, 199.9, 30)).toBe(false);
    expect(isRegisteredPrice(opts, 210.5, 40)).toBe(false);
  });

  it("sem cotas: só o preço base sem desconto", () => {
    const base = [{ price: 99.9, discount: null, channel: null }];
    expect(isRegisteredPrice(base, 99.9, 0)).toBe(true);
    expect(isRegisteredPrice(base, 99.9, 15)).toBe(false);
    expect(isRegisteredPrice(base, 80, 0)).toBe(false);
  });
});

describe("planStaleFix", () => {
  const turismo = [{ price: 210.5, discount: 30, channel: "Esquenta Black" }];

  it("card da Thuanny: 199,90/30% → 210,50/30%", () => {
    expect(planStaleFix(turismo, 199.9, 30)).toEqual({ price: 210.5, discount: 30 });
  });

  it("item já no valor atual: nada a fazer", () => {
    expect(planStaleFix(turismo, 210.5, 30)).toBeNull();
  });

  it("desconto que não é de nenhuma cota (ajuste manual): não mexe", () => {
    expect(planStaleFix(turismo, 199.9, 25)).toBeNull();
  });

  it("duas cotas com o mesmo desconto: ambíguo, não mexe", () => {
    const opts = [
      { price: 100, discount: 30, channel: "A" },
      { price: 120, discount: 30, channel: "B" },
    ];
    expect(planStaleFix(opts, 90, 30)).toBeNull();
  });

  it("produto sem cotas: não mexe", () => {
    expect(planStaleFix([{ price: 50, discount: null, channel: null }], 40, 0)).toBeNull();
  });
});
