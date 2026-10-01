/**
 * POST /api/auth/forgot-password — tempo de resposta uniforme (pentest
 * out/2026: ~190 ms para e-mail inexistente × ~580 ms para existente).
 *
 * Roda o serviço REAL (`requestPasswordReset`) contra um Prisma falso e um
 * envio de e-mail lento, com timers falsos: prova que, antes de responder,
 * e-mail existente e inexistente fazem exatamente o mesmo trabalho, e que
 * o token/e-mail só acontecem depois, em segundo plano.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  userFindMany: vi.fn(),
  tokenUpdateMany: vi.fn(),
  tokenCreate: vi.fn(),
  sendPasswordResetEmail: vi.fn(),
  withRateLimit: vi.fn(),
  background: [] as Array<{ label: string; task: () => Promise<unknown> }>,
}));

vi.mock("@/lib/prisma-base", () => ({
  prismaBase: {
    user: { findMany: mocks.userFindMany },
    passwordResetToken: {
      updateMany: mocks.tokenUpdateMany,
      create: mocks.tokenCreate,
    },
  },
}));

vi.mock("@/lib/mail/send", () => ({
  sendPasswordResetEmail: mocks.sendPasswordResetEmail,
}));

vi.mock("@/lib/rate-limit", () => ({
  getClientIp: () => "203.0.113.10",
  withRateLimit: mocks.withRateLimit,
}));

// Captura a tarefa em vez de executá-la: o teste decide quando "depois da
// resposta" acontece.
vi.mock("@/lib/background", () => ({
  runInBackground: (label: string, task: () => Promise<unknown>) => {
    mocks.background.push({ label, task });
  },
}));

import { POST } from "@/app/api/auth/forgot-password/route";

const FLOOR_MS = 300;
const DB_MS = 40;
const MAIL_MS = 350;

function delayed<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

function req(email: string): Request {
  return new Request("https://acme.bwipo.com/api/auth/forgot-password", {
    method: "POST",
    headers: { "content-type": "application/json", host: "acme.bwipo.com" },
    body: JSON.stringify({ email }),
  });
}

const EXISTING = "ana@acme.com";
const MISSING = "ninguem@nada.com";

/** Chamadas ao banco / e-mail feitas até aqui. */
function workDone() {
  return {
    userFindMany: mocks.userFindMany.mock.calls.length,
    tokenUpdateMany: mocks.tokenUpdateMany.mock.calls.length,
    tokenCreate: mocks.tokenCreate.mock.calls.length,
    mail: mocks.sendPasswordResetEmail.mock.calls.length,
  };
}

/**
 * Dispara o POST e avança o relógio falso. Devolve o instante em que a
 * resposta saiu e o trabalho feito ATÉ a resposta.
 */
async function run(email: string) {
  const start = Date.now();
  let res: Response | null = null;
  let elapsedMs = -1;
  let workBeforeResponse = workDone();
  const pending = POST(req(email)).then((r) => {
    res = r;
    elapsedMs = Date.now() - start;
    workBeforeResponse = workDone();
  });
  await vi.advanceTimersByTimeAsync(5_000);
  await pending;
  return { res: res as unknown as Response, elapsedMs, workBeforeResponse };
}

const savedFloor = process.env.AUTH_MIN_RESPONSE_MS;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.background.length = 0;
  vi.useFakeTimers();
  delete process.env.AUTH_MIN_RESPONSE_MS;
  mocks.withRateLimit.mockResolvedValue({ ok: true, headers: {} });
  // Banco: acha a conta só para o e-mail existente, e demora.
  mocks.userFindMany.mockImplementation((args: { where: { email: string } }) =>
    delayed(
      DB_MS,
      args.where.email === EXISTING
        ? [
            {
              id: "u1",
              email: EXISTING,
              organization: { slug: "acme", status: "ACTIVE" },
            },
          ]
        : [],
    ),
  );
  mocks.tokenUpdateMany.mockImplementation(() => delayed(DB_MS, { count: 0 }));
  mocks.tokenCreate.mockImplementation(() => delayed(DB_MS, {}));
  // SMTP lento: é o que fazia a diferença de ~390 ms.
  mocks.sendPasswordResetEmail.mockImplementation(() => delayed(MAIL_MS, { sent: true }));
});

