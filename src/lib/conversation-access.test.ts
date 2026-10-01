/**
 * Veredito de acesso a uma conversa (`userHasConversationAccess`) — tabela
 * congelada ANTES da reescrita do P-10.
 *
 * Cada cenário monta uma org em memória (`@/test-setup/inbox-fixture`), com
 * `where` avaliado de verdade, e confere o veredito de 4 usuários × 7
 * conversas. A tabela `ESPERADO` foi gerada com a implementação anterior
 * (uma consulta por checagem, em série) e não muda com a deduplicação: se
 * uma checagem sumir ou afrouxar, algum `false` vira `true` aqui.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  delete process.env.REDIS_URL;
  delete process.env.FEATURE_FLAG_RBAC_GRANULAR_SCOPE_V1;
});

vi.mock("@/lib/prisma-base", async () => {
  const { probe } = await import("@/test-setup/io-probe");
  return {
    prismaBase: probe.prisma,
    isPgPoolTimeoutError: () => false,
    withPgPoolRetry: (fn: () => unknown) => fn(),
  };
});
vi.mock("@/lib/prisma", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/prisma")>();
  const { probe } = await import("@/test-setup/io-probe");
  const { getRequestContext } = await import("@/lib/request-context");
  const { SCOPED_FIXTURE_MODELS } = await import("@/test-setup/inbox-fixture");
  return { ...actual, prisma: probe.scoped(SCOPED_FIXTURE_MODELS, getRequestContext) };
});

import type { AppUserRole } from "@/lib/auth-types";
import { cache } from "@/lib/cache";
import {
  requireConversationAccess,
  resolveConversationId,
  userHasConversationAccess,
} from "@/lib/conversation-access";
import { runWithContext } from "@/lib/request-context";
import type { FakeDb } from "@/test-setup/fake-db";
import {
  CONV,
  ORG,
  seedInbox,
  USERS,
  type FixtureUserKey,
  type SeedOptions,
} from "@/test-setup/inbox-fixture";
import { probe } from "@/test-setup/io-probe";

const USER_KEYS: FixtureUserKey[] = ["member", "other", "manager", "admin"];
const CONV_KEYS = ["mine", "others", "queue", "resolved", "dealOwner", "foreign", "missing"] as const;
type ConvKey = (typeof CONV_KEYS)[number];
const CONV_IDS: Record<ConvKey, string> = { ...CONV, missing: "conv_nao_existe" };

const QUEUE_PERMS = ["conversation:view", "conversation:reply", "conversation:claim", "inbox:tab:entrada"];

function setRole(db: FakeDb, roleId: string, patch: Record<string, unknown>) {
  const role = db.table("role").find((r) => r.id === roleId);
  if (!role) throw new Error(`papel ${roleId} não existe no fixture`);
  Object.assign(role, patch);
}

const SCENARIOS: Record<string, SeedOptions> = {
  "padrão (flag de escopo desligada)": {},
  "flag ligada, operador com canal ch_1 liberado por papel": {
    rbacFlag: true,
    scopeGrants: { channel: { view: { roles: { role_member: ["ch_1"] } } } },
  },
  "flag ligada, operador só enxerga o canal ch_2": {
    rbacFlag: true,
    scopeGrants: { channel: { view: { roles: { role_member: ["ch_2"] } } } },
  },
  "flag ligada, gestor vê ch_1 e ch_2 mas ch_1 está negado a ele": {
    rbacFlag: true,
    scopeGrants: {
      channel: {
        view: { users: { [USERS.manager.id]: ["ch_1", "ch_2"] } },
        deny: { users: { [USERS.manager.id]: ["ch_1"] } },
      },
    },
  },
  "flag ligada, gestor só enxerga o canal ch_2 (por papel)": {
    rbacFlag: true,
    scopeGrants: { channel: { view: { roles: { role_manager: ["ch_2"] } } } },
  },
  "visibility.MEMBER = all, flag ligada, operador só enxerga o canal ch_2": {
    rbacFlag: true,
    scopeGrants: { channel: { view: { roles: { role_member: ["ch_2"] } } } },
    settings: { "visibility.MEMBER": "all" },
  },
  "visibility.MEMBER = all, flag ligada, canal ch_1 liberado, conversa de outro sem canal": {
    rbacFlag: true,
    scopeGrants: { channel: { view: { roles: { role_member: ["ch_1"] } } } },
    settings: { "visibility.MEMBER": "all" },
    mutate: (db) => {
      const conv = db.table("conversation").find((c) => c.id === CONV.others);
      if (conv) conv.channelId = null;
    },
  },
  "canal negado no JSON, mas flag desligada": {
    rbacFlag: false,
    scopeGrants: { channel: { view: { roles: { role_member: ["ch_2"] } } } },
  },
  "operador com fila de entrada (inbox:tab:entrada + claim) e pool livre": {
    memberPermissions: QUEUE_PERMS,
    settings: { "unassigned.MEMBER": "true" },
  },
  "operador com fila de entrada, mas sem ver o pool livre": {
    memberPermissions: QUEUE_PERMS,
  },
  "visibility.MEMBER = all": {
    settings: { "visibility.MEMBER": "all" },
  },
  "visibility.MEMBER = all + pool livre": {
    settings: { "visibility.MEMBER": "all", "unassigned.MEMBER": "true" },
  },
  "visibility.MANAGER = own": {
    settings: { "visibility.MANAGER": "own" },
  },
  "visibility.MANAGER = own, flag ligada, papel sem caixa compartilhada": {
    rbacFlag: true,
    settings: { "visibility.MANAGER": "own" },
    mutate: (db) => setRole(db, "role_manager", { sharedInbox: false }),
  },
  "visibility.MANAGER = own sem pool livre; o contato da fila é do gestor": {
    settings: { "visibility.MANAGER": "own", "unassigned.MANAGER": "false" },
    mutate: (db) => {
      const contact = db.table("contact").find((c) => c.id === "ct_3");
      if (contact) contact.assignedToId = USERS.manager.id;
    },
  },
  "idem, com flag ligada e papel sem caixa compartilhada (own estrito)": {
    rbacFlag: true,
    settings: { "visibility.MANAGER": "own", "unassigned.MANAGER": "false" },
    mutate: (db) => {
      const contact = db.table("contact").find((c) => c.id === "ct_3");
      if (contact) contact.assignedToId = USERS.manager.id;
      setRole(db, "role_manager", { sharedInbox: false });
    },
  },
  "gestor sem pool livre (unassigned.MANAGER = false)": {
    settings: { "unassigned.MANAGER": "false" },
  },
  "papel do operador com seeTeam": {
    mutate: (db) => setRole(db, "role_member", { seeTeam: true }),
  },
  "papel do operador com seeTeam + seeUnassigned": {
    mutate: (db) => setRole(db, "role_member", { seeTeam: true, seeUnassigned: true }),
  },
  "gestor restrito ao departamento dep_1 (conversas sem departamento)": {
    departments: { manager: ["dep_1"] },
  },
  "gestor restrito ao departamento dep_1 (conversa de outro agente no dep_1)": {
    departments: { manager: ["dep_1"] },
    mutate: (db) => {
      const conv = db.table("conversation").find((c) => c.id === CONV.others);
      if (conv) conv.departmentId = "dep_1";
    },
  },
  "funil p_2 bloqueado para o papel do operador": {
    mutate: (db) => db.insert("rolePipelineGrant", { roleId: "role_member", pipelineId: "p_2", canView: false }),
  },
  "etapa st_1 bloqueada para o papel do operador (conversa própria presa nela)": {
    mutate: (db) =>
      db.insert("roleStageGrant", { roleId: "role_member", stageId: "st_1", canView: false, canEdit: false }),
  },
  "etapa st_1 bloqueada para o papel do gestor": {
    mutate: (db) =>
      db.insert("roleStageGrant", { roleId: "role_manager", stageId: "st_1", canView: false, canEdit: false }),
  },
};

type Verdicts = Record<FixtureUserKey, Record<ConvKey, boolean>>;

/** `true` = acessa. Ordem das colunas: CONV_KEYS. */
const ESPERADO: Record<string, Record<FixtureUserKey, string>> = {
  "padrão (flag de escopo desligada)": {
    member: "mine:sim others:NÃO queue:NÃO resolved:sim dealOwner:sim foreign:NÃO missing:NÃO",
    other: "mine:sim others:sim queue:NÃO resolved:sim dealOwner:sim foreign:NÃO missing:NÃO",
    manager: "mine:sim others:sim queue:sim resolved:sim dealOwner:sim foreign:NÃO missing:NÃO",
    admin: "mine:sim others:sim queue:sim resolved:sim dealOwner:sim foreign:NÃO missing:NÃO",
  },
  "flag ligada, operador com canal ch_1 liberado por papel": {
    member: "mine:sim others:NÃO queue:NÃO resolved:sim dealOwner:sim foreign:NÃO missing:NÃO",
    other: "mine:sim others:sim queue:NÃO resolved:sim dealOwner:sim foreign:NÃO missing:NÃO",
    manager: "mine:sim others:sim queue:sim resolved:sim dealOwner:sim foreign:NÃO missing:NÃO",
    admin: "mine:sim others:sim queue:sim resolved:sim dealOwner:sim foreign:NÃO missing:NÃO",
  },
  "flag ligada, operador só enxerga o canal ch_2": {
    member: "mine:sim others:NÃO queue:NÃO resolved:sim dealOwner:sim foreign:NÃO missing:NÃO",
    other: "mine:sim others:sim queue:NÃO resolved:sim dealOwner:sim foreign:NÃO missing:NÃO",
    manager: "mine:sim others:sim queue:sim resolved:sim dealOwner:sim foreign:NÃO missing:NÃO",
    admin: "mine:sim others:sim queue:sim resolved:sim dealOwner:sim foreign:NÃO missing:NÃO",
  },
  "flag ligada, gestor vê ch_1 e ch_2 mas ch_1 está negado a ele": {
    member: "mine:sim others:NÃO queue:NÃO resolved:sim dealOwner:sim foreign:NÃO missing:NÃO",
    other: "mine:sim others:sim queue:NÃO resolved:sim dealOwner:sim foreign:NÃO missing:NÃO",
    manager: "mine:NÃO others:NÃO queue:NÃO resolved:NÃO dealOwner:NÃO foreign:NÃO missing:NÃO",
    admin: "mine:sim others:sim queue:sim resolved:sim dealOwner:sim foreign:NÃO missing:NÃO",
  },
  "flag ligada, gestor só enxerga o canal ch_2 (por papel)": {
    member: "mine:sim others:NÃO queue:NÃO resolved:sim dealOwner:sim foreign:NÃO missing:NÃO",
    other: "mine:sim others:sim queue:NÃO resolved:sim dealOwner:sim foreign:NÃO missing:NÃO",
    manager: "mine:NÃO others:NÃO queue:NÃO resolved:NÃO dealOwner:NÃO foreign:NÃO missing:NÃO",
    admin: "mine:sim others:sim queue:sim resolved:sim dealOwner:sim foreign:NÃO missing:NÃO",
  },
  "visibility.MEMBER = all, flag ligada, operador só enxerga o canal ch_2": {
    member: "mine:sim others:NÃO queue:NÃO resolved:sim dealOwner:sim foreign:NÃO missing:NÃO",
    other: "mine:sim others:sim queue:NÃO resolved:sim dealOwner:sim foreign:NÃO missing:NÃO",
    manager: "mine:sim others:sim queue:sim resolved:sim dealOwner:sim foreign:NÃO missing:NÃO",
    admin: "mine:sim others:sim queue:sim resolved:sim dealOwner:sim foreign:NÃO missing:NÃO",
  },
  "visibility.MEMBER = all, flag ligada, canal ch_1 liberado, conversa de outro sem canal": {
    member: "mine:sim others:NÃO queue:NÃO resolved:sim dealOwner:sim foreign:NÃO missing:NÃO",
    other: "mine:sim others:sim queue:NÃO resolved:sim dealOwner:sim foreign:NÃO missing:NÃO",
    manager: "mine:sim others:sim queue:sim resolved:sim dealOwner:sim foreign:NÃO missing:NÃO",
    admin: "mine:sim others:sim queue:sim resolved:sim dealOwner:sim foreign:NÃO missing:NÃO",
  },
  "canal negado no JSON, mas flag desligada": {
    member: "mine:sim others:NÃO queue:NÃO resolved:sim dealOwner:sim foreign:NÃO missing:NÃO",
    other: "mine:sim others:sim queue:NÃO resolved:sim dealOwner:sim foreign:NÃO missing:NÃO",
    manager: "mine:sim others:sim queue:sim resolved:sim dealOwner:sim foreign:NÃO missing:NÃO",
    admin: "mine:sim others:sim queue:sim resolved:sim dealOwner:sim foreign:NÃO missing:NÃO",
  },
  "operador com fila de entrada (inbox:tab:entrada + claim) e pool livre": {
    member: "mine:sim others:NÃO queue:sim resolved:sim dealOwner:sim foreign:NÃO missing:NÃO",
    other: "mine:sim others:sim queue:sim resolved:sim dealOwner:sim foreign:NÃO missing:NÃO",
    manager: "mine:sim others:sim queue:sim resolved:sim dealOwner:sim foreign:NÃO missing:NÃO",
    admin: "mine:sim others:sim queue:sim resolved:sim dealOwner:sim foreign:NÃO missing:NÃO",
  },
  "operador com fila de entrada, mas sem ver o pool livre": {
    member: "mine:sim others:NÃO queue:NÃO resolved:sim dealOwner:sim foreign:NÃO missing:NÃO",
    other: "mine:sim others:sim queue:NÃO resolved:sim dealOwner:sim foreign:NÃO missing:NÃO",
    manager: "mine:sim others:sim queue:sim resolved:sim dealOwner:sim foreign:NÃO missing:NÃO",
    admin: "mine:sim others:sim queue:sim resolved:sim dealOwner:sim foreign:NÃO missing:NÃO",
  },
  "visibility.MEMBER = all": {
    member: "mine:sim others:sim queue:NÃO resolved:sim dealOwner:sim foreign:NÃO missing:NÃO",
    other: "mine:sim others:sim queue:NÃO resolved:sim dealOwner:sim foreign:NÃO missing:NÃO",
    manager: "mine:sim others:sim queue:sim resolved:sim dealOwner:sim foreign:NÃO missing:NÃO",
    admin: "mine:sim others:sim queue:sim resolved:sim dealOwner:sim foreign:NÃO missing:NÃO",
  },
  "visibility.MEMBER = all + pool livre": {
    member: "mine:sim others:sim queue:sim resolved:sim dealOwner:sim foreign:NÃO missing:NÃO",
    other: "mine:sim others:sim queue:sim resolved:sim dealOwner:sim foreign:NÃO missing:NÃO",
    manager: "mine:sim others:sim queue:sim resolved:sim dealOwner:sim foreign:NÃO missing:NÃO",
    admin: "mine:sim others:sim queue:sim resolved:sim dealOwner:sim foreign:NÃO missing:NÃO",
  },
  "visibility.MANAGER = own": {
    member: "mine:sim others:NÃO queue:NÃO resolved:sim dealOwner:sim foreign:NÃO missing:NÃO",
    other: "mine:sim others:sim queue:NÃO resolved:sim dealOwner:sim foreign:NÃO missing:NÃO",
    manager: "mine:NÃO others:NÃO queue:sim resolved:NÃO dealOwner:NÃO foreign:NÃO missing:NÃO",
    admin: "mine:sim others:sim queue:sim resolved:sim dealOwner:sim foreign:NÃO missing:NÃO",
  },
  "visibility.MANAGER = own, flag ligada, papel sem caixa compartilhada": {
    member: "mine:sim others:NÃO queue:NÃO resolved:sim dealOwner:sim foreign:NÃO missing:NÃO",
    other: "mine:sim others:sim queue:NÃO resolved:sim dealOwner:sim foreign:NÃO missing:NÃO",
    manager: "mine:NÃO others:NÃO queue:sim resolved:NÃO dealOwner:NÃO foreign:NÃO missing:NÃO",
    admin: "mine:sim others:sim queue:sim resolved:sim dealOwner:sim foreign:NÃO missing:NÃO",
  },
  "visibility.MANAGER = own sem pool livre; o contato da fila é do gestor": {
    member: "mine:sim others:NÃO queue:NÃO resolved:sim dealOwner:sim foreign:NÃO missing:NÃO",
    other: "mine:sim others:sim queue:NÃO resolved:sim dealOwner:sim foreign:NÃO missing:NÃO",
    manager: "mine:NÃO others:NÃO queue:sim resolved:NÃO dealOwner:NÃO foreign:NÃO missing:NÃO",
    admin: "mine:sim others:sim queue:sim resolved:sim dealOwner:sim foreign:NÃO missing:NÃO",
  },
  "idem, com flag ligada e papel sem caixa compartilhada (own estrito)": {
    member: "mine:sim others:NÃO queue:NÃO resolved:sim dealOwner:sim foreign:NÃO missing:NÃO",
    other: "mine:sim others:sim queue:NÃO resolved:sim dealOwner:sim foreign:NÃO missing:NÃO",
    manager: "mine:NÃO others:NÃO queue:NÃO resolved:NÃO dealOwner:NÃO foreign:NÃO missing:NÃO",
    admin: "mine:sim others:sim queue:sim resolved:sim dealOwner:sim foreign:NÃO missing:NÃO",
  },
  "gestor sem pool livre (unassigned.MANAGER = false)": {
    member: "mine:sim others:NÃO queue:NÃO resolved:sim dealOwner:sim foreign:NÃO missing:NÃO",
    other: "mine:sim others:sim queue:NÃO resolved:sim dealOwner:sim foreign:NÃO missing:NÃO",
    manager: "mine:sim others:sim queue:NÃO resolved:sim dealOwner:sim foreign:NÃO missing:NÃO",
    admin: "mine:sim others:sim queue:sim resolved:sim dealOwner:sim foreign:NÃO missing:NÃO",
  },
  "papel do operador com seeTeam": {
    member: "mine:sim others:sim queue:NÃO resolved:sim dealOwner:sim foreign:NÃO missing:NÃO",
    other: "mine:sim others:sim queue:NÃO resolved:sim dealOwner:sim foreign:NÃO missing:NÃO",
    manager: "mine:sim others:sim queue:sim resolved:sim dealOwner:sim foreign:NÃO missing:NÃO",
    admin: "mine:sim others:sim queue:sim resolved:sim dealOwner:sim foreign:NÃO missing:NÃO",
  },
  "papel do operador com seeTeam + seeUnassigned": {
    member: "mine:sim others:sim queue:sim resolved:sim dealOwner:sim foreign:NÃO missing:NÃO",
    other: "mine:sim others:sim queue:sim resolved:sim dealOwner:sim foreign:NÃO missing:NÃO",
    manager: "mine:sim others:sim queue:sim resolved:sim dealOwner:sim foreign:NÃO missing:NÃO",
    admin: "mine:sim others:sim queue:sim resolved:sim dealOwner:sim foreign:NÃO missing:NÃO",
  },
  "gestor restrito ao departamento dep_1 (conversas sem departamento)": {
    member: "mine:sim others:NÃO queue:NÃO resolved:sim dealOwner:sim foreign:NÃO missing:NÃO",
    other: "mine:sim others:sim queue:NÃO resolved:sim dealOwner:sim foreign:NÃO missing:NÃO",
    manager: "mine:NÃO others:NÃO queue:NÃO resolved:NÃO dealOwner:NÃO foreign:NÃO missing:NÃO",
    admin: "mine:sim others:sim queue:sim resolved:sim dealOwner:sim foreign:NÃO missing:NÃO",
  },
  "gestor restrito ao departamento dep_1 (conversa de outro agente no dep_1)": {
    member: "mine:sim others:NÃO queue:NÃO resolved:sim dealOwner:sim foreign:NÃO missing:NÃO",
    other: "mine:sim others:sim queue:NÃO resolved:sim dealOwner:sim foreign:NÃO missing:NÃO",
    manager: "mine:NÃO others:sim queue:NÃO resolved:NÃO dealOwner:NÃO foreign:NÃO missing:NÃO",
    admin: "mine:sim others:sim queue:sim resolved:sim dealOwner:sim foreign:NÃO missing:NÃO",
  },
  "funil p_2 bloqueado para o papel do operador": {
    member: "mine:sim others:NÃO queue:NÃO resolved:sim dealOwner:NÃO foreign:NÃO missing:NÃO",
    other: "mine:sim others:sim queue:NÃO resolved:sim dealOwner:NÃO foreign:NÃO missing:NÃO",
    manager: "mine:sim others:sim queue:sim resolved:sim dealOwner:sim foreign:NÃO missing:NÃO",
    admin: "mine:sim others:sim queue:sim resolved:sim dealOwner:sim foreign:NÃO missing:NÃO",
  },
  "etapa st_1 bloqueada para o papel do operador (conversa própria presa nela)": {
    member: "mine:NÃO others:NÃO queue:NÃO resolved:NÃO dealOwner:sim foreign:NÃO missing:NÃO",
    other: "mine:NÃO others:sim queue:NÃO resolved:NÃO dealOwner:sim foreign:NÃO missing:NÃO",
    manager: "mine:sim others:sim queue:sim resolved:sim dealOwner:sim foreign:NÃO missing:NÃO",
    admin: "mine:sim others:sim queue:sim resolved:sim dealOwner:sim foreign:NÃO missing:NÃO",
  },
  "etapa st_1 bloqueada para o papel do gestor": {
    member: "mine:sim others:NÃO queue:NÃO resolved:sim dealOwner:sim foreign:NÃO missing:NÃO",
    other: "mine:sim others:sim queue:NÃO resolved:sim dealOwner:sim foreign:NÃO missing:NÃO",
    manager: "mine:NÃO others:sim queue:sim resolved:NÃO dealOwner:sim foreign:NÃO missing:NÃO",
    admin: "mine:sim others:sim queue:sim resolved:sim dealOwner:sim foreign:NÃO missing:NÃO",
  },
};

