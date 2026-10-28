/**
 * Identificação do visitante do webchat (docs/decisoes/webchat-widget.md §3.2).
 *
 * Regra (decisão de 28/10/2026): o que o visitante digita NUNCA liga,
 * funde nem sobrescreve um contato que já existia. O visitante é anônimo:
 * digitar o e-mail/telefone de alguém não prova que ele é essa pessoa, e
 * ligar a sessão ao contato existente expunha o histórico dele no widget
 * (`GET /messages`) e, encadeado, fundia/apagava contatos.
 *
 *  - O visitante fica no contato que nasceu no webchat
 *    (`Contact.webchatVisitorId === session.id`), criado agora se ainda
 *    não existe. Só esse contato recebe nome/e-mail/telefone.
 *  - Se o e-mail/telefone bate com outro contato da org, a conversa ganha
 *    uma nota interna de "possível duplicado" (duplicate-notice.ts) para o
 *    agente fundir manualmente. Sem conversa ainda, a nota sai quando o
 *    ticket nascer (inbound). Nada disso volta para o widget.
 * O inbox recebe `contact_updated` + `conversation_updated`.
 *
 * Roda dentro de `withSystemContext(organizationId)`.
 */
import { defaultDealTitleForContact } from "@/lib/display-name";
import { getLogger } from "@/lib/logger";
import { parseContactPhoneInput } from "@/lib/phone";
import { prisma } from "@/lib/prisma";
import { invalidateBoardData } from "@/lib/cache/keys";
import { publishContactUpdated, publishConversationUpdated } from "@/lib/realtime-events";
import {
  findPossibleDuplicates,
  recordPossibleDuplicateNotice,
} from "@/lib/webchat/duplicate-notice";
import {
  anonymousVisitorName,
  ensureVisitorContact,
  WEBCHAT_CONVERSATION_CHANNEL,
} from "@/lib/webchat/inbound";
import type { WebchatSessionRow } from "@/lib/webchat/session";

const log = getLogger("webchat-identify");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_NAME = 120;
const MAX_EMAIL = 254;

export class WebchatIdentifyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WebchatIdentifyError";
  }
}

export type WebchatIdentity = {
  name: string | null;
  email: string | null;
  phone: string | null;
};

/** Valida o que o visitante digitou. Lança `WebchatIdentifyError` (400). */
export function parseWebchatIdentity(input: {
  name?: unknown;
  email?: unknown;
  phone?: unknown;
}): WebchatIdentity {
  const str = (v: unknown, field: string): string | null => {
    if (v === undefined || v === null) return null;
    if (typeof v !== "string") throw new WebchatIdentifyError(`${field} deve ser texto.`);
    const t = v.trim();
    return t || null;
  };
  const name = str(input.name, "name");
  if (name && name.length > MAX_NAME) {
    throw new WebchatIdentifyError(`Nome passa de ${MAX_NAME} caracteres.`);
  }
  const emailRaw = str(input.email, "email");
  const email = emailRaw ? emailRaw.toLowerCase() : null;
  if (email && (email.length > MAX_EMAIL || !EMAIL_RE.test(email))) {
    throw new WebchatIdentifyError("E-mail inválido.");
  }
  const phoneRaw = str(input.phone, "phone");
  let phone: string | null = null;
  if (phoneRaw) {
    const parsed = parseContactPhoneInput(phoneRaw);
    if (!parsed.ok) throw new WebchatIdentifyError(parsed.reason);
    phone = parsed.value;
  }
  return { name, email, phone };
}

export function hasIdentity(id: WebchatIdentity): boolean {
  return Boolean(id.name || id.email || id.phone);
}

export type IdentifyResult = {
  /** Contato do PRÓPRIO visitante (nascido no webchat). */
  contactId: string;
  /**
   * Quantos outros contatos têm o e-mail/telefone informado (viraram nota
   * interna). Uso interno das rotas — não vai para o widget.
   */
  possibleDuplicates: number;
};

/**
 * O auto-deal do visitante anônimo nasce "Negócio Visitante a1b2c3"
 * (`defaultDealTitleForContact`, o mesmo do `ensureOpenDealForContact`).
 * Depois de identificado, os deals abertos do contato que AINDA têm
 * exatamente esse título passam para o título padrão com o nome real.
 * Título editado pelo operador (qualquer outro texto) não é tocado.
 * Devolve quantos foram renomeados.
 */
