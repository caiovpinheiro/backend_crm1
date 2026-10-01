import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";

import type { AppUserRole } from "@/lib/auth-types";
import type { AuthzContext } from "@/lib/authz";
import { conversationFunnelWhere } from "@/lib/authz/funnel-visibility";
import { authzContextOnce } from "@/lib/authz/request-prechecks";
import { listAllowedChannelIds } from "@/lib/authz/resource-policy";
import { prisma } from "@/lib/prisma";
import { getOrgIdOrThrow } from "@/lib/request-context";
import { createRequestMemo, type RequestMemo } from "@/lib/request-memo";
import { getVisibilityFilter, withInboxQueueVisibility } from "@/lib/visibility";

type SessionUser = {
  id: string;
  role: AppUserRole;
  organizationId?: string | null;
  isSuperAdmin?: boolean;
};

type SessionLike = {
  user?: {
    id?: string;
    role?: AppUserRole | string;
    organizationId?: string | null;
    isSuperAdmin?: boolean;
  };
} | null;

const PG_INT4_MAX = 2_147_483_647;

/**
 * Campos da conversa que a decisão de acesso lê. Quem carrega a linha por
 * conta própria (`requireConversationAccessAndLoad`) precisa incluí-los no
 * `select` — o tipo `ConversationAccessRow` cobra isso.
 */
export const CONVERSATION_ACCESS_SELECT = {
  id: true,
  assignedToId: true,
  channelId: true,
  contactId: true,
  organizationId: true,
} as const;

export type ConversationAccessRow = {
  id: string;
  assignedToId: string | null;
  channelId: string | null;
  contactId: string | null;
  organizationId: string;
};

export type ConversationAccessOptions = {
  /**
   * Memo da requisição (`@/lib/request-memo`). Passe o do handler para que
   * as checagens seguintes (canal, permissões) reaproveitem authz/flag/
   * grants/papéis lidos aqui. Sem ele, a função usa um memo próprio.
   */
  memo?: RequestMemo;
  /**
   * Dispara já, junto com a leitura da conversa, os insumos da regra de
   * visibilidade e de canal (departamento, settings, flag, grants, papéis),
   * em vez de esperar descobrir que o usuário não é o responsável. Custa no
   * máximo uma consulta a mais quando ele é; economiza uma fase quando não
   * é. Para rotas quentes que em seguida precisam da política de canal de
   * qualquer jeito (`GET /messages`).
   */
  prefetch?: boolean;
};

/**
 * Dígitos → CUID da conversa na org; senão devolve o próprio id.
 * Bookmarks `?c=<number>` e o 1º frame do inbox (antes de normalizar).
 */
export async function resolveConversationId(
  idOrNumber: string,
): Promise<string | null> {
  if (!/^\d+$/.test(idOrNumber)) return idOrNumber;
  const n = Number(idOrNumber);
  if (!Number.isInteger(n) || n < 1 || n > PG_INT4_MAX) return null;
  const orgId = getOrgIdOrThrow();
  const row = await prisma.conversation.findUnique({
    where: { organizationId_number: { organizationId: orgId, number: n } },
    select: { id: true },
  });
  return row?.id ?? null;
}

/**
 * `where` que acha a conversa pelo CUID ou pelo número na org do contexto —
 * a mesma regra de `resolveConversationId`, sem a consulta extra só para
 * trocar número por id. `null` = número inválido (não existe conversa).
 */
function conversationWhereByIdOrNumber(
  idOrNumber: string,
): Prisma.ConversationWhereInput | null {
  if (!/^\d+$/.test(idOrNumber)) return { id: idOrNumber };
  const n = Number(idOrNumber);
  if (!Number.isInteger(n) || n < 1 || n > PG_INT4_MAX) return null;
  return { organizationId: getOrgIdOrThrow(), number: n };
}

