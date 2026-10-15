/**
 * PUT /api/deals/:id/custom-fields — caminhos que davam 500 (gate de carga,
 * item F; 7 ocorrências em produção em 15/10 às 15h).
 *
 * Banco falso em memória. O upsert imita o do Prisma SEM o modo nativo (a
 * extensão de org junta `organizationId` ao `where`): lê, espera uma volta
 * do event loop e insere — dois salvamentos simultâneos do mesmo campo sem
 * valor colidem no `@@unique([dealId, customFieldId])` (P2002).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Field = { id: string; name: string; label: string; entity: string; type: string };
type Op = () => Promise<unknown>;

const h = vi.hoisted(() => ({
  fields: [] as Array<{ id: string; name: string; label: string; entity: string; type: string }>,
  rows: new Map<string, string>(),
  deal: { id: "deal_1" } as { id: string } | null,
  upserts: 0,
  /** Próximas N tentativas de upsert lançam este erro. */
  failNext: [] as unknown[],
  log: { warn: [] as unknown[][], error: [] as unknown[][] },
  events: [] as unknown[],
}));

const key = (dealId: string, fieldId: string) => `${dealId}|${fieldId}`;

vi.mock("@/lib/logger", () => ({
  getLogger: () => ({
    warn: (...a: unknown[]) => h.log.warn.push(a),
    error: (...a: unknown[]) => h.log.error.push(a),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));
vi.mock("@/lib/api-auth", () => ({
  authenticateApiRequest: async () => ({ ok: true, user: { id: "u1", organizationId: "org1", role: "ADMIN" } }),
  runWithApiUserContext: (_u: unknown, fn: () => unknown) => fn(),
}));
vi.mock("@/lib/authz/resource-policy", () => ({
  requirePermissionForUser: async () => null,
  canEditFieldForUser: async () => true,
  loadScopedPolicy: async () => ({ enabled: false, grants: [] }),
}));
vi.mock("@/lib/authz/scope-grants", () => ({ canAccessField: () => true }));
vi.mock("@/services/deals", () => ({
  getDealById: async () => h.deal,
  createDealEvent: async (...a: unknown[]) => {
    h.events.push(a);
  },
}));
vi.mock("@/lib/prisma-helpers", () => ({
  withOrgFromCtx: <T,>(d: T) => ({ ...d, organizationId: "org1" }),
}));
vi.mock("@/lib/prisma-base", () => ({ prismaBase: {} }));
vi.mock("@/lib/request-context", () => ({ getRequestContext: () => ({ organizationId: "org1" }) }));
vi.mock("@/lib/cache/response-families", () => ({
  bumpResponseFamilies: vi.fn(),
  RESPONSE_FAMILIES: {},
}));
vi.mock("@/lib/prisma", () => {
  const tick = () => new Promise((r) => setImmediate(r));
  return {
    prisma: {
      customField: {
        findMany: async (args: { where: { id?: { in: string[] }; entity?: string } }) => {
          if (args.where.id) return h.fields.filter((f: Field) => args.where.id!.in.includes(f.id));
          return h.fields
            .filter((f: Field) => f.entity === args.where.entity)
            .map((f: Field) => {
              const v = h.rows.get(`deal_1|${f.id}`);
              return {
                ...f,
                options: [],
                required: false,
                highlightRules: null,
                dealValues: v === undefined ? [] : [{ value: v }],
              };
            });
        },
      },
      dealCustomFieldValue: {
        findMany: async (args: { where: { dealId: string; customFieldId: { in: string[] } } }) =>
          args.where.customFieldId.in
            .filter((fid) => h.rows.has(`${args.where.dealId}|${fid}`))
            .map((fid) => ({ customFieldId: fid, value: h.rows.get(`${args.where.dealId}|${fid}`)! })),
        upsert: (args: {
          where: { dealId_customFieldId: { dealId: string; customFieldId: string } };
          update: { value: string };
          create: { value: string };
        }): Op => async () => {
          h.upserts++;
          const fail = h.failNext.shift();
          if (fail) throw fail;
          const { dealId, customFieldId } = args.where.dealId_customFieldId;
          const k = `${dealId}|${customFieldId}`;
          const existed = h.rows.has(k); // leitura
          await tick(); // outra requisição pode inserir aqui
          if (existed) {
            h.rows.set(k, args.update.value);
          } else {
            if (h.rows.has(k)) {
              throw Object.assign(new Error("Unique constraint failed on the fields: (`dealId`,`customFieldId`)"), {
                code: "P2002",
                meta: { target: ["dealId", "customFieldId"], modelName: "DealCustomFieldValue" },
              });
            }
            h.rows.set(k, args.create.value);
          }
          return { value: h.rows.get(k) };
        },
      },
      $transaction: async (ops: Op[]) => {
        const out = [];
        for (const op of ops) out.push(await op());
        return out;
      },
    },
  };
});

import { PUT } from "./route";

function put(body: unknown, raw = false): Promise<Response> {
  return PUT(
    new Request("https://api.test/api/deals/deal_1/custom-fields", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: raw ? (body as string) : JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: "deal_1" }) },
  );
}

const prismaError = (code: string, message = `prisma ${code}`) =>
  Object.assign(new Error(message), { code, meta: { modelName: "DealCustomFieldValue" } });

beforeEach(() => {
  h.fields = [
    { id: "f_cpf", name: "cpf", label: "CPF", entity: "deal", type: "TEXT" },
    { id: "f_valor", name: "valor", label: "Valor", entity: "deal", type: "NUMBER" },
    { id: "f_contato", name: "apelido", label: "Apelido", entity: "contact", type: "TEXT" },
  ];
  h.rows.clear();
  h.deal = { id: "deal_1" };
  h.upserts = 0;
  h.failNext = [];
  h.log.warn = [];
  h.log.error = [];
  h.events = [];
});

describe("PUT /api/deals/:id/custom-fields — sucesso (regressão)", () => {
  it("grava, devolve a lista e registra o evento", async () => {
    const res = await put({ values: [{ fieldId: "f_cpf", value: "123" }] });
    expect(res.status).toBe(200);
    const json = (await res.json()) as Array<{ fieldId: string; value: string | null }>;
    expect(json.find((f) => f.fieldId === "f_cpf")?.value).toBe("123");
    expect(h.rows.get(key("deal_1", "f_cpf"))).toBe("123");
    expect(h.events).toHaveLength(1);
  });

  it("vazio limpa (allowBlank do editor)", async () => {
    h.rows.set(key("deal_1", "f_cpf"), "123");
    expect((await put({ values: [{ fieldId: "f_cpf", value: "" }] })).status).toBe(200);
    expect(h.rows.get(key("deal_1", "f_cpf"))).toBe("");
  });

  it("campo repetido no corpo: o último vence, um upsert só; NUL é removido", async () => {
    const res = await put({
      values: [
        { fieldId: "f_cpf", value: "primeiro" },
        { fieldId: "f_cpf", value: "seg\u0000undo" },
      ],
    });
    expect(res.status).toBe(200);
    expect(h.upserts).toBe(1);
    expect(h.rows.get(key("deal_1", "f_cpf"))).toBe("segundo");
  });

  it("negócio inexistente → 404", async () => {
    h.deal = null;
    expect((await put({ values: [{ fieldId: "f_cpf", value: "1" }] })).status).toBe(404);
  });
});

describe("erros do cliente viram 4xx (antes 500)", () => {
  it("JSON inválido → 400 INVALID_JSON, sem escrita", async () => {
    const res = await put("{values: [", true);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "INVALID_JSON" });
    expect(h.upserts).toBe(0);
  });

  it("corpo null ou `values` que não é lista → 400 INVALID_BODY", async () => {
    expect((await put(null)).status).toBe(400);
    const res = await put({ values: "f_cpf=1" });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "INVALID_BODY" });
  });

  it("campo apagado (ou de outra org: a consulta é escopada) → 422 CUSTOM_FIELD_NOT_FOUND, sem escrita", async () => {
    const res = await put({ values: [{ fieldId: "f_apagado", value: "x" }, { fieldId: "f_cpf", value: "1" }] });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: "CUSTOM_FIELD_NOT_FOUND", fieldIds: ["f_apagado"] });
    expect(h.upserts).toBe(0);
  });

  it("campo de contato no negócio → 422 CUSTOM_FIELD_WRONG_ENTITY", async () => {
    const res = await put({ values: [{ fieldId: "f_contato", value: "x" }] });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ code: "CUSTOM_FIELD_WRONG_ENTITY", fieldIds: ["f_contato"] });
  });
});

