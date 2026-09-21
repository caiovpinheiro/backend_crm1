import { describe, expect, it } from "vitest";

import {
  applyOrderProductMatches,
  formatWhatsappOrderText,
  parseWhatsappOrder,
  type WhatsappOrderSnapshot,
} from "@/lib/whatsapp-catalog-order";

const base = {
  id: "wamid.ORDER1",
  timestamp: "1710000000",
  type: "order",
};

describe("parseWhatsappOrder", () => {
  it("lê um produto com preço decimal", () => {
    const order = parseWhatsappOrder({
      ...base,
      order: {
        catalog_id: "cat-1",
        text: "quero este",
        product_items: [
          {
            product_retailer_id: "sku-a",
            quantity: 1,
            item_price: 12.5,
            currency: "BRL",
          },
        ],
      },
    });
    expect(order?.catalogId).toBe("cat-1");
    expect(order?.text).toBe("quero este");
    expect(order?.items).toHaveLength(1);
    expect(order?.items[0]).toMatchObject({
      productRetailerId: "sku-a",
      quantity: 1,
      itemPrice: 12.5,
      currency: "BRL",
      productId: null,
      name: "sku-a",
    });
    expect(order?.total).toBe(12.5);
  });

  it("lê vários produtos e quantidades", () => {
    const order = parseWhatsappOrder({
      ...base,
      id: "wamid.ORDER2",
      order: {
        catalog_id: "cat-1",
        product_items: [
          { product_retailer_id: "a", quantity: 2, item_price: 10, currency: "BRL" },
          { product_retailer_id: "b", quantity: 3, item_price: "4.25", currency: "BRL" },
        ],
      },
    });
    expect(order?.items.map((i) => [i.productRetailerId, i.quantity])).toEqual([
      ["a", 2],
      ["b", 3],
    ]);
    expect(order?.total).toBe(32.75);
    expect(formatWhatsappOrderText(order!)).toContain("a × 2");
    expect(formatWhatsappOrderText(order!)).toContain("b × 3");
    expect(formatWhatsappOrderText(order!)).not.toBe("[order]");
  });

  it("mantém item desconhecido e não descarta o pedido", () => {
    const parsed = parseWhatsappOrder({
      ...base,
      order: {
        catalog_id: "cat-9",
        product_items: [
          { product_retailer_id: "desconhecido", quantity: 1, item_price: 9.9, currency: "BRL" },
        ],
      },
    });
    const enriched = applyOrderProductMatches(parsed!, [
      {
        productRetailerId: "outro",
        productId: "p1",
        name: "Não deve casar",
        imageUrl: null,
      },
    ]);
    expect(enriched.items[0]?.productId).toBeNull();
    expect(enriched.items[0]?.name).toBe("desconhecido");
    expect(enriched.items[0]?.itemPrice).toBe(9.9);
  });

  it("casa pelo retailer id e preserva o preço do pedido", () => {
    const parsed = parseWhatsappOrder({
      ...base,
      order: {
        catalog_id: "cat-1",
        product_items: [
          { product_retailer_id: "sku-a", quantity: 2, item_price: 15.4, currency: "BRL" },
        ],
      },
    });
    const enriched = applyOrderProductMatches(parsed!, [
      {
        productRetailerId: "sku-a",
        productId: "prod-1",
        name: "Curso de Inglês",
        imageUrl: "https://cdn.example/capa.jpg",
      },
    ]);
    expect(enriched.items[0]).toMatchObject({
      productId: "prod-1",
      name: "Curso de Inglês",
      imageUrl: "https://cdn.example/capa.jpg",
      itemPrice: 15.4,
    });
  });

  it("mensagem duplicada produz o mesmo pedido", () => {
    const payload = {
      ...base,
      order: {
        catalog_id: "cat-1",
        product_items: [
          { product_retailer_id: "sku-a", quantity: 1, item_price: 10, currency: "BRL" },
        ],
      },
    };
    const a = parseWhatsappOrder(payload);
    const b = parseWhatsappOrder(payload);
    expect(a).toEqual(b);
    expect(payload.id).toBe("wamid.ORDER1");
  });

  it("o snapshot sobrevive ao reidratar o histórico", () => {
    const parsed = parseWhatsappOrder({
      ...base,
      order: {
        catalog_id: "cat-1",
        product_items: [
          { product_retailer_id: "sku-a", quantity: 4, item_price: 1.1, currency: "BRL" },
        ],
      },
    })!;
    const stored = JSON.parse(JSON.stringify(parsed)) as WhatsappOrderSnapshot;
    expect(stored.items[0]?.quantity).toBe(4);
    expect(stored.total).toBe(4.4);
    expect(formatWhatsappOrderText(stored)).toContain("Total:");
  });
});
