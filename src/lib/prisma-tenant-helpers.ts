/**
 * Helpers puros (sem dependencia de Prisma engine) usados pela extension
 * de organization-scope em @/lib/prisma. Extraidos pra modulo separado
 * pra serem testaveis sem precisar de DB rodando.
 *
 * Contrato (Fase 1 — isolamento):
 *   - mergeWhere(existing, orgId) preserva o where original e acrescenta
 *     `{ organizationId: orgId }` via AND externo. Filtro divergente
 *     retorna vazio; nunca substitui o organizationId do caller.
 *   - Seletores únicos (`id`, compostos `foo_bar`) sobem ao topo para
 *     findUnique / update / delete / upsert continuarem WhereUniqueInput.
 *   - deepInjectOrgId injeta organizationId do contexto. organizationId
 *     (ou organization.connect.id) divergente nas escritas LANÇA
 *     TenantIsolationError — não reescreve em silêncio.
 */

const LOGICAL_KEYS = new Set(["AND", "OR", "NOT"]);

export class TenantIsolationError extends Error {
  constructor(
    message = "Operação recusada: organizationId divergente do contexto autenticado.",
  ) {
    super(message);
    this.name = "TenantIsolationError";
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** organizationId scalar ou `{ equals }` extraído do where/data. */
export function extractOrgIdConstraint(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (isPlainObject(value) && typeof value.equals === "string") {
    return value.equals;
  }
  return undefined;
}

export function assertWritableOrgId(value: unknown, orgId: string): void {
  if (value === undefined || value === null) return;
  if (typeof value === "string") {
    if (value !== orgId) throw new TenantIsolationError();
    return;
  }
  if (!isPlainObject(value)) return;
  if (typeof value.equals === "string" && value.equals !== orgId) {
    throw new TenantIsolationError();
  }
  const connect = value.connect;
  if (isPlainObject(connect) && typeof connect.id === "string") {
    if (connect.id !== orgId) throw new TenantIsolationError();
  }
}

export function assertUniqueWhereOrg(where: unknown, orgId: string): void {
  if (!where || typeof where !== "object" || Array.isArray(where)) return;
  for (const value of Object.values(where as Record<string, unknown>)) {
    if (!isPlainObject(value)) continue;
    if (
      typeof value.organizationId === "string" &&
      value.organizationId !== orgId
    ) {
      throw new TenantIsolationError();
    }
  }
}

/**
 * Preserva `existing` e exige a org autenticada por AND externo.
 * Filtros divergentes não vazam: AND(org B, org A) é vazio.
 */
export function mergeWhere(
  existing: unknown,
  orgId: string,
): Record<string, unknown> {
  const sessionConstraint = { organizationId: orgId };
  if (!existing || typeof existing !== "object" || Array.isArray(existing)) {
    return sessionConstraint;
  }
  const original = existing as Record<string, unknown>;
  const lifted: Record<string, unknown> = {};
  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(original)) {
    if (LOGICAL_KEYS.has(key)) {
      rest[key] = value;
      continue;
    }
    if (key === "organizationId") {
      rest[key] = value;
      continue;
    }
    // Compound @@unique (`foo_bar`) só é válido em WhereUniqueInput no topo —
    // não pode ir para AND (WhereInput). `id` e scalars unique também sobem.
    if (key === "id" || key.includes("_")) {
      lifted[key] = value;
      if (key === "id") rest[key] = value;
      continue;
    }
    lifted[key] = value;
    rest[key] = value;
  }
  const andClause = Object.keys(rest).length
    ? [rest, sessionConstraint]
    : [sessionConstraint];
  return {
    ...lifted,
    AND: andClause,
  };
}

export function mergeData(
  existing: unknown,
  orgId: string,
): Record<string, unknown> {
  if (!existing || typeof existing !== "object") {
    return { organization: { connect: { id: orgId } } };
  }
  const d = existing as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(d, "organizationId")) {
    assertWritableOrgId(d.organizationId, orgId);
    return d;
  }
  if (Object.prototype.hasOwnProperty.call(d, "organization")) {
    assertWritableOrgId(d.organization, orgId);
    return d;
  }
  return { ...d, organization: { connect: { id: orgId } } };
}