describe("corrida de upsert concorrente (P2002)", () => {
  it("dois PUT simultâneos no mesmo campo ainda sem valor → os dois 200; o último vence", async () => {
    const [a, b] = await Promise.all([
      put({ values: [{ fieldId: "f_valor", value: "100" }] }),
      put({ values: [{ fieldId: "f_valor", value: "200" }] }),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    // Um inseriu; o outro colidiu (P2002) e repetiu como UPDATE.
    expect(h.upserts).toBe(3);
    expect(["100", "200"]).toContain(h.rows.get(key("deal_1", "f_valor")));
    expect(h.log.error).toHaveLength(0);
  });

  it("P2002 na 1ª tentativa (automação gravando o mesmo campo) → repete e grava", async () => {
    h.failNext = [prismaError("P2002")];
    const res = await put({ values: [{ fieldId: "f_valor", value: "300" }] });
    expect(res.status).toBe(200);
    expect(h.rows.get(key("deal_1", "f_valor"))).toBe("300");
  });

  it("P2002 de novo na 2ª tentativa → 409 CONCURRENT_UPDATE com log estruturado", async () => {
    h.failNext = [prismaError("P2002"), prismaError("P2002")];
    const res = await put({ values: [{ fieldId: "f_cpf", value: "529.982.247-25" }] });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "CONCURRENT_UPDATE" });
    expect(h.log.warn).toHaveLength(1);
    expect(h.log.warn[0]![0]).toMatchObject({ code: "P2002", dealId: "deal_1", fieldIds: ["f_cpf"] });
    // Nunca o valor (dado pessoal) no log.
    expect(JSON.stringify(h.log)).not.toContain("529.982.247-25");
  });
});

