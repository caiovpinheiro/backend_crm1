/**
 * Filtros avançados do Kanban de deals.
 *
 * O cliente envia um objeto `AdvancedDealFilters` (livre, validado em
 * runtime) e o serviço traduz para `Prisma.DealWhereInput` somando ao
 * `where` base usado por `getBoardData` e listagens.
 *
 * Mantemos schema livre (JSON) na tabela `saved_filters` para evoluir
 * sem migration nova a cada operador.
 */

import { Prisma, type DealStatus } from "@prisma/client";

import {
  metaSessionWindowWhere,
  metaWhatsappConversationWhere,
} from "@/lib/meta-session-window";
import { chatMessageSqlFilter } from "@/lib/conversation-last-message";
import { prisma } from "@/lib/prisma";
import { getRequestContext } from "@/lib/request-context";
import type { ServerTiming } from "@/lib/server-timing";

/**
 * Quando o termo de busca contém >=3 dígitos, casa o input contra o
 * telefone do contato **normalizado** (somente dígitos). Suporta o caso
 * comum: usuário digita "11945010493" mas telefone está salvo como
 * "+55 (11) 94501-0493" ou variações.
 */
/** Exposto para listagens (`getDeals`/`getContacts`) reutilizarem a mesma regra. */
export async function findContactIdsByPhoneDigits(
  digits: string,
): Promise<string[]> {
  if (digits.length < 3) return [];
  const ctx = getRequestContext();
  const orgId = ctx?.organizationId;
  if (!orgId) return [];
  // Sufixo via reverse(...) LIKE 'rev%' — bate no índice
  // `contacts_org_phone_digits_rev_pattern_idx`.
  //
  // O `text_pattern_ops` desse índice não é detalhe: o banco roda em
  // collation en_US.UTF-8, e nela um btree comum NÃO atende `LIKE 'x%'`.
  // O índice original (`..._rev_idx`, sem pattern ops) nunca foi usado —
  // o plano em produção varria os 42k contatos da org aplicando
  // regexp_replace por linha, 95ms por chamada. Ver migration
  // 20260826191000_phone_digits_pattern_idx.
  //
  // `'\\D'` (e não `'\D'`): em template literal o `\D` é cozido para `D`, o
  // texto enviado deixa de ser a expressão do índice (o planner só usa índice
  // de expressão com texto idêntico) e o regexp_replace passa a remover a
  // letra D — telefone com máscara deixava de casar.
  const suffix = digits.length > 11 ? digits.slice(-11) : digits;
  const revPrefix = [...suffix].reverse().join("") + "%";
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM contacts
    WHERE "organizationId" = ${orgId}
      AND reverse(regexp_replace(COALESCE(phone, ''), '\\D', '', 'g'))
          LIKE ${revPrefix}
    LIMIT 500
  `;
  return rows.map((r) => r.id);
}

/**
 * A organização já tem `contacts.lastMessageAt` / `lastMessageDirection`
 * preenchidas (backfill `scripts/backfill-contacts-last-message.mjs`)?
 *
 * "Pronta" = nenhuma conversa COM mensagem de chat cujo contato ainda esteja
 * com a coluna NULL. "Com mensagem de chat" = `conversations.lastMessageAt`
 * preenchido OU, enquanto o backfill da própria conversa não passou, uma
 * mensagem do recorte em `messages` — sem isso, logo depois do deploy (as
 * duas colunas ainda vazias no histórico) a organização pareceria pronta e o
 * filtro só acharia quem escreveu depois do deploy.
 *
 * Depois de pronta o código mantém as colunas a cada mensagem
 * (`touchContactLastMessage`), então o estado não volta: guardamos `true`
 * pela vida do processo. Enquanto não está pronta, reconsulta no máximo uma
 * vez por minuto por organização — o filtro de direção fica no caminho antigo
 * (correto, só mais caro) e troca sozinho quando o backfill termina.
 *
 * A sonda para na primeira linha pendente; com tudo preenchido percorre as
 * conversas da organização uma vez por processo (e só olha `messages` das
 * conversas cujo contato segue NULL, que são as sem mensagem de chat).
 */
const CONTACT_LAST_MESSAGE_RECHECK_MS = 60_000;
const contactLastMessageReady = new Map<string, true | number>();

export async function isContactLastMessageReady(orgId: string): Promise<boolean> {
  const known = contactLastMessageReady.get(orgId);
  if (known === true) return true;
  if (typeof known === "number" && Date.now() - known < CONTACT_LAST_MESSAGE_RECHECK_MS) {
    return false;
  }
  let pending = true;
  try {
    const rows = await prisma.$queryRaw<{ pending: boolean }[]>`
      SELECT EXISTS (
        SELECT 1
        FROM conversations v
        INNER JOIN contacts c ON c.id = v."contactId"
        WHERE v."organizationId" = ${orgId}
          AND c."lastMessageAt" IS NULL
          AND (
            v."lastMessageAt" IS NOT NULL
            OR EXISTS (
              SELECT 1 FROM messages m
              WHERE m."conversationId" = v.id
                AND ${chatMessageSqlFilter("m")}
            )
          )
      ) AS pending
    `;
    pending = rows[0]?.pending !== false;
  } catch {
    // Coluna ainda não existe (migration pendente) ou banco fora: caminho antigo.
    pending = true;
  }
  contactLastMessageReady.set(orgId, pending ? Date.now() : true);
  return !pending;
}

/** Só para testes: esquece o que já foi sondado. */
export function resetContactLastMessageReadyForTests(): void {
  contactLastMessageReady.clear();
}

/**
 * CAMINHO ANTIGO do filtro de direção (organização ainda sem
 * `contacts.lastMessageDirection` preenchida — ver
 * `isContactLastMessageReady`).
 *
 * Contatos SEM conversa ativa cuja conversa mais recente terminou com
 * mensagem na direção pedida ("in" = do cliente). Complementa o filtro
 * "Mensagem recebida/enviada" do Kanban, que para contatos com conversa
 * ativa é resolvido no próprio where. Só contatos com negócio entram.
 * Teto de 20 mil ids para o IN não estourar o limite de parâmetros.
 *
 * Custo em produção (05/10): 989 ms por chamada (LATERAL por contato da
 * organização inteira) e até 20 mil ids devolvidos ao Node.
 */
const CLOSED_ONLY_DIRECTION_CAP = 20000;
export async function findClosedOnlyContactIdsByLastDirection(
  dir: "in" | "out",
): Promise<string[]> {
  const orgId = getRequestContext()?.organizationId;
  if (!orgId) return [];
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT c.id
    FROM contacts c
    JOIN LATERAL (
      SELECT v."lastMessageDirection" AS d
      FROM conversations v
      WHERE v."organizationId" = ${orgId} AND v."contactId" = c.id
      ORDER BY v."updatedAt" DESC, v.id DESC
      LIMIT 1
    ) last ON true
    WHERE c."organizationId" = ${orgId}
      AND last.d = ${dir}
      AND EXISTS (
        SELECT 1 FROM deals x
        WHERE x."organizationId" = ${orgId} AND x."contactId" = c.id
      )
      AND NOT EXISTS (
        SELECT 1 FROM conversations a
        WHERE a."organizationId" = ${orgId}
          AND a."contactId" = c.id
          AND a.status <> 'RESOLVED'
      )
    ORDER BY c.id
    LIMIT ${CLOSED_ONLY_DIRECTION_CAP}
  `;
  return rows.map((r) => r.id);
}

/**
 * Teto de candidatos por pré-query de busca. Termos genéricos ("a", "silva")
 * casariam com dezenas de milhares de contatos — o IN gigante degradaria a
 * query de deals mais do que ajudaria. Com o teto, a busca fica "melhor
 * esforço" e o usuário refina o termo (padrão de CRMs: Kommo/Pipedrive).
 */
const SEARCH_CANDIDATE_CAP = 5000;

/**
 * Candidatos da busca do diretório de contatos. ILIKE de name/email/phone
 * em queries separadas para o GIN trgm (OR na mesma cláusula faz o planner
 * desistir do índice). Campos customizados e, se o termo tiver dígitos,
 * telefone normalizado + valores/deals por dígitos — tudo vira `id IN`.
 */
