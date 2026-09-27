/**
 * Aviso para quem espera na fila. Antes era um texto só: o primeiro saía e
 * os seguintes eram barrados pela trava anti-repetição — o cliente que
 * pedia para cancelar, reclamava ou chamava ("alô? alguém?") ficava sem
 * nada. Agora o aviso acompanha o que ele escreveu e nunca repete o último.
 * Nenhum domínio de cliente.
 */

import { isNearDuplicateReply } from "./ground-reply";

export type QueueNoticeKind = "first" | "cancel" | "upset" | "call" | "again";

const fold = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");

const CANCEL = /\b(?:cancel\w*|desist\w*|nao quero mais|pode encerrar|encerr[ae]\w*|deixa pra la|esquece)\b/;
const UPSET = /\b(?:lixo|pessim\w*|horrivel|absurdo|ridicul\w*|vergonha|descaso|ninguem (?:resolve|responde|atende)|de um lado (?:pro|para o) outro|demora\w*|cade|to esperando|estou esperando|palhacada|merda|porra|nao resolve\w*)\b/;
const CALL = /^(?:\?+|\.+|a+l+o+\W*|oi+\W*|ola\W*|alguem\W*|tem alguem\W*|(?:ei|e ai|hello)\W*)+$|\balguem\s*\?|\btem alguem\b|\bto aqui\b|\bestou aqui\b/;

export const QUEUE_NOTICES: Record<Exclude<QueueNoticeKind, "first">, string[]> = {
  cancel: [
    "Tudo bem, anotei que você quer cancelar. Sua mensagem fica registrada para a equipe, que vê a conversa assim que assumir.",
  ],
  upset: [
    "Sinto muito pela espera. Sua conversa está na fila e a equipe vê todas as suas mensagens; em instantes alguém continua com você por aqui.",
    "Entendo a sua frustração e peço desculpas pela demora. Você não perdeu o lugar na fila: assim que alguém da equipe assumir, continua daqui.",
  ],
  call: [
    "Estou aqui! Sua conversa está na fila; assim que alguém da equipe assumir, continua com você por aqui.",
    "Sigo com você. Sua conversa continua na fila da equipe e nada do que você escreveu se perde.",
  ],
  again: [
    "Sua mensagem ficou registrada para a equipe. Assim que alguém assumir, continua com você por aqui.",
    "Recebido! A equipe vai ver esta mensagem junto com as anteriores quando assumir a conversa.",
  ],
};

/** Mensagens neutras seguidas dentro disto não recebem aviso de novo. */
export const QUEUE_NOTICE_QUIET_MS = 20_000;

/** Aviso padrão para quem escreve enquanto espera na fila. */
export const QUEUED_MESSAGE_DEFAULT = "Você já está na fila de atendimento. Em instantes alguém da equipe continua com você por aqui.";
/** Fora do horário não se promete "em instantes": a equipe segue no próximo horário. */
export const QUEUED_MESSAGE_OUTSIDE_HOURS = "Você já está na fila de atendimento. Sua mensagem fica registrada e alguém da equipe continua com você por aqui no próximo horário de atendimento.";

/** Aviso configurado ou o padrão certo para o horário. */
export function queuedMessageFor(configured: string | null | undefined, withinBusinessHours: boolean): string {
  const custom = configured?.trim();
  if (custom) return custom;
  return withinBusinessHours ? QUEUED_MESSAGE_DEFAULT : QUEUED_MESSAGE_OUTSIDE_HOURS;
}

/** Promete atendimento imediato ("em instantes", "já já"): não cabe fora do horário. */
const PROMISES_SOON = /\bem instantes\b|\bja ja\b|\bem (?:poucos|alguns) (?:minutos|instantes)\b|\bdaqui a pouco\b|\blogo mais\b/;

export function queueNoticeKind(message: string): QueueNoticeKind {
  const m = fold(message).replace(/\s+/g, " ").trim();
  if (CANCEL.test(m)) return "cancel";
  if (UPSET.test(m)) return "upset";
  if (!m || CALL.test(m)) return "call";
  return "again";
}

/**
 * Qual aviso mandar (ou nenhum). `lastReply`: última mensagem do agente na
 * conversa; `lastReplyAt`: quando saiu. Primeiro aviso = o configurado.
 */
export function pickQueueNotice(args: {
  message: string;
  configured: string;
  lastReply: string | null;
  lastReplyAt: Date | null;
  now?: Date;
  /** Fora do horário: nenhuma variante que prometa "em instantes". */
  outsideHours?: boolean;
}): { text: string; kind: QueueNoticeKind } | null {
  const now = args.now ?? new Date();
  const repeats = (t: string) => !!args.lastReply && isNearDuplicateReply(t, args.lastReply);
  const allDefaults = [QUEUED_MESSAGE_DEFAULT, QUEUED_MESSAGE_OUTSIDE_HOURS, ...Object.values(QUEUE_NOTICES).flat()];
  const noticedBefore = !!args.lastReply && (repeats(args.configured) || allDefaults.some(repeats));
  if (!noticedBefore) return { text: args.configured, kind: "first" };
  const kind = queueNoticeKind(args.message);
  const recent = !!args.lastReplyAt && now.getTime() - args.lastReplyAt.getTime() < QUEUE_NOTICE_QUIET_MS;
  if (kind === "again" && recent) return null;
  const fits = (t: string) => !repeats(t) && !(args.outsideHours && PROMISES_SOON.test(fold(t)));
  const options = [...QUEUE_NOTICES[kind === "first" ? "again" : kind], ...QUEUE_NOTICES.again, args.configured];
  const text = options.find(fits);
  return text ? { text, kind } : null;
}
