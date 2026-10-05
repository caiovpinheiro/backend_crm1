/**
 * Quem pode ver um `deal_moved`.
 *
 * O evento não usa `pipelineId`/`stageId` no singular: o gate genérico do
 * SSE esconderia o frame inteiro, e quem está só na origem deixaria de ver
 * o card sair. Aqui a regra é por lado:
 * - não vê origem nem destino → o evento não sai;
 * - vê a origem e não o destino → sai sem `card` (só ids para tirar o card);
 * - vê o destino → sai com `card`, para inserir o negócio que não está em cache.
 *
 * Admin / sem restrição de funil recebe o payload intacto (mesma referência,
 * o frame pré-serializado do barramento é reaproveitado).
 */
import type { AuthzContext } from "@/lib/authz";
import { canViewPipeline, canViewStage } from "@/lib/authz";
import { funnelScopeOf } from "@/lib/authz/funnel-visibility";

function readId(data: Record<string, unknown>, key: string): string | null {
  const value = data[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function canSeeSide(
  ctx: AuthzContext,
  pipelineId: string | null,
  stageId: string | null,
): boolean {
  if (!pipelineId && !stageId) return false;
  if (pipelineId && !canViewPipeline(ctx, pipelineId)) return false;
  if (stageId && !canViewStage(ctx, stageId)) return false;
  return true;
}

/**
 * `null` = não entregar. O mesmo objeto de entrada = entregar intacto.
 * Objeto novo = entregar sem o `card`.
 */
export function projectDealMovedForViewer(
  data: unknown,
  ctx: AuthzContext | null,
): unknown | null {
  if (!data || typeof data !== "object") return data;
  const rec = data as Record<string, unknown>;
  const fromPipelineId = readId(rec, "fromPipelineId");
  const toPipelineId = readId(rec, "toPipelineId");
  const fromStageId = readId(rec, "fromStageId");
  const toStageId = readId(rec, "toStageId");
  if (!fromPipelineId && !toPipelineId && !fromStageId && !toStageId) {
    return data;
  }
  if (!ctx || funnelScopeOf(ctx) === null) return data;

  const seeFrom = canSeeSide(ctx, fromPipelineId, fromStageId);
  const seeTo = canSeeSide(ctx, toPipelineId, toStageId);
  if (!seeFrom && !seeTo) return null;
  if (seeTo || !("card" in rec)) return data;
  const rest = { ...rec };
  delete rest.card;
  return rest;
}
