/**
 * Pedido do catálogo WhatsApp (webhook `messages[].type = "order"`).
 * O preço gravado é o do payload da Meta, não o preço atual do produto.
 */

import { prisma } from "@/lib/prisma";

export type WhatsappOrderItem = {
  productRetailerId: string;
  quantity: number;
  itemPrice: number;
  currency: string;
  productId: string | null;
  name: string;
  imageUrl: string | null;
};

export type WhatsappOrderSnapshot = {
  catalogId: string;
  text: string | null;
  currency: string;
  items: WhatsappOrderItem[];
  total: number;
};

export type OrderProductMatch = {
  productRetailerId: string;
  productId: string;
  name: string;
  imageUrl: string | null;
};

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function asString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function asNumber(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim()) {
    const n = Number(v.replace(",", "."));
    if (Number.isFinite(n)) return n;
  }
  return 0;
}

function roundMoney(n: number): number {
  return Math.round(n * 100) / 100;
}

export function formatOrderMoney(amount: number, currency: string): string {
  const code = currency.trim() || "BRL";
  try {
    return new Intl.NumberFormat("pt-BR", {
      style: "currency",
      currency: code,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${code}`;
  }
}

/** Extrai o pedido. Itens sem id continuam na lista. `null` se não houver bloco `order`. */
export function parseWhatsappOrder(
  message: Record<string, unknown>,
): WhatsappOrderSnapshot | null {
  const order = asRecord(message.order);
  if (!order) return null;

  const catalogId = asString(order.catalog_id);
  const note = asString(order.text) || null;
  const rawItems = Array.isArray(order.product_items) ? order.product_items : [];
  const items: WhatsappOrderItem[] = rawItems.map((raw, index) => {
    const item = asRecord(raw) ?? {};
    const productRetailerId =
      asString(item.product_retailer_id) || `item-${index + 1}`;
    const quantity = Math.max(1, Math.round(asNumber(item.quantity) || 1));
    const itemPrice = roundMoney(Math.max(0, asNumber(item.item_price)));
    const currency = asString(item.currency) || "BRL";
    return {
      productRetailerId,
      quantity,
      itemPrice,
      currency,
      productId: null,
      name: productRetailerId,
      imageUrl: null,
    };
  });

  const currency = items[0]?.currency || "BRL";
  const total = roundMoney(
    items.reduce((sum, item) => sum + item.itemPrice * item.quantity, 0),
  );

  return { catalogId, text: note, currency, items, total };
}

/** Casa só por ProductMetaLink (canal + catálogo Meta + retailer id). Não troca o preço. */
export function applyOrderProductMatches(
  order: WhatsappOrderSnapshot,
  matches: OrderProductMatch[],
): WhatsappOrderSnapshot {
  const byRetailer = new Map(
    matches.map((m) => [m.productRetailerId, m] as const),
  );
  const items = order.items.map((item) => {
    const hit = byRetailer.get(item.productRetailerId);
    if (!hit) return item;
    return {
      ...item,
      productId: hit.productId,
      name: hit.name || item.productRetailerId,
      imageUrl: hit.imageUrl,
    };
  });
  return { ...order, items };
}

export function formatWhatsappOrderText(order: WhatsappOrderSnapshot): string {
  const lines = ["Pedido do catálogo"];
  if (order.text) lines.push(order.text);
  if (order.items.length === 0) {
    lines.push("Nenhum item informado.");
  } else {
    for (const item of order.items) {
      lines.push(
        `${item.name} × ${item.quantity} — ${formatOrderMoney(item.itemPrice, item.currency)}`,
      );
    }
    lines.push(`Total: ${formatOrderMoney(order.total, order.currency)}`);
  }
  return lines.join("\n");
}

export function isWhatsappOrderSnapshot(v: unknown): v is WhatsappOrderSnapshot {
  const o = asRecord(v);
  return Boolean(o && Array.isArray(o.items) && typeof o.catalogId === "string");
}

export async function enrichWhatsappOrder(
  order: WhatsappOrderSnapshot,
  channelId: string | null | undefined,
): Promise<WhatsappOrderSnapshot> {
  if (!channelId || !order.catalogId || order.items.length === 0) return order;
  const retailerIds = [...new Set(order.items.map((i) => i.productRetailerId))];
  const links = await prisma.productMetaLink.findMany({
    where: {
      channelId,
      metaCatalogId: order.catalogId,
      productRetailerId: { in: retailerIds },
    },
    select: {
      productRetailerId: true,
      product: { select: { id: true, name: true, imageUrl: true } },
    },
  });
  return applyOrderProductMatches(
    order,
    links.map((link) => ({
      productRetailerId: link.productRetailerId,
      productId: link.product.id,
      name: link.product.name,
      imageUrl: link.product.imageUrl ?? null,
    })),
  );
}
