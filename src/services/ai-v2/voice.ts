/**
 * Resposta por áudio do motor v2.
 *
 * O áudio é outro jeito de entregar a MESMA resposta do turno: o texto falado
 * é a resposta que já passou pelas conferências do motor (fontes, links,
 * dados sensíveis). Qualquer impedimento — configuração, permissão, limite,
 * falha do provedor ou da conversão — faz a resposta sair em texto, como
 * sempre. Nenhum domínio de cliente.
 */

import type { V2AgentConfig } from "@/lib/ai-v2/types";
import { getLogger } from "@/lib/logger";
import { prismaBase } from "@/lib/prisma-base";
import { decryptSecret, encryptSecret } from "@/lib/secret-crypto";

import type { V2Counters } from "./limits";
import { traceStep } from "./trace";
import { VoiceProviderError, voiceModelInfo, voiceProviderFor } from "./voice-provider";

const log = getLogger("ai-v2.voice");

export const VOICE_PERMISSION_QUESTION_DEFAULT = "Posso te responder por áudio? É rapidinho.";
export const VOICE_COMPANION_TEXT_DEFAULT = "Te respondi por áudio.";
/** Abre a linha escrita quando o áudio traz valor, data ou link. */
export const VOICE_WRITTEN_PREFIX = "Por escrito:";
/** Abaixo disto a resposta é um "ok"/cumprimento: vai em texto. */
export const VOICE_MIN_CHARS = 40;
/** Quanto o motor espera o áudio sair antes de mandar a linha escrita. */
const VOICE_SEND_WAIT_MS = 30_000;

// ─── Texto falado e texto escrito ───────────────────────────────────────

const URL_RE = /https?:\/\/\S+|www\.\S+/gi;

