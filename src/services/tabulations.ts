import { prisma } from "@/lib/prisma";
import { getRequestContext } from "@/lib/request-context";
import { withOrgFromCtx } from "@/lib/prisma-helpers";

/**
 * Tabulacoes de atendimento — arvore por departamento.
 *
 * Regras invariantes garantidas aqui (nao delegar pra rota):
 *   - Toda operacao filtra por org do contexto (Prisma extension ja
 *     injeta em SCOPED_MODELS, mas mantemos where explicito por
 *     defesa/documentacao).
 *   - `parent.departmentId === node.departmentId` (arvore homogenea).
 *   - Ao mover/renomear/desativar, `position` eh gerenciada pelo caller
 *     (default = max+1 na criacao).
 *
 * A escolha do agente ao encerrar exige uma FOLHA (usar
 * `assertLeafInDepartment`).
 */

export type TabulationNode = {
  id: string;
  /** ID amigável sequencial por organização (não o CUID). */
  number: number;
  parentId: string | null;
  name: string;
  color: string | null;
  position: number;
  active: boolean;
  children: TabulationNode[];
};

/** Snapshot gravado em `CONVERSATION_TABULATED.meta` (timeline + analytics). */
export type TabulationLogFields = {
  tabulationId: string;
  ancestorIds: string[];
  departmentId: string | null;
  tabulationName: string;
  tabulationNumber: number;
};

export function tabulationLogMeta(
  snap: {
    tabulationId: string;
    ancestorIds: string[];
    departmentId?: string | null;
    name: string;
    number: number;
  },
  extra?: Record<string, unknown>,
): TabulationLogFields & Record<string, unknown> {
  return {
    tabulationId: snap.tabulationId,
    ancestorIds: snap.ancestorIds,
    departmentId: snap.departmentId ?? null,
    tabulationName: snap.name,
    tabulationNumber: snap.number,
    ...extra,
  };
}

/**
 * Próximo `Tabulation.number` da org corrente. Schema:
 * `@@unique([organizationId, number])` sem default — Postgres sequences
 * não particionam por coluna. A extension Prisma já escopa o aggregate.
 * Em corrida o caller faz retry em P2002 (ver `createNode`).
 */
export async function nextTabulationNumber(): Promise<number> {
  const r = await prisma.tabulation.aggregate({ _max: { number: true } });
  return (r._max.number ?? 0) + 1;
}

function isTabulationNumberUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as {
    code?: string;
    message?: string;
    meta?: { target?: string[] | string };
  };
  if (e.code !== "P2002") return false;
  const target = e.meta?.target;
  const hasNumber = (s: string) => s === "number" || s.includes("number");
  if (Array.isArray(target)) return target.some((t) => hasNumber(String(t)));
  if (typeof target === "string") return hasNumber(target);
  const msg = typeof e.message === "string" ? e.message : "";
  return /organizationId/i.test(msg) && /[`"']number[`"']/i.test(msg);
}

const TABULATION_NUMBER_MAX_RETRIES = 5;

function orgIdOrThrow(): string {
  const ctx = getRequestContext();
  const orgId = ctx?.organizationId;
  if (!orgId) throw new Error("Sem organizationId no contexto.");
  return orgId;
}

export type TabulationDepartmentGroup = {
  departmentId: string;
  departmentName: string;
  requireTabulationOnClose: boolean;
  tree: TabulationNode[];
};

type TabulationRow = Awaited<ReturnType<typeof listByDepartment>>[number];

function buildTreeFromRows(rows: TabulationRow[]): TabulationNode[] {
  const byId = new Map<string, TabulationNode>();
  rows.forEach((r) => {
    byId.set(r.id, {
      id: r.id,
      number: r.number,
      parentId: r.parentId,
      name: r.name,
      color: r.color,
      position: r.position,
      active: r.active,
      children: [],
    });
  });
  const roots: TabulationNode[] = [];
  byId.forEach((node) => {
    if (node.parentId && byId.has(node.parentId)) {
      byId.get(node.parentId)!.children.push(node);
    } else {
      roots.push(node);
    }
  });
  const sortRec = (arr: TabulationNode[]) => {
    arr.sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
    arr.forEach((n) => sortRec(n.children));
  };
  sortRec(roots);
  return roots;
}

export async function listByDepartment(departmentId: string) {
  const orgId = orgIdOrThrow();
  return prisma.tabulation.findMany({
    where: { organizationId: orgId, departmentId },
    orderBy: [{ position: "asc" }, { name: "asc" }],
  });
}

