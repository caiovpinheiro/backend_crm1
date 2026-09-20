/**
 * Política de mídia recebida da v2 (SPEC 3.5).
 * Nenhum domínio de cliente.
 */

import type { V2AgentConfig, V2MediaAction, V2MediaKindConfig } from "@/lib/ai-v2/types";

export type V2MediaKind = "audio" | "image" | "document";

export function detectV2MediaKinds(messageType?: string): V2MediaKind[] {
  if (!messageType) return [];
  const mt = messageType.toLowerCase();
  if (["audio", "ptt", "voice", "voice_note"].includes(mt)) return ["audio"];
  if (["image"].includes(mt)) return ["image"];
  if (["document"].includes(mt)) return ["document"];
  return [];
}

export function evaluateV2Media(
  config: V2AgentConfig,
  messageType?: string,
): { kind: V2MediaKind; action: V2MediaAction; message?: string } | null {
  const kinds = detectV2MediaKinds(messageType);
  if (kinds.length === 0) return null;
  const kind = kinds[0];
  let cfg: V2MediaKindConfig;
  if (kind === "audio") cfg = config.media.audio;
  else if (kind === "image") cfg = config.media.image;
  else cfg = config.media.document;

  let message: string | undefined;
  if (cfg.action === "handoff") message = cfg.handoffMessage;
  if (cfg.action === "ask_text") message = cfg.askTextMessage;
  return { kind, action: cfg.action, message };
}
