/**
 * Áudio e imagem do turno viram texto no que o agente recebe, conforme a
 * política de mídia do agente ("transcrever"/"descrever"). Nenhum domínio
 * de cliente.
 */

import { v2AuxModel } from "@/lib/ai-v2/models";
import { prismaBase } from "@/lib/prisma-base";
import { isMediaPlaceholderText } from "@/lib/ai-agents/media-placeholder";
import { tryGetAgentApiKey } from "@/services/ai/agent-key";
import type { V2AgentConfig } from "@/lib/ai-v2/types";
import { traceStep } from "./trace";
import { mediaTextLine, understandMedia, understoodKindOf, type MediaMessage, type UnderstoodKind } from "./media-understanding";

/** Política do agente para este tipo: entende (transcreve/descreve) ou não. */
export function shouldUnderstand(config: V2AgentConfig, kind: UnderstoodKind): boolean {
  const action = kind === "audio" ? config.media.audio.action : config.media.image.action;
  return action === "transcribe" || action === "describe";
}

/**
 * Troca o marcador de cada mídia do turno ("[Áudio]", "[Imagem]") pelo
 * conteúdo. Texto do cliente fica como está; legenda de imagem entra junto.
 */
export function composeTurnText(
  userMessage: string,
  items: Array<{ kind: UnderstoodKind; text: string; content: string | null }>,
): string {
  const lines = userMessage.split("\n");
  const kept: string[] = [];
  let placeholdersRemoved = 0;
  for (const line of lines) {
    if (isMediaPlaceholderText(line) && placeholdersRemoved < items.length) {
      placeholdersRemoved++;
      continue;
    }
    // Legenda de imagem sai do texto solto: volta junto da descrição.
    if (items.some((i) => i.kind === "image" && i.content && !isMediaPlaceholderText(i.content) && i.content.trim() === line.trim())) continue;
    kept.push(line);
  }
  return [...kept.filter((l) => l.trim()), ...items.map((i) => mediaTextLine(i.kind, i.text, i.content))].join("\n");
}

export async function enrichTurnWithMedia(args: {
  organizationId: string;
  agentUserId: string;
  agentConfigId: string;
  config: V2AgentConfig;
  userMessage: string;
  messageIds: string[];
}): Promise<{ userMessage: string; understood: number; failed: number }> {
  if (args.messageIds.length === 0) return { userMessage: args.userMessage, understood: 0, failed: 0 };
  const rows = (await prismaBase.message.findMany({
    where: { organizationId: args.organizationId, id: { in: args.messageIds }, direction: "in" },
    select: { id: true, messageType: true, mediaUrl: true, content: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  })) as Array<MediaMessage & { createdAt: Date }>;

  const targets = rows
    .map((m) => ({ m, kind: understoodKindOf(m.messageType) }))
    .filter((x): x is { m: MediaMessage & { createdAt: Date }; kind: UnderstoodKind } => !!x.kind && shouldUnderstand(args.config, x.kind));
  if (targets.length === 0) return { userMessage: args.userMessage, understood: 0, failed: 0 };

  // Áudio e imagem usam a chave do próprio agente.
  const apiKey = await tryGetAgentApiKey(args.agentConfigId).catch(() => null);
  const items: Array<{ kind: UnderstoodKind; text: string; content: string | null }> = [];
  let failed = 0;
  for (const { m, kind } of targets) {
    const r = await understandMedia({
      organizationId: args.organizationId,
      userId: args.agentUserId,
      message: m,
      kind,
      // Leitura de imagem com a chave OpenAI do agente.
      model: v2AuxModel(args.config.model),
      apiKey,
    });
    const label = kind === "audio" ? "Áudio" : "Imagem";
    if (r.text) {
      items.push({ kind, text: r.text, content: m.content });
      traceStep("mídia", `${label} ${kind === "audio" ? "transcrito" : "lido"}${r.cached ? " (já estava salvo)" : ""}: "${r.text.slice(0, 80)}${r.text.length > 80 ? "…" : ""}"`);
    } else {
      failed++;
      traceStep("mídia", `${label} não entendido: ${r.error ?? "sem resultado"}`);
    }
  }
  if (items.length === 0) return { userMessage: args.userMessage, understood: 0, failed };
  return { userMessage: composeTurnText(args.userMessage, items), understood: items.length, failed };
}
