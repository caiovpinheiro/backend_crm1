/**
 * Login não revela o estado da conta (pentest out/2026, vuln-0005).
 *
 * `authorize()` real + lockout REAL sobre um Prisma em memória:
 *  - senha errada, conta inexistente e e-mail não confirmado dão a mesma
 *    falha genérica (`null` → `code=credentials`), fazendo o mesmo trabalho;
 *  - `account_locked` aparece igual para e-mail inexistente e existente;
 *  - e-mail não confirmado + senha correta dispara o reenvio no servidor,
 *    em segundo plano e com teto.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Attempt = { email: string; outcome: string; createdAt: Date; userId: string | null };
type DbUser = {
  id: string;
  name: string;
  email: string;
  type: "HUMAN" | "AI";
  role: string;
  hashedPassword: string | null;
  avatarUrl: string | null;
  organizationId: string | null;
  isSuperAdmin: boolean;
  isErased: boolean;
  mfaSecret: string | null;
  mfaEnabledAt: Date | null;
  emailVerifiedAt: Date | null;
  sessionVersion: number;
  organization: { slug: string; name: string } | null;
};

const { mocks, prismaFake } = vi.hoisted(() => {
  const mocks = {
    captured: { config: null as null | Record<string, unknown> },
    db: {
      users: [] as unknown[],
      attempts: [] as unknown[],
    },
    compare: vi.fn(),
    withRateLimit: vi.fn(),
    consumeRateLimit: vi.fn(),
    sendVerifyEmail: vi.fn(),
    tokenCreate: vi.fn(),
    background: [] as Array<{ label: string; task: () => Promise<unknown> }>,
  };

  function inWindow(a: Attempt, where: Record<string, unknown>): boolean {
    const outcomes = (where.outcome as { in?: string[] } | undefined)?.in;
    const gt = (where.createdAt as { gt?: Date } | undefined)?.gt;
    return (
      a.email === where.email &&
      (!outcomes || outcomes.includes(a.outcome)) &&
      (!gt || a.createdAt.getTime() > gt.getTime())
    );
  }

  const prismaFake = {
    user: {
      findMany: async (args: { where: { email: string } }) =>
        (mocks.db.users as DbUser[]).filter(
          (u) => u.email === args.where.email && u.type !== "AI" && !u.isErased,
        ),
      findUnique: async (args: { where: { id: string } }) =>
        (mocks.db.users as DbUser[]).find((u) => u.id === args.where.id) ?? null,
    },
    organization: {
      findUnique: async () => ({ status: "ACTIVE", slug: "acme" }),
    },
    loginAttempt: {
      count: async (args: { where: Record<string, unknown> }) =>
        (mocks.db.attempts as Attempt[]).filter((a) => inWindow(a, args.where)).length,
      findMany: async (args: { where: Record<string, unknown> }) =>
        (mocks.db.attempts as Attempt[])
          .filter((a) => inWindow(a, args.where))
          .sort((x, y) => y.createdAt.getTime() - x.createdAt.getTime())
          .map((a) => ({ createdAt: a.createdAt })),
      create: async (args: { data: { email: string; outcome: string; userId?: string | null } }) => {
        (mocks.db.attempts as Attempt[]).push({
          email: args.data.email,
          outcome: args.data.outcome,
          userId: args.data.userId ?? null,
          createdAt: new Date(),
        });
        return {};
      },
      deleteMany: async (args: { where: Record<string, unknown> }) => {
        const before = mocks.db.attempts.length;
        mocks.db.attempts = (mocks.db.attempts as Attempt[]).filter(
          (a) => !inWindow(a, args.where),
        );
        return { count: before - mocks.db.attempts.length };
      },
    },
    emailVerificationToken: {
      updateMany: async () => ({ count: 0 }),
      create: mocks.tokenCreate,
    },
  };

  return { mocks, prismaFake };
});

vi.mock("next-auth", () => ({
  default: (config: Record<string, unknown>) => {
    mocks.captured.config = config;
    return { handlers: {}, auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() };
  },
}));
vi.mock("next-auth/providers/credentials", () => ({
  default: (opts: Record<string, unknown>) => opts,
}));
vi.mock("@auth/core/errors", () => ({
  CredentialsSignin: class CredentialsSignin extends Error {
    code = "credentials";
  },
}));
vi.mock("bcryptjs", () => ({ compare: mocks.compare }));
vi.mock("@/lib/prisma-base", () => ({ prismaBase: prismaFake }));
vi.mock("./prisma-base", () => ({ prismaBase: prismaFake }));
vi.mock("@/lib/rate-limit", () => ({
  getClientIp: () => "198.51.100.7",
  withRateLimit: mocks.withRateLimit,
  consumeRateLimit: mocks.consumeRateLimit,
}));
vi.mock("./rate-limit", () => ({
  getClientIp: () => "198.51.100.7",
  withRateLimit: mocks.withRateLimit,
  consumeRateLimit: mocks.consumeRateLimit,
}));
vi.mock("@/lib/mail/send", () => ({ sendVerifyEmail: mocks.sendVerifyEmail }));
// Captura a tarefa: "segundo plano" só roda quando o teste mandar.
vi.mock("@/lib/background", () => ({
  runInBackground: (label: string, task: () => Promise<unknown>) => {
    mocks.background.push({ label, task });
  },
}));
vi.mock("./crypto/secrets", () => ({ decryptSecret: vi.fn() }));
vi.mock("./auth/totp", () => ({ verifyTotp: vi.fn() }));
vi.mock("./auth/backup-codes", () => ({ findMatchingBackupCode: vi.fn() }));
vi.mock("./request-context", () => ({ enterRequestContext: vi.fn() }));
vi.mock("./auth.config", () => ({ default: { callbacks: {} } }));
vi.mock("@/lib/cache/redis-client", () => ({ getCacheClient: () => null }));
vi.mock("@/lib/audit/log", () => ({ logAuditAsync: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

import "./auth";
import { confirmEmailVerification } from "@/services/email-verification";

type Authorize = (
  credentials: Record<string, unknown>,
  request?: Request,
) => Promise<unknown>;

function authorize(email: string, password: string): Promise<unknown> {
  const providers = mocks.captured.config?.providers as Array<{ authorize: Authorize }>;
  return providers[0].authorize(
    { email, password },
    new Request("https://api.test/api/auth/callback/credentials", { method: "POST" }),
  );
}

/** Resultado como o cliente vê: sessão, falha genérica ou código de erro. */
async function outcomeOf(email: string, password: string): Promise<string> {
  try {
    const user = await authorize(email, password);
    return user ? "session" : "credentials";
  } catch (err) {
    return (err as { code?: string }).code ?? "unknown";
  }
}