afterEach(() => {
  vi.useRealTimers();
  if (savedFloor === undefined) delete process.env.AUTH_MIN_RESPONSE_MS;
  else process.env.AUTH_MIN_RESPONSE_MS = savedFloor;
});

describe("POST /api/auth/forgot-password — tempo uniforme", () => {
  it("existente × inexistente: mesmo trabalho antes de responder e mesmo instante", async () => {
    const existing = await run(EXISTING);
    const missing = await run(MISSING);

    // Nenhum dos dois toca no banco nem no SMTP antes da resposta.
    const nothing = { userFindMany: 0, tokenUpdateMany: 0, tokenCreate: 0, mail: 0 };
    expect(existing.workBeforeResponse).toEqual(nothing);
    expect(missing.workBeforeResponse).toEqual(nothing);

    // Mesmo limite consumido (1 por pedido, por IP).
    expect(mocks.withRateLimit).toHaveBeenCalledTimes(2);

    // Mesma resposta, no mesmo instante: o piso de latência.
    expect(existing.elapsedMs).toBe(FLOOR_MS);
    expect(missing.elapsedMs).toBe(FLOOR_MS);
    expect(existing.res.status).toBe(200);
    expect(missing.res.status).toBe(200);
    expect(await existing.res.text()).toBe(await missing.res.text());

    // Os dois agendaram a mesma tarefa de segundo plano.
    expect(mocks.background.map((b) => b.label)).toEqual([
      "auth.forgot-password",
      "auth.forgot-password",
    ]);
  });

  it("o token e o e-mail acontecem depois, em segundo plano, só para a conta existente", async () => {
    await run(EXISTING);
    await run(MISSING);
    expect(workDone()).toEqual({ userFindMany: 0, tokenUpdateMany: 0, tokenCreate: 0, mail: 0 });

    const [existingTask, missingTask] = mocks.background;

    const done = existingTask.task();
    await vi.advanceTimersByTimeAsync(5_000);
    await done;
    expect(mocks.tokenCreate).toHaveBeenCalledTimes(1);
    expect(mocks.sendPasswordResetEmail).toHaveBeenCalledTimes(1);
    const mail = mocks.sendPasswordResetEmail.mock.calls[0][0] as {
      to: string;
      resetUrl: string;
    };
    expect(mail.to).toBe(EXISTING);
    expect(mail.resetUrl).toContain("https://acme.bwipo.com/reset-password?token=");

    const doneMissing = missingTask.task();
    await vi.advanceTimersByTimeAsync(5_000);
    await doneMissing;
    expect(mocks.tokenCreate).toHaveBeenCalledTimes(1);
    expect(mocks.sendPasswordResetEmail).toHaveBeenCalledTimes(1);
  });

  it("corpo inválido responde igual, no mesmo instante", async () => {
    const start = Date.now();
    let elapsedMs = -1;
    const pending = POST(
      new Request("https://acme.bwipo.com/api/auth/forgot-password", {
        method: "POST",
        body: "{não é json",
      }),
    ).then((r) => {
      elapsedMs = Date.now() - start;
      return r;
    });
    await vi.advanceTimersByTimeAsync(5_000);
    const res = await pending;
    expect(res.status).toBe(200);
    expect(elapsedMs).toBe(FLOOR_MS);
  });

  it("limite por IP estourado: 429 sem agendar nada", async () => {
    mocks.withRateLimit.mockResolvedValue({
      ok: false,
      headers: {},
      response: new Response("{}", { status: 429 }),
    });
    const { res } = await run(EXISTING);
    expect(res.status).toBe(429);
    expect(mocks.background).toHaveLength(0);
  });
});
