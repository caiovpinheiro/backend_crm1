/**
 * Produtos vinculados ao negócio, no formato que o passo Webhook expõe:
 *  - `{{dealProduct.<campo>}}`      → último produto adicionado ao negócio
 *  - `{{dealProducts.<i>.<campo>}}` → lista (0 = último adicionado)
 *  - `{{dealProductsTotal}}`        → soma dos valores finais
 *
 * Valores numéricos saem como número com ponto (`172.43`), que é o que
 * n8n/integrações esperam. Duração, modalidade e nível seguem as mesmas
 * regras da tela do negócio e da mensagem de produto
 * (`product-messages.ts`).
 *
 * Mantenha os campos alinhados com o grupo "Produto do negócio" em
 * `frontend: src/lib/automation-webhook-variables.ts`.
 */
import { prisma } from "@/lib/prisma";
import {
  formatCourseDuration,
  formatCourseLevel,
  formatCourseMode,
  formatProductKind,
} from "@/services/product-messages";

export type WebhookDealProduct = {
  id: string;
  productId: string;
  name: string;
  sku: string;
  kind: string;
  unit: string;
  quantity: number;
  unitPrice: number;
  discount: number;
  finalUnitPrice: number;
  finalPrice: number;
  mode: string;
  level: string;
  grau: string;
  duration: string;
  durationMonths: number | null;
  semesters: number | null;
};

export type WebhookDealProductsRoot = {
  dealProduct: WebhookDealProduct | null;
  dealProducts: WebhookDealProduct[];
  dealProductsTotal: number;
};

const EMPTY: WebhookDealProductsRoot = {
  dealProduct: null,
  dealProducts: [],
  dealProductsTotal: 0,
};

function round2(n: number): number {
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** Algum template do passo cita produto? Evita a query em todo webhook. */
export function webhookUsesDealProducts(cfg: Record<string, unknown>): boolean {
  try {
    return JSON.stringify(cfg).includes("dealProduct");
  } catch {
    return false;
  }
}

type Row = {
  id: string;
  productId: string;
  quantity: unknown;
  unitPrice: unknown;
  discount: unknown;
  product: {
    name: string;
    sku: string | null;
    kind: string;
    unit: string;
    price: unknown;
    courseConfig: {
      mode: string;
      level: string | null;
      grau: string | null;
      semester: number | null;
      pricingOptions: unknown;
    } | null;
  };
};

export function toWebhookDealProduct(row: Row): WebhookDealProduct {
  const quantity = num(row.quantity) || 0;
  const unitPrice = num(row.unitPrice);
  const discount = Math.min(100, Math.max(0, num(row.discount)));
  const finalUnitPrice = round2(unitPrice * (1 - discount / 100));
  const cc = row.product.courseConfig;
  const duration = cc
    ? formatCourseDuration({
        level: cc.level,
        semester: cc.semester,
        pricingOptions: cc.pricingOptions,
        unitPrice,
        discount,
        catalogPrice: num(row.product.price),
      })
    : "";
  const months = /^(\d+) meses$/.exec(duration);
  const semesters = /^(\d+) semestres?$/.exec(duration);
  return {
    id: row.id,
    productId: row.productId,
    name: row.product.name,
    sku: row.product.sku ?? "",
    kind: formatProductKind(row.product.kind),
    unit: row.product.unit,
    quantity,
    unitPrice: round2(unitPrice),
    discount: round2(discount),
    finalUnitPrice,
    finalPrice: round2(finalUnitPrice * quantity),
    mode: cc ? formatCourseMode(cc.mode) : "",
    level: cc ? formatCourseLevel(cc.level) : "",
    grau: cc?.grau?.trim() ?? "",
    duration,
    durationMonths: months ? Number(months[1]) : null,
    semesters: semesters ? Number(semesters[1]) : null,
  };
}

export async function loadDealProductsForWebhook(
  dealId: string | null | undefined,
): Promise<WebhookDealProductsRoot> {
  if (!dealId) return EMPTY;
  const rows = await prisma.dealProduct.findMany({
    where: { dealId },
    // 0 = último adicionado: é o produto "da vez" no card do negócio.
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: {
      id: true,
      productId: true,
      quantity: true,
      unitPrice: true,
      discount: true,
      product: {
        select: {
          name: true,
          sku: true,
          kind: true,
          unit: true,
          price: true,
          courseConfig: {
            select: {
              mode: true,
              level: true,
              grau: true,
              semester: true,
              pricingOptions: true,
            },
          },
        },
      },
    },
  });
  const dealProducts = rows.map((r) => toWebhookDealProduct(r as Row));
  return {
    dealProduct: dealProducts[0] ?? null,
    dealProducts,
    dealProductsTotal: round2(dealProducts.reduce((n, p) => n + p.finalPrice, 0)),
  };
}
