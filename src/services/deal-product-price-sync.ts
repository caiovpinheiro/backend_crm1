import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { createDealEventsMany } from "@/services/deals";

/**
 * Preço do produto ↔ itens dos negócios (`DealProduct`).
 *
 * O item copia `unitPrice`/`discount` quando o produto entra no card. Quando o
 * produto muda de valor, os itens de negócios ABERTOS que ainda estão com o
 * valor antigo daquela cota passam para o novo. Ganhos e perdidos nunca mudam
 * (consulta histórica); item com valor diferente do antigo foi ajustado de
 * propósito e também fica como está.
 *
 * Spec: docs/superpowers/specs/2026-11-23-preco-produto-cards-design.md
 */

/** Uma cota de preço. `discount: null` = produto sem cotas (desconto do item é livre). */
export type PriceOption = { price: number; discount: number | null; channel: string | null };
export type PricePair = { price: number; discount: number | null };
export type PriceChange = { from: PricePair; to: PricePair };

const EPS = 0.005;
const same = (a: number, b: number) => Math.abs(a - b) < EPS;
const samePair = (a: PricePair, b: PricePair) =>
  same(a.price, b.price) && same(a.discount ?? 0, b.discount ?? 0);

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Cotas efetivas do produto: `pricingOptions` do curso, ou o preço base. */
export function readPriceOptions(basePrice: unknown, pricingOptions: unknown): PriceOption[] {
  const base = num(basePrice);
  if (Array.isArray(pricingOptions) && pricingOptions.length > 0) {
    return pricingOptions.map((raw) => {
      const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
      const d = o.discountPercent;
      const channel = typeof o.channel === "string" && o.channel.trim() ? o.channel.trim() : null;
      return {
        price: num(o.price) || base,
        discount: d === null || d === undefined || d === "" ? 0 : num(d),
        channel,
      };
    });
  }
  return [{ price: base, discount: null, channel: null }];
}

function uniqueChannel(list: PriceOption[], channel: string | null): PriceOption | null {
  if (!channel) return null;
  const hits = list.filter((o) => o.channel === channel);
  return hits.length === 1 ? hits[0] : null;
}

/**
 * Mudanças de valor entre as cotas antes/depois do salvamento.
 * Casa pelo canal (quando único nas duas listas), senão pela posição.
 * Um par antigo que ainda existe como cota atual não é propagado.
 */
export function diffPriceChanges(before: PriceOption[], after: PriceOption[]): PriceChange[] {
  const changes: PriceChange[] = [];
  before.forEach((old, i) => {
    const byChannel =
      uniqueChannel(before, old.channel) && uniqueChannel(after, old.channel);
    const next = byChannel ? uniqueChannel(after, old.channel) : (after[i] ?? null);
    if (!next) return;
    const from: PricePair = { price: old.price, discount: old.discount };
    const to: PricePair = { price: next.price, discount: next.discount };
    if (samePair(from, to)) return;
    if (after.some((o) => samePair(o, from))) return;
    if (changes.some((c) => samePair(c.from, from))) return;
    changes.push({ from, to });
  });
  return changes;
}

/**
 * O par (preço, desconto) é o de uma cota cadastrada? Sem cotas, vale o preço
 * base sem desconto.
 */
export function isRegisteredPrice(
  options: PriceOption[],
  unitPrice: number,
  discount: number,
): boolean {
  return options.some(
    (o) => same(o.price, unitPrice) && same(o.discount ?? 0, discount),
  );
}

/**
 * Correção única de itens já defasados: se o par do item não é de nenhuma
 * cota atual e o desconto bate com exatamente uma cota, devolve o par dessa
 * cota. Produto sem cotas (desconto livre) não é corrigido: não há como saber
 * o preço antigo.
 */
export function planStaleFix(
  options: PriceOption[],
  unitPrice: number,
  discount: number,
): PricePair | null {
  if (options.some((o) => o.discount === null)) return null;
  if (isRegisteredPrice(options, unitPrice, discount)) return null;
  const hits = options.filter((o) => same(o.discount ?? 0, discount));
  if (hits.length !== 1) return null;
  return { price: hits[0].price, discount: hits[0].discount };
}

/** Recalcula `deals.value` (soma dos itens) dos negócios informados, numa query só. */
export async function recalcDealValues(dealIds: string[]): Promise<void> {
  if (dealIds.length === 0) return;
  for (let i = 0; i < dealIds.length; i += 500) {
    const chunk = dealIds.slice(i, i + 500);
    await prisma.$executeRaw`
      UPDATE "deals" d
      SET "value" = COALESCE((
        SELECT SUM(dp."quantity" * dp."unitPrice" * (100 - dp."discount") / 100)
        FROM "deal_products" dp
        WHERE dp."dealId" = d."id"
      ), 0)::numeric(12, 2),
      "updatedAt" = NOW()
      WHERE d."id" IN (${Prisma.join(chunk)})
    `;
  }
}

/**
 * Aplica as mudanças aos itens de negócios ABERTOS do produto. Todos os itens
 * são selecionados antes de qualquer escrita, para uma mudança A→B não pegar
 * de novo um item numa mudança B→C do mesmo salvamento.
 */
export async function syncOpenDealPrices(args: {
  productId: string;
  productName: string;
  changes: PriceChange[];
  userId: string | null;
}): Promise<{ items: number; deals: number }> {
  if (args.changes.length === 0) return { items: 0, deals: 0 };

  const plan: Array<{ change: PriceChange; rows: Array<{ id: string; dealId: string; discount: number }> }> = [];
  for (const change of args.changes) {
    const rows = await prisma.dealProduct.findMany({
      where: {
        productId: args.productId,
        deal: { status: "OPEN" },
        unitPrice: new Prisma.Decimal(change.from.price.toFixed(2)),
        ...(change.from.discount !== null
          ? { discount: new Prisma.Decimal(change.from.discount.toFixed(2)) }
          : {}),
      },
      select: { id: true, dealId: true, discount: true },
    });
    plan.push({ change, rows: rows.map((r) => ({ ...r, discount: Number(r.discount) })) });
  }

  const dealIds = new Set<string>();
  const events: Parameters<typeof createDealEventsMany>[0] = [];
  let items = 0;
  for (const { change, rows } of plan) {
    if (rows.length === 0) continue;
    await prisma.dealProduct.updateMany({
      where: { id: { in: rows.map((r) => r.id) } },
      data: {
        unitPrice: change.to.price,
        ...(change.to.discount !== null ? { discount: change.to.discount } : {}),
      },
    });
    items += rows.length;
    for (const r of rows) {
      dealIds.add(r.dealId);
      events.push({
        dealId: r.dealId,
        userId: args.userId,
        type: "PRODUCT_UPDATED",
        meta: {
          productName: args.productName,
          reason: "price_sync",
          fromUnitPrice: change.from.price,
          unitPrice: change.to.price,
          fromDiscount: r.discount,
          discount: change.to.discount ?? r.discount,
        },
      });
    }
  }

  await recalcDealValues([...dealIds]);
  await createDealEventsMany(events);
  return { items, deals: dealIds.size };
}