const GOOD_PASSWORD = "senha-certa";

function user(overrides: Partial<DbUser>): DbUser {
  return {
    id: "u1",
    name: "Ana",
    email: "ana@acme.com",
    type: "HUMAN",
    role: "ADMIN",
    hashedPassword: "hash-ana",
    avatarUrl: null,
    organizationId: "org1",
    isSuperAdmin: false,
    isErased: false,
    mfaSecret: null,
    mfaEnabledAt: null,
    emailVerifiedAt: new Date("2026-01-01T00:00:00Z"),
    sessionVersion: 0,
    organization: { slug: "acme", name: "Acme" },
    ...overrides,
  };
}

const VERIFIED = user({});
const UNVERIFIED = user({ id: "u2", email: "nova@acme.com", emailVerifiedAt: null });
const MISSING_EMAIL = "ninguem@nada.com";

function lastAttempt(): Attempt {
  const all = mocks.db.attempts as Attempt[];
  return all[all.length - 1];
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.background.length = 0;
  mocks.db.users = [VERIFIED, UNVERIFIED];
  mocks.db.attempts = [];
  mocks.withRateLimit.mockResolvedValue({ ok: true, headers: {} });
  mocks.consumeRateLimit.mockResolvedValue({ allowed: true });
  mocks.sendVerifyEmail.mockResolvedValue({ sent: true });
  mocks.tokenCreate.mockResolvedValue({});
  // bcrypt falso: só a senha certa confere com o hash de um usuário real.
  mocks.compare.mockImplementation(
    async (password: string, hash: string) =>
      password === GOOD_PASSWORD && hash.startsWith("hash-"),
  );
});

