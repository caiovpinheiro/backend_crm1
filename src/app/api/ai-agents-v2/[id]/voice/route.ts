import { NextResponse } from "next/server";

import { requireAuth, requirePermission } from "@/lib/auth-helpers";
import type { V2VoiceSettings } from "@/lib/ai-v2/types";
import { getLogger } from "@/lib/logger";
import { ensureV2AgentSchema } from "@/services/ai-v2/ensure-schema";
import { agentVoiceKeyHint, speakableText, tryGetAgentVoiceKey } from "@/services/ai-v2/voice";
import { VoiceProviderError, voiceProviderFor } from "@/services/ai-v2/voice-provider";

const log = getLogger("api/ai-agents-v2/[id]/voice");

const PREVIEW_MAX_CHARS = 300;
const PREVIEW_DEFAULT_TEXT = "Olá! Esta é a voz que vai responder por áudio.";

/** Chave do provedor de voz do agente desta organização, ou a resposta de erro. */
async function voiceKeyOf(id: string, organizationId: string): Promise<{ key: string } | { response: NextResponse }> {
  await ensureV2AgentSchema();
  // A dica só existe para agente desta organização com chave cadastrada.
  if ((await agentVoiceKeyHint(id, organizationId)) === null) {
    return { response: NextResponse.json({ message: "Cadastre a chave do provedor de voz antes." }, { status: 400 }) };
  }
  const key = await tryGetAgentVoiceKey(id);
  if (!key) {
    return { response: NextResponse.json({ message: "A chave do provedor de voz não pôde ser lida. Cadastre a chave de novo." }, { status: 400 }) };
  }
  return { key };
}

function providerFailure(err: unknown, where: string): NextResponse {
  // Só o motivo já tratado: nada do provedor (nem a chave) vai para o log ou para a tela.
  const message = err instanceof VoiceProviderError ? err.message : "não foi possível falar com o provedor de voz";
  log.warn({ where, status: err instanceof VoiceProviderError ? err.status : undefined }, "[voice] provedor falhou");
  return NextResponse.json({ message: `Não deu certo: ${message}.` }, { status: 502 });
}

/** Vozes da conta do provedor, para a tela escolher. */
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const denied = await requirePermission(r.session.user, "settings:ai");
  if (denied) return denied;

  const found = await voiceKeyOf(id, r.session.user.organizationId!);
  if ("response" in found) return found.response;
  const provider = new URL(request.url).searchParams.get("provider");
  try {
    return NextResponse.json({ voices: await voiceProviderFor(provider).listVoices(found.key) });
  } catch (err) {
    return providerFailure(err, "voices");
  }
}

/** Prévia: gera um áudio curto com a voz escolhida, para ouvir na tela. */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const denied = await requirePermission(r.session.user, "settings:ai");
  if (denied) return denied;

  const body = (await request.json().catch(() => ({}))) as { voiceId?: unknown; text?: unknown; provider?: unknown; model?: unknown; settings?: unknown };
  const voiceId = typeof body.voiceId === "string" ? body.voiceId.trim() : "";
  if (!voiceId) return NextResponse.json({ message: "Escolha a voz antes de ouvir." }, { status: 400 });
  const text = speakableText(typeof body.text === "string" && body.text.trim() ? body.text : PREVIEW_DEFAULT_TEXT).slice(0, PREVIEW_MAX_CHARS);

  const found = await voiceKeyOf(id, r.session.user.organizationId!);
  if ("response" in found) return found.response;
  try {
    // Modelo e ajustes como estão na tela, para ouvir antes de salvar.
    const settings = body.settings && typeof body.settings === "object" ? (body.settings as V2VoiceSettings) : null;
    const audio = await voiceProviderFor(typeof body.provider === "string" ? body.provider : null).synthesize({
      apiKey: found.key,
      voiceId,
      text,
      model: typeof body.model === "string" ? body.model : null,
      settings,
    });
    return new NextResponse(new Uint8Array(audio.buffer), {
      status: 200,
      headers: { "Content-Type": audio.mime, "Cache-Control": "no-store" },
    });
  } catch (err) {
    return providerFailure(err, "preview");
  }
}
