/**
 * Provedor de voz (texto → áudio) do motor v2. Uma interface só, para trocar
 * de fornecedor sem tocar no motor. A chave é do agente e nunca vai para log
 * nem para mensagem de erro. Nenhum domínio de cliente.
 */

export type VoiceAudio = { buffer: Buffer; mime: string; ext: string };

export type VoiceOption = { id: string; name: string; language: string | null; previewUrl: string | null };

export interface VoiceProvider {
  id: string;
  /** Gera o áudio do texto, em português. Lança `VoiceProviderError` quando não dá. */
  synthesize(args: { apiKey: string; voiceId: string; text: string }): Promise<VoiceAudio>;
  /** Vozes da conta, para a tela escolher. */
  listVoices(apiKey: string): Promise<VoiceOption[]>;
}

/** Falha do provedor, com o motivo já em linguagem clara e sem a chave. */
export class VoiceProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "VoiceProviderError";
  }
}

const ELEVENLABS_BASE = "https://api.elevenlabs.io";
/** Modelo de baixa latência; aceita `language_code`. */
const ELEVENLABS_MODEL = "eleven_flash_v2_5";
/**
 * MP3: formato de saída sempre disponível. A conversão para mensagem de voz
 * (Ogg/Opus mono) é a mesma do áudio enviado pela equipe.
 */
const ELEVENLABS_OUTPUT = "mp3_44100_64";
const ELEVENLABS_TIMEOUT_MS = 20_000;

function describeStatus(status: number): string {
  if (status === 401 || status === 403) return "o provedor de voz recusou a chave";
  if (status === 402) return "a conta do provedor de voz está sem crédito";
  if (status === 404) return "a voz escolhida não existe nesta conta do provedor";
  if (status === 422) return "o provedor de voz não aceitou o pedido (voz ou texto inválido)";
  if (status === 429) return "o provedor de voz está limitando as chamadas agora";
  return `o provedor de voz respondeu com erro ${status}`;
}

async function elevenLabsFetch(path: string, apiKey: string, init: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(`${ELEVENLABS_BASE}${path}`, {
      ...init,
      headers: { ...(init.headers ?? {}), "xi-api-key": apiKey },
      signal: AbortSignal.timeout(ELEVENLABS_TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    throw new VoiceProviderError(timedOut ? "o provedor de voz demorou demais para responder" : "não foi possível falar com o provedor de voz");
  }
  if (!res.ok) throw new VoiceProviderError(describeStatus(res.status), res.status);
  return res;
}

export const elevenLabsProvider: VoiceProvider = {
  id: "elevenlabs",

  async synthesize({ apiKey, voiceId, text }) {
    const res = await elevenLabsFetch(
      `/v1/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${ELEVENLABS_OUTPUT}`,
      apiKey,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "audio/mpeg" },
        body: JSON.stringify({ text, model_id: ELEVENLABS_MODEL, language_code: "pt" }),
      },
    );
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length === 0) throw new VoiceProviderError("o provedor de voz devolveu um áudio vazio");
    return { buffer, mime: "audio/mpeg", ext: "mp3" };
  },

  async listVoices(apiKey) {
    const res = await elevenLabsFetch("/v2/voices?page_size=100", apiKey, { method: "GET", headers: { Accept: "application/json" } });
    const data = (await res.json().catch(() => ({}))) as { voices?: unknown };
    const rows = Array.isArray(data.voices) ? data.voices : [];
    const out: VoiceOption[] = [];
    for (const row of rows) {
      const r = row && typeof row === "object" ? (row as Record<string, unknown>) : {};
      if (typeof r.voice_id !== "string" || !r.voice_id) continue;
      const labels = r.labels && typeof r.labels === "object" ? (r.labels as Record<string, unknown>) : {};
      out.push({
        id: r.voice_id,
        name: typeof r.name === "string" && r.name ? r.name : r.voice_id,
        language: typeof labels.language === "string" ? labels.language : null,
        previewUrl: typeof r.preview_url === "string" ? r.preview_url : null,
      });
    }
    return out;
  },
};

const PROVIDERS: Record<string, VoiceProvider> = { elevenlabs: elevenLabsProvider };

export function voiceProviderFor(id: string | null | undefined): VoiceProvider {
  return PROVIDERS[id ?? "elevenlabs"] ?? elevenLabsProvider;
}
