/**
 * Banco em memória mínimo para testes que precisam de `where` de verdade
 * (autorização de conversa, contagem de consultas). Não é um Prisma: cobre
 * só os operadores usados nas rotas do inbox e LANÇA em operador
 * desconhecido — um teste nunca passa porque o filtro foi ignorado.
 *
 * Tabelas são arrays de objetos simples; relações são declaradas em
 * `relations` e resolvidas sob demanda (sem ciclos materializados).
 */

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;

export type RelationDef =
  | { kind: "one"; table: string; localKey: string; foreignKey?: string }
  | { kind: "many"; table: string; foreignKey: string; localKey?: string };

export type FakeDbSchema = Record<string, Record<string, RelationDef>>;

const SCALAR_OPS = new Set([
  "equals",
  "in",
  "notIn",
  "not",
  "lt",
  "lte",
  "gt",
  "gte",
  "startsWith",
  "contains",
  "mode",
]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v) && !(v instanceof Date);
}

function comparable(v: unknown): unknown {
  return v instanceof Date ? v.getTime() : v;
}

function scalarEquals(a: unknown, b: unknown, insensitive: boolean): boolean {
  if (insensitive && typeof a === "string" && typeof b === "string") {
    return a.toLowerCase() === b.toLowerCase();
  }
  return comparable(a ?? null) === comparable(b ?? null);
}

function matchScalar(value: unknown, filter: unknown): boolean {
  if (!isPlainObject(filter)) return scalarEquals(value, filter, false);
  const insensitive = filter.mode === "insensitive";
  for (const [op, arg] of Object.entries(filter)) {
    if (!SCALAR_OPS.has(op)) {
      throw new Error(`[fake-db] operador escalar desconhecido: ${op}`);
    }
    switch (op) {
      case "mode":
        break;
      case "equals":
        if (!scalarEquals(value, arg, insensitive)) return false;
        break;
      case "in":
        if (value === null || value === undefined) return false;
        if (!(arg as unknown[]).some((x) => scalarEquals(value, x, insensitive))) return false;
        break;
      case "notIn":
        // SQL: NULL NOT IN (...) não é verdadeiro.
        if (value === null || value === undefined) return false;
        if ((arg as unknown[]).some((x) => scalarEquals(value, x, insensitive))) return false;
        break;
      case "not":
        if (isPlainObject(arg)) {
          if (matchScalar(value, arg)) return false;
        } else if (arg === null) {
          if (value === null || value === undefined) return false;
        } else {
          // SQL: `col <> x` com col NULL não é verdadeiro.
          if (value === null || value === undefined) return false;
          if (scalarEquals(value, arg, insensitive)) return false;
        }
        break;
      case "lt":
      case "lte":
      case "gt":
      case "gte": {
        if (value === null || value === undefined) return false;
        const a = comparable(value) as number;
        const b = comparable(arg) as number;
        if (op === "lt" && !(a < b)) return false;
        if (op === "lte" && !(a <= b)) return false;
        if (op === "gt" && !(a > b)) return false;
        if (op === "gte" && !(a >= b)) return false;
        break;
      }
      case "startsWith":
        if (typeof value !== "string" || !value.startsWith(String(arg))) return false;
        break;
      case "contains":
        if (typeof value !== "string" || !value.includes(String(arg))) return false;
        break;
    }
  }
  return true;
}

export class FakeDb {
  readonly tables: Record<string, Row[]> = {};

  constructor(private readonly schema: FakeDbSchema) {}

  table(name: string): Row[] {
    return (this.tables[name] ??= []);
  }

  insert(name: string, ...rows: Row[]): void {
    this.table(name).push(...rows);
  }

  private related(model: string, row: Row, key: string): Row | Row[] | null | undefined {
    const def = this.schema[model]?.[key];
    if (!def) return undefined;
    if (def.kind === "one") {
      const fk = row[def.localKey];
      if (fk === null || fk === undefined) return null;
      return this.table(def.table).find((r) => r[def.foreignKey ?? "id"] === fk) ?? null;
    }
    const local = row[def.localKey ?? "id"];
    return this.table(def.table).filter((r) => r[def.foreignKey] === local);
  }

  matches(model: string, row: Row, where: Where | null | undefined): boolean {
    if (!where) return true;
    for (const [key, cond] of Object.entries(where)) {
      if (cond === undefined) continue;
      if (key === "AND") {
        const parts = Array.isArray(cond) ? cond : [cond];
        if (!parts.every((p) => this.matches(model, row, p as Where))) return false;
        continue;
      }
      if (key === "OR") {
        if (!(cond as Where[]).some((p) => this.matches(model, row, p))) return false;
        continue;
      }
      if (key === "NOT") {
        const parts = Array.isArray(cond) ? cond : [cond];
        if (parts.some((p) => this.matches(model, row, p as Where))) return false;
        continue;
      }
      const def = this.schema[model]?.[key];
      if (def) {
        if (!this.matchRelation(model, row, key, def, cond)) return false;
        continue;
      }
      // Chave única composta (`organizationId_number: { organizationId, number }`).
      if (key.includes("_") && isPlainObject(cond) && !(key in row)) {
        const parts = key.split("_");
        if (parts.every((p) => p in cond)) {
          if (!parts.every((p) => scalarEquals(row[p], cond[p], false))) return false;
          continue;
        }
      }
      if (!matchScalar(row[key], cond)) return false;
    }
    return true;
  }

