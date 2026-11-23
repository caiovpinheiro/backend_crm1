/**
 * backfill-deal-product-prices
 *
 * Correção única: itens de negócios ABERTOS que ficaram com o preço antigo de
 * um produto (adicionados antes da atualização de valores) passam para o preço
 * atual da cota. Ganhos e perdidos não mudam. Regra em `planStaleFix`
 * (src/services/deal-product-price-sync.ts): só corrige quando o par
 * (preço, desconto) do item não é de nenhuma cota atual e o desconto bate com
 * exatamente uma cota. Ajustes manuais com outro desconto ficam como estão.
 *
 * Uso (DATABASE_URL de .env.local / .env):
 *   npx tsx src/scripts/backfill-deal-product-prices.ts --org <orgId>           # relatório
 *   npx tsx src/scripts/backfill-deal-product-prices.ts --org <orgId> --apply   # grava
 *
 * Spec: docs/superpowers/specs/2026-11-23-preco-produto-cards-design.md
 */

import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";

loadEnv({ path: resolve(process.cwd(), ".env.local") });
loadEnv({ path: resolve(process.cwd(), ".env") });

const brl = (n: number) => n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

async function main() {
  const argv = process.argv.slice(2);
  const apply = argv.includes("--apply");
  const orgIdx = argv.indexOf("--org");
  const orgId = orgIdx >= 0 ? argv[orgIdx + 1] : undefined;
  if (!orgId) {
    console.error("Uso: backfill-deal-product-prices.ts --org <organizationId> [--apply]");
    process.exit(1);
  }

  const { prisma } = await import("@/lib/prisma");
  const { withSystemContext } = await import("@/lib/webhook-context");
  const { planStaleFix, readPriceOptions, syncOpenDealPrices } = await import(
    "@/services/deal-product-price-sync"
  );

  await withSystemContext(orgId, async () => {
    const products = await prisma.product.findMany({
      where: { courseConfig: { isNot: null } },
      select: { id: true, name: true, price: true, courseConfig: { select: { pricingOptions: true } } },
      orderBy: { name: "asc" },
    });

    let totalItems = 0;
    let totalDeals = 0;
    for (const p of products) {
      const options = readPriceOptions(p.price, p.courseConfig?.pricingOptions);
      const rows = await prisma.dealProduct.findMany({
        where: { productId: p.id, deal: { status: "OPEN" } },
        select: { unitPrice: true, discount: true },
      });
      const groups = new Map<string, { from: { price: number; discount: number }; to: { price: number; discount: number | null }; n: number }>();
      for (const r of rows) {
        const price = Number(r.unitPrice);
        const discount = Number(r.discount);
        const to = planStaleFix(options, price, discount);
        if (!to) continue;
        const key = `${price}|${discount}`;
        const g = groups.get(key) ?? { from: { price, discount }, to, n: 0 };
        g.n++;
        groups.set(key, g);
      }
      for (const g of groups.values()) {
        console.log(
          `${p.name}: ${g.n} item(ns) ${brl(g.from.price)} (${g.from.discount}%) → ${brl(g.to.price)} (${g.to.discount ?? g.from.discount}%)`,
        );
        if (apply) {
          const res = await syncOpenDealPrices({
            productId: p.id,
            productName: p.name,
            changes: [{ from: g.from, to: g.to }],
            userId: null,
          });
          totalItems += res.items;
          totalDeals += res.deals;
        } else {
          totalItems += g.n;
        }
      }
    }

    console.log(
      apply
        ? `\nAplicado: ${totalItems} item(ns) em ${totalDeals} negócio(s) abertos.`
        : `\nRelatório: ${totalItems} item(ns) seriam atualizados. Rode com --apply para gravar.`,
    );
  });
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
