import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { analyzeTemplateComponents } from "@/lib/meta-whatsapp/analyze-template-components";
import { listMessageTemplatesByGraphId } from "@/lib/meta-whatsapp/list-message-templates-index";
import { resolveMetaTemplatesClient } from "@/lib/meta-whatsapp/resolve-templates-client";
import { prisma } from "@/lib/prisma";

type GraphMap = Awaited<ReturnType<typeof listMessageTemplatesByGraphId>>;

/**
 * Cache TTL em memória do catálogo Graph (map por graph-template-id).
 * Chave = organizationId + channelId (WABA distinta por canal Cloud API).
 */
const GRAPH_MAP_TTL_MS = 60_000;
const graphMapCache = new Map<string, { at: number; map: GraphMap }>();

function cacheKey(orgId: string, channelId: string): string {
  return `${orgId}::${channelId || "default"}`;
}

/**
 * Lista templates habilitados para o agente. Quando o canal Meta Cloud da org
 * está disponível, mescla metadados (botões, variáveis, Flow) a partir da
 * Graph — evita envio como texto por BD desatualizado sem backfill.
 *
 * `?channelId=` restringe à WABA daquele canal (só templates presentes nela).
 */
export async function GET(request: Request) {
  return withOrgContext(async (session) => {
    try {
      const url = new URL(request.url);
      const channelId = url.searchParams.get("channelId")?.trim() || "";

      const configs = await prisma.whatsAppTemplateConfig.findMany({
        // Oculto no CRM não é oferecido ao agente, mesmo com o toggle ligado.
        where: { agentEnabled: true, hiddenAt: null },
        orderBy: { label: "asc" },
      });

      const orgId = session.user.organizationId;
      let graphMap: GraphMap | null = null;

      const key = orgId ? cacheKey(orgId, channelId) : "";
      const cached = key ? graphMapCache.get(key) : undefined;
      if (cached && Date.now() - cached.at < GRAPH_MAP_TTL_MS) {
        graphMap = cached.map;
      } else {
        const resolved = await resolveMetaTemplatesClient({
          organizationId: orgId,
          isSuperAdmin: session.user.isSuperAdmin,
          channelId: channelId || null,
        });
        if (!resolved.ok && channelId) {
          return resolved.response;
        }
        if (resolved.ok) {
          try {
            graphMap = await listMessageTemplatesByGraphId(resolved.client);
            if (key) graphMapCache.set(key, { at: Date.now(), map: graphMap });
          } catch {
            graphMap = null;
          }
        }
      }

      const enriched = configs
        .map((row) => {
          const id = typeof row.metaTemplateId === "string" ? row.metaTemplateId.trim() : "";
          const hit = id && graphMap ? graphMap.get(id) : undefined;
          // Com channelId: só templates que existem na WABA desse canal.
          if (channelId && graphMap && !hit) return null;
          if (!hit) return row;

          const analysis = analyzeTemplateComponents(hit.components, {
            parameterFormat: hit.parameterFormat,
          });

          return {
            ...row,
            hasButtons: analysis.hasButtons,
            buttonTypes: analysis.buttonTypes,
            hasVariables: analysis.hasVariables,
            flowAction: analysis.flowAction,
            flowId: analysis.flowId,
            headerFormat: analysis.headerFormat,
          };
        })
        .filter((row): row is NonNullable<typeof row> => row != null);

      return NextResponse.json(enriched);
    } catch (e) {
      return NextResponse.json(
        { message: e instanceof Error ? e.message : "Erro." },
        { status: 500 },
      );
    }
  });
}