describe("erros do servidor: resposta clara + log com `code`", () => {
  it("P2003 / P2025 (negócio ou campo apagado no meio) → 409 DELETED_DURING_SAVE", async () => {
    for (const code of ["P2003", "P2025"]) {
      h.failNext = [prismaError(code)];
      const res = await put({ values: [{ fieldId: "f_cpf", value: "1" }] });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: "DELETED_DURING_SAVE" });
    }
    expect(h.log.warn.map((c) => (c[0] as { code: string }).code)).toEqual(["P2003", "P2025"]);
  });

  it("pool esgotado / transação vencida (P2024, P2028) → 503 com Retry-After e log.error com code", async () => {
    for (const code of ["P2024", "P2028"]) {
      h.failNext = [prismaError(code, "Timed out fetching a new connection from the connection pool.")];
      const res = await put({ values: [{ fieldId: "f_cpf", value: "1" }] });
      expect(res.status).toBe(503);
      expect(res.headers.get("Retry-After")).toBe("5");
      expect(await res.json()).toMatchObject({ code: "DB_BUSY" });
    }
    expect(h.log.error.map((c) => (c[0] as { code: string }).code)).toEqual(["P2024", "P2028"]);
  });

  it("erro desconhecido → 500 genérico (sem vazar a mensagem do Prisma), log.error com fieldIds e sem valores", async () => {
    h.failNext = [new Error("invalid byte sequence for encoding \"UTF8\": 0x00 — Invalid `prisma.dealCustomFieldValue.upsert()`")];
    const res = await put({ values: [{ fieldId: "f_cpf", value: "Maria da Silva" }] });
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ message: "Erro ao salvar campos personalizados." });
    expect(h.log.error).toHaveLength(1);
    expect(h.log.error[0]![0]).toMatchObject({
      route: "PUT /api/deals/:id/custom-fields",
      code: null,
      dealId: "deal_1",
      fieldIds: ["f_cpf"],
    });
    expect(JSON.stringify(h.log)).not.toContain("Maria da Silva");
  });
});
