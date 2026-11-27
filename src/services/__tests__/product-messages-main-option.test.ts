import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ productFindUnique: vi.fn(), templateFindMany: vi.fn() }));
vi.mock("@/lib/prisma", () => ({
  prisma: {
    product: { findUnique: mocks.productFindUnique },
    productMessageTemplate: { findMany: mocks.templateFindMany },
  },
}));

import { renderProductMessageForProduct } from "../product-messages";

const PRODUCT = {
  id: "gf", name: "Gestão Financeira", description: null, sku: null, price: 189.5, unit: "mês", kind: "COURSE",
  courseConfig: { level: "GRADUATION", grau: null, mode: "EAD", semester: 8, pricingOptions: [{ price: 189.5, channel: "Black Friday", discountPercent: 35 }], gradeUrl: null, gradeFileName: null, gradeMime: null },
  customValues: [],
};

describe("mensagem do produto: prévia sem preço pedido usa a opção principal (27/11)", () => {
  beforeEach(() => {
    mocks.productFindUnique.mockResolvedValue(PRODUCT);
    mocks.templateFindMany.mockResolvedValue([{ id: "t", name: "T", courseLevel: null, content: "De ~R$ {{preco}}~ por *R$ {{preco_promocional}} ao mês*" }]);
  });

  it("sem unitPrice/discount: 'por' com o desconto da opção principal, igual ao envio da equipe", async () => {
    const r = await renderProductMessageForProduct({ productId: "gf" });
    expect(r.text).toBe("De ~R$ 189,50~ por *R$ 123,17 ao mês*");
  });

  it("com preço e desconto pedidos (envio pelo negócio): vale o que veio", async () => {
    const r = await renderProductMessageForProduct({ productId: "gf", unitPrice: 189.5, discount: 30 });
    expect(r.text).toBe("De ~R$ 189,50~ por *R$ 132,65 ao mês*");
  });
});
