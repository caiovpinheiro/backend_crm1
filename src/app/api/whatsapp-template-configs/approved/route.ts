import { NextResponse } from "next/server";

import { withApiAuthContext } from "@/lib/api-auth";
import { analyzeTemplateComponents } from "@/lib/meta-whatsapp/analyze-template-components";
import { resolveMetaTemplatesClient } from "@/lib/meta-whatsapp/resolve-templates-client";
import { prisma } from "@/lib/prisma";

/**
 * Lista TODOS os templates APROVADOS da WABA da organização (via Graph), sem
 * depender do toggle "Agente" (`agentEnabled`). Usado pelos seletores de
 * automação: cada org pode usar seus templates aprovados direto na automação.
 *
 * Mantém o MESMO shape do `/agent-enabled` (metaTemplateName, label, language,
 * category, hasButtons, hasVariables, flowAction, flowId) para os consumidores
 * do frontend funcionarem sem mudança de contrato. O `label` vem do config
 * local quando existir; senão fica vazio (o front cai no metaTemplateName).
 *
 * Sem canal Meta conectado na org -> retorna lista vazia (mesma UX de "nenhum
 * template"), em vez de erro, para não quebrar o dropdown da automação.
 */
type GraphRow = Record<string, unknown>;

function extractAfter(raw: unknown): string | undefined {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
  const paging = o?.paging as Record<string, unknown> | undefined;
  const cursors = paging?.cursors as Record<string, unknown> | undefined;
  const a = cursors?.after;
  return typeof a === "string" && a.length > 0 ? a : undefined;
}

// Auth hibrida (Bearer OU sessao): alem dos seletores de automacao no
// frontend, esta rota alimenta o dropdown de template do node do n8n. E
// leitura escopada pela org do token — nao expoe credencial da WABA, so
// nome/idioma/corpo/botoes dos templates ja aprovados.
export async function GET(request: Request) {
  return withApiAuthContext(request, async (user) => {
    try {
      const url = new URL(request.url);
      const channelId = url.searchParams.get("channelId");
      const resolved = await resolveMetaTemplatesClient({
        organizationId: user.organizationId,
        isSuperAdmin: user.isSuperAdmin,
        channelId,
      });
      // Sem canal/credenciais Meta na org: nada aprovado para listar.
      // channelId inválido (404) propaga erro; demais falhas de resolve → [].
      if (!resolved.ok) {
        if (channelId?.trim() && resolved.response.status === 404) {
          return resolved.response;
        }
        return NextResponse.json([]);
      }

      // Labels amigáveis do config local (opcional; só enriquece o rótulo).
      const configs = await prisma.whatsAppTemplateConfig.findMany({
        select: {
          metaTemplateId: true,
          metaTemplateName: true,
          label: true,
          agentEnabled: true,
          operatorVariables: true,
          hiddenAt: true,
        },
      });
      // Template oculto no CRM sai também dos seletores (automação, mensagens
      // prontas). Envio não é afetado: o executor resolve por nome sem olhar
      // `hiddenAt`, então automação que já usa continua funcionando.
      const hiddenIds = new Set(
        configs.filter((c) => c.hiddenAt).map((c) => c.metaTemplateId),
      );
      const hiddenNames = new Set(
        configs.filter((c) => c.hiddenAt).map((c) => c.metaTemplateName),
      );
      const labelById = new Map<string, string>();
      const labelByName = new Map<string, string>();
      const agentByName = new Map<string, boolean>();
      // Mapeamento variável → campo do CRM definido na criação do template.
      // Serve de PADRÃO para o passo `send_whatsapp_template` pré-preencher os
      // parâmetros; o operador continua podendo sobrescrever.
      const operatorVarsById = new Map<string, unknown[]>();
      const operatorVarsByName = new Map<string, unknown[]>();
      for (const c of configs) {
        const opVars = Array.isArray(c.operatorVariables) ? c.operatorVariables : null;
        if (c.metaTemplateId) {
          labelById.set(c.metaTemplateId, c.label ?? "");
          if (opVars) operatorVarsById.set(c.metaTemplateId, opVars);
        }
        if (c.metaTemplateName) {
          labelByName.set(c.metaTemplateName, c.label ?? "");
          agentByName.set(c.metaTemplateName, c.agentEnabled);
          if (opVars) operatorVarsByName.set(c.metaTemplateName, opVars);
        }
      }

      const out: Array<Record<string, unknown>> = [];
      let after: string | undefined;
      do {
        const raw = await resolved.client.listMessageTemplates({ limit: 500, after });
        const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
        const data = Array.isArray(o.data) ? (o.data as GraphRow[]) : [];
        for (const row of data) {
          const status = String(row.status ?? "").toUpperCase();
          if (status !== "APPROVED") continue;
          const name = typeof row.name === "string" ? row.name : "";
          if (!name) continue;
          const id = typeof row.id === "string" ? row.id : "";
          if (hiddenIds.has(id) || hiddenNames.has(name)) continue;
          const components = Array.isArray(row.components) ? (row.components as unknown[]) : [];
          const pf = typeof row.parameter_format === "string" ? row.parameter_format : null;
          const analysis = analyzeTemplateComponents(components, { parameterFormat: pf });

          out.push({
            metaTemplateId: id,
            metaTemplateName: name,
            label: labelById.get(id) || labelByName.get(name) || "",
            language: typeof row.language === "string" ? row.language : "pt_BR",
            category: typeof row.category === "string" ? row.category : null,
            agentEnabled: agentByName.get(name) ?? false,
            bodyPreview: analysis.bodyText ?? "",
            headerPreview: analysis.headerText ?? "",
            footerPreview: analysis.footerText ?? "",
            hasButtons: analysis.hasButtons,
            buttonTypes: analysis.buttonTypes,
            buttons: analysis.buttons,
            hasVariables: analysis.hasVariables,
            flowAction: analysis.flowAction,
            flowId: analysis.flowId,
            headerFormat: analysis.headerFormat,
            operatorVariables:
              operatorVarsById.get(id) ?? operatorVarsByName.get(name) ?? null,
          });
        }
        after = extractAfter(raw);
      } while (after);

      out.sort((a, b) => {
        const la = String(a.label || a.metaTemplateName || "");
        const lb = String(b.label || b.metaTemplateName || "");
        return la.localeCompare(lb);
      });

      return NextResponse.json(out);
    } catch (e) {
      return NextResponse.json(
        { message: e instanceof Error ? e.message : "Erro." },
        { status: 500 },
      );
    }
  });
}