export async function getTree(departmentId: string): Promise<TabulationNode[]> {
  const rows = await listByDepartment(departmentId);
  return buildTreeFromRows(rows);
}

export async function listOrgDepartments(): Promise<
  Array<{
    id: string;
    name: string;
    requireTabulationOnClose: boolean;
  }>
> {
  const orgId = orgIdOrThrow();
  return prisma.department.findMany({
    where: { organizationId: orgId },
    select: { id: true, name: true, requireTabulationOnClose: true },
    orderBy: { name: "asc" },
  });
}

export async function listDepartmentsForUser(userId: string): Promise<
  Array<{
    id: string;
    name: string;
    requireTabulationOnClose: boolean;
  }>
> {
  const orgId = orgIdOrThrow();
  const rows = await prisma.departmentMember.findMany({
    where: { organizationId: orgId, userId },
    select: {
      department: {
        select: { id: true, name: true, requireTabulationOnClose: true },
      },
    },
  });
  return rows
    .map((r) => r.department)
    .sort((a, b) => a.name.localeCompare(b.name, "pt"));
}

export async function getTreesForDepartments(
  departments: Array<{
    id: string;
    name: string;
    requireTabulationOnClose: boolean;
  }>,
): Promise<TabulationDepartmentGroup[]> {
  if (departments.length === 0) return [];
  const orgId = orgIdOrThrow();
  const ids = departments.map((d) => d.id);
  const rows = await prisma.tabulation.findMany({
    where: { organizationId: orgId, departmentId: { in: ids } },
    orderBy: [{ position: "asc" }, { name: "asc" }],
  });
  const byDept = new Map<string, TabulationRow[]>();
  for (const row of rows) {
    const list = byDept.get(row.departmentId) ?? [];
    list.push(row);
    byDept.set(row.departmentId, list);
  }
  return departments.map((d) => ({
    departmentId: d.id,
    departmentName: d.name,
    requireTabulationOnClose: d.requireTabulationOnClose,
    tree: buildTreeFromRows(byDept.get(d.id) ?? []),
  }));
}

/** Retorna [rootId, ..., leafId] (inclui o proprio id ao fim). */
export async function getAncestors(id: string): Promise<string[]> {
  return ancestorsInOrg(id, orgIdOrThrow());
}

async function ancestorsInOrg(id: string, orgId: string): Promise<string[]> {
  const chain: string[] = [];
  let cursor: { id: string; parentId: string | null } | null =
    await prisma.tabulation.findFirst({
      where: { id, organizationId: orgId },
      select: { id: true, parentId: true },
    });
  const seen = new Set<string>();
  while (cursor) {
    if (seen.has(cursor.id)) break;
    seen.add(cursor.id);
    chain.push(cursor.id);
    if (!cursor.parentId) break;
    cursor = await prisma.tabulation.findFirst({
      where: { id: cursor.parentId, organizationId: orgId },
      select: { id: true, parentId: true },
    });
  }
  return chain.reverse();
}

/**
 * Tabulacao de encerramento AUTOMATICO do departamento (IA de encerramento
 * academico, step `finish_conversation`). Revalida a folha na hora do uso —
 * a arvore pode ter sido reorganizada/desativada depois de configurada; nesse
 * caso devolve null e o encerramento segue sem tabular (nunca bloqueia o bot).
 *
 * Recebe `organizationId` explicito: roda fora de request context (webhook,
 * worker de automacao), onde `orgIdOrThrow()` nao vale.
 */
export async function resolveAutoCloseTabulation(args: {
  organizationId: string;
  departmentId: string | null | undefined;
}): Promise<{
  tabulationId: string;
  ancestorIds: string[];
  name: string;
  number: number;
} | null> {
  const { organizationId, departmentId } = args;
  if (!departmentId) return null;

  const dept = await prisma.department.findFirst({
    where: { id: departmentId, organizationId },
    select: { autoCloseTabulationId: true },
  });
  const tabulationId = dept?.autoCloseTabulationId;
  if (!tabulationId) return null;

  const node = await prisma.tabulation.findFirst({
    where: { id: tabulationId, organizationId, departmentId, active: true },
    select: {
      id: true,
      name: true,
      number: true,
      children: { where: { active: true }, select: { id: true }, take: 1 },
    },
  });
  if (!node || node.children.length > 0) return null;

  return {
    tabulationId,
    name: node.name,
    number: node.number,
    ancestorIds: await ancestorsInOrg(tabulationId, organizationId),
  };
}