export async function resolveContactSearchCandidates(
  search: string,
): Promise<{ ids: string[]; capped: boolean }> {
  const orgId = getRequestContext()?.organizationId;
  if (!orgId) return { ids: [], capped: false };
  const pattern = `%${search}%`;
  const digits = search.replace(/\D+/g, "");

  const [byName, byEmail, byPhone, byCcfv, phoneIds, cfMatches] =
    await Promise.all([
      prisma.$queryRaw<{ id: string }[]>`
        SELECT id FROM contacts
        WHERE "organizationId" = ${orgId} AND name ILIKE ${pattern}
        ORDER BY "createdAt" DESC
        LIMIT ${SEARCH_CANDIDATE_CAP}
      `,
      prisma.$queryRaw<{ id: string }[]>`
        SELECT id FROM contacts
        WHERE "organizationId" = ${orgId} AND email ILIKE ${pattern}
        ORDER BY "createdAt" DESC
        LIMIT ${SEARCH_CANDIDATE_CAP}
      `,
      prisma.$queryRaw<{ id: string }[]>`
        SELECT id FROM contacts
        WHERE "organizationId" = ${orgId} AND phone ILIKE ${pattern}
        ORDER BY "createdAt" DESC
        LIMIT ${SEARCH_CANDIDATE_CAP}
      `,
      prisma.$queryRaw<{ contactId: string }[]>`
        SELECT v."contactId"
        FROM contact_custom_field_values v
        INNER JOIN contacts c ON c.id = v."contactId"
        WHERE v."organizationId" = ${orgId} AND v.value ILIKE ${pattern}
        ORDER BY c."createdAt" DESC
        LIMIT ${SEARCH_CANDIDATE_CAP}
      `,
      digits.length >= 3
        ? findContactIdsByPhoneDigits(digits)
        : Promise.resolve([] as string[]),
      digits.length >= 3
        ? findCustomFieldMatchesByDigits(digits)
        : Promise.resolve({ dealIds: [] as string[], contactIds: [] as string[] }),
    ]);

  const idSet = new Set<string>([
    ...byName.map((r) => r.id),
    ...byEmail.map((r) => r.id),
    ...byPhone.map((r) => r.id),
    ...byCcfv.map((r) => r.contactId),
    ...phoneIds,
    ...cfMatches.contactIds,
  ]);

  if (cfMatches.dealIds.length > 0) {
    const fromDeals = await prisma.$queryRaw<{ id: string }[]>`
      SELECT DISTINCT "contactId" AS id FROM deals
      WHERE "organizationId" = ${orgId}
        AND id = ANY(${cfMatches.dealIds})
        AND "contactId" IS NOT NULL
    `;
    for (const r of fromDeals) {
      if (r.id) idSet.add(r.id);
    }
  }

  if (idSet.size === 0) return { ids: [], capped: false };

  const unionIds = [...idSet];
  const ranked = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM contacts
    WHERE "organizationId" = ${orgId}
      AND id = ANY(${unionIds})
    ORDER BY "createdAt" DESC
    LIMIT ${SEARCH_CANDIDATE_CAP}
  `;
  const sourceHitCap =
    byName.length >= SEARCH_CANDIDATE_CAP ||
    byEmail.length >= SEARCH_CANDIDATE_CAP ||
    byPhone.length >= SEARCH_CANDIDATE_CAP ||
    byCcfv.length >= SEARCH_CANDIDATE_CAP;
  return {
    ids: ranked.map((r) => r.id),
    capped: sourceHitCap || unionIds.length > SEARCH_CANDIDATE_CAP,
  };
}

/**
 * Candidatos da busca do inbox. Mesma estratégia que a busca de negócios usava
 * antes de `createDealSearch` (pré-consultas indexadas devolvendo ids),
 * aplicada às colunas que a conversa só alcança por join: contato, empresa,
 * campos personalizados, título de negócio e responsável. NÃO migrou para
 * subconsultas: o where de conversas é Prisma em vários caminhos (lista,
 * contadores, encerramento em massa) e não há consulta SQL própria onde a busca
 * caiba — ver o relatório do PR "perf(busca)".
 *
 * Devolver IDs deixa o `where` final de conversas tocando apenas colunas da
 * própria tabela (`contactId`/`assignedToId` IN + `inboxName` + `number`),
 * todas cobertas por índice — o planner resolve por BitmapOr. O OR
 * cross-table anterior misturava ILIKE em contacts/users com EXISTS por
 * linha em ccfv/deals e custava ~4s por busca no inbox (HAR de 26/ago/26),
 * contra ~0,4s da busca de negócios com o mesmo termo.
 *
 * Pré-queries em paralelo, cada uma indexada e curta: o padrão anterior
 * segurava UMA conexão por ~4s. name/email/phone vão separados para o
 * planner usar GIN trgm (OR na mesma cláusula desiste do índice).
 */
export async function resolveConversationSearchCandidates(
  search: string,
): Promise<{ contactIds: string[]; assignedToIds: string[] }> {
  const orgId = getRequestContext()?.organizationId;
  if (!orgId) return { contactIds: [], assignedToIds: [] };
  const pattern = `%${search}%`;

  const [byName, byEmail, byPhone, byProfile, byCcfv, byDealTitle, byCompany, byUser] =
    await Promise.all([
      prisma.$queryRaw<{ id: string }[]>`
        SELECT id FROM contacts
        WHERE "organizationId" = ${orgId} AND name ILIKE ${pattern}
        LIMIT ${SEARCH_CANDIDATE_CAP}
      `,
      prisma.$queryRaw<{ id: string }[]>`
        SELECT id FROM contacts
        WHERE "organizationId" = ${orgId} AND email ILIKE ${pattern}
        LIMIT ${SEARCH_CANDIDATE_CAP}
      `,
      prisma.$queryRaw<{ id: string }[]>`
        SELECT id FROM contacts
        WHERE "organizationId" = ${orgId} AND phone ILIKE ${pattern}
        LIMIT ${SEARCH_CANDIDATE_CAP}
      `,
      // Separada da anterior de propósito: `whatsapp_username` e `source` têm
      // índices trgm PARCIAIS (a maioria dos contatos tem os dois nulos).
      // Juntar tudo num OR só faria o planner desistir do BitmapOr e varrer
      // `contacts` inteira.
      prisma.$queryRaw<{ id: string }[]>`
        SELECT id FROM contacts
        WHERE "organizationId" = ${orgId}
          AND (whatsapp_username ILIKE ${pattern} OR source ILIKE ${pattern})
        LIMIT ${SEARCH_CANDIDATE_CAP}
      `,
      prisma.$queryRaw<{ contactId: string }[]>`
        SELECT "contactId" FROM contact_custom_field_values
        WHERE "organizationId" = ${orgId} AND value ILIKE ${pattern}
        LIMIT ${SEARCH_CANDIDATE_CAP}
      `,
      prisma.$queryRaw<{ contactId: string }[]>`
        SELECT DISTINCT "contactId" FROM deals
        WHERE "organizationId" = ${orgId}
          AND "contactId" IS NOT NULL
          AND title ILIKE ${pattern}
        LIMIT ${SEARCH_CANDIDATE_CAP}
      `,
      prisma.$queryRaw<{ id: string }[]>`
        SELECT c.id FROM contacts c
        JOIN companies co ON co.id = c."companyId"
        WHERE c."organizationId" = ${orgId} AND co.name ILIKE ${pattern}
        LIMIT ${SEARCH_CANDIDATE_CAP}
      `,
      // `users` é pequena (dezenas de linhas por org) — seq scan aqui é mais
      // barato que manter índice trgm. `organizationId` é nulo só para
      // super-admin, que nunca é responsável por conversa de tenant.
      prisma.$queryRaw<{ id: string }[]>`
        SELECT id FROM users
        WHERE "organizationId" = ${orgId}
          AND (name ILIKE ${pattern} OR email ILIKE ${pattern})
        LIMIT ${SEARCH_CANDIDATE_CAP}
      `,
    ]);

  const contactIds = [
    ...new Set([
      ...byName.map((r) => r.id),
      ...byEmail.map((r) => r.id),
      ...byPhone.map((r) => r.id),
      ...byProfile.map((r) => r.id),
      ...byCcfv.map((r) => r.contactId),
      ...byDealTitle.map((r) => r.contactId),
      ...byCompany.map((r) => r.id),
    ]),
  ];
  return { contactIds, assignedToIds: byUser.map((r) => r.id) };
}

/**
 * Casa uma busca só-dígitos contra valores de campos personalizados
 * **normalizados** (apenas dígitos). Cobre o caso do CPF/RGM salvo com
 * máscara ("123.456.789-00", "12.345.678") quando o operador digita só
 * números — e o inverso.
 *
 * Zeros à esquerda são descartados do termo porque a base tem CPF vindo do
 * ERP com o zero perdido ("1234567890" para 01234567890): com `%digits%` o
 * termo sem zero casa as duas formas.
 */
export async function findCustomFieldMatchesByDigits(digits: string): Promise<{
  dealIds: string[];
  contactIds: string[];
}> {
  const empty = { dealIds: [], contactIds: [] };
  const core = digits.replace(/^0+/, "");
  if (core.length < 6) return empty;
  const orgId = getRequestContext()?.organizationId;
  if (!orgId) return empty;
  const pattern = `%${core}%`;
  const [dealRows, contactRows] = await Promise.all([
    // `'\\D'` (e não `'\D'`): em template literal o `\D` é cozido para `D` e o
    // regexp_replace passaria a remover a letra D, deixando a máscara intacta —
    // exatamente o que a normalização existe para evitar. O texto precisa bater
    // com a expressão do índice `*_cfv_value_digits_trgm_idx`.
    prisma.$queryRaw<{ dealId: string }[]>`
      SELECT DISTINCT "dealId" FROM deal_custom_field_values
      WHERE "organizationId" = ${orgId}
        AND regexp_replace(value, '\\D', '', 'g') LIKE ${pattern}
      LIMIT ${SEARCH_CANDIDATE_CAP}
    `,
    prisma.$queryRaw<{ contactId: string }[]>`
      SELECT DISTINCT "contactId" FROM contact_custom_field_values
      WHERE "organizationId" = ${orgId}
        AND regexp_replace(value, '\\D', '', 'g') LIKE ${pattern}
      LIMIT ${SEARCH_CANDIDATE_CAP}
    `,
  ]);
  return {
    dealIds: dealRows.map((r) => r.dealId),
    contactIds: contactRows.map((r) => r.contactId),
  };
}

// ---------------------------------------------------------------------------
// Busca livre de negócios (Kanban, lista, busca rápida, exportação)
// ---------------------------------------------------------------------------

/**
 * Termo curto (até 3 caracteres): casa só o título do negócio e o nome do
 * contato, por prefixo (do texto e de cada palavra). E-mail e campos
 * personalizados exigem 4+ caracteres. `%ana%` num termo desses casa milhares
 * de linhas em todas as fontes (org de teste: 4.802 nomes, 3.040 e-mails,
 * 10.590 valores de campo personalizado só para "ana") e não ajuda quem digita.
 */
export const SEARCH_SHORT_TERM_MAX = 3;

/** Teto de uma subconsulta de campo personalizado (valores livres, sem recência). */
const DEAL_SEARCH_CUSTOM_FIELD_CAP = 5000;
/**
 * Teto de uma subconsulta de contato (nome/e-mail/telefone). Alto de propósito:
 * os ids ficam no Postgres. Também dá ao planner uma estimativa pequena o
 * bastante para fazer `hashed SubPlan` (e não reexecutar a subconsulta por linha).
 */
const DEAL_SEARCH_CONTACT_CAP = 20_000;
const DEAL_SEARCH_PHONE_CAP = 500;
/**
 * Teto dos ids de `DealSearch.prismaWhere()` (caminhos que só falam Prisma:
 * lista, exportação, filtros agregados, "carregar mais" por posição). Um
 * parâmetro por id no `IN` — o Postgres aceita 32.767 por consulta.
 */
export const DEAL_SEARCH_IDS_CAP = 20_000;

const PG_INT4_MAX = 2147483647;
const TRUE_SQL = Prisma.sql`TRUE`;

/** `%`, `_` e `\` do termo viram literais (o `contains` do Prisma também escapa). */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, "\\$&");
}

/**
 * `col IN (subconsulta)`. Uma subconsulta entra sem parênteses extras (`IN
 * ((SELECT …))` é ambíguo para o parser do Postgres: lista de um escalar x
 * subconsulta); várias viram `IN ((A) UNION ALL (B))`, cada uma com o seu LIMIT.
 */
function inSubqueries(col: Prisma.Sql, subs: Prisma.Sql[]): Prisma.Sql {
  if (subs.length === 1) return Prisma.sql`${col} IN (${subs[0]!})`;
  const wrapped = subs.map((q) => Prisma.sql`(${q})`);
  return Prisma.sql`${col} IN (${Prisma.join(wrapped, " UNION ALL ")})`;
}

export type DealSearchResolved = { ids: number; capped: boolean };

export type DealSearch = {
  /**
   * Predicado sobre `deals d` (a organização vem do contexto). Sem lista de
   * ids: contato, e-mail e campos personalizados viram subconsultas indexadas.
   * Use dentro de uma consulta SQL que já filtra `d."organizationId"`.
   */
  sql: Prisma.Sql;
  /**
   * Para quem só fala Prisma: UMA consulta de ids (mesmo predicado, mais recentes
   * primeiro, com teto) e `{ id: { in } }`. Memoizada na primeira chamada.
   * `narrowSql` (alias `d`) restringe a consulta ao que o chamador já sabe
   * traduzir (status, funil, etapas, dono) — são condições que continuam em AND
   * no where final, então só reduzem candidatos.
   */
  prismaWhere(opts?: {
    narrowSql?: Prisma.Sql | null;
    idsCap?: number;
  }): Promise<Prisma.DealWhereInput>;
  /** Resultado de `prismaWhere()` (`undefined` = ainda não rodou). */
  resolved(): DealSearchResolved | undefined;
};

/**
 * Busca livre de negócios: título, nome/e-mail/telefone do contato, número do
 * negócio e valores de campos personalizados do negócio ou do contato (CPF,
 * RGM, matrícula, polo, curso…), com termo numérico por dígitos normalizados.
 * Mesma resposta no Kanban, na lista (`GET /api/deals?search=`), na busca
 * rápida e na exportação.
 *
 * Antes: 5 pré-consultas `ILIKE '%termo%'` (até 5.000 ids cada) devolviam ~13 mil
 * ids ao Node, que os mandava de volta como `contactId IN (…)` / `id IN (…)`,
 * um parâmetro por id. Agora o termo vai como parâmetro e o Postgres resolve
 * tudo na mesma consulta (o board) ou numa só consulta de ids (`prismaWhere`).
 *
 * `search.pre` / `search.ids` (Server-Timing) saem de `prismaWhere`; o board
 * mede `search.apply` na consulta final.
 */
export function createDealSearch(
  searchRaw: string,
  opts: { timing?: ServerTiming } = {},
): DealSearch | null {
  const search = searchRaw.trim();
  if (!search) return null;
  const orgId = getRequestContext()?.organizationId;

  const digits = search.replace(/\D+/g, "");
  // Termo "numérico": CPF, RGM, matrícula, telefone ou número do negócio, com
  // ou sem máscara. O ILIKE literal não casa "123.456.789-00" com
  // "12345678900" (nem o inverso); para esses termos usa-se os dígitos
  // normalizados. Procurar em nome/e-mail é dispensável: não há CPF em nome.
  const numericTerm =
    digits.replace(/^0+/, "").length >= 6 && /^[\d\s+().-]+$/.test(search);
  const short = search.length <= SEARCH_SHORT_TERM_MAX;

  const esc = escapeLike(search);
  const contains = `%${esc}%`;
  const prefix = `${esc}%`;
  const wordPrefix = `% ${esc}%`;

  // Número do negócio ("#123" digitado sem o #). `Deal.number` é int4: termos
  // numéricos longos (CPF, RGM, telefone) estouram o limite e fazem o Postgres
  // abortar a consulta inteira — por isso o teto de int32.
  let dealNumber: number | null = null;
  if (/^\d+$/.test(search)) {
    const asNumber = Number(search);
    if (Number.isInteger(asNumber) && asNumber >= 0 && asNumber <= PG_INT4_MAX) {
      dealNumber = asNumber;
    }
  }

  const titleSql = short
    ? Prisma.sql`(d.title ILIKE ${prefix} OR d.title ILIKE ${wordPrefix})`
    : Prisma.sql`d.title ILIKE ${contains}`;
  const or: Prisma.Sql[] = [titleSql];

  if (orgId) {
    // Ids de contato por fonte, cada uma uma subconsulta (UNION ALL) com teto.
    const contactSubs: Prisma.Sql[] = [];
    const dealSubs: Prisma.Sql[] = [];

    // Telefone por dígitos (sufixo): `contacts_org_phone_digits_rev_pattern_idx`.
    // `'\\D'` (e não `'\D'`): em template literal o `\D` é cozido para `D` e o
    // texto deixa de ser a expressão do índice (e o regexp passa a remover a
    // letra D, deixando a máscara intacta).
    if (digits.length >= 3) {
      const suffix = digits.length > 11 ? digits.slice(-11) : digits;
      const revPrefix = [...suffix].reverse().join("") + "%";
      contactSubs.push(Prisma.sql`
        SELECT c.id FROM contacts c
        WHERE c."organizationId" = ${orgId}
          AND reverse(regexp_replace(COALESCE(c.phone, ''), '\\D', '', 'g')) LIKE ${revPrefix}
        LIMIT ${DEAL_SEARCH_PHONE_CAP}
      `);
    }

    if (numericTerm) {
      // Zeros à esquerda saem do termo: a base tem CPF vindo do ERP com o zero
      // perdido ("1234567890" para 01234567890); `%digits%` casa as duas formas.
      // Expressão idêntica à dos índices `*_cfv_value_digits_trgm_idx`.
      const digitsPattern = `%${digits.replace(/^0+/, "")}%`;
      contactSubs.push(Prisma.sql`
        SELECT v."contactId" FROM contact_custom_field_values v
        WHERE v."organizationId" = ${orgId}
          AND regexp_replace(v.value, '\\D', '', 'g') LIKE ${digitsPattern}
        LIMIT ${DEAL_SEARCH_CUSTOM_FIELD_CAP}
      `);
      dealSubs.push(Prisma.sql`
        SELECT v."dealId" FROM deal_custom_field_values v
        WHERE v."organizationId" = ${orgId}
          AND regexp_replace(v.value, '\\D', '', 'g') LIKE ${digitsPattern}
        LIMIT ${DEAL_SEARCH_CUSTOM_FIELD_CAP}
      `);
    } else {
      // Uma coluna por subconsulta: OR de name/email/phone na mesma cláusula faz
      // o planner desistir do GIN trgm. Nome por `contacts_name_trgm_idx`.
      contactSubs.push(
        short
          ? Prisma.sql`
        SELECT c.id FROM contacts c
        WHERE c."organizationId" = ${orgId}
          AND (c.name ILIKE ${prefix} OR c.name ILIKE ${wordPrefix})
        LIMIT ${DEAL_SEARCH_CONTACT_CAP}
      `
          : Prisma.sql`
        SELECT c.id FROM contacts c
        WHERE c."organizationId" = ${orgId} AND c.name ILIKE ${contains}
        LIMIT ${DEAL_SEARCH_CONTACT_CAP}
      `,
      );
      if (!short) {
        contactSubs.push(Prisma.sql`
        SELECT c.id FROM contacts c
        WHERE c."organizationId" = ${orgId} AND c.email ILIKE ${contains}
        LIMIT ${DEAL_SEARCH_CONTACT_CAP}
      `);
        // Telefone é só dígito e pontuação: termo com letra nunca casa.
        if (/^[\d\s+().-]+$/.test(search)) {
          contactSubs.push(Prisma.sql`
        SELECT c.id FROM contacts c
        WHERE c."organizationId" = ${orgId} AND c.phone ILIKE ${contains}
        LIMIT ${DEAL_SEARCH_CONTACT_CAP}
      `);
        }
        contactSubs.push(Prisma.sql`
        SELECT v."contactId" FROM contact_custom_field_values v
        WHERE v."organizationId" = ${orgId} AND v.value ILIKE ${contains}
        LIMIT ${DEAL_SEARCH_CUSTOM_FIELD_CAP}
      `);
        dealSubs.push(Prisma.sql`
        SELECT v."dealId" FROM deal_custom_field_values v
        WHERE v."organizationId" = ${orgId} AND v.value ILIKE ${contains}
        LIMIT ${DEAL_SEARCH_CUSTOM_FIELD_CAP}
      `);
      }
    }

    if (contactSubs.length > 0) {
      or.push(inSubqueries(Prisma.sql`d."contactId"`, contactSubs));
    }
    if (dealSubs.length > 0) {
      or.push(inSubqueries(Prisma.sql`d.id`, dealSubs));
    }
  }
  if (dealNumber !== null) or.push(Prisma.sql`d.number = ${dealNumber}`);

  const sql = Prisma.join(or, " OR ", "(", ")");

  let memo: Promise<Prisma.DealWhereInput> | undefined;
  let resolved: DealSearchResolved | undefined;

  return {
    sql,
    resolved: () => resolved,
    prismaWhere: (o = {}) => {
      if (memo) return memo;
      memo = (async () => {
        if (!orgId) {
          // Sem organização no contexto: só o que não passa por outra tabela.
          const orOnly: Prisma.DealWhereInput[] = [
            { title: { contains: search, mode: "insensitive" } },
          ];
          if (dealNumber !== null) orOnly.push({ number: dealNumber });
          return { OR: orOnly };
        }
        const cap = Math.max(1, o.idsCap ?? DEAL_SEARCH_IDS_CAP);
        const t0 = performance.now();
        const rows = await prisma.$queryRaw<{ id: string }[]>`
          SELECT d.id FROM deals d
          WHERE d."organizationId" = ${orgId}
            AND (${o.narrowSql ?? TRUE_SQL})
            AND ${sql}
          ORDER BY d."updatedAt" DESC, d.id DESC
          LIMIT ${cap + 1}
        `;
        const capped = rows.length > cap;
        const ids = (capped ? rows.slice(0, cap) : rows).map((r) => r.id);
        resolved = { ids: ids.length, capped };
        opts.timing?.add(
          "search.pre",
          performance.now() - t0,
          capped ? "capped" : undefined,
        );
        opts.timing?.add("search.ids", ids.length, "count");
        return { id: { in: ids } };
      })();
      return memo;
    },
  };
}

/**
 * `OR` de busca livre de negócios para os caminhos que só falam Prisma
 * (filtros avançados da lista/exportação/painéis): uma consulta de ids, não
 * cinco pré-consultas. O board e a lista usam `createDealSearch` direto.
 */
export async function buildDealSearchOr(
  searchRaw: string,
  opts: { idsCap?: number; narrowSql?: Prisma.Sql | null; timing?: ServerTiming } = {},
): Promise<Prisma.DealWhereInput[]> {
  const search = createDealSearch(searchRaw, { timing: opts.timing });
  if (!search) return [];
  return [
    await search.prismaWhere({ idsCap: opts.idsCap, narrowSql: opts.narrowSql }),
  ];
}

export type DateRangeValue = {
  from?: string | null;
  to?: string | null;
};

/** Sentinela usada no filtro de origem para "Sem origem" (espelha o dashboard). */
export const SOURCE_NONE = "__none__";

export type CustomFieldFilter = {
  /** Nome (slug) do CustomField — único por organizationId+entity. */
  name: string;
  /** Default: contains se value, filled caso contrário. */
  operator?:
    | "eq"
    | "neq"
    | "contains"
    | "not_contains"
    | "filled"
    | "empty"
    | "gt"
    | "lt"
    | "between"
    | "before"
    | "after"
    | "in";
  value?: string | string[] | DateRangeValue | null;
};

export type AdvancedDealFilters = {
  /** AND (todos) | OR (qualquer). Aplica-se à lista `customFilters` adicionais. */
  logic?: "AND" | "OR";

  search?: string;

  /** Pipeline (filtra pela stage.pipelineId). */
  pipelineId?: string;
  /** IDs de etapa (OR entre elas). */
  stageIds?: string[];
  /** Status do deal. */
  statuses?: DealStatus[];

  /** Responsáveis (deal.ownerId). Inclui "null" como "sem responsável". */
  ownerIds?: (string | null)[];
  /** true = só leads sem responsável. */
  withoutOwner?: boolean;
  /** true = só leads sem contato. */
  withoutContact?: boolean;

  /** Filtros por origem (Contact.source). Pode incluir `SOURCE_NONE`. */
  sources?: string[];
  /** true = só leads sem origem (contato ausente ou source null/""). */
  withoutSource?: boolean;

  /**
   * Filtro por utm_source (Contact.adUtmSource) — informação rastreada.
   * Pode incluir `SOURCE_NONE` para "sem utm_source".
   */
  utmSources?: string[];
  withoutUtmSource?: boolean;

  /** Motivos de perda (Deal.lostReason) — match exato com a tabulação. */
  lostReasons?: string[];

  /** Tags do deal. */
  tagIds?: string[];
  /** any (qualquer) | all (todas) | none (sem nenhuma das informadas). */
  tagMode?: "any" | "all" | "none";
  /** true = só leads sem nenhuma tag (independente de `tagIds`). */
  withoutTags?: boolean;

  /** Filtros por contato. */
  contactSearch?: string;
  contactHasPhone?: boolean;
  contactHasEmail?: boolean;

  /** Datas: campo + intervalo. */
  createdAt?: DateRangeValue;
  updatedAt?: DateRangeValue;
  closedAt?: DateRangeValue;
  /** Último contato (última mensagem inbound ou outbound). */
  lastInteractionAt?: DateRangeValue;

  /** Campos personalizados de deal/contato. */
  dealCustomFields?: CustomFieldFilter[];
  contactCustomFields?: CustomFieldFilter[];

  /**
   * Filtros de conversa do contato (via Contact.conversations.some).
   * `conversationStatus`: "open" = alguma conversa não resolvida / "closed" = alguma resolvida.
   * `windowState`: janela 24h da Meta (WhatsApp Cloud), não é status RESOLVED.
   * `lastMessageDirection`: "out" = última msg nossa / "in" = última msg do cliente,
   *   olhando só as conversas não encerradas do contato.
   */
  conversationStatus?: "open" | "closed";
  windowState?: "open" | "closed";
  lastMessageDirection?: "in" | "out";

  /** Exceções do Painel → lista filtrada do pipeline. */
  exception?: "no_task" | "stalled" | "overdue" | "empty_value";
  /** Dias sem movimento para `exception=stalled`. Padrão 7. */
  stalledDays?: number;
};

/**
 * Aceita "YYYY-MM-DD" (data pura) e ISO completo. Para data pura,
 * retornamos o inicio do dia em UTC — quem chama decide se quer
 * estender pro fim do dia (ver `dateRangeBounds`).
 */
function parseDate(value: string | null | undefined): Date | undefined {
  if (!value) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const d = new Date(`${value}T00:00:00.000Z`);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

type DateBounds = { gte?: Date; lte?: Date };

/**
 * Converte um range "YYYY-MM-DD" do front em bounds Date para o Prisma.
 *
 * - `from` -> gte = inicio do dia UTC do `from`
 * - `to`   -> lte = fim do dia UTC do `to` (23:59:59.999)
 *
 * Nota timezone: comparamos em UTC. Para a maioria das aplicacoes
 * isso e "good enough" — se o dataset for sensivel a fuso, o usuario
 * pode usar "Personalizado" e definir horarios explicitos.
 */
function dateRangeBounds(range: DateRangeValue | undefined): DateBounds | undefined {
  if (!range) return undefined;
  const gte = parseDate(range.from);
  const lteStart = parseDate(range.to);
  if (!gte && !lteStart) return undefined;
  const f: DateBounds = {};
  if (gte) f.gte = gte;
  if (lteStart) {
    // Se o `to` veio como data pura (00:00 UTC), avanca pra 23:59:59.999
    // do mesmo dia UTC para abranger todo o dia.
    const isMidnightUtc =
      lteStart.getUTCHours() === 0 &&
      lteStart.getUTCMinutes() === 0 &&
      lteStart.getUTCSeconds() === 0 &&
      lteStart.getUTCMilliseconds() === 0;
    if (isMidnightUtc) {
      const end = new Date(lteStart);
      end.setUTCHours(23, 59, 59, 999);
      f.lte = end;
    } else {
      f.lte = lteStart;
    }
  }
  return f;
}

function isDateRangeValue(v: unknown): v is DateRangeValue {
  return !!v && typeof v === "object" && !Array.isArray(v) && ("from" in v || "to" in v);
}

/**
 * Custom fields são STRING no banco. Data entra como `DD/MM/AAAA` (painel)
 * ou `AAAA-MM-DD` (importação / input date). Comparar o texto cru mistura
 * os dois formatos: `30/09/2026` não casa com `2026-09-30`.
 * Operadores de data passam por `idsMatchingCustomDate`, que normaliza os
 * dois para `AAAA-MM-DD` antes do intervalo.
 *
 * `gt`/`lt` em campo numérico continua comparação de texto (só é estável
 * com padding consistente).
 */

/** `DD/MM/AAAA` ou `AAAA-MM-DD` (com ou sem hora) → `AAAA-MM-DD`, ou null. */
function canonicalCustomDate(raw: string): string | null {
  const s = raw.trim();
  const br = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(s);
  const iso = br
    ? `${br[3]}-${br[2]}-${br[1]}`
    : /^(\d{4})-(\d{2})-(\d{2})/.exec(s)?.[0] ?? null;
  if (!iso) return null;
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (
    dt.getUTCFullYear() !== y ||
    dt.getUTCMonth() !== m - 1 ||
    dt.getUTCDate() !== d
  ) {
    return null;
  }
  return iso;
}

type CustomDateCmp = { gte?: string; lte?: string; gt?: string; lt?: string };

/** Intervalo inclusivo em `AAAA-MM-DD` para operador de data. null = não é data. */
function dateCompareFromFilter(filter: CustomFieldFilter): CustomDateCmp | null {
  const op = filter.operator ?? "eq";
  if (op === "between" && isDateRangeValue(filter.value)) {
    const from = filter.value.from ? canonicalCustomDate(filter.value.from) : null;
    const to = filter.value.to ? canonicalCustomDate(filter.value.to) : null;
    if (!from && !to) return null;
    const cmp: CustomDateCmp = {};
    if (from) cmp.gte = from;
    if (to) cmp.lte = to;
    return cmp;
  }
  if (op !== "eq" && op !== "before" && op !== "after" && op !== "gt" && op !== "lt") {
    return null;
  }
  const valueStr = typeof filter.value === "string" ? filter.value.trim() : "";
  const day = valueStr ? canonicalCustomDate(valueStr) : null;
  if (!day) return null;
  if (op === "eq") return { gte: day, lte: day };
  if (op === "before" || op === "lt") return { lt: day };
  return { gt: day };
}

/**
 * IDs cujo valor de data (BR ou ISO) cai no intervalo.
 * `$queryRaw` não passa pelo escopo do Prisma — o `organizationId` vai no SQL.
 */
async function idsMatchingCustomDate(
  table: "deal_custom_field_values" | "contact_custom_field_values",
  idColumn: "dealId" | "contactId",
  customFieldId: string,
  cmp: CustomDateCmp,
): Promise<string[]> {
  const orgId = getRequestContext()?.organizationId;
  if (!orgId) return [];
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM (
      SELECT ${Prisma.raw(`"${idColumn}"`)} AS id,
        CASE
          WHEN value ~ '^[0-9]{2}/[0-9]{2}/[0-9]{4}'
            THEN substring(value from 7 for 4) || '-' || substring(value from 4 for 2) || '-' || substring(value from 1 for 2)
          WHEN value ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}'
            THEN substring(value from 1 for 10)
          ELSE NULL
        END AS canon
      FROM ${Prisma.raw(table)}
      WHERE "organizationId" = ${orgId}
        AND "customFieldId" = ${customFieldId}
    ) dates
    WHERE canon IS NOT NULL
      AND (${cmp.gte ? Prisma.sql`canon >= ${cmp.gte}` : Prisma.sql`TRUE`})
      AND (${cmp.lte ? Prisma.sql`canon <= ${cmp.lte}` : Prisma.sql`TRUE`})
      AND (${cmp.gt ? Prisma.sql`canon > ${cmp.gt}` : Prisma.sql`TRUE`})
      AND (${cmp.lt ? Prisma.sql`canon < ${cmp.lt}` : Prisma.sql`TRUE`})
  `;
  return rows.map((row) => row.id);
}
function buildContactCustomFieldClause(
  customFieldId: string,
  filter: CustomFieldFilter,
): Prisma.ContactWhereInput | null {
  const op = filter.operator ?? (filter.value ? "contains" : "filled");
  const valueStr = typeof filter.value === "string" ? filter.value.trim() : "";
  const valueArr = Array.isArray(filter.value) ? filter.value.filter(Boolean) : [];
  const range = isDateRangeValue(filter.value) ? filter.value : null;

  switch (op) {
    case "filled":
      return { customFields: { some: { customFieldId, value: { not: "" } } } };
    case "empty":
      return {
        OR: [
          { customFields: { none: { customFieldId } } },
          { customFields: { some: { customFieldId, value: "" } } },
        ],
      };
    case "eq":
      if (!valueStr) return null;
      return { customFields: { some: { customFieldId, value: valueStr } } };
    case "neq":
      if (!valueStr) return null;
      return { customFields: { some: { customFieldId, value: { not: valueStr } } } };
    case "contains":
      if (!valueStr) return null;
      return {
        customFields: {
          some: { customFieldId, value: { contains: valueStr, mode: "insensitive" } },
        },
      };
    case "not_contains":
      if (!valueStr) return null;
      return {
        NOT: {
          customFields: {
            some: { customFieldId, value: { contains: valueStr, mode: "insensitive" } },
          },
        },
      };
    case "in":
      if (valueArr.length === 0) return null;
      return { customFields: { some: { customFieldId, value: { in: valueArr } } } };
    case "gt":
      if (!valueStr) return null;
      return { customFields: { some: { customFieldId, value: { gt: valueStr } } } };
    case "lt":
      if (!valueStr) return null;
      return { customFields: { some: { customFieldId, value: { lt: valueStr } } } };
    case "before":
      if (!valueStr) return null;
      return { customFields: { some: { customFieldId, value: { lt: valueStr } } } };
    case "after":
      if (!valueStr) return null;
      return { customFields: { some: { customFieldId, value: { gt: valueStr } } } };
    case "between": {
      if (!range || (!range.from && !range.to)) return null;
      const valueWhere: { gte?: string; lte?: string } = {};
      if (range.from) valueWhere.gte = range.from;
      if (range.to) valueWhere.lte = range.to;
      return { customFields: { some: { customFieldId, value: valueWhere } } };
    }
    default:
      return null;
  }
}

