import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { prisma } from "@/lib/prisma";

/**
 * GET /api/ai-agents/product-fields
 *
 * Retorna todos os campos disponíveis de `Product` (fixos + custom
 * fields com entity="product"). A UI de configuração do agente usa
 * isso pra mostrar ao admin quais dados o LLM receberá quando chamar
 * a tool `search_products` — e gerar sugestões de política de
 * apresentação.
 *
 * Campos fixos têm `source: "builtin"`; custom fields têm
 * `source: "custom"` e incluem o tipo (TEXT, NUMBER, DATE...).
 */
export async function GET() {
  return withOrgContext(async () => {
    const builtin = [
      {
        source: "builtin" as const,
        name: "name",
        label: "Nome",
        description: "Nome do produto/serviço/curso.",
      },
      {
        source: "builtin" as const,
        name: "sku",
        label: "SKU/código",
        description: "Código interno do item (se houver).",
      },
      {
        source: "builtin" as const,
        name: "priceFormatted",
        label: "Preço (BRL)",
        description: "Valor já formatado em reais, use este diretamente.",
      },
      {
        source: "builtin" as const,
        name: "unit",
        label: "Unidade",
        description: "Unidade de venda (un, hora, semestre, etc).",
      },
      {
        source: "builtin" as const,
        name: "type",
        label: "Tipo",
        description: "Categoria (PRODUCT, SERVICE, CURSO...).",
      },
      {
        source: "builtin" as const,
        name: "description",
        label: "Descrição",
        description: "Texto descritivo livre do produto.",
      },
    ];

    const custom = await prisma.customField.findMany({
      where: { entity: "product" },
      select: { name: true, label: true, type: true },
      orderBy: [{ label: "asc" }],
    });

    const customSerialized = custom.map((c) => ({
      source: "custom" as const,
      name: c.name,
      label: c.label,
      type: c.type,
      description: `Campo personalizado (${c.type}).`,
    }));

    return NextResponse.json({
      builtin,
      custom: customSerialized,
    });
  });
}
