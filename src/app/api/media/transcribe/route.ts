import { NextResponse } from "next/server";
import path from "path";

import { auth } from "@/lib/auth";
import { convertToMp3, guessInputExt } from "@/lib/audio-convert";
import { GROQ_MODEL, mimeForGroq, transcribeGroq } from "@/lib/groq-transcribe";
import {
  fetchAuthorizedAudioBuffer,
  MediaTooLargeError,
} from "@/lib/fetch-authorized-audio";

/**
 * Transcrição de áudio — Groq Whisper como provedor PRIMÁRIO.
 * ──────────────────────────────────────────────────────────────────
 *
 * Por que Groq?
 *   ▸ `whisper-large-v3-turbo` é o modelo mais rápido e preciso da
 *     família Whisper (~9x mais rápido que `whisper-large-v3`).
 *   ▸ Free tier MUITO generoso (centenas de requests/dia) sem
 *     necessidade de cartão de crédito.
 *   ▸ Sem cold-start (problema crônico do HF Inference free).
 *   ▸ Aceita OGG/WebM/MP3/M4A/etc diretamente — não precisa converter
 *     pra WAV via ffmpeg na maior parte dos casos (o ffmpeg-static
 *     é a fonte do erro recorrente "ffmpeg falhou" porque alguns
 *     ambientes Windows não conseguem decodificar WebM-Opus).
 *   ▸ Excelente em português brasileiro.
 *
 * Setup:
 *   1) Crie conta grátis em https://console.groq.com (sem cartão).
 *   2) Gere uma API key.
 *   3) Adicione `GROQ_API_KEY=...` no `.env.local`.
 *   4) (Opcional) Sobreponha o modelo via `GROQ_TRANSCRIBE_MODEL`.
 *
 * Fallback:
 *   - Se `GROQ_API_KEY` não estiver configurado, cai pro HF Whisper
 *     (`HUGGINGFACE_API_KEY` opcional). Histórico mantido pra não
 *     forçar configuração nova em ambientes que já tinham HF.
 *
 * Pipeline:
 *   1) Recebe `{ url }` no body — URL do áudio.
 *   2) Baixa o áudio (storage da org, uploads legado da org, ou CDN Meta
 *      vinculada à org) com teto de 16 MB.

 *   3) Tenta enviar O ARQUIVO ORIGINAL pro Groq (multipart) — Groq
 *      aceita Opus/Vorbis/AAC/MP3/WAV/FLAC sem precisar transcodar.
 *   4) Se Groq rejeitar formato/codec, converte pra MP3 (libmp3lame
 *      é mais robusto que pcm_s16le pra WebM-Opus do WhatsApp) e
 *      tenta de novo.
 *   5) Retorna `{ text, model, provider }` ou erro amigável.
 */

const HF_MODEL =
  process.env.HUGGINGFACE_TRANSCRIBE_MODEL?.trim() || "openai/whisper-base";

const HF_ENDPOINT = `https://api-inference.huggingface.co/models/${HF_MODEL}`;

type HfTextResponse = { text?: string; error?: string; estimated_time?: number };

/** Fallback antigo via Hugging Face (caso `GROQ_API_KEY` não exista).
 *  Mantido apenas para retrocompatibilidade — Groq é nitidamente
 *  superior em qualidade, latência e estabilidade. */
