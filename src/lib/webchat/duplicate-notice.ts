/**
 * Aviso de "possível duplicado" do webchat.
 *
 * O visitante é anônimo: o que ele digita (e-mail/telefone) não prova que
 * ele é o dono do contato que já existe com esse dado. Por isso a
 * identificação NUNCA liga, funde nem sobrescreve outro contato — o
 * visitante fica no contato que nasceu no webchat e o agente recebe, na
 * conversa, uma nota interna dizendo com qual contato o dado bate. Se for a
 * mesma pessoa, o agente funde manualmente.
 *
 * A nota é `messageType=note` + `isPrivate=true` (a mesma forma da nota
 * interna do composer): o inbox a mostra como nota (sempre visível, o
 * "ocultar eventos" não a esconde) e o widget nunca a lê
 * (`visitorMessageWhere` corta `isPrivate`). `authorType` fica `human`
 * de propósito: com `system` o inbox a classificaria como evento ocultável.
 *
 * Roda dentro de `withSystemContext(organizationId)`.
 */
import { noteMessageChange } from "@/lib/cache/message-versions";
import { getLogger } from "@/lib/logger";
import { phoneMatchVariants } from "@/lib/phone";
import { prisma } from "@/lib/prisma";
import { withOrgFromCtx } from "@/lib/prisma-helpers";
import { publishNewMessage } from "@/lib/realtime-events";

const log = getLogger("webchat-duplicate-notice");

/** Autor exibido na nota (não é ator de sistema no inbox). */
export const WEBCHAT_NOTICE_SENDER = "Webchat";
const MAX_MATCHES = 3;

export type PossibleDuplicate = {
  id: string;
  name: string;
  number: number | null;
  by: "email" | "phone";
  value: string;
};

/**
 * Outros contatos da org com o e-mail ou telefone (com/sem o 9) que o
 * visitante informou. Uso interno: nada disto vai para o widget.
 */
export async function findPossibleDuplicates(
  ownContactId: string,
  data: { email?: string | null; phone?: string | null },
): Promise<PossibleDuplicate[]> {
  const out: PossibleDuplicate[] = [];
  const seen = new Set<string>([ownContactId]);
  const select = { id: true, name: true, number: true } as const;
  if (data.email) {
    const rows = await prisma.contact.findMany({
      where: { id: { not: ownContactId }, email: { equals: data.email, mode: "insensitive" } },
      orderBy: { createdAt: "asc" },
      take: MAX_MATCHES,
      select,
    });
    for (const r of rows) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      out.push({ id: r.id, name: r.name, number: r.number > 0 ? r.number : null, by: "email", value: data.email });
    }
  }
  const variants = phoneMatchVariants(data.phone ?? null);
  if (data.phone && variants.length > 0) {
    const rows = await prisma.contact.findMany({
      where: { id: { not: ownContactId }, phone: { in: variants } },
      orderBy: { createdAt: "asc" },
      take: MAX_MATCHES,
      select,
    });
    for (const r of rows) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      out.push({ id: r.id, name: r.name, number: r.number > 0 ? r.number : null, by: "phone", value: data.phone });
    }
  }
  return out;
}

function contactLabel(d: PossibleDuplicate): string {
  const ref = d.number != null ? `#${d.number}` : `id ${d.id}`;
  return `${d.name} (${ref})`;
}

/** Texto da nota: um parágrafo por dado informado. */
export function possibleDuplicateNoticeText(matches: PossibleDuplicate[]): string {
  const byField = new Map<string, PossibleDuplicate[]>();
  for (const m of matches) {
    const k = `${m.by}\u0000${m.value}`;
    byField.set(k, [...(byField.get(k) ?? []), m]);
  }
  const lines: string[] = [];
  for (const group of byField.values()) {
    const first = group[0]!;
    const what = first.by === "email" ? `o e-mail ${first.value}` : `o telefone ${first.value}`;
    const who = group.map(contactLabel).join(", ");
    const owner = group.length > 1 ? `aos contatos ${who}` : `ao contato ${who}`;
    lines.push(
      `Visitante do webchat informou ${what}, que pertence ${owner} — possível duplicado. ` +
        "Nada foi unido automaticamente; funda manualmente se for a mesma pessoa.",
    );
  }
  return lines.join("\n");
}

/**
 * Grava a nota de possível duplicado na conversa (uma vez por texto: o
 * mesmo aviso não se repete no ticket). Devolve o id da nota ou null.
 */
export async function recordPossibleDuplicateNotice(args: {
  organizationId: string;
  conversationId: string;
  contactId: string;
  matches: PossibleDuplicate[];
}): Promise<string | null> {
  if (args.matches.length === 0) return null;
  const content = possibleDuplicateNoticeText(args.matches);
  const already = await prisma.message.findFirst({
    where: {
      conversationId: args.conversationId,
      messageType: "note",
      isPrivate: true,
      senderName: WEBCHAT_NOTICE_SENDER,
      content,
    },
    select: { id: true },
  });
  if (already) return already.id;
  const saved = await prisma.message.create({
    data: withOrgFromCtx({
      conversationId: args.conversationId,
      content,
      direction: "out",
      messageType: "note",
      isPrivate: true,
      senderName: WEBCHAT_NOTICE_SENDER,
    }),
    select: { id: true, organizationId: true, conversationId: true, externalId: true, createdAt: true },
  });
  void noteMessageChange(saved.organizationId, saved.conversationId, "new", saved.id, saved.externalId);
  try {
    publishNewMessage({
      organizationId: args.organizationId,
      conversationId: args.conversationId,
      contactId: args.contactId,
      direction: "out",
      messageType: "note",
      content,
      senderName: WEBCHAT_NOTICE_SENDER,
      timestamp: saved.createdAt,
    });
  } catch (err) {
    log.debug({ err }, "SSE da nota de duplicado falhou (não-fatal)");
  }
  return saved.id;
}

/**
 * Atalho: confere os dados do contato do visitante e, havendo outro contato
 * com o mesmo e-mail/telefone, grava a nota na conversa. Best-effort —
 * nunca derruba o fluxo do visitante.
 */
export async function notePossibleDuplicatesInConversation(args: {
  organizationId: string;
  conversationId: string;
  contact: { id: string; email?: string | null; phone?: string | null };
}): Promise<void> {
  if (!args.contact.email && !args.contact.phone) return;
  try {
    const matches = await findPossibleDuplicates(args.contact.id, args.contact);
    await recordPossibleDuplicateNotice({
      organizationId: args.organizationId,
      conversationId: args.conversationId,
      contactId: args.contact.id,
      matches,
    });
  } catch (err) {
    log.warn({ err, conversationId: args.conversationId }, "nota de possível duplicado falhou");
  }
}