function buildDealCustomFieldClause(
  customFieldId: string,
  filter: CustomFieldFilter,
): Prisma.DealWhereInput | null {
  const op = filter.operator ?? (filter.value ? "contains" : "filled");
  const valueStr = typeof filter.value === "string" ? filter.value.trim() : "";
  const valueArr = Array.isArray(filter.value) ? filter.value.filter(Boolean) : [];
  const range = isDateRangeValue(filter.value) ? filter.value : null;

  switch (op) {
    case "filled":
      return { customFields: { some: { customFieldId, value: { not: "" } } } };
    case "empty":
      return {
        OR: [
          { customFields: { none: { customFieldId } } },
          { customFields: { some: { customFieldId, value: "" } } },
        ],
      };
    case "eq":
      if (!valueStr) return null;
      return { customFields: { some: { customFieldId, value: valueStr } } };
    case "neq":
      if (!valueStr) return null;
      return { customFields: { some: { customFieldId, value: { not: valueStr } } } };
    case "contains":
      if (!valueStr) return null;
      return {
        customFields: {
          some: { customFieldId, value: { contains: valueStr, mode: "insensitive" } },
        },
      };
    case "not_contains":
      if (!valueStr) return null;
      return {
        NOT: {
          customFields: {
            some: { customFieldId, value: { contains: valueStr, mode: "insensitive" } },
          },
        },
      };
    case "in":
      if (valueArr.length === 0) return null;
      return { customFields: { some: { customFieldId, value: { in: valueArr } } } };
    case "gt":
      if (!valueStr) return null;
      return { customFields: { some: { customFieldId, value: { gt: valueStr } } } };
    case "lt":
      if (!valueStr) return null;
      return { customFields: { some: { customFieldId, value: { lt: valueStr } } } };
    case "before":
      if (!valueStr) return null;
      return { customFields: { some: { customFieldId, value: { lt: valueStr } } } };
    case "after":
      if (!valueStr) return null;
      return { customFields: { some: { customFieldId, value: { gt: valueStr } } } };
    case "between": {
      if (!range || (!range.from && !range.to)) return null;
      const valueWhere: { gte?: string; lte?: string } = {};
      if (range.from) valueWhere.gte = range.from;
      if (range.to) valueWhere.lte = range.to;
      return { customFields: { some: { customFieldId, value: valueWhere } } };
    }
    default:
      return null;
  }
}

