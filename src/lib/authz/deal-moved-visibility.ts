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
 * Além do funil, o `card` (título, contato, valor, dono) só vai a quem VÊ o
 * negócio pela posse (`canSeeDeal`, mesmo critério do GET /api/deals/:id):
 * quem não vê recebe o evento sem `card` e sem `ownerId`/`orgUnitId` — só ids
 * de funil/etapa/negócio, o bastante para tirar o card de uma coluna.
 *
 * Admin / sem restrição de funil e de posse recebe o payload intacto (mesma
 * referência, o frame pré-serializado do barramento é reaproveitado).
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

/** Posse: o assinante vê o negócio deste dono? `undefined` = o payload não informou. */
export type DealMovedOwnerGate = (deal: { ownerId: string | null | undefined }) => boolean;

/**
 * `null` = não entregar. O mesmo objeto de entrada = entregar intacto.
 * Objeto novo = entregar sem o `card` (e sem dono/unidade se o negócio não é visível).
 */
export function projectDealMovedForViewer(
  data: unknown,
  ctx: AuthzContext | null,
  canSeeDeal?: DealMovedOwnerGate | null,
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

  // Funil/etapa: só quando o usuário tem escopo restrito.
  let seeTo = true;
  if (ctx && funnelScopeOf(ctx) !== null) {
    const seeFrom = canSeeSide(ctx, fromPipelineId, fromStageId);
    seeTo = canSeeSide(ctx, toPipelineId, toStageId);
    if (!seeFrom && !seeTo) return null;
  }

  // Posse: o `ownerId` do payload decide se o negócio é visível.
  let dealVisible = true;
  if (canSeeDeal) {
    const ownerId =
      !("ownerId" in rec) || rec.ownerId === undefined
        ? undefined
        : typeof rec.ownerId === "string"
          ? rec.ownerId
          : null;
    dealVisible = canSeeDeal({ ownerId });
  }

  const dropCard = "card" in rec && (!seeTo || !dealVisible);
  const dropOwnership = !dealVisible && ("ownerId" in rec || "orgUnitId" in rec);
  if (!dropCard && !dropOwnership) return data;
  const rest = { ...rec };
  if (dropCard) delete rest.card;
  if (dropOwnership) {
    delete rest.ownerId;
    delete rest.orgUnitId;
  }
  return rest;
}