/**
 * Tabulacao escolhida no passo `tabulate_conversation` de uma automacao.
 * Revalida na hora do uso, como `resolveAutoCloseTabulation`: a arvore pode
 * ter sido reorganizada ou desativada depois de o fluxo ser montado, e nesse
 * caso devolve null pro passo seguir sem tabular em vez de derrubar o fluxo.
 *
 * Devolve o `departmentId` da propria tabulacao — e nao o da conversa. O log
 * usa esse valor pro dashboard agrupar o registro na arvore a que a opcao
 * pertence, inclusive quando a conversa esta sem departamento.
 */
export async function resolveTabulationForStep(args: {
  organizationId: string;
  tabulationId: string | null | undefined;
}): Promise<{
  tabulationId: string;
  ancestorIds: string[];
  departmentId: string;
  name: string;
  number: number;
} | null> {
  const { organizationId, tabulationId } = args;
  if (!tabulationId) return null;

  const node = await prisma.tabulation.findFirst({
    where: { id: tabulationId, organizationId, active: true },
    select: {
      id: true,
      departmentId: true,
      name: true,
      number: true,
      children: { where: { active: true }, select: { id: true }, take: 1 },
    },
  });
  if (!node || node.children.length > 0) return null;

  return {
    tabulationId: node.id,
    departmentId: node.departmentId,
    name: node.name,
    number: node.number,
    ancestorIds: await ancestorsInOrg(node.id, organizationId),
  };
}

/**
 * Garante que `id` existe, pertence ao `departmentId` E eh folha (sem
 * filhos ativos). Filhos inativos nao impedem a escolha — `active` eh
 * por no. Lanca com `code` estavel pra rota mapear pra 400.
 */
export async function assertLeafInDepartment(
  id: string,
  departmentId: string,
): Promise<{ id: string; name: string; number: number }> {
  const orgId = orgIdOrThrow();
  const node = await prisma.tabulation.findFirst({
    where: { id, organizationId: orgId, departmentId, active: true },
    select: {
      id: true,
      name: true,
      number: true,
      children: { where: { active: true }, select: { id: true }, take: 1 },
    },
  });
  if (!node) {
    const err = new Error("Tabulacao invalida para este departamento.");
    (err as { code?: string }).code = "TABULATION_INVALID";
    throw err;
  }
  if (node.children.length > 0) {
    const err = new Error("Selecione uma tabulacao folha.");
    (err as { code?: string }).code = "TABULATION_NOT_LEAF";
    throw err;
  }
  return { id: node.id, name: node.name, number: node.number };
}

/** Folha ativa em qualquer um dos departamentos (fallback sem depto na conversa). */
export async function assertLeafInDepartments(
  id: string,
  departmentIds: string[],
): Promise<{ id: string; name: string; number: number; departmentId: string }> {
  if (departmentIds.length === 0) {
    const err = new Error("Tabulacao invalida para este agente.");
    (err as { code?: string }).code = "TABULATION_INVALID";
    throw err;
  }
  if (departmentIds.length === 1) {
    const leaf = await assertLeafInDepartment(id, departmentIds[0]!);
    return { ...leaf, departmentId: departmentIds[0]! };
  }
  const orgId = orgIdOrThrow();
  const node = await prisma.tabulation.findFirst({
    where: {
      id,
      organizationId: orgId,
      departmentId: { in: departmentIds },
      active: true,
    },
    select: {
      id: true,
      name: true,
      number: true,
      departmentId: true,
      children: { where: { active: true }, select: { id: true }, take: 1 },
    },
  });
  if (!node) {
    const err = new Error("Tabulacao invalida para os departamentos deste agente.");
    (err as { code?: string }).code = "TABULATION_INVALID";
    throw err;
  }
  if (node.children.length > 0) {
    const err = new Error("Selecione uma tabulacao folha.");
    (err as { code?: string }).code = "TABULATION_NOT_LEAF";
    throw err;
  }
  return {
    id: node.id,
    name: node.name,
    number: node.number,
    departmentId: node.departmentId,
  };
}

/** Folha ativa em qualquer departamento da org (conversa sem depto associado). */
export async function assertLeafInOrg(
  id: string,
): Promise<{ id: string; name: string; number: number; departmentId: string | null }> {
  const orgId = orgIdOrThrow();
  const node = await prisma.tabulation.findFirst({
    where: { id, organizationId: orgId, active: true },
    select: {
      id: true,
      name: true,
      number: true,
      departmentId: true,
      children: { where: { active: true }, select: { id: true }, take: 1 },
    },
  });
  if (!node) {
    const err = new Error("Tabulacao invalida.");
    (err as { code?: string }).code = "TABULATION_INVALID";
    throw err;
  }
  if (node.children.length > 0) {
    const err = new Error("Selecione uma tabulacao folha.");
    (err as { code?: string }).code = "TABULATION_NOT_LEAF";
    throw err;
  }
  return {
    id: node.id,
    name: node.name,
    number: node.number,
    departmentId: node.departmentId,
  };
}

