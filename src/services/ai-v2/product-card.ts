/**
 * Cartão de produto que o agente envia: o mesmo texto que a equipe manda ao
 * encaminhar um produto (modelo de mensagem de produto da organização), com
 * a imagem cadastrada. O preço segue a opção de preço escolhida na
 * configuração do agente; sem ela, a opção principal do produto. Nenhum domínio de cliente.
 */

import { prisma } from "@/lib/prisma";

/** Limite da legenda de imagem no WhatsApp. Acima disso o texto vai em mensagem própria. */
export const PRODUCT_CARD_CAPTION_MAX = 1024;

export type V2ProductCard = {
  productId: string;
  name: string;
  text: string;
  image: { url: string; mimeType: string | null; name: string | null } | null;
};

function fold(s: string): string {
  return s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim();
}

/**
 * Preço que o agente usa para um produto. Com uma opção de preço escolhida
 * (pelo nome do canal) e cadastrada no produto, vale o preço e o desconto
 * dela. Sem canal escolhido, ou com um canal que o produto não tem (a
 * campanha renomeou a opção), vale a opção principal do produto — a 1ª, a
 * que a tela do produto mostra em "Desconto" e "Valor com desconto" e que o
 * card do negócio copia ao adicionar o produto. Antes caía no preço de tabela
 * sem desconto e o cartão do agente dizia "por R$ 189,50" enquanto o da
 * equipe dizia "por R$ 123,17" (27/11). Produto sem opção: o de tabela.
 */
export function pickPolicyPrice(
  basePrice: number,
  pricingOptions: unknown,
  priceChannel: string | null | undefined,
): { unitPrice: number; discount: number } {
  const options = Array.isArray(pricingOptions)
    ? pricingOptions.map((item) => (item && typeof item === "object" ? (item as Record<string, unknown>) : {}))
    : [];
  const toPrice = (o: Record<string, unknown>) => {
    const price = Number(o.price);
    const discount = Number(o.discountPercent);
    return {
      unitPrice: Number.isFinite(price) && price > 0 ? price : basePrice,
      discount: Number.isFinite(discount) ? Math.min(100, Math.max(0, discount)) : 0,
    };
  };
  const wanted = fold(priceChannel ?? "");
  if (wanted) {
    const hit = options.find((o) => typeof o.channel === "string" && fold(o.channel) === wanted);
    if (hit) return toPrice(hit);
  }
  if (options.length > 0) return toPrice(options[0]);
  return { unitPrice: basePrice, discount: 0 };
}

/**
 * Valor final com desconto, arredondado como o cartão do produto
 * (`toFixed(2)` em product-messages): 189,50 com 35% dá R$ 123,17 nos dois.
 * `Math.round` dava 123,18 no texto do modelo e 123,17 no cartão.
 */
export function policyFinalPrice(unitPrice: number, discount: number): number {
  return Number((unitPrice * (1 - discount / 100)).toFixed(2));
}

const fmtBRL = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });

/** Monta o cartão de um produto ativo da organização. `null` quando o produto não existe. */
export async function buildV2ProductCard(args: {
  organizationId: string;
  productId: string;
  priceChannel?: string | null;
}): Promise<V2ProductCard | null> {
  const product = await prisma.product.findFirst({
    where: { id: args.productId, organizationId: args.organizationId, isActive: true },
    select: {
      id: true,
      name: true,
      price: true,
      description: true,
      imageUrl: true,
      imageMime: true,
      imageName: true,
      courseConfig: { select: { pricingOptions: true } },
      customValues: { include: { customField: { select: { label: true, name: true } } } },
    },
  });
  if (!product) return null;

  const base = Number(product.price) || 0;
  const { unitPrice, discount } = pickPolicyPrice(base, product.courseConfig?.pricingOptions, args.priceChannel);

  // Texto do modelo de mensagem de produto da organização, quando existe.
  let text: string | null = null;
  try {
    const { renderProductMessageForProduct } = await import("@/services/product-messages");
    text = (await renderProductMessageForProduct({ productId: product.id, unitPrice, discount })).text;
  } catch {
    text = null;
  }
  if (!text?.trim()) {
    const finalPrice = policyFinalPrice(unitPrice, discount);
    const cfText = (product.customValues ?? [])
      .filter((v) => v.value && v.value.trim())
      .map((v) => `${v.customField.label ?? v.customField.name}: ${v.value}`)
      .join("\n");
    text = [product.name, finalPrice > 0 ? fmtBRL.format(finalPrice) : "", product.description ?? "", cfText].filter(Boolean).join("\n");
  }

  const imageUrl = product.imageUrl?.trim() || "";
  return {
    productId: product.id,
    name: product.name,
    text: text.trim(),
    image: imageUrl ? { url: imageUrl, mimeType: product.imageMime ?? null, name: product.imageName ?? null } : null,
  };
}
