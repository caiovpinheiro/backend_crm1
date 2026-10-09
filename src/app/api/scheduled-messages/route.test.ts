import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  session: null as null | {
    user: { id: string; organizationId: string; role: string; isSuperAdmin: boolean };
  },
  access: vi.fn(async () => null as NextResponse | null),
  list: vi.fn(async () => [{ id: "sm_1" }]),
  create: vi.fn(async () => ({ id: "sm_new" })),
  get: vi.fn(async () => null as { id: string; conversationId: string } | null),
  cancel: vi.fn(async () => ({ id: "sm_1", status: "CANCELLED" })),
}));

vi.mock("@/lib/auth-helpers", () => ({
  withOrgContext: async (fn: (session: NonNullable<typeof h.session>) => Promise<unknown>) => {
    if (!h.session) {
      return NextResponse.json({ message: "Não autorizado." }, { status: 401 });
    }
    return fn(h.session);
  },
}));

vi.mock("@/lib/conversation-access", () => ({
  requireConversationAccess: h.access,
}));

vi.mock("@/services/scheduled-messages", () => ({
  listPendingByConversation: h.list,
  createScheduledMessage: h.create,
  getScheduledMessage: h.get,
  cancelScheduledMessage: h.cancel,
  ScheduledMessageValidationError: class ScheduledMessageValidationError extends Error {},
}));

import { DELETE } from "@/app/api/scheduled-messages/[id]/route";
import { GET, POST } from "@/app/api/scheduled-messages/route";

const session = {
  user: { id: "user_1", organizationId: "org_1", role: "MEMBER", isSuperAdmin: false },
};

function denied() {
  return NextResponse.json(
    { message: "Conversa não encontrada ou sem permissão." },
    { status: 404 },
  );
}

beforeEach(() => {
  h.session = session;
  h.access.mockReset();
  h.access.mockResolvedValue(null);
  h.list.mockClear();
  h.create.mockClear();
  h.get.mockReset();
  h.get.mockResolvedValue(null);
  h.cancel.mockClear();
});

describe("GET /api/scheduled-messages", () => {
  it("sem sessão → 401 e não lista", async () => {
    h.session = null;
    const res = await GET(new Request("http://localhost/api/scheduled-messages?conversationId=conv_1"));
    expect(res.status).toBe(401);
    expect(h.list).not.toHaveBeenCalled();
  });

  it("com acesso à conversa → lista", async () => {
    const res = await GET(new Request("http://localhost/api/scheduled-messages?conversationId=conv_1"));
    expect(res.status).toBe(200);
    expect(h.access).toHaveBeenCalledWith(session, "conv_1");
    expect(h.list).toHaveBeenCalledWith("conv_1");
  });

  it("mesma org sem visibilidade → 404 e não lista", async () => {
    h.access.mockResolvedValue(denied());
    const res = await GET(new Request("http://localhost/api/scheduled-messages?conversationId=conv_other"));
    expect(res.status).toBe(404);
    expect(h.list).not.toHaveBeenCalled();
  });

  it("outra org ou conversa inexistente → 404 e não lista", async () => {
    h.access.mockResolvedValue(denied());
    const res = await GET(new Request("http://localhost/api/scheduled-messages?conversationId=conv_foreign"));
    expect(res.status).toBe(404);
    expect(h.list).not.toHaveBeenCalled();
  });
});

describe("POST /api/scheduled-messages", () => {
  const body = {
    conversationId: "conv_1",
    content: "olá",
    scheduledAt: new Date(Date.now() + 60_000).toISOString(),
  };

  it("com acesso → cria", async () => {
    const res = await POST(
      new Request("http://localhost/api/scheduled-messages", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    );
    expect(res.status).toBe(201);
    expect(h.create).toHaveBeenCalledWith(expect.objectContaining({ conversationId: "conv_1", createdById: "user_1" }));
  });

  it("sem acesso à conversa → 404 e não cria", async () => {
    h.access.mockResolvedValue(denied());
    const res = await POST(
      new Request("http://localhost/api/scheduled-messages", {
        method: "POST",
        body: JSON.stringify({ ...body, conversationId: "conv_hidden" }),
      }),
    );
    expect(res.status).toBe(404);
    expect(h.create).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/scheduled-messages/:id", () => {
  function call(id = "sm_1") {
    return DELETE(new Request("http://localhost/api/scheduled-messages/" + id), {
      params: Promise.resolve({ id }),
    });
  }

  it("agendamento de outra org (invisível) → 404 e não cancela", async () => {
    h.get.mockResolvedValue(null);
    const res = await call();
    expect(res.status).toBe(404);
    expect(h.cancel).not.toHaveBeenCalled();
    expect(h.access).not.toHaveBeenCalled();
  });

  it("mesma org sem acesso à conversa → 404 e não cancela", async () => {
    h.get.mockResolvedValue({ id: "sm_1", conversationId: "conv_hidden" });
    h.access.mockResolvedValue(denied());
    const res = await call();
    expect(res.status).toBe(404);
    expect(h.access).toHaveBeenCalledWith(session, "conv_hidden");
    expect(h.cancel).not.toHaveBeenCalled();
  });

  it("com acesso → cancela", async () => {
    h.get.mockResolvedValue({ id: "sm_1", conversationId: "conv_1" });
    const res = await call();
    expect(res.status).toBe(200);
    expect(h.cancel).toHaveBeenCalledWith("sm_1", "user_1");
  });
});