async function transcribeHuggingFace(
  audio: Buffer,
  contentType: string,
): Promise<{ text: string } | { error: string; status?: number }> {
  const headers: Record<string, string> = {
    "Content-Type": contentType,
    "Accept": "application/json",
  };
  const apiKey = process.env.HUGGINGFACE_API_KEY?.trim();
  if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const hfRes = await fetch(HF_ENDPOINT, {
        method: "POST",
        headers,
        body: new Uint8Array(audio),
        cache: "no-store",
      });

      const ctype = hfRes.headers.get("content-type") || "";

      if (hfRes.status === 503 && ctype.includes("application/json")) {
        const json = (await hfRes.json()) as HfTextResponse;
        const wait = Math.min(15, Math.ceil(json.estimated_time ?? 5));
        console.log(`[transcribe/hf] Modelo carregando, aguardando ${wait}s…`);
        await new Promise((r) => setTimeout(r, wait * 1000));
        continue;
      }

      if (!hfRes.ok) {
        const text = await hfRes.text();
        console.warn(`[transcribe/hf] ${hfRes.status}: ${text.slice(0, 200)}`);

        if (hfRes.status === 401 || hfRes.status === 403) {
          return {
            error: !apiKey
              ? "Hugging Face exige autenticação. Configure GROQ_API_KEY (recomendado, grátis) ou HUGGINGFACE_API_KEY."
              : "Hugging Face rejeitou a chave HUGGINGFACE_API_KEY.",
            status: 401,
          };
        }

        if (hfRes.status === 429) {
          return {
            error: "Limite gratuito atingido. Configure GROQ_API_KEY (grátis, sem cartão).",
            status: 429,
          };
        }

        return { error: `Hugging Face retornou ${hfRes.status}.`, status: 502 };
      }

      const json = (await hfRes.json()) as HfTextResponse;
      const text = (json.text ?? "").trim();

      if (!text) {
        return { error: "Transcrição vazia (áudio sem fala detectável?)." };
      }

      return { text };
    } catch (err) {
      console.error("[transcribe/hf] Erro:", err);
      if (attempt === 1) {
        return {
          error: err instanceof Error ? `Erro ao transcrever: ${err.message}` : "Erro ao transcrever.",
          status: 502,
        };
      }
    }
  }

  return {
    error: "Modelo continua carregando. Tente novamente em alguns segundos.",
    status: 503,
  };
}