export async function createNode(input: {
  departmentId: string;
  parentId?: string | null;
  name: string;
  color?: string | null;
}) {
  const orgId = orgIdOrThrow();
  // Se `parentId` foi passado, ele DEVE existir na mesma org+dept.
  if (input.parentId) {
    const parent = await prisma.tabulation.findFirst({
      where: {
        id: input.parentId,
        organizationId: orgId,
        departmentId: input.departmentId,
      },
      select: { id: true },
    });
    if (!parent) {
      const err = new Error("Pai invalido.");
      (err as { code?: string }).code = "PARENT_INVALID";
      throw err;
    }
  }
  const maxPos = await prisma.tabulation.aggregate({
    where: {
      organizationId: orgId,
      departmentId: input.departmentId,
      parentId: input.parentId ?? null,
    },
    _max: { position: true },
  });
  const position = (maxPos._max.position ?? -1) + 1;
  let lastErr: unknown;
  for (let attempt = 0; attempt < TABULATION_NUMBER_MAX_RETRIES; attempt++) {
    try {
      const number = await nextTabulationNumber();
      return await prisma.tabulation.create({
        data: withOrgFromCtx({
          departmentId: input.departmentId,
          parentId: input.parentId ?? null,
          name: input.name.trim(),
          color: input.color ?? null,
          position,
          number,
        }),
      });
    } catch (err) {
      lastErr = err;
      if (!isTabulationNumberUniqueViolation(err)) throw err;
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error("Falha ao alocar number de tabulacao.");
}

export async function updateNode(
  id: string,
  patch: {
    name?: string;
    color?: string | null;
    parentId?: string | null;
    position?: number;
    active?: boolean;
  },
) {
  const orgId = orgIdOrThrow();
  const node = await prisma.tabulation.findFirst({
    where: { id, organizationId: orgId },
    select: { id: true, departmentId: true, parentId: true },
  });
  if (!node) {
    const err = new Error("Tabulacao nao encontrada.");
    (err as { code?: string }).code = "NOT_FOUND";
    throw err;
  }
  if (patch.parentId !== undefined && patch.parentId !== null) {
    if (patch.parentId === id) {
      const err = new Error("Uma tabulacao nao pode ser pai de si mesma.");
      (err as { code?: string }).code = "CYCLE";
      throw err;
    }
    const parent = await prisma.tabulation.findFirst({
      where: {
        id: patch.parentId,
        organizationId: orgId,
        departmentId: node.departmentId,
      },
      select: { id: true },
    });
    if (!parent) {
      const err = new Error("Pai invalido.");
      (err as { code?: string }).code = "PARENT_INVALID";
      throw err;
    }
    // Impedir mover um nó pra baixo de um descendente dele (ciclo).
    const ancestors = await getAncestors(patch.parentId);
    if (ancestors.includes(id)) {
      const err = new Error("Movimento formaria um ciclo.");
      (err as { code?: string }).code = "CYCLE";
      throw err;
    }
  }
  const data: Record<string, unknown> = {};
  if (typeof patch.name === "string" && patch.name.trim()) data.name = patch.name.trim();
  if (patch.color !== undefined) data.color = patch.color;
  if (patch.parentId !== undefined) data.parentId = patch.parentId;
  if (typeof patch.position === "number") data.position = patch.position;
  if (typeof patch.active === "boolean") data.active = patch.active;
  return prisma.tabulation.update({ where: { id }, data });
}

/* ─── Import/Export (CSV round-trip por id) ───────────────────────── */

export type FlatTabulationRow = {
  id: string;
  parentId: string;
  name: string;
  active: boolean;
  position: number;
  path: string;
};

export type FlatTabulationInput = {
  id?: string | null;
  parentId?: string | null;
  name: string;
  active?: boolean | null;
  position?: number | null;
};

/** Achata a árvore do departamento numa lista plana (com `path` legível). */
export async function exportFlat(departmentId: string): Promise<FlatTabulationRow[]> {
  const rows = await listByDepartment(departmentId);
  const byId = new Map(rows.map((r) => [r.id, r] as const));
  const pathOf = (start: (typeof rows)[number]): string => {
    const parts: string[] = [];
    const seen = new Set<string>();
    let cur: (typeof rows)[number] | undefined = start;
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      parts.unshift(cur.name);
      cur = cur.parentId ? byId.get(cur.parentId) : undefined;
    }
    return parts.join(" > ");
  };
  return rows.map((r) => ({
    id: r.id,
    parentId: r.parentId ?? "",
    name: r.name,
    active: r.active,
    position: r.position,
    path: pathOf(r),
  }));
}

/**
 * Importa/atualiza tabulações a partir de linhas planas (ex.: CSV exportado).
 *
 * Semântica (não-destrutiva — nunca apaga o que ficou de fora):
 *   - Linha com `id` que EXISTE no depto → atualiza (nome/ativo/pai/posição).
 *   - Linha sem `id` (ou id inexistente) → cria. `parentId` pode apontar
 *     para um id real OU para o id (temporário) de outra linha nova; a
 *     resolução é topológica (pais antes dos filhos).
 *   - Reparent respeita as validações de ciclo de `updateNode`.
 */
export async function importFlat(
  departmentId: string,
  rows: FlatTabulationInput[],
): Promise<{ created: number; updated: number; skipped: number }> {
  const orgId = orgIdOrThrow();
  const dept = await prisma.department.findFirst({
    where: { id: departmentId, organizationId: orgId },
    select: { id: true },
  });
  if (!dept) {
    const err = new Error("Departamento não encontrado.");
    (err as { code?: string }).code = "DEPT_NOT_FOUND";
    throw err;
  }

  const existing = await prisma.tabulation.findMany({
    where: { organizationId: orgId, departmentId },
    select: { id: true },
  });
  const existingIds = new Set(existing.map((e) => e.id));

  const idMap = new Map<string, string>(); // chave do CSV → id real
  const creates: FlatTabulationInput[] = [];
  const updates: FlatTabulationInput[] = [];
  for (const row of rows) {
    const rid = (row.id ?? "").trim();
    if (rid && existingIds.has(rid)) {
      idMap.set(rid, rid);
      updates.push(row);
    } else {
      creates.push(row);
    }
  }

  let created = 0;
  let updated = 0;
  let skipped = 0;

  // Criações com resolução topológica de pais.
  let pending = creates.slice();
  let guard = 0;
  while (pending.length > 0 && guard < 100000) {
    guard += 1;
    const next: FlatTabulationInput[] = [];
    let progressed = false;
    for (const row of pending) {
      const name = (row.name ?? "").trim();
      if (!name) {
        skipped += 1;
        continue;
      }
      const pRaw = (row.parentId ?? "").trim();
      let parentId: string | null = null;
      if (pRaw) {
        if (idMap.has(pRaw)) parentId = idMap.get(pRaw)!;
        else if (existingIds.has(pRaw)) parentId = pRaw;
        else {
          next.push(row); // pai ainda não resolvido nesta passada
          continue;
        }
      }
      const node = await createNode({ departmentId, parentId, name });
      existingIds.add(node.id);
      if (row.active === false) {
        await prisma.tabulation.update({ where: { id: node.id }, data: { active: false } });
      }
      const csvKey = (row.id ?? "").trim();
      if (csvKey) idMap.set(csvKey, node.id);
      created += 1;
      progressed = true;
    }
    pending = next;
    if (!progressed) break; // pais irresolvíveis → resto é ignorado
  }
  skipped += pending.length;

  // Atualizações (via updateNode, que valida ciclo/pai).
  for (const row of updates) {
    const rid = (row.id ?? "").trim();
    const patch: {
      name?: string;
      active?: boolean;
      position?: number;
      parentId?: string | null;
    } = {};
    const name = (row.name ?? "").trim();
    if (name) patch.name = name;
    if (typeof row.active === "boolean") patch.active = row.active;
    if (typeof row.position === "number") patch.position = row.position;
    const pRaw = (row.parentId ?? "").trim();
    if (pRaw) {
      const mapped = idMap.get(pRaw) ?? (existingIds.has(pRaw) ? pRaw : null);
      if (mapped && mapped !== rid) patch.parentId = mapped;
    } else {
      patch.parentId = null;
    }
    try {
      await updateNode(rid, patch);
      updated += 1;
    } catch {
      skipped += 1;
    }
  }

  return { created, updated, skipped };
}

export async function deleteNode(id: string) {
  const orgId = orgIdOrThrow();
  const node = await prisma.tabulation.findFirst({
    where: { id, organizationId: orgId },
    select: { id: true },
  });
  if (!node) {
    const err = new Error("Tabulacao nao encontrada.");
    (err as { code?: string }).code = "NOT_FOUND";
    throw err;
  }
  // Cascade por FK. Conversation.tabulationId -> SET NULL preserva historico.
  await prisma.tabulation.delete({ where: { id } });
}
