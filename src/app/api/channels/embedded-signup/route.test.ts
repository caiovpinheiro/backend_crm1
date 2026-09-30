/**
 * Cobertura do POST /api/channels/embedded-signup.
 * Mocka withOrgContext (passa direto), meta-constants e o provisionamento
 * para validar: validacao de body, troca code->token e resposta enriquecida.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { provisionMetaCloudChannel } = vi.hoisted(() => ({
  provisionMetaCloudChannel: vi.fn(),
}));

vi.mock("@/lib/auth-helpers", () => ({
  withOrgContext: (fn: () => unknown) => fn(),
}));

vi.mock("@/lib/meta-constants", () => ({
  CRM_META_APP_ID: "app-123",
  CRM_META_APP_SECRET: "secret-xyz",
}));

vi.mock("@/services/channels-meta-provision", async () => {
  const actual = await vi.importActual<
    typeof import("@/services/channels-meta-provision")
  >("@/services/channels-meta-provision");
  return {
    ...actual,
    provisionMetaCloudChannel,
  };
});

function req(body: unknown): Request {
  return new Request("http://localhost/api/channels/embedded-signup", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

describe("POST /api/channels/embedded-signup", () => {
  beforeEach(() => {
    provisionMetaCloudChannel.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("400 quando falta code", async () => {
    const { POST } = await import("./route");
    const res = await POST(req({ phoneNumberId: "pn", wabaId: "waba" }));
    expect(res.status).toBe(400);
  });

  it("400 quando falta phoneNumberId/wabaId", async () => {
    const { POST } = await import("./route");
    const res = await POST(req({ code: "abc" }));
    expect(res.status).toBe(400);
  });

  it("caminho feliz: troca token e provisiona, retorna flags", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ access_token: "EAA-token" }),
      })) as unknown as typeof fetch,
    );
    provisionMetaCloudChannel.mockResolvedValue({
      channel: { id: "ch-1" },
      created: true,
      webhookSubscribed: true,
      phoneRegistered: false,
      displayPhone: "+55 11 90000-0000",
      verifiedName: "Empresa X",
    });

    const { POST } = await import("./route");
    const res = await POST(
      req({ code: "abc", phoneNumberId: "pn", wabaId: "waba", name: "WA" }),
    );
    expect(res.status).toBe(201);
    const data = (await res.json()) as Record<string, unknown>;
    expect(data.webhookSubscribed).toBe(true);
    expect(data.phoneRegistered).toBe(false);
    expect(data.displayPhone).toBe("+55 11 90000-0000");

    expect(provisionMetaCloudChannel).toHaveBeenCalledTimes(1);
    const arg = provisionMetaCloudChannel.mock.calls[0][0] as {
      accessToken: string;
      embeddedSignup: boolean;
    };
    expect(arg.accessToken).toBe("EAA-token");
    expect(arg.embeddedSignup).toBe(true);
  });

  it("400 quando a Meta recusa a troca de code por token", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 400,
        json: async () => ({
          error: {
            message: "invalid code",
            type: "OAuthException",
            code: 100,
            error_subcode: 36007,
            fbtrace_id: "TRACE-SECRET",
          },
        }),
      })) as unknown as typeof fetch,
    );
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { POST } = await import("./route");
    const res = await POST(
      req({ code: "bad", phoneNumberId: "pn", wabaId: "waba" }),
    );
    expect(res.status).toBe(400);
    expect(provisionMetaCloudChannel).not.toHaveBeenCalled();

    // SEC2-5: o log leva só código/tipo do erro — nunca o corpo da Meta
    // (message/fbtrace_id podem carregar fragmentos do fluxo OAuth).
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(errorSpy.mock.calls[0]);
    expect(logged).toContain("OAuthException");
    expect(logged).toContain("100");
    expect(logged).not.toContain("invalid code");
    expect(logged).not.toContain("TRACE-SECRET");
  });
});
