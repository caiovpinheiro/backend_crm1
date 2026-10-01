/**
 * SV-2: prova de renovação da sessão atual. A claim só sobe quando o token
 * estava na versão imediatamente anterior E a prova (uso único, 60 s, deste
 * usuário, para a versão atual do banco) é apresentada. Cobre memória (sem
 * Redis) e Redis (falso, com MULTI GET+DEL).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findUnique: vi.fn(),
  logAuditAsync: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  client: { current: null as unknown },
}));

vi.mock("@/lib/prisma-base", () => ({
  prismaBase: { user: { findUnique: mocks.findUnique } },
}));
vi.mock("@/lib/audit/log", () => ({ logAuditAsync: mocks.logAuditAsync }));
vi.mock("@/lib/logger", () => ({
  getLogger: () => ({ info: mocks.info, warn: mocks.warn, debug: vi.fn(), error: vi.fn() }),
}));
vi.mock("@/lib/cache/redis-client", () => ({
  getCacheClient: () => mocks.client.current,
}));

import {
  SESSION_RENEWAL_TTL_MS,
  clearSessionRenewalsForTests,
  issueSessionRenewal,
  renewSessionVersion,
  sessionRenewalProofFrom,
} from "@/lib/auth/session-renewal";
import {
  clearSessionVersionCacheForTests,
  getCachedSessionVersion,
  setCachedSessionVersion,
} from "@/lib/auth/session-version";

/** Redis mínimo: SET PX NX e MULTI GET+DEL, com TTL por `Date.now()`. */
function fakeRedis() {
  const store = new Map<string, { value: string; expiresAt: number }>();
  const read = (key: string) => {
    const hit = store.get(key);
    if (!hit) return null;
    if (hit.expiresAt <= Date.now()) {
      store.delete(key);
      return null;
    }
    return hit.value;
  };
  const state = { store, down: false, sets: 0, execs: 0 };
  const client = {
    async set(key: string, value: string, _px: string, ttl: number, _nx: string) {
      if (state.down) throw new Error("Connection is closed.");
      state.sets += 1;
      if (read(key) !== null) return null;
      store.set(key, { value, expiresAt: Date.now() + ttl });
      return "OK";
    },
    multi() {
      const queue: Array<() => unknown> = [];
      const chain = {
        get(key: string) {
          queue.push(() => read(key));
          return chain;
        },
        del(key: string) {
          queue.push(() => (read(key) !== null && store.delete(key) ? 1 : 0));
          return chain;
        },
        async exec() {
          if (state.down) throw new Error("Connection is closed.");
          state.execs += 1;
          return queue.map((run) => [null, run()] as [null, unknown]);
        },
      };
      return chain;
    },
  };
  return { client, state };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearSessionRenewalsForTests();
  clearSessionVersionCacheForTests();
  mocks.client.current = null;
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-01T12:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

/** Usuário u1 trocou a senha: banco foi de 3 para 4; a sessão dele estava em 3. */
async function issueFor(userId = "u1", newVersion = 4, tokenVersion = 3) {
  const grant = await issueSessionRenewal({ userId, newVersion, tokenVersion });
  if (!grant) throw new Error("esperava uma prova");
  return grant;
}

describe("issueSessionRenewal", () => {
  it("emite nonce aleatório de 43 caracteres com a versão nova e 60 s de validade", async () => {
    const a = await issueFor();
    const b = await issueFor();
    expect(a.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.token).not.toBe(b.token);
    expect(a).toMatchObject({ sessionVersion: 4, expiresInSec: 60 });
  });

  it("não emite quando a sessão que pediu não estava na versão imediatamente anterior", async () => {
    expect(await issueSessionRenewal({ userId: "u1", newVersion: 4, tokenVersion: 2 })).toBeNull();
    expect(await issueSessionRenewal({ userId: "u1", newVersion: 4, tokenVersion: 4 })).toBeNull();
    // `revokeUserSessions` devolve `null` quando a linha não existe mais.
    expect(await issueSessionRenewal({ userId: "u1", newVersion: null, tokenVersion: 3 })).toBeNull();
  });
});

describe("renewSessionVersion — memória (sem Redis)", () => {
  beforeEach(() => {
    mocks.findUnique.mockResolvedValue({ sessionVersion: 4 });
  });

  it("token na versão anterior + prova válida: sobe para a versão atual do banco", async () => {
    const grant = await issueFor();
    // Cache velho deste processo não entra na conta: lê o banco.
    setCachedSessionVersion("u1", 3);
    const renewed = await renewSessionVersion({
      userId: "u1",
      organizationId: "org1",
      tokenVersion: 3,
      proof: grant.token,
    });
    expect(renewed).toBe(4);
    expect(mocks.findUnique).toHaveBeenCalledWith({
      where: { id: "u1" },
      select: { sessionVersion: true },
    });
    expect(getCachedSessionVersion("u1")).toBe(4);
    expect(mocks.logAuditAsync).toHaveBeenCalledWith(
      expect.objectContaining({
        entity: "user",
        action: "session_renewed",
        entityId: "u1",
        organizationId: "org1",
        actorId: "u1",
      }),
    );
  });

  it("uso único: a segunda apresentação da mesma prova é recusada", async () => {
    const grant = await issueFor();
    expect(await renewSessionVersion({ userId: "u1", tokenVersion: 3, proof: grant.token })).toBe(4);
    // Outra sessão antiga do mesmo usuário (também em 3) com a prova copiada.
    expect(
      await renewSessionVersion({ userId: "u1", tokenVersion: 3, proof: grant.token }),
    ).toBeNull();
  });

  it("prova expirada (60 s) é recusada", async () => {
    const grant = await issueFor();
    vi.advanceTimersByTime(SESSION_RENEWAL_TTL_MS);
    expect(
      await renewSessionVersion({ userId: "u1", tokenVersion: 3, proof: grant.token }),
    ).toBeNull();
  });

  it("prova inventada ou malformada é recusada sem tocar no estoque", async () => {
    const grant = await issueFor();
    for (const proof of ["", "x", "a".repeat(43), "../../etc/passwd", "a".repeat(500)]) {
      expect(await renewSessionVersion({ userId: "u1", tokenVersion: 3, proof })).toBeNull();
    }
    // A prova verdadeira continua valendo depois dos chutes.
    expect(await renewSessionVersion({ userId: "u1", tokenVersion: 3, proof: grant.token })).toBe(4);
  });

  it("prova de outro usuário é recusada (e queimada)", async () => {
    const grant = await issueFor("u2", 4, 3);
    expect(
      await renewSessionVersion({ userId: "u1", tokenVersion: 3, proof: grant.token }),
    ).toBeNull();
    mocks.findUnique.mockResolvedValue({ sessionVersion: 4 });
    expect(
      await renewSessionVersion({ userId: "u2", tokenVersion: 3, proof: grant.token }),
    ).toBeNull();
  });

  it("token já revogado antes (duas versões atrás) não se renova nem com prova válida", async () => {
    const grant = await issueFor();
    expect(
      await renewSessionVersion({ userId: "u1", tokenVersion: 2, proof: grant.token }),
    ).toBeNull();
    expect(mocks.logAuditAsync).not.toHaveBeenCalled();
  });

  it("outro incremento depois da emissão (reset administrativo): a prova não vale mais", async () => {
    const grant = await issueFor();
    mocks.findUnique.mockResolvedValue({ sessionVersion: 5 });
    expect(
      await renewSessionVersion({ userId: "u1", tokenVersion: 3, proof: grant.token }),
    ).toBeNull();
    // Nem para um token que estivesse em 4.
    expect(
      await renewSessionVersion({ userId: "u1", tokenVersion: 4, proof: grant.token }),
    ).toBeNull();
  });

  it("banco fora do ar ou usuário apagado: não renova e não queima a prova", async () => {
    const grant = await issueFor();
    mocks.findUnique.mockRejectedValue(new Error("db down"));
    expect(
      await renewSessionVersion({ userId: "u1", tokenVersion: 3, proof: grant.token }),
    ).toBeNull();
    mocks.findUnique.mockResolvedValue(null);
    expect(
      await renewSessionVersion({ userId: "u1", tokenVersion: 3, proof: grant.token }),
    ).toBeNull();
    mocks.findUnique.mockResolvedValue({ sessionVersion: 4 });
    expect(await renewSessionVersion({ userId: "u1", tokenVersion: 3, proof: grant.token })).toBe(4);
  });

  it("claim já na versão atual (update repetido após dar certo): devolve a atual, sem derrubar", async () => {
    const grant = await issueFor();
    expect(await renewSessionVersion({ userId: "u1", tokenVersion: 3, proof: grant.token })).toBe(4);
    expect(await renewSessionVersion({ userId: "u1", tokenVersion: 4, proof: grant.token })).toBe(4);
    expect(mocks.logAuditAsync).toHaveBeenCalledTimes(1);
  });
});

describe("renewSessionVersion — Redis (outra réplica consome)", () => {
  beforeEach(() => {
    mocks.findUnique.mockResolvedValue({ sessionVersion: 4 });
  });

  it("guarda só o hash do nonce, com TTL, e consome com MULTI GET+DEL", async () => {
    const redis = fakeRedis();
    mocks.client.current = redis.client;
    const grant = await issueFor();

    const keys = [...redis.state.store.keys()];
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^auth:session-renewal:[0-9a-f]{64}$/);
    expect(keys[0]).not.toContain(grant.token);
    expect(redis.state.store.get(keys[0])?.value).toBe("4:u1");

    // "Outra réplica": memória local vazia, mesmo Redis.
    clearSessionRenewalsForTests();
    expect(await renewSessionVersion({ userId: "u1", tokenVersion: 3, proof: grant.token })).toBe(4);
    expect(redis.state.store.size).toBe(0);
    expect(
      await renewSessionVersion({ userId: "u1", tokenVersion: 3, proof: grant.token }),
    ).toBeNull();
  });

  it("duas tentativas simultâneas com a mesma prova: só uma renova", async () => {
    const redis = fakeRedis();
    mocks.client.current = redis.client;
    const grant = await issueFor();
    const results = await Promise.all([
      renewSessionVersion({ userId: "u1", tokenVersion: 3, proof: grant.token }),
      renewSessionVersion({ userId: "u1", tokenVersion: 3, proof: grant.token }),
    ]);
    expect(results.filter((r) => r === 4)).toHaveLength(1);
    expect(results.filter((r) => r === null)).toHaveLength(1);
  });

  it("TTL no Redis: prova expirada é recusada", async () => {
    const redis = fakeRedis();
    mocks.client.current = redis.client;
    const grant = await issueFor();
    vi.advanceTimersByTime(SESSION_RENEWAL_TTL_MS + 1);
    expect(
      await renewSessionVersion({ userId: "u1", tokenVersion: 3, proof: grant.token }),
    ).toBeNull();
  });

  it("Redis fora na emissão: cai para a memória e renova na mesma réplica", async () => {
    const redis = fakeRedis();
    redis.state.down = true;
    mocks.client.current = redis.client;
    const grant = await issueFor();
    expect(redis.state.store.size).toBe(0);
    expect(mocks.warn).toHaveBeenCalled();
    expect(await renewSessionVersion({ userId: "u1", tokenVersion: 3, proof: grant.token })).toBe(4);
  });

  it("Redis fora no consumo de uma prova guardada no Redis: recusa (não renova às cegas)", async () => {
    const redis = fakeRedis();
    mocks.client.current = redis.client;
    const grant = await issueFor();
    redis.state.down = true;
    expect(
      await renewSessionVersion({ userId: "u1", tokenVersion: 3, proof: grant.token }),
    ).toBeNull();
  });
});

describe("sessionRenewalProofFrom", () => {
  it("só aceita string não vazia no campo sessionRenewal", () => {
    expect(sessionRenewalProofFrom({ sessionRenewal: "abc" })).toBe("abc");
    expect(sessionRenewalProofFrom({ sessionRenewal: "" })).toBeNull();
    expect(sessionRenewalProofFrom({ sessionRenewal: 4 })).toBeNull();
    expect(sessionRenewalProofFrom({ sessionRenewal: { token: "abc" } })).toBeNull();
    expect(sessionRenewalProofFrom({ name: "Fulano" })).toBeNull();
    expect(sessionRenewalProofFrom(undefined)).toBeNull();
    expect(sessionRenewalProofFrom(null)).toBeNull();
    expect(sessionRenewalProofFrom("abc")).toBeNull();
  });
});