/**
 * Condição de origem em cima do contato do deal, com suporte a
 * "Sem origem" (contato com source null/"" ou deal sem contato).
 */
function buildDealSourceCondition(
  sources?: string[],
  withoutSource?: boolean,
): Prisma.DealWhereInput | null {
  const real = (sources ?? []).filter((s) => s && s !== SOURCE_NONE);
  const wantNone = withoutSource === true || (sources ?? []).includes(SOURCE_NONE);
  const or: Prisma.DealWhereInput[] = [];
  if (real.length) or.push({ contact: { is: { source: { in: real } } } });
  if (wantNone) {
    or.push({
      OR: [
        { contactId: null },
        { contact: { is: { source: null } } },
        { contact: { is: { source: "" } } },
      ],
    });
  }
  if (or.length === 0) return null;
  return or.length === 1 ? or[0] : { OR: or };
}

/** Mesma semântica de origem, aplicada a Contact.adUtmSource. */
function buildDealUtmSourceCondition(
  utmSources?: string[],
  withoutUtmSource?: boolean,
): Prisma.DealWhereInput | null {
  const real = (utmSources ?? []).filter((s) => s && s !== SOURCE_NONE);
  const wantNone =
    withoutUtmSource === true || (utmSources ?? []).includes(SOURCE_NONE);
  const or: Prisma.DealWhereInput[] = [];
  if (real.length) or.push({ contact: { is: { adUtmSource: { in: real } } } });
  if (wantNone) {
    or.push({
      OR: [
        { contactId: null },
        { contact: { is: { adUtmSource: null } } },
        { contact: { is: { adUtmSource: "" } } },
      ],
    });
  }
  if (or.length === 0) return null;
  return or.length === 1 ? or[0] : { OR: or };
}

