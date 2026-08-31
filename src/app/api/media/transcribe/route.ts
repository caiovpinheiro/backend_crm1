import { NextResponse } from "next/server";
import path from "path";

import { auth } from "@/lib/auth";
import { convertToMp3, guessInputExt } from "@/lib/audio-convert";
import { isAllowedMetaMediaUrl } from "@/lib/meta-media-url";

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
 *   2) Baixa o áudio (via /uploads, Meta proxy ou mesma origem).
 *   3) Tenta enviar O ARQUIVO ORIGINAL pro Groq (multipart) — Groq
 *      aceita Opus/Vorbis/AAC/MP3/WAV/FLAC sem precisar transcodar.
 *   4) Se Groq rejeitar formato/codec, converte pra MP3 (libmp3lame
 *      é mais robusto que pcm_s16le pra WebM-Opus do WhatsApp) e
 *      tenta de novo.
 *   5) Retorna `{ text, model, provider }` ou erro amigável.
 */

async function fetchAudioBuffer(
  rawUrl: string,
  request: Request,
): Promise<{ buffer: Buffer; contentType: string }> {
  let decoded = decodeURIComponent(rawUrl);
  if (!decoded.startsWith("/")) {
    try {
      const parsed = new URL(decoded);
      if (
        parsed.pathname.startsWith("/api/") ||
        parsed.pathname.startsWith("/uploads/")
      ) {
        decoded = `${parsed.pathname}${parsed.search}`;
      }
    } catch {
      /* URL absoluta que não é storage — segue o fluxo Meta/externo */
    }
  }

  // PR 1.3: paths internos (`/uploads/...`, `/api/storage/...`) são
  // resolvidos via fetch HTTP com cookies de sessão pra que o
  // middleware/gateway aplique auth + checagem de tenant. NÃO ler do
  // FS direto — bypassaria a validação multi-tenant.
  if (isAllowedMetaMediaUrl(decoded)) {
    const token = process.env.META_WHATSAPP_ACCESS_TOKEN?.trim();
    if (!token) throw new Error("Token Meta não configurado.");
    const res = await fetch(decoded, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`Meta retornou ${res.status}.`);
    return {
      buffer: Buffer.from(await res.arrayBuffer()),
      contentType: res.headers.get("content-type") || "audio/ogg",
    };
  }

  if (decoded.startsWith("/")) {
    const origin = new URL(request.url).origin;
    const cookie = request.headers.get("cookie") ?? "";
    const res = await fetch(`${origin}${decoded}`, {
      headers: { cookie },
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`Origem retornou ${res.status}.`);
    return {
      buffer: Buffer.from(await res.arrayBuffer()),
      contentType: res.headers.get("content-type") || "audio/ogg",
    };
  }

  // Permite URL absoluta do próprio app (mesmo origin) — a UI às vezes
  // passa `https://.../api/...` ou `https://.../uploads/...`.
  try {
    const origin = new URL(request.url).origin;
    const u = new URL(decoded);
    if (u.origin === origin && u.pathname.startsWith("/")) {
      const cookie = request.headers.get("cookie") ?? "";
      const res = await fetch(`${origin}${u.pathname}${u.search}`, {
        headers: { cookie },
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`Origem retornou ${res.status}.`);
      return {
        buffer: Buffer.from(await res.arrayBuffer()),
        contentType: res.headers.get("content-type") || "audio/ogg",
      };
    }
  } catch {
    // ignore parse errors; keep unauthorized below
  }

  throw new Error("URL não autorizada.");
}

const GROQ_MODEL =
  process.env.GROQ_TRANSCRIBE_MODEL?.trim() || "whisper-large-v3-turbo";

const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/audio/transcriptions";

const HF_MODEL =
  process.env.HUGGINGFACE_TRANSCRIBE_MODEL?.trim() || "openai/whisper-base";

const HF_ENDPOINT = `https://api-inference.huggingface.co/models/${HF_MODEL}`;

/** Mapeia extensão pra MIME type aceito pelo Groq/Whisper.
 *  Groq aceita: mp3, mp4, mpeg, mpga, m4a, wav, webm, flac, ogg, opus. */
function mimeForGroq(ext: string): string {
  switch (ext.toLowerCase()) {
    case "mp3":
    case "mpeg":
    case "mpga":
      return "audio/mpeg";
    case "mp4":
    case "m4a":
      return "audio/mp4";
    case "wav":
      return "audio/wav";
    case "webm":
      return "audio/webm";
    case "flac":
      return "audio/flac";
    case "ogg":
    case "opus":
      return "audio/ogg";
    default:
      return "application/octet-stream";
  }
}

/** Extensão "amigável pro Groq" — converte aliases (`opus` → `ogg`,
 *  `mpga`/`mpeg` → `mp3`) pro nome de arquivo que o servidor espera. */
function groqFilename(ext: string): string {
  const norm = ext.toLowerCase();
  const final = norm === "opus" ? "ogg" : norm === "mpga" || norm === "mpeg" ? "mp3" : norm;
  return `audio.${final || "webm"}`;
}

type GroqResponse = { text?: string; error?: { message?: string } };
type HfTextResponse = { text?: string; error?: string; estimated_time?: number };

/** Tenta transcrever via Groq. Retorna `{ text }` em sucesso,
 *  `{ retryWithMp3: true }` se Groq rejeitou o formato (caller deve
 *  converter pra MP3 e tentar de novo) ou `{ error }` em falha
 *  definitiva. */
async function transcribeGroq(
  apiKey: string,
  audio: Buffer,
  ext: string,
): Promise<{ text: string } | { retryWithMp3: true } | { error: string; status?: number }> {
  const form = new FormData();
  const blob = new Blob([new Uint8Array(audio)], { type: mimeForGroq(ext) });
  form.append("file", blob, groqFilename(ext));
  form.append("model", GROQ_MODEL);
  // `response_format: json` retorna `{ text }` puro — verbose_json
  // traria timestamps mas é mais lento e desnecessário pro caso de
  // uso (operador só precisa ler o conteúdo do áudio).
  form.append("response_format", "json");
  // `language: pt` força transcrição em português (Whisper detecta
  // automaticamente, mas explicitar evita falsos positivos quando o
  // áudio começa com pausa longa ou tem música de fundo).
  form.append("language", "pt");
  // `temperature: 0` = saída determinística — duas chamadas no mesmo
  // áudio retornam o mesmo texto.
  form.append("temperature", "0");

  let res: Response;
  try {
    res = await fetch(GROQ_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
    });
  } catch (err) {
    return {
      error: err instanceof Error ? `Erro de rede ao chamar Groq: ${err.message}` : "Erro de rede.",
    };
  }

  const ctype = res.headers.get("content-type") || "";

  if (res.ok) {
    if (!ctype.includes("application/json")) {
      return { error: "Resposta inesperada do Groq (não-JSON)." };
    }
    const json = (await res.json()) as GroqResponse;
    const text = (json.text ?? "").trim();
    if (!text) {
      return { error: "Transcrição vazia (áudio sem fala detectável?)." };
    }
    return { text };
  }

  // Groq retorna 400 com `error.message` quando o formato não bate.
  // Sinalizamos pro caller tentar de novo com MP3 (transcoded).
  let msg = `HTTP ${res.status}`;
  try {
    if (ctype.includes("application/json")) {
      const j = (await res.json()) as GroqResponse;
      msg = j.error?.message ?? msg;
    } else {
      msg = (await res.text()).slice(0, 200);
    }
  } catch { /* ignora parse error */ }

  console.warn(`[transcribe/groq] ${res.status}: ${msg}`);

  if (res.status === 400 && /file|format|decode|invalid/i.test(msg)) {
    return { retryWithMp3: true };
  }

  if (res.status === 401 || res.status === 403) {
    return { error: "Chave Groq inválida (GROQ_API_KEY).", status: 401 };
  }

  if (res.status === 429) {
    return {
      error: "Limite de requisições do Groq atingido. Tente em alguns minutos.",
      status: 429,
    };
  }

  return { error: `Groq retornou ${res.status}: ${msg}`, status: 502 };
}

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
    const fetched = await fetchAudioBuffer(rawUrl, request);
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
