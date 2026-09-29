/**
 * Transcrição de áudio pelo Groq Whisper (compartilhada pela rota de
 * transcrição da conversa e pelo "Comparar com humano").
 */

import { convertToMp3 } from "@/lib/audio-convert";

export const GROQ_MODEL =
  process.env.GROQ_TRANSCRIBE_MODEL?.trim() || "whisper-large-v3-turbo";

const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/audio/transcriptions";

/** Mapeia extensão pra MIME type aceito pelo Groq/Whisper.
 *  Groq aceita: mp3, mp4, mpeg, mpga, m4a, wav, webm, flac, ogg, opus. */
export function mimeForGroq(ext: string): string {
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
export function groqFilename(ext: string): string {
  const norm = ext.toLowerCase();
  const final = norm === "opus" ? "ogg" : norm === "mpga" || norm === "mpeg" ? "mp3" : norm;
  return `audio.${final || "webm"}`;
}

type GroqResponse = { text?: string; error?: { message?: string } };

/** Tenta transcrever via Groq. Retorna `{ text }` em sucesso,
 *  `{ retryWithMp3: true }` se Groq rejeitou o formato (caller deve
 *  converter pra MP3 e tentar de novo) ou `{ error }` em falha
 *  definitiva. */
export async function transcribeGroq(
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

/**
 * Transcreve com o arquivo original e, se o Groq recusar o formato, de novo
 * em MP3. Sem GROQ_API_KEY devolve erro (sem cair em provedor lento).
 */
export async function transcribeWithGroq(audio: Buffer, ext: string): Promise<{ text: string } | { error: string }> {
  const key = process.env.GROQ_API_KEY?.trim();
  if (!key) return { error: "Transcrição não configurada (GROQ_API_KEY)." };
  const first = await transcribeGroq(key, audio, ext);
  if ("text" in first) return first;
  if ("retryWithMp3" in first) {
    const mp3 = await convertToMp3(audio, ext);
    if (!mp3) return { error: "Não foi possível preparar o áudio (ffmpeg indisponível)." };
    const retry = await transcribeGroq(key, mp3, "mp3");
    if ("text" in retry) return retry;
    return { error: "error" in retry ? retry.error : "Formato de áudio não aceito." };
  }
  return { error: first.error };
}