function encode(row: Record<ConvKey, boolean>): string {
  return CONV_KEYS.map((k) => `${k}:${row[k] ? "sim" : "NÃO"}`).join(" ");
}

async function verdicts(seed: SeedOptions): Promise<Verdicts> {
  const db = seedInbox(seed);
  probe.setDbHandler((model, operation, args) => db.run(model, operation, args));
  const out = {} as Verdicts;
  for (const userKey of USER_KEYS) {
    const u = USERS[userKey];
    const row = {} as Record<ConvKey, boolean>;
    for (const convKey of CONV_KEYS) {
      const { result } = await probe.run(() =>
        runWithContext({ organizationId: ORG, userId: u.id, isSuperAdmin: false }, () =>
          userHasConversationAccess(
            { id: u.id, role: u.role as AppUserRole, organizationId: ORG, isSuperAdmin: false },
            CONV_IDS[convKey],
          ),
        ),
      );
      row[convKey] = result;
    }
    out[userKey] = row;
  }
  return out;
}

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(new Date("2026-09-30T12:00:00.000Z"));
});
afterAll(() => {
  vi.useRealTimers();
});
beforeEach(async () => {
  probe.reset();
  await cache.delPattern("*");
});

describe("userHasConversationAccess — tabela de vereditos", () => {
  for (const [name, seed] of Object.entries(SCENARIOS)) {
    it(name, async () => {
      const got = await verdicts(seed);
      const encoded = Object.fromEntries(
        USER_KEYS.map((k) => [k, encode(got[k])]),
      ) as Record<FixtureUserKey, string>;
      if (process.env.P10_GOLDEN) {
        const { appendFileSync } = await import("node:fs");
        appendFileSync(process.env.P10_GOLDEN, `  ${JSON.stringify(name)}: ${JSON.stringify(encoded, null, 4)},\n`);
        return;
      }
      expect(encoded).toEqual(ESPERADO[name]);
    });
  }
});

