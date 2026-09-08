import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import {
  CRM_SEARCH_GUIDANCE,
  loadCrmFieldCatalog,
} from "@/services/ai/crm-field-policy";

/**
 * GET /api/ai-agents/crm-fields
 *
 * Catálogo de campos que a tool `search_crm_records` consegue varrer:
 * colunas fixas de contato/empresa/negócio/produto e os `CustomField` da
 * organização. A tela do agente usa isto para montar a lista de "campos
 * legíveis" (`toolConfig.search_crm_records.readableFields`).
 *
 * `sensitiveHint` é aviso, não trava: o campo aparenta carregar dado
 * pessoal e quem liberar deve saber disso. A trava real é o default-deny
 * — campo que não estiver na lista do operador nunca chega ao modelo.
 *
 * Serve também `guidance`, o texto exato que o agente recebe, para o
 * operador ler o que está sendo instruído em vez de adivinhar.
 */
export async function GET() {
  return withOrgContext(async () => {
    const fields = await loadCrmFieldCatalog();
    return NextResponse.json({
      fields,
      guidance: CRM_SEARCH_GUIDANCE,
    });
  });
}