/**
 * Decide se `user` pode ver a conversa que `loadRow` devolve; devolve a
 * própria linha quando pode, `null` quando não pode ou ela não existe.
 *
 * Regra (a mesma do GET /conversations — nada foi removido, só deixou de
 * ser consultado mais de uma vez):
 *
 *   existe na org
 *   E  não está presa a funil/etapa bloqueados para o usuário
 *   E  ( é o responsável
 *        OU é dono de algum negócio do contato
 *        OU passa no filtro de visibilidade (own/all, pool livre,
 *           departamento, filas compartilhadas) E no escopo de canal )
 *
 * Consultas: a linha da conversa (1) e, quando o veredito não sai do que
 * já está em memória, UM `count` na própria linha com o resto da regra —
 * antes eram até 4 em série (funil, negócio, visibilidade+canal, e a
 * releitura da conversa). Atalhos em memória só onde a resposta é a mesma
 * do banco: `assignedToId` e `channelId` da linha recém-lida.
 */
async function resolveConversationAccess<T extends ConversationAccessRow>(
  user: SessionUser,
  loadRow: () => Promise<T | null>,
  opts: ConversationAccessOptions = {},
): Promise<T | null> {
  const memo = opts.memo ?? createRequestMemo();

  // Org para authz/política de canal: a da sessão ou a do contexto. Se
  // ainda não houver contexto aqui, resolve depois de ler a linha (ordem
  // original) — o `try` só adianta a leitura quando já dá.
  const startAuthz = (): Promise<AuthzContext> =>
    authzContextOnce(memo, {
      userId: user.id,
      organizationId: user.organizationId ?? getOrgIdOrThrow(),
      isSuperAdmin: Boolean(user.isSuperAdmin),
    });
  const startVisibility = () => getVisibilityFilter(user, { memo });
  const startChannels = () =>
    listAllowedChannelIds(
      {
        id: user.id,
        role: user.role,
        organizationId: user.organizationId ?? getOrgIdOrThrow(),
      },
      memo,
    );
  /** Dispara sem esperar; erro só aparece para quem der `await` depois. */
  const early = <R>(start: () => Promise<R>): Promise<R> | null => {
    try {
      const pending = start();
      pending.catch(() => undefined);
      return pending;
    } catch {
      return null;
    }
  };

  const authzEarly = early(startAuthz);
  const visibilityEarly = opts.prefetch ? early(startVisibility) : null;
  const channelsEarly = opts.prefetch ? early(startChannels) : null;

  const conv = await loadRow();
  if (!conv) return null;

  const authz = await (authzEarly ?? startAuthz());
  const funnelWhere = conversationFunnelWhere(authz);

  /** Só falta o funil: sem restrição passa; com restrição, um `count`. */
  const passesFunnel = async (): Promise<T | null> => {
    if (!funnelWhere) return conv;
    const visible = await prisma.conversation.count({
      where: { AND: [{ id: conv.id }, funnelWhere] },
    });
    return visible > 0 ? conv : null;
  };

  // Quem está atribuído precisa responder — mesmo se o recorte de canal
  // / fila compartilhada da listagem estiver mais estreito que o GET :id.
  // Funil/etapa bloqueados continuam inacessíveis mesmo para o responsável.
  if (conv.assignedToId === user.id) return passesFunnel();

  const [visibility, allowedChannelIds] = await Promise.all([
    visibilityEarly ?? startVisibility(),
    // Escopo de canais por usuário (mesma regra do GET /conversations).
    channelsEarly ?? startChannels(),
  ]);
  let where = visibility.conversationWhere;
  try {
    const perms: ReadonlySet<string> =
      authz.isSuperAdmin || authz.isAdmin ? new Set(["*"]) : authz.permissions;
    where = withInboxQueueVisibility(visibility.conversationWhere, {
      permissions: perms,
      includeUnassigned: visibility.includeUnassigned,
    });
  } catch {
    // Sem authz (jobs / contexto incompleto) — mantém where base.
  }
  const unrestricted = !where || Object.keys(where).length === 0;

  // Dono do negócio abre o card no pipeline e a aba Conversa pede as
  // mensagens. O assignee do ticket pode ser outra pessoa (transferência
  // só do deal, ou o chat ficou com o atendente anterior). Sem isto o
  // GET /messages devolve 404 e a aba fica em "Não foi possível carregar".
  const ownsDeal: Prisma.ConversationWhereInput | null = conv.contactId
    ? {
        contact: {
          deals: { some: { ownerId: user.id, organizationId: conv.organizationId } },
        },
      }
    : null;

  const grants: Prisma.ConversationWhereInput[] = [];
  if (ownsDeal) grants.push(ownsDeal);

  if (unrestricted) {
    // Visibilidade irrestrita: só o canal decide, e o canal da linha já
    // está em memória. Mesmo predicado do GET /conversations — ticket sem
    // canal não passa no `in`.
    const channelAllowed =
      !allowedChannelIds ||
      (conv.channelId !== null && allowedChannelIds.includes(conv.channelId));
    if (channelAllowed) return passesFunnel();
    // Canal fora do escopo: só o dono do negócio ainda entra.
  } else {
    grants.push(
      allowedChannelIds
        ? { AND: [where, { channelId: { in: allowedChannelIds } }] }
        : where,
    );
  }

  if (grants.length === 0) return null;
  const conditions: Prisma.ConversationWhereInput[] = [{ id: conv.id }];
  if (funnelWhere) conditions.push(funnelWhere);
  conditions.push(grants.length === 1 ? grants[0]! : { OR: grants });
  const n = await prisma.conversation.count({ where: { AND: conditions } });
  return n > 0 ? conv : null;
}

