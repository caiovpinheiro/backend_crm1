import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { normalizeToolConfig, toolPolicyFor } from "@/lib/ai-agents/steering";
import { prisma } from "@/lib/prisma";
import {
  CRM_SEARCH_GUIDANCE,
  loadCrmFieldCatalog,
} from "@/services/ai/crm-field-policy";

/** Onde a allowlist é gravada — a tela não precisa deduzir o caminho. */
const TOOL_ID = "search_crm_records";
const CONFIG_PATH = `toolConfig.${TOOL_ID}.readableFields`;

/**
 * GET /api/ai-agents/crm-fields[?agentId=<id>]
 *
 * Catálogo de campos que a tool `search_crm_records` consegue varrer, para
 * a tela de configuração do agente montar o toggle campo a campo.
 *
 * O catálogo é derivado: os campos personalizados e as próprias entidades
 * saem das definições da organização em contexto (`CustomField`), não de
 * lista embutida. Campos `builtin` são colunas do CRM, iguais em todo
 * tenant.
 *
 * `agentId` é opcional. Com ele a resposta já traz `selected` (o que está
 * gravado hoje) e aplica `sensitiveTerms` do agente nos avisos, poupando a
 * tela de um segundo request e de recalcular o aviso no cliente.
 *
 * `sensitiveHint` é aviso, não trava: sinaliza que o nome do campo sugere
 * dado pessoal. A trava é o default-deny — campo fora de `selected` nunca
 * chega ao modelo.
 */
export async function GET(request: Request) {
  return withOrgContext(async () => {
    const agentId = new URL(request.url).searchParams.get("agentId");

    let selected: string[] | null = null;
    let orgWide: boolean | null = null;
    let sensitiveTerms: string[] = [];

    if (agentId) {
      const agent = await prisma.aIAgentConfig.findUnique({
        where: { id: agentId },
        select: { toolConfig: true, enabledTools: true },
      });
      if (!agent) {
        return NextResponse.json(
          { message: "Agente não encontrado." },
          { status: 404 },
        );
      }
      const policy = toolPolicyFor(
        normalizeToolConfig(agent.toolConfig),
        TOOL_ID,
      );
      selected = policy.readableFields;
      orgWide = policy.allowOrgWideSearch;
      sensitiveTerms = policy.sensitiveTerms;
    }

    const catalog = await loadCrmFieldCatalog({ sensitiveTerms });

    return NextResponse.json({
      toolId: TOOL_ID,
      configPath: CONFIG_PATH,
      /// Curinga por entidade ("deal.*") e global ("*") são chaves válidas.
      wildcardsSupported: true,
      guidance: CRM_SEARCH_GUIDANCE,
      entities: catalog.entities,
      /// Lista plana, mesma forma da primeira versão deste endpoint.
      fields: catalog.fields,
      /// Null quando `agentId` não foi informado.
      selected,
      allowOrgWideSearch: orgWide,
      sensitiveTerms,
    });
  });
}