describe("login — falha de credencial é uma só para o cliente", () => {
  it("senha errada, conta inexistente e e-mail não confirmado: mesmo código genérico", async () => {
    expect(await outcomeOf(VERIFIED.email, "errada")).toBe("credentials");
    expect(await outcomeOf(MISSING_EMAIL, "errada")).toBe("credentials");
    // Senha CORRETA, e-mail não confirmado: antes era `email_unverified`.
    expect(await outcomeOf(UNVERIFIED.email, GOOD_PASSWORD)).toBe("credentials");
    expect(await outcomeOf(UNVERIFIED.email, "errada")).toBe("credentials");
  });

  it("nenhum caminho devolve mais o código email_unverified", async () => {
    const seen = new Set<string>();
    for (const [email, password] of [
      [VERIFIED.email, "errada"],
      [MISSING_EMAIL, "errada"],
      [UNVERIFIED.email, GOOD_PASSWORD],
      [UNVERIFIED.email, "errada"],
    ]) {
      seen.add(await outcomeOf(email, password));
    }
    expect([...seen]).toEqual(["credentials"]);
  });

  it("os três casos fazem o mesmo trabalho: 1 bcrypt e 1 tentativa registrada", async () => {
    for (const [email, password] of [
      [VERIFIED.email, "errada"],
      [MISSING_EMAIL, "errada"],
      [UNVERIFIED.email, GOOD_PASSWORD],
    ]) {
      mocks.compare.mockClear();
      const before = mocks.db.attempts.length;
      await outcomeOf(email, password);
      expect(mocks.compare).toHaveBeenCalledTimes(1);
      expect(mocks.db.attempts.length - before).toBe(1);
    }
  });

  it("conta confirmada com a senha certa continua entrando", async () => {
    expect(await outcomeOf(VERIFIED.email, GOOD_PASSWORD)).toBe("session");
  });
});

describe("login — account_locked não distingue conta real de e-mail inventado", () => {
  async function failUntilLocked(email: string, password: string): Promise<string[]> {
    const outcomes: string[] = [];
    for (let i = 0; i < 6; i += 1) outcomes.push(await outcomeOf(email, password));
    return outcomes;
  }

  const EXPECTED = [
    "credentials",
    "credentials",
    "credentials",
    "credentials",
    "credentials",
    "account_locked",
  ];

  it("e-mail inexistente bloqueia na mesma tentativa que conta existente", async () => {
    const missing = await failUntilLocked(MISSING_EMAIL, "errada");
    const existing = await failUntilLocked(VERIFIED.email, "errada");
    expect(missing).toEqual(EXPECTED);
    expect(existing).toEqual(EXPECTED);
  });

  it("e-mail não confirmado com a senha certa bloqueia igual (sem oráculo de senha)", async () => {
    expect(await failUntilLocked(UNVERIFIED.email, GOOD_PASSWORD)).toEqual(EXPECTED);
  });

  it("bloqueado: nem consulta usuário nem roda bcrypt, exista a conta ou não", async () => {
    await failUntilLocked(MISSING_EMAIL, "errada");
    await failUntilLocked(VERIFIED.email, "errada");
    mocks.compare.mockClear();
    expect(await outcomeOf(MISSING_EMAIL, "errada")).toBe("account_locked");
    expect(await outcomeOf(VERIFIED.email, GOOD_PASSWORD)).toBe("account_locked");
    expect(mocks.compare).not.toHaveBeenCalled();
  });

  it("o bloqueio é por e-mail digitado: não vaza para outro e-mail", async () => {
    await failUntilLocked(MISSING_EMAIL, "errada");
    expect(await outcomeOf(VERIFIED.email, GOOD_PASSWORD)).toBe("session");
  });
});