/**
 * Traduz `AdvancedDealFilters` para `Prisma.DealWhereInput`.
 * O retorno deve ser somado às outras condições via `AND` em `dealWhere`.
 */
export async function buildDealWhereFromFilters(
  filters: AdvancedDealFilters,
): Promise<Prisma.DealWhereInput[]> {
  const conditions: Prisma.DealWhereInput[] = [];

  const search = filters.search?.trim();
  if (search) {
    const or = await buildDealSearchOr(search);
    if (or.length > 0) conditions.push({ OR: or });
  }

  if (filters.pipelineId) {
    conditions.push({ stage: { pipelineId: filters.pipelineId } });
  }

  if (filters.stageIds && filters.stageIds.length > 0) {
    conditions.push({ stageId: { in: filters.stageIds } });
  }

  if (filters.statuses && filters.statuses.length > 0) {
    conditions.push({ status: { in: filters.statuses } });
  }

  // Responsável
  if (filters.withoutOwner) {
    conditions.push({ ownerId: null });
  } else if (filters.ownerIds && filters.ownerIds.length > 0) {
    const realIds = filters.ownerIds.filter((id): id is string => !!id);
    const hasNull = filters.ownerIds.some((id) => id === null);
    if (hasNull && realIds.length > 0) {
      conditions.push({ OR: [{ ownerId: null }, { ownerId: { in: realIds } }] });
    } else if (hasNull) {
      conditions.push({ ownerId: null });
    } else if (realIds.length > 0) {
      conditions.push({ ownerId: { in: realIds } });
    }
  }

  if (filters.withoutContact) {
    conditions.push({ contactId: null });
  }

  const sourceCond = buildDealSourceCondition(filters.sources, filters.withoutSource);
  if (sourceCond) conditions.push(sourceCond);

  const utmSourceCond = buildDealUtmSourceCondition(
    filters.utmSources,
    filters.withoutUtmSource,
  );
  if (utmSourceCond) conditions.push(utmSourceCond);

  if (filters.lostReasons && filters.lostReasons.length > 0) {
    conditions.push({ lostReason: { in: filters.lostReasons } });
  }

  // Tags
  if (filters.withoutTags) {
    conditions.push({ tags: { none: {} } });
  } else if (filters.tagIds && filters.tagIds.length > 0) {
    const ids = filters.tagIds;
    const mode = filters.tagMode ?? "any";
    if (mode === "any") {
      conditions.push({ tags: { some: { tagId: { in: ids } } } });
    } else if (mode === "all") {
      // todas: cada tag deve aparecer
      for (const tagId of ids) {
        conditions.push({ tags: { some: { tagId } } });
      }
    } else if (mode === "none") {
      conditions.push({ tags: { none: { tagId: { in: ids } } } });
    }
  }

  // Contato
  const contactSearch = filters.contactSearch?.trim();
  if (contactSearch) {
    conditions.push({
      contact: {
        is: {
          OR: [
            { name: { contains: contactSearch, mode: "insensitive" } },
            { email: { contains: contactSearch, mode: "insensitive" } },
            { phone: { contains: contactSearch } },
          ],
        },
      },
    });
  }
  if (filters.contactHasPhone === true) {
    conditions.push({ contact: { is: { phone: { not: null } } } });
  } else if (filters.contactHasPhone === false) {
    conditions.push({ contact: { is: { phone: null } } });
  }
  if (filters.contactHasEmail === true) {
    conditions.push({ contact: { is: { email: { not: null } } } });
  } else if (filters.contactHasEmail === false) {
    conditions.push({ contact: { is: { email: null } } });
  }

  // Datas
  const created = dateRangeBounds(filters.createdAt);
  if (created) conditions.push({ createdAt: { ...created } });
  const updated = dateRangeBounds(filters.updatedAt);
  if (updated) conditions.push({ updatedAt: { ...updated } });
  const closed = dateRangeBounds(filters.closedAt);
  if (closed) conditions.push({ closedAt: { ...closed } });
  const lastInter = dateRangeBounds(filters.lastInteractionAt);
  if (lastInter) {
    // proxy: última mensagem da conversation do contato
    conditions.push({
      contact: {
        is: {
          conversations: {
            some: { lastInboundAt: { ...lastInter } },
          },
        },
      },
    });
  }

  // Filtros de conversa (status + direção da última mensagem). Combinados no
  // MESMO `some` para casar a mesma conversation quando ambos estão ativos.
  {
    const convSome: Prisma.ConversationWhereInput = {};
    if (filters.conversationStatus === "open") convSome.status = { not: "RESOLVED" };
    else if (filters.conversationStatus === "closed") convSome.status = "RESOLVED";
    const dir = filters.lastMessageDirection;
    const orgIdForDir = getRequestContext()?.organizationId;
    if (
      (dir === "in" || dir === "out") &&
      !filters.conversationStatus &&
      orgIdForDir &&
      (await isContactLastMessageReady(orgIdForDir))
    ) {
      // Direção da ÚLTIMA mensagem de chat do contato, em coluna pronta
      // (`contacts.lastMessageDirection`, gravada junto de
      // `conversations.lastMessageAt`). Um predicado na PK do contato: o
      // board traduz para EXISTS no SQL (`translateContactFilter`), sem
      // pré-consulta nem lista de ids.
      //
      // Diferença para o caminho antigo (abaixo): vale a última mensagem de
      // chat do contato em QUALQUER conversa. Antes: com conversa ativa, "tem
      // uma ativa na direção pedida e nenhuma ativa na oposta" (contato com
      // duas conversas ativas em direções opostas não casava com nenhum dos
      // dois filtros; agora casa com a mais recente); só com encerradas, a
      // conversa de `updatedAt` mais recente (que muda com atribuição e
      // encerramento, não só com mensagem). Ligação (`whatsapp_call`) e
      // evento não contam como mensagem.
      conditions.push({ contact: { is: { lastMessageDirection: dir } } });
    } else if ((dir === "in" || dir === "out") && !filters.conversationStatus) {
      // Direção da ÚLTIMA mensagem do contato. Antes bastava "alguma
      // conversa" com a direção pedida: contato com conversa antiga em que o
      // cliente falou por último aparecia em "Mensagem recebida" mesmo com a
      // conversa atual respondida — o filtro mostrava recebidas E enviadas.
      //
      // Com conversa ativa: só as não encerradas contam (tem uma com a
      // direção pedida e nenhuma com a oposta).
      // Só com conversas encerradas: vale a mais recente.
      conditions.push({
        OR: [
          {
            contact: {
              is: {
                AND: [
                  {
                    conversations: {
                      some: { status: { not: "RESOLVED" }, lastMessageDirection: dir },
                    },
                  },
                  {
                    conversations: {
                      none: {
                        status: { not: "RESOLVED" },
                        lastMessageDirection: dir === "in" ? "out" : "in",
                      },
                    },
                  },
                ],
              },
            },
          },
          { contactId: { in: await findClosedOnlyContactIdsByLastDirection(dir) } },
        ],
      });
    } else {
      if (dir === "in" || dir === "out") convSome.lastMessageDirection = dir;
      if (Object.keys(convSome).length > 0) {
        conditions.push({ contact: { is: { conversations: { some: convSome } } } });
      }
    }
  }

  // Janela 24h da Meta (WhatsApp Cloud). "Aberta" = contato tem ticket
  // com inbound < 24h; "fechada" = tem WhatsApp Meta e nenhum ticket aberto.
  if (filters.windowState === "open") {
    conditions.push({
      contact: {
        is: { conversations: { some: metaSessionWindowWhere("open") } },
      },
    });
  } else if (filters.windowState === "closed") {
    conditions.push({
      contact: {
        is: {
          conversations: {
            some: metaWhatsappConversationWhere(),
            none: metaSessionWindowWhere("open"),
          },
        },
      },
    });
  }

  // Custom fields (Deal)
  if (filters.dealCustomFields && filters.dealCustomFields.length > 0) {
    const names = filters.dealCustomFields.map((f) => f.name.trim()).filter(Boolean);
    if (names.length > 0) {
      const defs = await prisma.customField.findMany({
        where: { entity: "deal", name: { in: names } },
        select: { id: true, name: true, type: true },
      });
      const byName = new Map(defs.map((d) => [d.name, d]));
      for (const f of filters.dealCustomFields) {
        const def = byName.get(f.name.trim());
        if (!def) continue;
        const dateCmp = def.type === "DATE" ? dateCompareFromFilter(f) : null;
        if (dateCmp) {
          const ids = await idsMatchingCustomDate(
            "deal_custom_field_values",
            "dealId",
            def.id,
            dateCmp,
          );
          conditions.push({ id: { in: ids } });
          continue;
        }
        const clause = buildDealCustomFieldClause(def.id, f);
        if (clause) conditions.push(clause);
      }
    }
  }

  // Custom fields (Contact)
  if (filters.contactCustomFields && filters.contactCustomFields.length > 0) {
    const names = filters.contactCustomFields.map((f) => f.name.trim()).filter(Boolean);
    if (names.length > 0) {
      const defs = await prisma.customField.findMany({
        where: { entity: "contact", name: { in: names } },
        select: { id: true, name: true, type: true },
      });
      const byName = new Map(defs.map((d) => [d.name, d]));
      for (const f of filters.contactCustomFields) {
        const def = byName.get(f.name.trim());
        if (!def) continue;
        const dateCmp = def.type === "DATE" ? dateCompareFromFilter(f) : null;
        if (dateCmp) {
          const ids = await idsMatchingCustomDate(
            "contact_custom_field_values",
            "contactId",
            def.id,
            dateCmp,
          );
          conditions.push({ contactId: { in: ids } });
          continue;
        }
        const clause = buildContactCustomFieldClause(def.id, f);
        if (clause) conditions.push({ contact: { is: clause } });
      }
    }
  }

  const exception = filters.exception;
  if (exception) {
    conditions.push({ status: "OPEN" });
    const now = new Date();
    if (exception === "no_task") {
      conditions.push({
        activities: { none: { completed: false, scheduledAt: { gte: now } } },
      });
    } else if (exception === "stalled") {
      const days =
        typeof filters.stalledDays === "number" &&
        Number.isFinite(filters.stalledDays) &&
        filters.stalledDays > 0 &&
        filters.stalledDays <= 365
          ? Math.round(filters.stalledDays)
          : 7;
      conditions.push({
        updatedAt: { lt: new Date(now.getTime() - days * 86_400_000) },
      });
    } else if (exception === "overdue") {
      const start = new Date(now);
      start.setHours(0, 0, 0, 0);
      conditions.push({ expectedClose: { lt: start } });
    } else if (exception === "empty_value") {
      conditions.push({ value: { lte: 0 } });
    }
  }

  return conditions;
}