  private matchRelation(
    model: string,
    row: Row,
    key: string,
    def: RelationDef,
    cond: unknown,
  ): boolean {
    const target = this.related(model, row, key);
    if (def.kind === "many") {
      const list = (target as Row[]) ?? [];
      if (!isPlainObject(cond)) throw new Error(`[fake-db] filtro inválido em ${model}.${key}`);
      for (const [op, sub] of Object.entries(cond)) {
        const hit = (r: Row) => this.matches(def.table, r, sub as Where);
        if (op === "some") {
          if (!list.some(hit)) return false;
        } else if (op === "none") {
          if (list.some(hit)) return false;
        } else if (op === "every") {
          if (!list.every(hit)) return false;
        } else {
          throw new Error(`[fake-db] operador de lista desconhecido em ${model}.${key}: ${op}`);
        }
      }
      return true;
    }
    const one = target as Row | null;
    if (cond === null) return one === null;
    if (!isPlainObject(cond)) throw new Error(`[fake-db] filtro inválido em ${model}.${key}`);
    if ("is" in cond || "isNot" in cond) {
      if ("is" in cond) {
        if (cond.is === null) {
          if (one !== null) return false;
        } else if (!one || !this.matches(def.table, one, cond.is as Where)) {
          return false;
        }
      }
      if ("isNot" in cond) {
        if (cond.isNot === null) {
          if (one === null) return false;
        } else if (one && this.matches(def.table, one, cond.isNot as Where)) {
          return false;
        }
      }
      return true;
    }
    return one !== null && this.matches(def.table, one, cond);
  }

  private project(model: string, row: Row, select: unknown): Row {
    if (!isPlainObject(select)) return { ...row };
    const out: Row = {};
    for (const [key, spec] of Object.entries(select)) {
      if (!spec) continue;
      const def = this.schema[model]?.[key];
      if (!def) {
        out[key] = row[key] ?? null;
        continue;
      }
      const target = this.related(model, row, key);
      const nested = isPlainObject(spec) ? spec : {};
      if (def.kind === "many") {
        out[key] = this.query(def.table, (target as Row[]) ?? [], nested);
      } else {
        out[key] = target ? this.project(def.table, target as Row, nested.select) : null;
      }
    }
    return out;
  }

  private query(model: string, rows: Row[], args: Record<string, unknown>): Row[] {
    let list = rows.filter((r) => this.matches(model, r, args.where as Where));
    const orderBy = args.orderBy
      ? Array.isArray(args.orderBy)
        ? (args.orderBy as Record<string, "asc" | "desc">[])
        : [args.orderBy as Record<string, "asc" | "desc">]
      : [];
    if (orderBy.length > 0) {
      list = [...list].sort((a, b) => {
        for (const o of orderBy) {
          const [field, dir] = Object.entries(o)[0]!;
          const x = comparable(a[field]) as number | string;
          const y = comparable(b[field]) as number | string;
          if (x === y) continue;
          const cmp = x < y ? -1 : 1;
          return dir === "desc" ? -cmp : cmp;
        }
        return 0;
      });
    }
    if (typeof args.take === "number") list = list.slice(0, args.take);
    return list.map((r) => this.project(model, r, args.select));
  }

  /** Executa uma operação de leitura no estilo Prisma. */
  run(model: string, operation: string, rawArgs: unknown): unknown {
    const args = (rawArgs ?? {}) as Record<string, unknown>;
    const rows = this.table(model);
    switch (operation) {
      case "findMany":
        return this.query(model, rows, args);
      case "findFirst":
      case "findUnique":
        return this.query(model, rows, { ...args, take: 1 })[0] ?? null;
      case "count":
        return rows.filter((r) => this.matches(model, r, args.where as Where)).length;
      default:
        return undefined;
    }
  }
}

/** Relações usadas pelas rotas do inbox. */
export const INBOX_SCHEMA: FakeDbSchema = {
  conversation: {
    contact: { kind: "one", table: "contact", localKey: "contactId" },
    assignedTo: { kind: "one", table: "user", localKey: "assignedToId" },
    channelRef: { kind: "one", table: "channel", localKey: "channelId" },
    messages: { kind: "many", table: "message", foreignKey: "conversationId" },
  },
  contact: {
    deals: { kind: "many", table: "deal", foreignKey: "contactId" },
    conversations: { kind: "many", table: "conversation", foreignKey: "contactId" },
    automationContexts: { kind: "many", table: "automationContext", foreignKey: "contactId" },
  },
  deal: {
    stage: { kind: "one", table: "stage", localKey: "stageId" },
    contact: { kind: "one", table: "contact", localKey: "contactId" },
  },
  message: {
    conversation: { kind: "one", table: "conversation", localKey: "conversationId" },
  },
  pinnedMessage: {
    message: { kind: "one", table: "message", localKey: "messageId" },
  },
  userRoleAssignment: {
    role: { kind: "one", table: "role", localKey: "roleId" },
  },
  role: {
    stageGrants: { kind: "many", table: "roleStageGrant", foreignKey: "roleId" },
    pipelineGrants: { kind: "many", table: "rolePipelineGrant", foreignKey: "roleId" },
    fieldGrants: { kind: "many", table: "roleFieldGrant", foreignKey: "roleId" },
  },
  activityEvent: {
    actorUser: { kind: "one", table: "user", localKey: "actorUserId" },
  },
};