describe("login — e-mail não confirmado: reenvio no servidor", () => {
  it("senha correta agenda o reenvio em segundo plano, sem enviar antes de responder", async () => {
    await outcomeOf(UNVERIFIED.email, GOOD_PASSWORD);
    expect(lastAttempt()).toMatchObject({
      email: UNVERIFIED.email,
      outcome: "email_unverified",
      userId: "u2",
    });
    expect(mocks.background.map((b) => b.label)).toEqual(["auth.login.verify-resend"]);
    // Nada de token/e-mail no caminho da resposta.
    expect(mocks.tokenCreate).not.toHaveBeenCalled();
    expect(mocks.sendVerifyEmail).not.toHaveBeenCalled();

    await mocks.background[0].task();
    expect(mocks.consumeRateLimit).toHaveBeenCalledWith(
      "user:u2:auth.verify-resend",
      "auth.verify-resend",
    );
    expect(mocks.tokenCreate).toHaveBeenCalledTimes(1);
    expect(mocks.sendVerifyEmail).toHaveBeenCalledTimes(1);
    expect(mocks.sendVerifyEmail.mock.calls[0][0]).toMatchObject({
      to: UNVERIFIED.email,
      organizationName: "Acme",
      verifyUrl: "https://acme.bwipo.com/verify-email?email=nova%40acme.com",
    });
  });

  it("senha errada NÃO dispara reenvio (só o titular recebe o código)", async () => {
    await outcomeOf(UNVERIFIED.email, "errada");
    expect(mocks.background).toHaveLength(0);
  });

  it("conta inexistente ou já confirmada não dispara reenvio", async () => {
    await outcomeOf(MISSING_EMAIL, "errada");
    await outcomeOf(VERIFIED.email, "errada");
    await outcomeOf(VERIFIED.email, GOOD_PASSWORD);
    expect(mocks.background).toHaveLength(0);
  });

  it("teto por usuário estourado: não gera código nem envia", async () => {
    mocks.consumeRateLimit.mockResolvedValue({ allowed: false });
    await outcomeOf(UNVERIFIED.email, GOOD_PASSWORD);
    await mocks.background[0].task();
    expect(mocks.tokenCreate).not.toHaveBeenCalled();
    expect(mocks.sendVerifyEmail).not.toHaveBeenCalled();
  });

  it("conta confirmada entre o login e a tarefa: não envia", async () => {
    await outcomeOf(UNVERIFIED.email, GOOD_PASSWORD);
    mocks.db.users = [VERIFIED, { ...UNVERIFIED, emailVerifiedAt: new Date() }];
    await mocks.background[0].task();
    expect(mocks.sendVerifyEmail).not.toHaveBeenCalled();
  });
});

describe("confirmar o e-mail destrava o login", () => {
  it("as falhas de email_unverified somem depois da confirmação", async () => {
    for (let i = 0; i < 6; i += 1) await outcomeOf(UNVERIFIED.email, GOOD_PASSWORD);
    expect(await outcomeOf(UNVERIFIED.email, GOOD_PASSWORD)).toBe("account_locked");

    // Confirmação bem-sucedida (código válido) — Prisma falso mínimo.
    const fake = prismaFake as unknown as Record<string, Record<string, unknown>>;
    fake.user.findFirst = async () => ({
      id: UNVERIFIED.id,
      email: UNVERIFIED.email,
      emailVerifiedAt: null,
    });
    fake.user.update = async () => ({});
    fake.emailVerificationToken.findFirst = async () => ({ id: "t1" });
    fake.emailVerificationToken.update = async () => ({});
    (prismaFake as unknown as { $transaction: unknown }).$transaction = async (
      fn: (tx: unknown) => Promise<unknown>,
    ) => fn(prismaFake);

    await confirmEmailVerification({ email: UNVERIFIED.email, code: "123456" });
    mocks.db.users = [VERIFIED, { ...UNVERIFIED, emailVerifiedAt: new Date() }];

    expect(await outcomeOf(UNVERIFIED.email, GOOD_PASSWORD)).toBe("session");
  });
});