export async function POST(request: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ message: "Não autorizado." }, { status: 401 });
  }
  const orgId = (session.user as { organizationId?: string | null }).organizationId ?? "";
  if (!orgId) {
    return NextResponse.json({ message: "Não autorizado." }, { status: 401 });
  }

  let body: { url?: string };
  try {
    body = (await request.json()) as { url?: string };
  } catch {
    return NextResponse.json({ message: "Body inválido." }, { status: 400 });
  }

  const rawUrl = body.url?.trim();
  if (!rawUrl) {
    return NextResponse.json({ message: "URL ausente." }, { status: 400 });
  }

  let audioBuffer: Buffer;
  let inputExt: string;
  let inputContentType: string;

  try {
    const fetched = await fetchAuthorizedAudioBuffer(rawUrl, {
      userId: session.user.id,
      organizationId: orgId,
      isSuperAdmin: Boolean(session.user.isSuperAdmin),
      role: (session.user as { role?: string | null }).role ?? null,
    });
    const baseMime = fetched.contentType.split(";")[0].trim();
    inputExt = guessInputExt(baseMime);
    inputContentType = baseMime;
    audioBuffer = fetched.buffer;
    // Se o MIME do servidor veio "bin"/desconhecido, tenta deduzir pela URL.
    if (inputExt === "bin") {
      const urlExt = path.extname(decodeURIComponent(rawUrl).split("?")[0]).slice(1).toLowerCase();
      if (urlExt) {
        inputExt = urlExt;
        inputContentType = mimeForGroq(urlExt);
      } else {
        inputExt = "webm";
      }
    }
  } catch (err) {
    if (err instanceof MediaTooLargeError) {
      return NextResponse.json({ message: err.message }, { status: 413 });
    }
    return NextResponse.json(
      { message: err instanceof Error ? err.message : "Falha ao baixar áudio." },
      { status: 502 },
    );
  }

  const groqKey = process.env.GROQ_API_KEY?.trim();
  const hfKey = process.env.HUGGINGFACE_API_KEY?.trim();

  // ── Fail-fast quando NÃO há provedor configurado ─────────────────
  // Sem `GROQ_API_KEY` e sem `HUGGINGFACE_API_KEY`, o caminho HF puro
  // (anônimo) historicamente retorna 401 e, antes disso, força um
  // ffmpeg→WAV que em alguns ambientes Docker (Easypanel/Linux) fica
  // pendurado por minutos — estourando o timeout do proxy nginx e
  // devolvendo HTML 502/504 pro cliente. Em vez disso, devolvemos JSON
  // imediato com instrução clara para o operador.
  if (!groqKey && !hfKey) {
    return NextResponse.json(
      {
        message:
          "Transcrição não está configurada no servidor. Configure GROQ_API_KEY no painel Easypanel (chave grátis em https://console.groq.com — sem cartão).",
      },
      { status: 503 },
    );
  }

  // ── Caminho preferencial: Groq Whisper ────────────────────────────
  if (groqKey) {
    // Tentativa 1: arquivo original.
    const result = await transcribeGroq(groqKey, audioBuffer, inputExt);

    if ("text" in result) {
      return NextResponse.json({ text: result.text, model: GROQ_MODEL, provider: "groq" });
    }

    // Tentativa 2: transcoda pra MP3 e tenta de novo.
    if ("retryWithMp3" in result) {
      console.log("[transcribe] Groq rejeitou formato — transcodando pra MP3 e tentando de novo…");
      const mp3 = await convertToMp3(audioBuffer, inputExt);
      if (!mp3) {
        return NextResponse.json(
          {
            message:
              "Não foi possível preparar o áudio (ffmpeg indisponível). Tente baixar o áudio em MP3 e enviar novamente.",
          },
          { status: 500 },
        );
      }
      const retry = await transcribeGroq(groqKey, mp3, "mp3");
      if ("text" in retry) {
        return NextResponse.json({ text: retry.text, model: GROQ_MODEL, provider: "groq" });
      }
      if ("error" in retry) {
        return NextResponse.json({ message: retry.error }, { status: retry.status ?? 502 });
      }
    }

    if ("error" in result) {
      return NextResponse.json({ message: result.error }, { status: result.status ?? 502 });
    }
  }

  // ── Fallback: Hugging Face (precisa WAV 16kHz pra estabilidade) ───
  // Quando NÃO tem GROQ_API_KEY, mantemos o pipeline antigo. Sugerimos
  // configurar Groq no erro pra empurrar o operador pro caminho bom.
  console.log("[transcribe] GROQ_API_KEY ausente — caindo pro fallback Hugging Face.");

  // Importação tardia pra não pagar o custo de carregar o módulo
  // quando Groq está configurado (caminho feliz).
  const { convertToWav16k } = await import("@/lib/audio-convert");
  const wav = await convertToWav16k(audioBuffer, inputExt);

  if (!wav) {
    // Se até a conversão WAV falhou, tenta mandar o original direto
    // pro HF — alguns modelos Whisper aceitam OGG/WebM nativamente.
    console.warn("[transcribe] WAV16k falhou — enviando arquivo original pro HF como último recurso.");
    const hfRaw = await transcribeHuggingFace(audioBuffer, inputContentType);
    if ("text" in hfRaw) {
      return NextResponse.json({ text: hfRaw.text, model: HF_MODEL, provider: "huggingface" });
    }
    return NextResponse.json(
      {
        message:
          (hfRaw.error ?? "Não foi possível transcrever o áudio.") +
          " Configure GROQ_API_KEY (grátis em https://console.groq.com) para uma experiência mais robusta.",
      },
      { status: hfRaw.status ?? 500 },
    );
  }

  const hf = await transcribeHuggingFace(wav, "audio/wav");
  if ("text" in hf) {
    return NextResponse.json({ text: hf.text, model: HF_MODEL, provider: "huggingface" });
  }
  return NextResponse.json(
    {
      message:
        hf.error +
        " Dica: configure GROQ_API_KEY (grátis em https://console.groq.com) para usar Whisper Large v3 Turbo, mais rápido e preciso.",
    },
    { status: hf.status ?? 502 },
  );
}
