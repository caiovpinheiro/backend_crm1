/**
 * Áudio e imagem do cliente viram texto para o agente, com a chave do
 * próprio agente: áudio é transcrito e imagem é lida pelo modelo dele
 * (descrição + texto visível, como print de erro ou documento).
 *
 * O resultado fica guardado por mensagem: não repete o custo, e o histórico
 * dos turnos seguintes (e o "Comparar com humano") enxerga o conteúdo em vez
 * do marcador "[Áudio]". Nenhum domínio de cliente.
 */

import { prismaBase } from "@/lib/prisma-base";
import { fetchAuthorizedAudioBuffer } from "@/lib/fetch-authorized-audio";
import { guessInputExt } from "@/lib/audio-convert";
import { transcribeWithGroq } from "@/lib/groq-transcribe";
import { isMediaPlaceholderText } from "@/lib/ai-agents/media-placeholder";
import { generateWithTools, transcribeWithOpenAI } from "@/services/ai/provider";

export type UnderstoodKind = "audio" | "image";

const AUDIO_TYPES = new Set(["audio", "ptt", "voice", "voice_note"]);
const IMAGE_TYPES = new Set(["image"]);

export function understoodKindOf(messageType: string | null | undefined): UnderstoodKind | null {
  const t = (messageType ?? "").toLowerCase();
  if (AUDIO_TYPES.has(t)) return "audio";
  if (IMAGE_TYPES.has(t)) return "image";
  return null;
}

/**
 * Como o conteúdo entra no texto do cliente. O mesmo formato no turno e no
 * histórico: o motor tira do histórico as bolhas que já estão no turno
 * comparando o texto.
 */
export function mediaTextLine(kind: UnderstoodKind, text: string, caption?: string | null): string {
  const cap = caption && !isMediaPlaceholderText(caption) ? caption.trim() : "";
  if (kind === "audio") return `[Áudio do cliente, transcrito]: ${text}`;
  return `[Imagem enviada pelo cliente${cap ? `, com a legenda "${cap}"` : ""}]: ${text}`;
}

// ─── Armazenamento ─────────────────────────────────────────────────────

const db = prismaBase as unknown as {
  $queryRawUnsafe: <T = unknown>(q: string, ...v: unknown[]) => Promise<T>;
  $executeRawUnsafe: (q: string, ...v: unknown[]) => Promise<number>;
};

let schemaReady = false;
async function ensureSchema(): Promise<void> {
  if (schemaReady || process.env.NODE_ENV === "test") return;
  await db.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "ai_simple_media_texts" (
      "messageId" TEXT PRIMARY KEY,
      "organizationId" TEXT NOT NULL,
      "kind" TEXT NOT NULL,
      "text" TEXT NOT NULL,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  schemaReady = true;
}

/** Textos já obtidos para estas mensagens (id → texto). */
export async function getMediaTexts(organizationId: string, messageIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (messageIds.length === 0) return out;
  try {
    await ensureSchema();
    const rows = await db.$queryRawUnsafe<Array<{ messageId: string; text: string }>>(
      `SELECT "messageId", "text" FROM "ai_simple_media_texts" WHERE "organizationId" = $1 AND "messageId" = ANY($2::text[])`,
      organizationId, messageIds,
    );
    for (const r of rows) out.set(r.messageId, r.text);
  } catch (err) {
    console.warn("[ai-v2 mídia] leitura dos textos falhou:", err instanceof Error ? err.message : err);
  }
  return out;
}

async function saveMediaText(organizationId: string, messageId: string, kind: UnderstoodKind, text: string): Promise<void> {
  try {
    await ensureSchema();
    await db.$executeRawUnsafe(
      `INSERT INTO "ai_simple_media_texts" ("messageId","organizationId","kind","text") VALUES ($1,$2,$3,$4)
       ON CONFLICT ("messageId") DO UPDATE SET "text" = EXCLUDED."text"`,
      messageId, organizationId, kind, text,
    );
  } catch (err) {
    console.warn("[ai-v2 mídia] gravação do texto falhou:", err instanceof Error ? err.message : err);
  }
}

// ─── Entender a mídia ───────────────────────────────────────────────────

const IMAGE_PROMPT = [
  "Você recebe uma imagem que um cliente mandou num atendimento por mensagem.",
  "Em português, descreva objetivamente o que ela mostra e transcreva literalmente todo texto visível (mensagem de erro, tela de sistema, documento, comprovante).",
  "Não interprete a intenção do cliente nem invente o que não aparece. Até 8 linhas.",
].join(" ");

export type MediaMessage = {
  id: string;
  messageType: string | null;
  mediaUrl: string | null;
  content: string | null;
};

export type UnderstandArgs = {
  organizationId: string;
  /** Usuário do agente: o download confere o acesso como o dele. */
  userId: string;
  message: MediaMessage;
  kind: UnderstoodKind;
  /** Modelo e chave do agente: leitura de imagem e transcrição de áudio. */
  model: string;
  apiKey: string | null;
};

/** Texto da mídia (do cache ou obtido agora). `null` quando não deu para entender. */
export async function understandMedia(args: UnderstandArgs): Promise<{ text: string | null; error?: string; cached: boolean }> {
  const cached = await getMediaTexts(args.organizationId, [args.message.id]);
  const hit = cached.get(args.message.id);
  if (hit) return { text: hit, cached: true };
  if (!args.message.mediaUrl) return { text: null, error: "mídia sem arquivo", cached: false };

  try {
    const media = await fetchAuthorizedAudioBuffer(args.message.mediaUrl, {
      userId: args.userId,
      organizationId: args.organizationId,
      isSuperAdmin: false,
      role: null,
    });
    const mime = media.contentType.split(";")[0].trim();
    let text: string | null = null;
    if (args.kind === "audio") {
      // Chave do próprio agente primeiro (a mesma conta que ele já usa); o
      // serviço de transcrição do servidor só quando o agente não tem chave.
      if (args.apiKey) {
        try {
          text = await transcribeWithOpenAI(args.apiKey, new Uint8Array(media.buffer));
        } catch (err) {
          return { text: null, error: `transcrição pela chave do agente falhou: ${err instanceof Error ? err.message : String(err)}`, cached: false };
        }
      } else {
        const ext = guessInputExt(mime);
        const r = await transcribeWithGroq(media.buffer, ext === "bin" ? "ogg" : ext);
        if ("error" in r) return { text: null, error: `agente sem chave do modelo; ${r.error}`, cached: false };
        text = r.text.trim();
      }
    } else {
      if (!args.apiKey) return { text: null, error: "sem chave do modelo", cached: false };
      const r = await generateWithTools({
        model: args.model,
        apiKey: args.apiKey,
        system: IMAGE_PROMPT,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Imagem enviada pelo cliente:" },
              { type: "image", image: new Uint8Array(media.buffer), mediaType: mime.startsWith("image/") ? mime : "image/jpeg" },
            ],
          },
        ] as never,
        temperature: 0,
        maxOutputTokens: 500,
        maxSteps: 1,
      });
      text = r.text.trim();
    }
    if (!text) return { text: null, error: "resultado vazio", cached: false };
    await saveMediaText(args.organizationId, args.message.id, args.kind, text);
    return { text, cached: false };
  } catch (err) {
    return { text: null, error: err instanceof Error ? err.message : String(err), cached: false };
  }
}
