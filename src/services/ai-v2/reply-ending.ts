/**
 * Fecho das respostas ("Me avise se funcionou", "Ficou alguma dúvida?"): a
 * frase vem da configuração (do agente ou do assunto) e é o motor que a põe
 * no fim, não o modelo — assim ela sempre aparece quando deve, nunca depois
 * de transferência/encerramento ou de resposta que já pergunta algo, alterna
 * entre as frases e não se repete na mensagem seguinte.
 * Nenhum domínio de cliente: só as frases configuradas.
 */

import type { V2AgentConfig, V2ReplyEnding, V2Theme } from "@/lib/ai-v2/types";

export type V2ReplyKind = "procedure" | "info";

const fold = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** Linha de passo: "1.", "2)", "1️⃣", "Passo 3". */
const STEP_LINE = /^\s*(?:\d{1,2}\s*[.)-]|\d️?⃣|passo\s+\d)/i;

/** Passo a passo (2+ passos numerados) ou informação. */
export function classifyReply(reply: string): V2ReplyKind {
  const steps = reply.split(/\n+/).filter((l) => STEP_LINE.test(l)).length;
  return steps >= 2 ? "procedure" : "info";
}

/** Regras valendo: as do assunto quando ele tem as próprias, senão as do agente. */
export function effectiveReplyEnding(config: V2AgentConfig, theme?: V2Theme | null): V2ReplyEnding | undefined {
  if (theme?.replyEnding && theme.replyEnding.inherit === false) return theme.replyEnding;
  return config.replyEnding;
}

/** Há alguma frase configurada (o prompt então pede ao modelo que não crie o próprio fecho). */
export function hasReplyEnding(ending: V2ReplyEnding | undefined): boolean {
  return !!ending && [ending.procedure, ending.info].some((r) => r?.enabled && r.phrases.some((p) => p.trim()));
}

/**
 * Resposta com o fecho configurado, ou a mesma quando não cabe.
 * `lastAgentMessage`: a mensagem anterior do agente (para não repetir).
 */
export function applyReplyEnding(args: {
  reply: string;
  ending: V2ReplyEnding | undefined;
  lastAgentMessage?: string | null;
  /** Número que muda a cada turno (ex.: tamanho do histórico), para alternar as frases. */
  turnSeed?: number;
}): { text: string; added: string | null; kind: V2ReplyKind | null } {
  const reply = args.reply.trimEnd();
  if (!reply.trim() || !args.ending) return { text: args.reply, added: null, kind: null };
  const kind = classifyReply(reply);
  const rule = args.ending[kind];
  const phrases = (rule?.enabled ? rule.phrases : []).map((p) => p.trim()).filter(Boolean);
  if (phrases.length === 0) return { text: args.reply, added: null, kind };

  // Já termina com pergunta (pedido de dado, opção, confirmação): não soma outra.
  const lastLine = reply.split("\n").filter((l) => l.trim()).pop() ?? "";
  if (/\?\s*[\p{Emoji_Presentation}\p{Extended_Pictographic}\s]*$/u.test(lastLine)) return { text: args.reply, added: null, kind };

  // A resposta ou a mensagem anterior do agente já traz uma das frases.
  const foldedReply = fold(reply);
  const foldedLast = fold(args.lastAgentMessage ?? "");
  if (phrases.some((p) => foldedReply.includes(fold(p)) || (foldedLast && foldedLast.includes(fold(p))))) {
    return { text: args.reply, added: null, kind };
  }

  const phrase = phrases[Math.abs(args.turnSeed ?? 0) % phrases.length];
  return { text: `${reply}\n\n${phrase}`, added: phrase, kind };
}

/** Linha do prompt: quem põe o fecho é o motor. */
export const REPLY_ENDING_PROMPT =
  "Não termine a resposta com pergunta de confirmação (\"conseguiu?\", \"funcionou?\", \"ficou claro?\") nem oferta de mais ajuda: o fecho é acrescentado depois. Pergunte só o que for necessário para continuar o atendimento.";
