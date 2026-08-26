import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { cache } from "@/lib/cache";
import { whatsappTemplateCatalogKey } from "@/lib/cache/keys";
import { analyzeTemplateComponents } from "@/lib/meta-whatsapp/analyze-template-components";
import {
  ensureWhatsappTemplateHiddenAtColumn,
  isMissingHiddenAtColumn,
} from "@/lib/meta-whatsapp/ensure-hidden-at";
import {
  listMessageTemplatesByGraphId,
  type MessageTemplateGraphHit,
} from "@/lib/meta-whatsapp/list-message-templates-index";
import { resolveMetaTemplatesClient } from "@/lib/meta-whatsapp/resolve-templates-client";
import { prisma } from "@/lib/prisma";

type GraphMap = Map<string, MessageTemplateGraphHit>;
type GraphEntries = Array<[string, MessageTemplateGraphHit]>;

/**
 * Catálogo da Graph em cache compartilhado (Redis/Valkey).
 *
 * TTL longo de propósito: template WABA passa por aprovação da Meta e muda
 * em escala de horas/dias, não de minutos. Não é infinito porque template
 * pode ser criado/aprovado direto no Meta Business Manager, fora do CRM —
 * caminho pelo qual não recebemos sinal nenhum. 30min limita essa janela
 * cega; mudanças feitas PELO CRM invalidam na hora (ver `keys.ts`).
 */
const GRAPH_CATALOG_TTL_SEC = 1_800;

/** Sinaliza ao `cache.wrap` que não há o que cachear (ver uso abaixo). */
class EmptyGraphCatalogError extends Error {}

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

      await ensureWhatsappTemplateHiddenAtColumn();
      let configs;
      try {
        configs = await prisma.whatsAppTemplateConfig.findMany({
          // Oculto no CRM não é oferecido ao agente, mesmo com o toggle ligado.
          where: { agentEnabled: true, hiddenAt: null },
          orderBy: { label: "asc" },
        });
      } catch (e) {
        if (!isMissingHiddenAtColumn(e)) throw e;
        configs = await prisma.whatsAppTemplateConfig.findMany({
          where: { agentEnabled: true },
          orderBy: { label: "asc" },
          omit: { hiddenAt: true },
        });
      }

      const orgId = session.user.organizationId;
      let graphMap: GraphMap | null = null;

      // Resolver o canal ANTES de olhar o cache: é ele que fornece o `wabaId`
      // (a chave correta do catálogo) e é ele que valida que o canal pertence
      // à org da sessão. O cache em memória anterior era consultado antes
      // disso, então um `channelId` inválido ou de outra org só era barrado
      // no primeiro request de cada minuto. O lookup é org-scoped e barato.
      const resolved = await resolveMetaTemplatesClient({
        organizationId: orgId,
        isSuperAdmin: session.user.isSuperAdmin,
        channelId: channelId || null,
      });
      if (!resolved.ok && channelId) {
        return resolved.response;
      }

      if (resolved.ok && orgId) {
        const client = resolved.client;
        try {
          const entries = await cache.wrap<GraphEntries>(
            whatsappTemplateCatalogKey(orgId, client.wabaId),
            GRAPH_CATALOG_TTL_SEC,
            async () => {
              const map = await listMessageTemplatesByGraphId(client);
              // Catálogo vazio NÃO vai pro cache: com `?channelId=`, um map
              // vazio faz `!hit` derrubar todos os templates e o agente
              // ficaria sem nenhuma opção pelo TTL inteiro. Degradar sem
              // cache é preferível a cachear a ausência.
              if (map.size === 0) throw new EmptyGraphCatalogError();
              return [...map.entries()];
            },
          );
          graphMap = new Map(entries);
        } catch {
          // Graph indisponível ou catálogo vazio: segue sem enriquecimento,
          // servindo o que está no banco. Nada de falha é cacheado.
          graphMap = null;
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
      console.error("[whatsapp-template-configs/agent-enabled]", e);
      return NextResponse.json(
        { message: "Erro ao carregar templates." },
        { status: 500 },
      );
    }
  });
}