describe("requireConversationAccess — respostas", () => {
  const session = (key: FixtureUserKey) => ({
    user: { id: USERS[key].id, role: USERS[key].role, organizationId: ORG, isSuperAdmin: false },
  });
  const call = async (key: FixtureUserKey, id: string) => {
    const { result } = await probe.run(() =>
      runWithContext({ organizationId: ORG, userId: USERS[key].id, isSuperAdmin: false }, () =>
        requireConversationAccess(session(key), id),
      ),
    );
    return result;
  };

  beforeEach(() => {
    const db = seedInbox();
    probe.setDbHandler((model, operation, args) => db.run(model, operation, args));
  });

  it("401 sem sessão ou sem papel", async () => {
    const semSessao = await probe.run(() => requireConversationAccess(null, CONV.mine));
    expect(semSessao.result?.status).toBe(401);
    const semPapel = await probe.run(() =>
      requireConversationAccess({ user: { id: USERS.member.id, organizationId: ORG } }, CONV.mine),
    );
    expect(semPapel.result?.status).toBe(401);
  });

  it("null (liberado) para o responsável — por id e pelo número da conversa", async () => {
    expect(await call("member", CONV.mine)).toBeNull();
    expect(await call("member", "101")).toBeNull();
  });

  it("404 com a mesma mensagem para conversa de outro, de outra org e inexistente", async () => {
    for (const id of [CONV.others, CONV.foreign, "conv_nao_existe", "999999", "0"]) {
      const res = await call("member", id);
      expect(res?.status).toBe(404);
      expect(await res?.json()).toEqual({ message: "Conversa não encontrada ou sem permissão." });
    }
  });

  it("o número da conversa resolve só dentro da org do contexto", async () => {
    // `conv_foreign` também é a nº 101, na org_2.
    const inOrg = async (organizationId: string) =>
      (
        await probe.run(() =>
          runWithContext({ organizationId, userId: "u_x", isSuperAdmin: false }, () =>
            resolveConversationId("101"),
          ),
        )
      ).result;
    expect(await inOrg(ORG)).toBe(CONV.mine);
    expect(await inOrg("org_2")).toBe(CONV.foreign);
    // 103 = conversa da fila: existe na org, mas o operador não a enxerga.
    expect((await call("member", "103"))?.status).toBe(404);
  });
});
