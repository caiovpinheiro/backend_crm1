/**
 * Registry de vertical packs.
 * Consumidores: `import { getVerticalPack, runVerticalIntercepts } from "@/verticals"`.
 *
 * Intercepts do pack academic são lazy (evita ciclo pack ↔ services/ai).
 */

import type { VerticalPack } from "@/verticals/types";
import { academicPack } from "@/verticals/academic/pack";

export type {
  PromptBlockCtx,
  VerticalIntercept,
  VerticalInterceptCtx,
  VerticalInterceptHit,
  VerticalInterceptPhase,
  VerticalPack,
} from "@/verticals/types";
export { runVerticalIntercepts } from "@/verticals/types";

const REGISTRY: Record<string, VerticalPack> = {
  academic: academicPack,
};

/** `null` / unknown → sem interceptos de vertical. */
export function getVerticalPack(
  id: string | null | undefined,
): VerticalPack | null {
  if (!id) return null;
  return REGISTRY[id] ?? null;
}

export function listVerticalPackIds(): string[] {
  return Object.keys(REGISTRY);
}
