/**
 * Cobertura do provisionamento Meta Cloud (Embedded Signup + manual).
 * Mocka o `fetch` da Graph API e o repositorio `@/services/channels`
 * para validar: subscribed_apps ok/falha, register non-fatal e o config
 * persistido (embeddedSignup flag, businessAccountId).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createChannel, updateChannel, getChannelById, findMetaCloudChannelByPhoneNumberId } =
  vi.hoisted(() => ({
    createChannel: vi.fn(),
    updateChannel: vi.fn(),
    getChannelById: vi.fn(),
    findMetaCloudChannelByPhoneNumberId: vi.fn(),
  }));

vi.mock("@/services/channels", () => ({
  createChannel,
  updateChannel,
  getChannelById,
  findMetaCloudChannelByPhoneNumberId,
}));

type FetchResp = { ok: boolean; json: () => Promise<unknown> };

/** Roteador de fetch por trecho de URL para simular a Graph API. */
function routeFetch(map: Record<string, FetchResp>) {
  return vi.fn(async (input: unknown) => {
    const url = String(input);
    for (const [needle, resp] of Object.entries(map)) {
      if (url.includes(needle)) return resp as unknown as Response;
    }
    return { ok: true, json: async () => ({}) } as unknown as Response;
  });
}

const ok = (body: unknown = { success: true }): FetchResp => ({
  ok: true,
  json: async () => body,
});
const fail = (body: unknown = { error: { message: "boom" } }): FetchResp => ({
  ok: false,
  json: async () => body,
});

describe("provisionMetaCloudChannel", () => {
  beforeEach(() => {
    createChannel.mockReset();
    updateChannel.mockReset();
    getChannelById.mockReset();
    findMetaCloudChannelByPhoneNumberId.mockReset();
    findMetaCloudChannelByPhoneNumberId.mockResolvedValue(null);
    createChannel.mockResolvedValue({ id: "ch-1", provider: "META_CLOUD_API" });
    updateChannel.mockResolvedValue({
      id: "ch-1",
      provider: "META_CLOUD_API",
      status: "CONNECTED",
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("cria canal com subscribed_apps ok, register ok e config correto", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "/subscribed_apps": ok(),
        "/register": ok(),
        "?fields=display_phone_number": ok({
          display_phone_number: "+55 11 90000-0000",
          verified_name: "Empresa X",
        }),
      }),
    );

    const { provisionMetaCloudChannel } = await import(
      "@/services/channels-meta-provision"
    );
    const result = await provisionMetaCloudChannel({
      accessToken: "tok",
      phoneNumberId: "pn-1",
      wabaId: "waba-1",
      name: "Meu WhatsApp",
      embeddedSignup: true,
    });

    expect(result.created).toBe(true);
    expect(result.webhookSubscribed).toBe(true);
    expect(result.phoneRegistered).toBe(true);
    expect(result.displayPhone).toBe("+55 11 90000-0000");
    expect(result.verifiedName).toBe("Empresa X");

    expect(createChannel).toHaveBeenCalledTimes(1);
    const createArg = createChannel.mock.calls[0][0] as {
      provider: string;
      config: Record<string, unknown>;
    };
    expect(createArg.provider).toBe("META_CLOUD_API");
    expect(createArg.config.businessAccountId).toBe("waba-1");
    expect(createArg.config.phoneNumberId).toBe("pn-1");
    expect(createArg.config.embeddedSignup).toBe(true);
    // Canais ES nao gravam appSecret proprio.
    expect(createArg.config.appSecret).toBeUndefined();
  });

  it("lanca erro quando subscribed_apps falha (webhook nao assinado)", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch({ "/subscribed_apps": fail() }),
    );

    const { provisionMetaCloudChannel, MetaProvisionError } = await import(
      "@/services/channels-meta-provision"
    );
    await expect(
      provisionMetaCloudChannel({
        accessToken: "tok",
        phoneNumberId: "pn-1",
        wabaId: "waba-1",
      }),
    ).rejects.toBeInstanceOf(MetaProvisionError);
    expect(createChannel).not.toHaveBeenCalled();
  });

  it("register non-fatal: canal criado mesmo com /register falhando", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "/subscribed_apps": ok(),
        "/register": fail({ error: { message: "already registered" } }),
        "?fields=display_phone_number": ok({ display_phone_number: "+1" }),
      }),
    );

    const { provisionMetaCloudChannel } = await import(
      "@/services/channels-meta-provision"
    );
    const result = await provisionMetaCloudChannel({
      accessToken: "tok",
      phoneNumberId: "pn-1",
      wabaId: "waba-1",
    });

    expect(result.created).toBe(true);
    expect(result.webhookSubscribed).toBe(true);
    expect(result.phoneRegistered).toBe(false);
  });

  it("reaproveita o canal do mesmo phoneNumberId em vez de criar outro", async () => {
    vi.stubGlobal(
      "fetch",
      routeFetch({
        "/subscribed_apps": ok(),
        "/register": ok(),
        "?fields=display_phone_number": ok({ display_phone_number: "+55" }),
      }),
    );
    findMetaCloudChannelByPhoneNumberId.mockResolvedValue({ id: "ch-existing" });
    updateChannel.mockResolvedValue({ id: "ch-existing", status: "CONNECTED" });

    const { provisionMetaCloudChannel } = await import(
      "@/services/channels-meta-provision"
    );
    const result = await provisionMetaCloudChannel({
      accessToken: "tok",
      phoneNumberId: "pn-1",
      wabaId: "waba-1",
      embeddedSignup: true,
    });

    expect(result.created).toBe(false);
    expect(createChannel).not.toHaveBeenCalled();
    expect(updateChannel).toHaveBeenCalledWith(
      "ch-existing",
      expect.objectContaining({ status: "CONNECTED" }),
    );
  });

  it("recusa gravar o mesmo número em outro canal", async () => {
    vi.stubGlobal("fetch", routeFetch({ "/subscribed_apps": ok(), "/register": ok() }));
    findMetaCloudChannelByPhoneNumberId.mockResolvedValue({ id: "ch-other" });
    getChannelById.mockResolvedValue({ id: "ch-pre" });

    const { provisionMetaCloudChannel, MetaProvisionError } = await import(
      "@/services/channels-meta-provision"
    );
    await expect(
      provisionMetaCloudChannel({
        accessToken: "tok",
        phoneNumberId: "pn-1",
        wabaId: "waba-1",
        channelId: "ch-pre",
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(createChannel).not.toHaveBeenCalled();
    expect(updateChannel).not.toHaveBeenCalled();
    expect(MetaProvisionError).toBeTruthy();
  });

  it("rejeita quando faltam credenciais obrigatorias", async () => {
    const { provisionMetaCloudChannel, MetaProvisionError } = await import(
      "@/services/channels-meta-provision"
    );
    await expect(
      provisionMetaCloudChannel({
        accessToken: "",
        phoneNumberId: "pn",
        wabaId: "waba",
      }),
    ).rejects.toBeInstanceOf(MetaProvisionError);
  });
});