/** A resposta como fala: sem link, marcação, emoji nem marcador de lista. */
export function speakableText(text: string): string {
  return text
    .replace(URL_RE, " ")
    .replace(/[*_~`]+/g, "")
    .replace(/^\s*(?:[-•–]|\d+[.)])\s+/gm, "")
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, "")
    .replace(/\s*\n+\s*/g, " ")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([.,!?;:])/g, "$1")
    .trim();
}

/** Marcações de interpretação do texto falado ("[animada]", "[pausa]"). Colchete com número não é marcação. */
const AUDIO_TAG_RE = /\[[^\[\]\n\d]{2,40}\]/g;

/** Tira as marcações de interpretação (ficam só no áudio, nunca no texto escrito). */
export function stripAudioTags(text: string): string {
  return text.replace(AUDIO_TAG_RE, " ").replace(/[ \t]{2,}/g, " ").replace(/\s+([.,!?;:])/g, "$1").trim();
}

const MONTHS = "janeiro|fevereiro|março|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro";
const WRITTEN_DATA_PATTERNS: RegExp[] = [
  /https?:\/\/[^\s)]+|www\.[^\s)]+/gi,
  /R\$\s?\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?|\b\d+(?:[.,]\d+)?\s?(?:reais|mil reais)\b/gi,
  new RegExp(`\\b\\d{1,2}(?:º)?\\s+de\\s+(?:${MONTHS})(?:\\s+de\\s+\\d{4})?|\\b(?:${MONTHS})\\s+de\\s+\\d{4}\\b`, "gi"),
  /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g,
  /\b\d{1,2}h(?:\d{2})?\b|\b\d{1,2}:\d{2}\b/g,
  /\b\d+(?:,\d+)?\s?%/g,
];

/**
 * Só os dados que precisam ficar por escrito — valor, data, horário,
 * percentual e link — na ordem em que aparecem, sem a frase em volta. Quem
 * não pode ouvir lê o essencial sem o áudio ser repetido em texto.
 */
export function writtenData(text: string): string[] {
  const found: Array<{ at: number; end: number; value: string }> = [];
  for (const re of WRITTEN_DATA_PATTERNS) {
    for (const m of text.matchAll(re)) {
      const value = m[0].replace(/[.,;:!?]+$/, "").trim();
      const at = m.index ?? 0;
      // Um dado dentro de outro já achado (o dia dentro da data por extenso) não repete.
      if (!value || found.some((f) => at >= f.at && at < f.end)) continue;
      found.push({ at, end: at + m[0].length, value });
    }
  }
  const seen = new Set<string>();
  return found
    .sort((a, b) => a.at - b.at)
    .map((f) => f.value)
    .filter((v) => (seen.has(v.toLowerCase()) ? false : (seen.add(v.toLowerCase()), true)))
    .slice(0, 6);
}

/** Linha escrita que acompanha o áudio: os dados, ou a linha configurada. Nunca vazia. */
export function voiceCompanionText(config: V2AgentConfig, replyText: string): string {
  const data = writtenData(stripAudioTags(replyText));
  if (data.length > 0) return `${VOICE_WRITTEN_PREFIX} ${data.join(" · ")}`;
  return config.voice?.companionText?.trim() || VOICE_COMPANION_TEXT_DEFAULT;
}

const digitsOf = (text: string) => (text.match(/\d+(?:[.,]\d+)*/g) ?? []).map((n) => n.replace(/\D/g, "")).filter(Boolean);

/**
 * O roteiro falado pode mudar o jeito de dizer, não o conteúdo: todo número
 * dele precisa estar na resposta escrita (a que o motor conferiu) e ele não
 * traz link. Fora disso, o motor fala a própria resposta.
 */
export function speechMatchesReply(speech: string, replyText: string): boolean {
  const plain = stripAudioTags(speech);
  if (!plain.trim()) return false;
  if (/https?:\/\/|www\./i.test(plain)) return false;
  const known = new Set(digitsOf(replyText));
  return digitsOf(plain).every((n) => known.has(n));
}

// ─── Decisão ────────────────────────────────────────────────────────────

export type VoiceDecision =
  | { action: "none"; reason: string }
  /** Pergunta a permissão no lugar da resposta; o áudio fica para depois do "sim". */
  | { action: "ask"; question: string }
  /** `spoken` vai ao provedor (com marcações, se o modelo aceita); `plain` é o mesmo texto sem elas. */
  | { action: "speak"; spoken: string; plain: string };

/** Configuração pronta para falar: ligada e com voz escolhida. */
export function voiceConfigured(config: V2AgentConfig): boolean {
  return config.voice?.enabled === true && !!config.voice.voiceId?.trim();
}

/** O cliente já liberou áudio nesta conversa (aceitou ou mandou áudio). */
export function voiceConsented(counters: V2Counters, clientAudioThisTurn: boolean): boolean {
  return counters.voiceConsent === "granted" || counters.voiceClientAudio === true || clientAudioThisTurn;
}

/**
 * Se a resposta deste turno vai por áudio. Função pura: tudo o que o motor
 * garante sobre voz está aqui, sem depender do que o modelo escreveu.
 */
export function decideVoice(args: {
  config: V2AgentConfig;
  counters: V2Counters;
  /** O modelo marcou a resposta para ir por áudio. */
  modelWantsVoice: boolean;
  /** O cliente mandou áudio nesta mensagem. */
  clientAudioThisTurn: boolean;
  autonomous: boolean;
  hasKey: boolean;
  replyText: string;
  /** Roteiro falado do modelo, já conferido contra a resposta. Vazio = fala a resposta. */
  speech?: string | null;
  /** A resposta vai com botões/lista (áudio não carrega opções). */
  hasOptions: boolean;
  /** Caracteres já falados hoje pelo agente. */
  charsToday: number;
}): VoiceDecision {
  const v = args.config.voice;
  if (!v || !voiceConfigured(args.config)) return { action: "none", reason: "voz desligada ou sem voz escolhida" };
  const wants = args.clientAudioThisTurn || (v.mode === "agent" && args.modelWantsVoice);
  if (!wants) return { action: "none", reason: "resposta em texto" };
  if (!args.hasKey) return { action: "none", reason: "o agente não tem chave do provedor de voz" };
  if (!args.autonomous) return { action: "none", reason: "modo sugestão não gera áudio" };
  if (args.counters.voiceConsent === "denied") return { action: "none", reason: "o cliente recusou áudio" };
  if (args.hasOptions) return { action: "none", reason: "a resposta vai com botões" };
  const source = args.speech?.trim() || args.replyText;
  // Limites e custo contam o que é dito, sem as marcações de interpretação.
  const plain = speakableText(stripAudioTags(source));
  const spoken = voiceModelInfo(v.model).audioTags ? speakableText(source) : plain;
  if (plain.length < VOICE_MIN_CHARS) return { action: "none", reason: "resposta curta demais para áudio" };
  if (plain.length > v.maxChars) return { action: "none", reason: `passa do limite de ${v.maxChars} caracteres falados` };
  if ((args.counters.voiceCount ?? 0) >= v.maxPerConversation) return { action: "none", reason: `teto de ${v.maxPerConversation} áudio(s) por conversa` };
  if (v.dailyCharCap > 0 && args.charsToday + plain.length > v.dailyCharCap) return { action: "none", reason: "teto diário de voz atingido" };
  if (!voiceConsented(args.counters, args.clientAudioThisTurn)) {
    if (args.counters.voiceAsked) return { action: "none", reason: "permissão já pedida e ainda sem resposta" };
    return { action: "ask", question: v.permissionQuestion?.trim() || VOICE_PERMISSION_QUESTION_DEFAULT };
  }
  return { action: "speak", spoken, plain };
}

/**
 * Guarda a resposta do cliente à pergunta de permissão. O "sim" só vale se a
 * pergunta foi feita; o "não" vale sempre.
 */
export function applyVoiceConsent(counters: V2Counters, answer: boolean | null | undefined): void {
  if (answer === false) counters.voiceConsent = "denied";
  else if (answer === true && counters.voiceAsked && counters.voiceConsent !== "denied") counters.voiceConsent = "granted";
}

/** Trecho do prompt: quando e como marcar a resposta para áudio. Vazio = o modelo nem fica sabendo. */
export function voicePromptSection(args: {
  config: V2AgentConfig;
  counters: V2Counters;
  clientAudioThisTurn: boolean;
  autonomous: boolean;
  hasKey: boolean;
}): string {
  const v = args.config.voice;
  if (!v || !voiceConfigured(args.config) || !args.hasKey || !args.autonomous) return "";
  if (args.counters.voiceConsent === "denied") return "";
  if ((args.counters.voiceCount ?? 0) >= v.maxPerConversation) return "";
  if (v.mode !== "agent" && !args.clientAudioThisTurn) return "";
  const lines = ["# Resposta por áudio"];
  if (args.clientAudioThisTurn) {
    lines.push("O cliente mandou áudio: esta resposta vai por áudio se couber no limite.");
  } else {
    lines.push("Você pode mandar esta resposta por áudio: marque voice=true. O sistema confere se pode e, se não puder, manda em texto.");
    if (v.guidance?.trim()) lines.push(`Quando usar áudio:\n${v.guidance.trim()}`);
  }
  lines.push(`Quando a resposta for por áudio, preencha também speech: o roteiro falado da mesma resposta, como quem grava um áudio para um conhecido — coloquial, frases curtas, sem lista, sem emoji e sem link, até ${v.maxChars} caracteres. O speech diz o mesmo que a reply, com os mesmos valores e datas, e nada que não esteja nela. A reply continua sendo a resposta escrita completa: fica no registro. Valor, data e link o sistema manda por escrito junto com o áudio.`);
  lines.push(voiceModelInfo(v.model).audioTags
    ? "No speech você pode pôr marcações de interpretação entre colchetes, antes do trecho a que se aplicam, como [animada] ou [confiante]. Elas mudam o jeito de falar e não são lidas em voz alta; use poucas."
    : "Não use colchetes nem marcações de interpretação no speech: seriam lidos em voz alta.");
  if (!voiceConsented(args.counters, args.clientAudioThisTurn)) {
    lines.push(args.counters.voiceAsked
      ? "O cliente já foi perguntado se aceita áudio. Se nesta mensagem ele aceitou, devolva voiceConsent=true; se recusou, voiceConsent=false; se não respondeu a isso, null."
      : "O cliente ainda não autorizou áudio: se você marcar voice=true, o sistema pergunta antes e a resposta fica para depois do sim. Não pergunte você.");
  }
  lines.push("Se o cliente disser que não quer áudio, devolva voiceConsent=false.");
  return lines.join("\n");
}

// ─── Chave do provedor (por agente, cifrada) ────────────────────────────

const db = prismaBase as unknown as {
  $queryRawUnsafe: <T = unknown>(q: string, ...v: unknown[]) => Promise<T>;
  $executeRawUnsafe: (q: string, ...v: unknown[]) => Promise<number>;
};

/** Chave colada com aspas, espaços ou quebra de linha: limpa. */
export function sanitizeVoiceApiKey(raw: string): string {
  return raw.replace(/[​-‍﻿]/g, "").trim().replace(/^["']+|["']+$/g, "").replace(/[\s\r\n]+/g, "");
}

/**
 * Traduz a chave em texto puro vinda da tela nos campos de banco.
 * `undefined` → não mexe; `null`/"" → limpa; texto → cifra + dica (4 últimos).
 */
export function voiceKeyFields(raw: string | null | undefined): { voiceApiKeyEnc: string | null; voiceApiKeyHint: string | null } | null {
  if (raw === undefined) return null;
  const key = sanitizeVoiceApiKey(raw ?? "");
  if (!key) return { voiceApiKeyEnc: null, voiceApiKeyHint: null };
  if (key.length < 16) throw new Error("Chave do provedor de voz curta demais. Confira se copiou a chave inteira.");
  return { voiceApiKeyEnc: encryptSecret(key), voiceApiKeyHint: key.slice(-4) };
}

export async function saveAgentVoiceKey(agentId: string, organizationId: string, fields: { voiceApiKeyEnc: string | null; voiceApiKeyHint: string | null }): Promise<void> {
  await db.$executeRawUnsafe(
    `UPDATE "ai_agent_configs" SET "voiceApiKeyEnc" = $1, "voiceApiKeyHint" = $2, "updatedAt" = NOW() WHERE id = $3 AND "organizationId" = $4`,
    fields.voiceApiKeyEnc, fields.voiceApiKeyHint, agentId, organizationId,
  );
}

/** Dica da chave (4 últimos) para a tela. A chave em si nunca volta. */
export async function agentVoiceKeyHint(agentId: string, organizationId: string): Promise<string | null> {
  try {
    const rows = await db.$queryRawUnsafe<Array<{ hint: string | null; has: boolean }>>(
      `SELECT "voiceApiKeyHint" AS hint, ("voiceApiKeyEnc" IS NOT NULL) AS has FROM "ai_agent_configs" WHERE id = $1 AND "organizationId" = $2`,
      agentId, organizationId,
    );
    return rows[0]?.has ? rows[0].hint ?? "" : null;
  } catch {
    return null;
  }
}

/** Chave em claro do provedor de voz do agente; `null` quando não há ou não pôde ser lida. */
export async function tryGetAgentVoiceKey(agentId: string): Promise<string | null> {
  try {
    const rows = await db.$queryRawUnsafe<Array<{ enc: string | null }>>(
      `SELECT "voiceApiKeyEnc" AS enc FROM "ai_agent_configs" WHERE id = $1`,
      agentId,
    );
    const enc = rows[0]?.enc;
    if (!enc) return null;
    return decryptSecret(enc).trim() || null;
  } catch {
    return null;
  }
}

// ─── Uso (teto diário) ──────────────────────────────────────────────────

let usageReady = false;
async function ensureUsageTable(): Promise<void> {
  if (usageReady || process.env.NODE_ENV === "test") return;
  await db.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "ai_simple_voice_usage" (
      "id" TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
      "organizationId" TEXT NOT NULL,
      "agentId" TEXT NOT NULL,
      "conversationId" TEXT,
      "chars" INTEGER NOT NULL,
      "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
  await db.$executeRawUnsafe(`CREATE INDEX IF NOT EXISTS idx_ai_simple_voice_usage_agent ON "ai_simple_voice_usage"("agentId", "createdAt")`);
  usageReady = true;
}

/** Caracteres falados pelo agente desde `since`. Sem leitura possível, conta zero. */
export async function voiceCharsSince(agentId: string, since: Date): Promise<number> {
  try {
    await ensureUsageTable();
    const rows = await db.$queryRawUnsafe<Array<{ total: number | bigint | null }>>(
      `SELECT COALESCE(SUM("chars"), 0) AS total FROM "ai_simple_voice_usage" WHERE "agentId" = $1 AND "createdAt" >= $2`,
      agentId, since,
    );
    return Number(rows[0]?.total ?? 0);
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : err }, "[ai-v2 voz] leitura do uso falhou");
    return 0;
  }
}

async function recordVoiceUsage(args: { organizationId: string; agentId: string; conversationId: string; chars: number }): Promise<void> {
  try {
    await ensureUsageTable();
    await db.$executeRawUnsafe(
      `INSERT INTO "ai_simple_voice_usage" ("organizationId","agentId","conversationId","chars") VALUES ($1,$2,$3,$4)`,
      args.organizationId, args.agentId, args.conversationId, args.chars,
    );
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : err }, "[ai-v2 voz] gravação do uso falhou");
  }
}

// ─── Entrega ────────────────────────────────────────────────────────────

/**
 * Gera o áudio e manda como mensagem de voz. `sent: false` em qualquer falha
 * (provedor, armazenamento, travas do envio, conversão): quem chama manda a
 * resposta em texto. O texto falado fica gravado na mensagem.
 */
export async function deliverVoiceReply(args: {
  organizationId: string;
  agentId: string;
  agentUserId: string;
  conversationId: string;
  contactId: string;
  config: V2AgentConfig;
  /** Texto enviado ao provedor (pode ter marcações de interpretação). */
  spoken: string;
  /** O mesmo texto sem marcações: conta no uso. */
  plain: string;
  /** Texto gravado na mensagem de voz, para a equipe e para o histórico. */
  record: string;
}): Promise<{ sent: boolean; reason?: string }> {
  const v = args.config.voice;
  const voiceId = v?.voiceId?.trim();
  if (!v || !voiceId) return { sent: false, reason: "sem voz escolhida" };
  const apiKey = await tryGetAgentVoiceKey(args.agentId);
  if (!apiKey) return { sent: false, reason: "sem chave do provedor de voz" };

  let url: string;
  let mime: string;
  let fileName: string;
  try {
    const audio = await voiceProviderFor(v.provider).synthesize({ apiKey, voiceId, text: args.spoken, model: v.model, settings: v.settings });
    // Cobrado pelo provedor na geração, saia ou não a mensagem.
    await recordVoiceUsage({ organizationId: args.organizationId, agentId: args.agentId, conversationId: args.conversationId, chars: args.plain.length });
    const { generateFileName, saveFile } = await import("@/lib/storage/local");
    fileName = generateFileName({ prefix: "voz", ext: audio.ext });
    const saved = await saveFile({ orgId: args.organizationId, bucket: "automation-media", fileName, buffer: audio.buffer });
    url = saved.url;
    mime = audio.mime;
  } catch (err) {
    const reason = err instanceof VoiceProviderError ? err.message : "não foi possível gerar ou guardar o áudio";
    log.warn({ agentId: args.agentId, status: err instanceof VoiceProviderError ? err.status : undefined, reason }, "[ai-v2 voz] geração falhou");
    return { sent: false, reason };
  }

  try {
    const { sendAgentFollowUpMedia, mediaNotSentTrace } = await import("@/services/ai/send-agent-media");
    let report: Parameters<typeof mediaNotSentTrace>[1];
    const sent = await sendAgentFollowUpMedia({
      conversationId: args.conversationId,
      contactId: args.contactId,
      agentUserId: args.agentUserId,
      attachments: [{ url, mimeType: mime, name: fileName, caption: args.record, voiceOnly: true, normalizeLoudness: true }],
      waitForSendMs: VOICE_SEND_WAIT_MS,
      report: (r) => {
        report = r;
      },
    });
    if (sent > 0) return { sent: true };
    const why = report?.blocked ? mediaNotSentTrace("Áudio", report) : "o áudio não pôde sair como mensagem de voz";
    return { sent: false, reason: why };
  } catch (err) {
    log.warn({ agentId: args.agentId, err: err instanceof Error ? err.message : err }, "[ai-v2 voz] envio falhou");
    return { sent: false, reason: "falha ao enviar o áudio" };
  }
}

/** Registra no rastro do turno por que a resposta não foi por áudio (quando alguém pediu áudio). */
export function traceVoiceSkipped(reason: string): void {
  traceStep("voz", `Resposta em texto: ${reason}`);
}
