/**
 * Cartão de produto que o agente envia: o mesmo texto que a equipe manda ao
 * encaminhar um produto (modelo de mensagem de produto da organização), com
 * a imagem cadastrada. O preço segue a opção de preço escolhida na
 * configuração do agente; sem ela, o de tabela. Nenhum domínio de cliente.
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
 * dela; nos demais casos, o preço de tabela sem desconto — o agente não
 * aplica desconto que ninguém configurou.
 */
export function pickPolicyPrice(
  basePrice: number,
  pricingOptions: unknown,
  priceChannel: string | null | undefined,
): { unitPrice: number; discount: number } {
  const wanted = fold(priceChannel ?? "");
  if (wanted && Array.isArray(pricingOptions)) {
    for (const item of pricingOptions) {
      const o = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
      if (typeof o.channel !== "string" || fold(o.channel) !== wanted) continue;
      const price = Number(o.price);
      const discount = Number(o.discountPercent);
      return {
        unitPrice: Number.isFinite(price) && price > 0 ? price : basePrice,
        discount: Number.isFinite(discount) ? Math.min(100, Math.max(0, discount)) : 0,
      };
    }
  }
  return { unitPrice: basePrice, discount: 0 };
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
    const finalPrice = unitPrice * (1 - discount / 100);
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