export function deepInjectOrgId(value: unknown, orgId: string): unknown {
  if (!value || typeof value !== "object") return value;
  if (Array.isArray(value)) {
    return value.map((item) => deepInjectOrgId(item, orgId));
  }
  const src = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  let seenOrgId = false;
  let seenOrganization = false;

  for (const [key, v] of Object.entries(src)) {
    if (key === "organizationId") {
      seenOrgId = true;
      assertWritableOrgId(v, orgId);
      out[key] = v;
      continue;
    }
    if (key === "organization") {
      seenOrganization = true;
      assertWritableOrgId(v, orgId);
      out[key] = v;
      continue;
    }
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const relW = v as Record<string, unknown>;
      const isRelationWrap =
        "create" in relW ||
        "createMany" in relW ||
        "connectOrCreate" in relW ||
        "upsert" in relW ||
        "update" in relW ||
        "updateMany" in relW;
      if (isRelationWrap) {
        const processed: Record<string, unknown> = { ...relW };
        if (processed.create !== undefined) {
          processed.create = deepInjectOrgId(processed.create, orgId);
        }
        if (
          processed.createMany &&
          typeof processed.createMany === "object"
        ) {
          const cm = { ...(processed.createMany as Record<string, unknown>) };
          if (cm.data !== undefined) {
            cm.data = deepInjectOrgId(cm.data, orgId);
          }
          processed.createMany = cm;
        }
        if (processed.connectOrCreate !== undefined) {
          const apply = (c: unknown): unknown => {
            if (!c || typeof c !== "object") return c;
            const co = { ...(c as Record<string, unknown>) };
            if (co.where !== undefined) {
              co.where = mergeWhere(co.where, orgId);
            }
            if (co.create !== undefined) {
              co.create = deepInjectOrgId(co.create, orgId);
            }
            return co;
          };
          processed.connectOrCreate = Array.isArray(processed.connectOrCreate)
            ? processed.connectOrCreate.map(apply)
            : apply(processed.connectOrCreate);
        }
        if (processed.upsert !== undefined) {
          const apply = (u: unknown): unknown => {
            if (!u || typeof u !== "object") return u;
            const uo = { ...(u as Record<string, unknown>) };
            if (uo.where !== undefined) {
              uo.where = mergeWhere(uo.where, orgId);
            }
            if (uo.create !== undefined) {
              uo.create = deepInjectOrgId(uo.create, orgId);
            }
            if (uo.update !== undefined) {
              uo.update = deepInjectOrgId(uo.update, orgId);
            }
            return uo;
          };
          processed.upsert = Array.isArray(processed.upsert)
            ? processed.upsert.map(apply)
            : apply(processed.upsert);
        }
        if (processed.update !== undefined) {
          const apply = (u: unknown): unknown => {
            if (!u || typeof u !== "object") return u;
            const uo = u as Record<string, unknown>;
            if (uo.data !== undefined) {
              return { ...uo, data: deepInjectOrgId(uo.data, orgId) };
            }
            return deepInjectOrgId(uo, orgId);
          };
          processed.update = Array.isArray(processed.update)
            ? processed.update.map(apply)
            : apply(processed.update);
        }
        if (processed.updateMany !== undefined) {
          const apply = (u: unknown): unknown => {
            if (!u || typeof u !== "object") return u;
            const uo = { ...(u as Record<string, unknown>) };
            if (uo.where !== undefined) {
              uo.where = mergeWhere(uo.where, orgId);
            }
            if (uo.data !== undefined) {
              uo.data = deepInjectOrgId(uo.data, orgId);
            }
            return uo;
          };
          processed.updateMany = Array.isArray(processed.updateMany)
            ? processed.updateMany.map(apply)
            : apply(processed.updateMany);
        }
        out[key] = processed;
        continue;
      }
    }
    out[key] = v;
  }
  // connect/disconnect/set = input "checked". Injetar organizationId
  // (unchecked) no mesmo objeto faz o Prisma rejeitar o write
  // (ex.: contact.update com company: { connect } → 500 genérico).
  const hasCheckedRelationOp = Object.values(src).some((v) => {
    if (!v || typeof v !== "object" || Array.isArray(v)) return false;
    const r = v as Record<string, unknown>;
    return "connect" in r || "disconnect" in r || "set" in r;
  });
  if (!seenOrgId && !seenOrganization && !hasCheckedRelationOp) {
    out.organizationId = orgId;
  }
  return out;
}
