/**
 * Aula inaugural (calouros) — envio do link YouTube na janela operacional
 * e prioridade para contatos com tags calouros1008_1..6 (qualquer etapa).
 *
 * Datas padrão: 10 e 11/ago/2026 (BRT). Override: INAUGURAL_LINK_DATES=YYYY-MM-DD,YYYY-MM-DD
 * URL: INAUGURAL_CLASS_YOUTUBE_URL ou default abaixo.
 */
import { prisma } from "@/lib/prisma";
import type { InboxPolicy } from "@/lib/ai-agents/steering";

export const INAUGURAL_CLASS_YOUTUBE_URL =
  (process.env.INAUGURAL_CLASS_YOUTUBE_URL || "").trim() ||
  "https://www.youtube.com/watch?v=5FYnrXjc-Tk";

const CALOUROS_TAG_RE = /^calouros1008_[1-6]$/i;

/** URL efetiva: o que o consultor salvou na tela vence env/default. */
export function resolveInauguralUrl(policy?: InboxPolicy | null): string {
  return policy?.inauguralUrl?.trim() || INAUGURAL_CLASS_YOUTUBE_URL;
}

export function isInauguralLinkWindow(
  now = new Date(),
  policy?: InboxPolicy | null,
): boolean {
  const day = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
  if (policy?.inauguralDates?.length) {
    return policy.inauguralDates.includes(day);
  }
  const raw =
    process.env.INAUGURAL_LINK_DATES?.trim() || "2026-08-10,2026-08-11";
  const allowed = new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
  return allowed.has(day);
}

export async function contactHasCalouros1008Tag(
  contactId: string,
): Promise<boolean> {
  const [onContact, openDeals] = await Promise.all([
    prisma.tagOnContact.findMany({
      where: { contactId },
      select: { tag: { select: { name: true } } },
    }),
    prisma.deal.findMany({
      where: { contactId, status: "OPEN" },
      select: {
        tags: { select: { tag: { select: { name: true } } } },
      },
    }),
  ]);
  for (const r of onContact) {
    if (CALOUROS_TAG_RE.test(String(r.tag?.name || "").trim())) return true;
  }
  for (const d of openDeals) {
    for (const r of d.tags ?? []) {
      if (CALOUROS_TAG_RE.test(String(r.tag?.name || "").trim())) return true;
    }
  }
  return false;
}

/** Pedido explícito de link / botão da campanha / dúvida da aula inaugural. */
export function userAsksInauguralClassLinkOrIssue(text: string): boolean {
  const t = String(text || "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return false;

  if (
    t.includes("clique para receber o link") ||
    t.includes("receber o link") ||
    t === "link" ||
    t === "o link" ||
    /^quero (o )?link/.test(t) ||
    /^manda(r)? (o )?link/.test(t) ||
    /^envia(r)? (o )?link/.test(t) ||
    /^me manda (o )?link/.test(t) ||
    /link da aula/.test(t) ||
    /link (da )?inaugural/.test(t) ||
    /aula inaugural/.test(t) ||
    /\binaugural\b/.test(t)
  ) {
    return true;
  }

  if (
    (/\baula\b/.test(t) || /\blive\b/.test(t) || /\byoutube\b/.test(t)) &&
    /(nao (consigo|abre|entro|acesso)|nao abre|trav|erro|problema|caiu|sumiu|perdi)/.test(
      t,
    )
  ) {
    return true;
  }

  return false;
}

export function buildInauguralClassLinkMessage(opts?: {
  problem?: boolean;
  policy?: InboxPolicy | null;
}): string {
  const link = resolveInauguralUrl(opts?.policy);
  if (opts?.problem) {
    return [
      "Entendo, vamos te ajudar com a *aula inaugural* 💜",
      "",
      "Segue o link oficial pra assistir (pode abrir no celular ou no PC):",
      "",
      link,
      "",
      "Se ainda não abrir ou travar, me conta o que aparece na tela que eu te oriento — ou te conecto com o time de Atendimento.",
    ].join("\n");
  }
  return [
    "Que bom que você veio buscar a *aula inaugural*! 😊",
    "",
    "Segue o link pra assistir com calma, no seu tempo:",
    "",
    link,
    "",
    "Qualquer dúvida sobre a aula ou o acesso, estou por aqui pra te ajudar.",
  ].join("\n");
}

export async function conversationAlreadyGotInauguralLink(
  conversationId: string,
  withinHours = 36,
): Promise<boolean> {
  const since = new Date(Date.now() - withinHours * 3600_000);
  const hit = await prisma.message.findFirst({
    where: {
      conversationId,
      direction: "out",
      isPrivate: false,
      createdAt: { gte: since },
      content: { contains: "youtu", mode: "insensitive" },
    },
    select: { id: true },
  });
  return Boolean(hit);
}

/**
 * Deve a IA interceptar e enviar o link agora?
 * Prioridade: tags calouros1008_* (qualquer etapa) na janela.
 * Demais contatos: só se pedirem link/problema da inaugural na janela.
 */
export async function shouldSendInauguralClassLink(args: {
  contactId: string;
  userMessage: string;
  policy?: InboxPolicy | null;
}): Promise<{ send: boolean; priorityCalouros: boolean; problem: boolean }> {
  if (args.policy && !args.policy.inauguralEnabled) {
    return { send: false, priorityCalouros: false, problem: false };
  }
  if (!isInauguralLinkWindow(new Date(), args.policy)) {
    return { send: false, priorityCalouros: false, problem: false };
  }
  const priorityCalouros = await contactHasCalouros1008Tag(args.contactId);
  const asks = userAsksInauguralClassLinkOrIssue(args.userMessage);
  const norm = String(args.userMessage || "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase();
  const problem =
    asks &&
    /(problema|nao (consigo|abre|entro|acesso)|trav|erro|caiu)/i.test(norm);

  if (priorityCalouros && asks) {
    return { send: true, priorityCalouros: true, problem };
  }
  if (asks) {
    return { send: true, priorityCalouros: false, problem };
  }
  return { send: false, priorityCalouros, problem: false };
}