/** Verifica se o usuário pode listar/ver esta conversa (mesma regra da API GET /conversations). */
export async function userHasConversationAccess(
  user: SessionUser,
  conversationId: string,
  opts: ConversationAccessOptions = {},
): Promise<boolean> {
  const conv = await resolveConversationAccess(
    user,
    () =>
      prisma.conversation.findFirst({
        where: { id: conversationId },
        select: CONVERSATION_ACCESS_SELECT,
      }),
    opts,
  );
  return conv !== null;
}

function unauthorized(): NextResponse {
  return NextResponse.json({ message: "Não autorizado." }, { status: 401 });
}

function notFound(): NextResponse {
  return NextResponse.json(
    { message: "Conversa não encontrada ou sem permissão." },
    { status: 404 },
  );
}

function sessionUserOf(session: SessionLike): SessionUser | null {
  if (!session?.user?.id) return null;
  const role = session.user.role as AppUserRole | undefined;
  if (!role) return null;
  return {
    id: session.user.id,
    role,
    organizationId: session.user.organizationId ?? undefined,
    isSuperAdmin: session.user.isSuperAdmin,
  };
}

/**
 * Checa o acesso E devolve a conversa, numa leitura só.
 *
 * `load` recebe o `where` (CUID ou número na org) e faz o `findFirst` com o
 * `select` que o handler precisa — incluindo os campos de
 * `CONVERSATION_ACCESS_SELECT`. Substitui o par `requireConversationAccess`
 * + `getConversationLite`, que lia a mesma linha duas vezes (três, com o
 * número na URL).
 *
 * Devolve `{ response }` com o mesmo 401/404 de `requireConversationAccess`
 * (404 para não vazar existência) ou `{ conversation }`.
 */
export async function requireConversationAccessAndLoad<T extends ConversationAccessRow>(
  session: SessionLike,
  conversationId: string,
  load: (where: Prisma.ConversationWhereInput) => Promise<T | null>,
  opts: ConversationAccessOptions = {},
): Promise<
  | { response: NextResponse; conversation?: undefined }
  | { response?: undefined; conversation: T }
> {
  const user = sessionUserOf(session);
  if (!user) return { response: unauthorized() };
  const where = conversationWhereByIdOrNumber(conversationId);
  if (!where) return { response: notFound() };
  const conversation = await resolveConversationAccess(user, () => load(where), opts);
  if (!conversation) return { response: notFound() };
  return { conversation };
}

/**
 * Retorna null se OK; caso contrário NextResponse 401/404 (404 para não vazar existência).
 */
export async function requireConversationAccess(
  session: SessionLike,
  conversationId: string,
  opts: ConversationAccessOptions = {},
): Promise<NextResponse | null> {
  const result = await requireConversationAccessAndLoad(
    session,
    conversationId,
    (where) =>
      prisma.conversation.findFirst({ where, select: CONVERSATION_ACCESS_SELECT }),
    opts,
  );
  return result.response ?? null;
}