/**
 * Parse defensivo do body do cliente. Retorna `null` se o input não
 * for um objeto. Filtros desconhecidos são silenciosamente ignorados.
 */
/**
 * Operadores aceitos em CustomField. Mantenha sincronizado com a union
 * em `CustomFieldFilter.operator`.
 */
const CUSTOM_FIELD_OPS = new Set([
  "eq",
  "neq",
  "contains",
  "not_contains",
  "filled",
  "empty",
  "gt",
  "lt",
  "between",
  "before",
  "after",
  "in",
]);

function asString(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.trim();
  return s.length > 0 ? s : undefined;
}

function asBool(v: unknown): boolean | undefined {
  return typeof v === "boolean" ? v : undefined;
}

function asStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const arr = v.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
  return arr.length > 0 ? arr : undefined;
}

function asDateRange(v: unknown): DateRangeValue | undefined {
  if (!v || typeof v !== "object") return undefined;
  const r = v as { from?: unknown; to?: unknown };
  const from = typeof r.from === "string" ? r.from : null;
  const to = typeof r.to === "string" ? r.to : null;
  if (!from && !to) return undefined;
  return { from, to };
}

function asCustomFieldFilter(v: unknown): CustomFieldFilter | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const name = asString(o.name);
  if (!name) return null;
  const operator =
    typeof o.operator === "string" && CUSTOM_FIELD_OPS.has(o.operator)
      ? (o.operator as CustomFieldFilter["operator"])
      : undefined;
  let value: CustomFieldFilter["value"];
  if (typeof o.value === "string") value = o.value;
  else if (Array.isArray(o.value)) {
    value = o.value.filter((x): x is string => typeof x === "string");
  } else if (o.value && typeof o.value === "object") {
    value = asDateRange(o.value) ?? null;
  } else {
    value = null;
  }
  return { name, operator, value };
}

