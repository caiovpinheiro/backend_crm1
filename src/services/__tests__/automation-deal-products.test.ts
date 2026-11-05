import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import {
  toWebhookDealProduct,
  webhookUsesDealProducts,
} from "@/services/automation-deal-products";

function row(over: Partial<Parameters<typeof toWebhookDealProduct>[0]> = {}) {
  return {
    id: "dp1",
    productId: "p1",
    quantity: "1",
    unitPrice: "229.91",
    discount: "25",
    product: {
      name: "GEOPROCESSAMENTO",
      sku: "GEO-EAD",
      kind: "COURSE",
      unit: "un",
      price: "229.91",
      courseConfig: {
        mode: "EAD",
        level: "POSTGRADUATE",
        grau: null,
        semester: null,
        pricingOptions: [{ price: 229.91, discountPercent: 25, months: 6 }],
      },
    },
    ...over,
  };
}

describe("toWebhookDealProduct", () => {
  it("pós: valor final, modalidade, nível e meses da opção de preço", () => {
    const p = toWebhookDealProduct(row());
    expect(p).toMatchObject({
      name: "GEOPROCESSAMENTO",
      kind: "Curso",
      quantity: 1,
      unitPrice: 229.91,
      discount: 25,
      finalUnitPrice: 172.43,
      finalPrice: 172.43,
      mode: "EAD",
      level: "Pós-Graduação",
      duration: "6 meses",
      durationMonths: 6,
      semesters: null,
    });
  });

  it("graduação: duração em semestres, valor final multiplica quantidade", () => {
    const p = toWebhookDealProduct(
      row({
        quantity: "2",
        unitPrice: "100",
        discount: "10",
        product: {
          ...row().product,
          courseConfig: {
            mode: "HYBRID",
            level: "GRADUATION",
            grau: "Bacharelado",
            semester: 8,
            pricingOptions: [],
          },
        },
      }),
    );
    expect(p).toMatchObject({
      finalUnitPrice: 90,
      finalPrice: 180,
      mode: "Semi-Presencial",
      level: "Graduação",
      grau: "Bacharelado",
      duration: "8 semestres",
      durationMonths: null,
      semesters: 8,
    });
  });

  it("produto sem curso: campos de curso vazios", () => {
    const p = toWebhookDealProduct(
      row({ product: { ...row().product, kind: "PHYSICAL", courseConfig: null } }),
    );
    expect(p).toMatchObject({ kind: "Físico", mode: "", level: "", duration: "", durationMonths: null });
  });
});

describe("webhookUsesDealProducts", () => {
  it("só carrega quando algum template cita o produto", () => {
    expect(webhookUsesDealProducts({ body: '{"curso":"{{dealProduct.name}}"}' })).toBe(true);
    expect(webhookUsesDealProducts({ body: '{"id":"{{deal.id}}"}' })).toBe(false);
  });
});