export async function renameAnonymousVisitorDeals(
  organizationId: string,
  contactId: string,
  visitorId: string,
  realName: string | null | undefined,
): Promise<number> {
  const placeholder = defaultDealTitleForContact(anonymousVisitorName(visitorId));
  const next = defaultDealTitleForContact(realName);
  if (!placeholder || !next || next === placeholder) return 0;
  const deals = await prisma.deal.findMany({
    where: { contactId, status: "OPEN", title: placeholder },
    select: { id: true, stage: { select: { pipelineId: true } } },
  });
  if (deals.length === 0) return 0;
  const res = await prisma.deal.updateMany({
    where: { id: { in: deals.map((d) => d.id) }, title: placeholder },
    data: { title: next },
  });
  // Mesmo efeito de `invalidateBoardsForPipelines` (services/deals): o card
  // do board mostra o título.
  const pipelineIds = new Set(deals.map((d) => d.stage?.pipelineId).filter(Boolean) as string[]);
  await Promise.all(
    [...pipelineIds].map((id) => invalidateBoardData(organizationId, id).catch(() => {})),
  );
  return res.count;
}

export type OwnVisitorContactView = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  /** Deu e-mail/telefone ou um nome que não é o placeholder. */
  identified: boolean;
};

/**
 * O que o widget pode ver do contato: só o do PRÓPRIO visitante
 * (`webchatVisitorId === session.id`). Sessão apontando para outro contato
 * (ligação antiga) devolve null — nunca dados de terceiros.
 */
export async function ownVisitorContactView(
  session: Pick<WebchatSessionRow, "id" | "contactId">,
): Promise<OwnVisitorContactView | null> {
  if (!session.contactId) return null;
  const row = await prisma.contact.findFirst({
    where: { id: session.contactId, webchatVisitorId: session.id },
    select: { id: true, name: true, email: true, phone: true },
  });
  if (!row) return null;
  return {
    ...row,
    identified: Boolean(row.email || row.phone) || row.name !== anonymousVisitorName(session.id),
  };
}

async function activeWebchatConversation(contactId: string, channelId: string) {
  return prisma.conversation.findFirst({
    where: {
      contactId,
      channel: WEBCHAT_CONVERSATION_CHANNEL,
      channelId,
      status: { not: "RESOLVED" },
    },
    orderBy: { updatedAt: "desc" },
    select: { id: true },
  });
}

export async function identifyWebchatVisitor(args: {
  organizationId: string;
  session: WebchatSessionRow;
  identity: WebchatIdentity;
}): Promise<IdentifyResult> {
  const { organizationId, session, identity } = args;
  if (!hasIdentity(identity)) {
    throw new WebchatIdentifyError("Informe nome, e-mail ou telefone.");
  }

  // Contato do próprio visitante — nunca um que já existia na org.
  const own = await ensureVisitorContact(session, identity);
  if (!own.isNew) {
    const data: Record<string, string> = {};
    if (identity.name) data.name = identity.name;
    if (identity.email) data.email = identity.email;
    if (identity.phone) data.phone = identity.phone;
    // `webchatVisitorId` no where: só o contato nascido nesta sessão muda.
    await prisma.contact.updateMany({
      where: { id: own.id, webchatVisitorId: session.id },
      data,
    });
  }
  if (identity.name) {
    await renameAnonymousVisitorDeals(organizationId, own.id, session.id, identity.name);
  }
  publishContactUpdated({ organizationId, contactId: own.id, reason: "webchat_identified" });

  const matches =
    identity.email || identity.phone ? await findPossibleDuplicates(own.id, identity) : [];
  const conv = await activeWebchatConversation(own.id, session.channelId);
  if (conv) {
    if (matches.length > 0) {
      try {
        await recordPossibleDuplicateNotice({
          organizationId,
          conversationId: conv.id,
          contactId: own.id,
          matches,
        });
      } catch (err) {
        log.warn({ err, conversationId: conv.id }, "nota de possível duplicado falhou");
      }
    }
    publishConversationUpdated({ organizationId, conversationId: conv.id, contactId: own.id });
  }
  // Sem conversa ainda: a nota sai quando o ticket nascer (processWebchatInbound).
  return { contactId: own.id, possibleDuplicates: matches.length };
}