function asCustomFieldArray(v: unknown): CustomFieldFilter[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: CustomFieldFilter[] = [];
  for (const item of v) {
    const f = asCustomFieldFilter(item);
    if (f) out.push(f);
  }
  return out.length > 0 ? out : undefined;
}

const VALID_DEAL_STATUSES = new Set(["OPEN", "WON", "LOST"]);
const VALID_TAG_MODES = new Set(["any", "all", "none"]);

/**
 * Sanitiza/valida o payload recebido do cliente. Ignora campos
 * desconhecidos e descarta valores invalidos. Nunca quebra — sempre
 * devolve um objeto valido (potencialmente vazio).
 */
export function parseAdvancedDealFilters(input: unknown): AdvancedDealFilters {
  if (!input || typeof input !== "object") return {};
  const o = input as Record<string, unknown>;
  const out: AdvancedDealFilters = {};

  if (o.logic === "AND" || o.logic === "OR") out.logic = o.logic;

  const search = asString(o.search);
  if (search) out.search = search;

  const pipelineId = asString(o.pipelineId);
  if (pipelineId) out.pipelineId = pipelineId;

  const stageIds = asStringArray(o.stageIds);
  if (stageIds) out.stageIds = stageIds;

  const statuses = asStringArray(o.statuses)?.filter((s) =>
    VALID_DEAL_STATUSES.has(s),
  ) as DealStatus[] | undefined;
  if (statuses && statuses.length > 0) out.statuses = statuses;

  // ownerIds aceita null como "sem responsavel"
  if (Array.isArray(o.ownerIds)) {
    const owners = o.ownerIds.filter(
      (x): x is string | null => x === null || (typeof x === "string" && x.trim().length > 0),
    );
    if (owners.length > 0) out.ownerIds = owners;
  }
  const wo = asBool(o.withoutOwner);
  if (wo) out.withoutOwner = wo;
  const wc = asBool(o.withoutContact);
  if (wc) out.withoutContact = wc;

  const sources = asStringArray(o.sources);
  if (sources) out.sources = sources;
  const ws = asBool(o.withoutSource);
  if (ws) out.withoutSource = ws;

  const utmSources = asStringArray(o.utmSources);
  if (utmSources) out.utmSources = utmSources;
  const wus = asBool(o.withoutUtmSource);
  if (wus) out.withoutUtmSource = wus;

  const lostReasons = asStringArray(o.lostReasons);
  if (lostReasons) out.lostReasons = lostReasons;

  const tagIds = asStringArray(o.tagIds);
  if (tagIds) out.tagIds = tagIds;
  if (typeof o.tagMode === "string" && VALID_TAG_MODES.has(o.tagMode)) {
    out.tagMode = o.tagMode as "any" | "all" | "none";
  }
  const wt = asBool(o.withoutTags);
  if (wt) out.withoutTags = wt;

  const contactSearch = asString(o.contactSearch);
  if (contactSearch) out.contactSearch = contactSearch;
  const chp = asBool(o.contactHasPhone);
  if (chp !== undefined) out.contactHasPhone = chp;
  const che = asBool(o.contactHasEmail);
  if (che !== undefined) out.contactHasEmail = che;

  const created = asDateRange(o.createdAt);
  if (created) out.createdAt = created;
  const updated = asDateRange(o.updatedAt);
  if (updated) out.updatedAt = updated;
  const closed = asDateRange(o.closedAt);
  if (closed) out.closedAt = closed;
  const lastI = asDateRange(o.lastInteractionAt);
  if (lastI) out.lastInteractionAt = lastI;

  const dealCfs = asCustomFieldArray(o.dealCustomFields);
  if (dealCfs) out.dealCustomFields = dealCfs;
  const contactCfs = asCustomFieldArray(o.contactCustomFields);
  if (contactCfs) out.contactCustomFields = contactCfs;

  if (o.conversationStatus === "open" || o.conversationStatus === "closed") {
    out.conversationStatus = o.conversationStatus;
  }
  if (o.windowState === "open" || o.windowState === "closed") {
    out.windowState = o.windowState;
  }
  if (o.lastMessageDirection === "in" || o.lastMessageDirection === "out") {
    out.lastMessageDirection = o.lastMessageDirection;
  }

  if (
    o.exception === "no_task" ||
    o.exception === "stalled" ||
    o.exception === "overdue" ||
    o.exception === "empty_value"
  ) {
    out.exception = o.exception;
  }
  {
    const n = Number(o.stalledDays);
    if (Number.isFinite(n)) {
      const days = Math.round(n);
      if (days > 0 && days <= 365) out.stalledDays = days;
    }
  }

  return out;
}

/**
 * Lê os filtros avançados de uma querystring: `filters` (JSON) ou `f`
 * (base64url do mesmo JSON, usado quando o payload é grande demais para a URL
 * legível). Devolve `{}` quando não há filtro válido.
 */
export function parseAdvancedDealFiltersFromParams(
  searchParams: URLSearchParams,
): AdvancedDealFilters {
  const raw = searchParams.get("filters");
  if (raw) {
    try {
      const parsed = parseAdvancedDealFilters(JSON.parse(raw));
      if (Object.keys(parsed).length > 0) return parsed;
    } catch {
      /* ignora filters inválido */
    }
  }
  const f = searchParams.get("f");
  if (f) {
    try {
      const b64 = f.replace(/-/g, "+").replace(/_/g, "/");
      const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
      const json = Buffer.from(b64 + pad, "base64").toString("utf8");
      return parseAdvancedDealFilters(JSON.parse(json));
    } catch {
      /* ignora f inválido */
    }
  }
  return {};
}
