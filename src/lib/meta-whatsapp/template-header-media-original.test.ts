/**
 * Campanha com "mídia original do template": em vez de URL/campo do CRM, o
 * header usa a mídia de exemplo do template aprovado na Meta
 * (`HEADER.example.header_handle[0]`), subida uma vez e reaproveitada.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/safe-outbound-url", () => ({
  assertSafeOutboundUrl: vi.fn(async () => undefined),
}));
vi.mock("@/lib/storage/read-for-send", () => ({
  isOrgOwnedStorageUrl: vi.fn(() => false),
  readStoredMediaForSend: vi.fn(),
}));

import { parseCampaignTemplatePayload } from "@/services/campaign-template-variables";
import {
  clearTemplateExampleMediaCache,
  injectTemplateHeaderMediaComponent,
  TemplateHeaderMediaError,
} from "./template-header-media";

const EXAMPLE_URL = "https://scontent.whatsapp.net/v/t61/black_geral.jpg?ccb=1";

function graphTemplate(example: string | null) {
  return {
    name: "black_geral",
    language: "pt_BR",
    components: [
      {
        type: "HEADER",
        format: "IMAGE",
        ...(example ? { example: { header_handle: [example] } } : {}),
      },
      { type: "BODY", text: "Black Friday!" },
    ],
  };
}

function makeClient(example: string | null) {
  return {
    phoneId: "phone-1",
    uploadMedia: vi.fn(async () => "media-original-1"),
    getMessageTemplateByGraphId: vi.fn(async () => graphTemplate(example)),
  };
}

const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
const fetchMock = vi.fn(async () => ({
  ok: true,
  status: 200,
  headers: { get: (k: string) => (k.toLowerCase() === "content-type" ? "image/jpeg" : null) },
  arrayBuffer: async () => jpg.buffer.slice(jpg.byteOffset, jpg.byteOffset + jpg.byteLength),
}));

const baseArgs = {
  templateName: "black_geral",
  languageCode: "pt_BR",
  templateGraphId: "gid-1",
  components: [{ type: "body", parameters: [{ type: "text", text: "Ana" }] }],
  headerMediaUrl: null,
  headerMediaType: "image" as const,
  useTemplateOriginalMedia: true,
};

beforeEach(() => {
  clearTemplateExampleMediaCache();
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});

describe("header com a mídia original do template", () => {
  it("baixa a mídia de exemplo da Meta, sobe e injeta { id } no header", async () => {
    const client = makeClient(EXAMPLE_URL);
    const out = await injectTemplateHeaderMediaComponent(client as never, baseArgs);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect((fetchMock.mock.calls[0] as unknown[])[0]).toBe(EXAMPLE_URL);
    expect(out).toEqual([
      { type: "header", parameters: [{ type: "image", image: { id: "media-original-1" } }] },
      { type: "body", parameters: [{ type: "text", text: "Ana" }] },
    ]);
  });

  it("reaproveita o media id entre destinatários (um upload por campanha)", async () => {
    const client = makeClient(EXAMPLE_URL);
    for (let i = 0; i < 5; i += 1) {
      await injectTemplateHeaderMediaComponent(client as never, baseArgs);
    }
    expect(client.uploadMedia).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("template sem mídia de exemplo falha com mensagem clara", async () => {
    const client = makeClient(null);
    await expect(injectTemplateHeaderMediaComponent(client as never, baseArgs)).rejects.toThrow(
      TemplateHeaderMediaError,
    );
    await expect(injectTemplateHeaderMediaComponent(client as never, baseArgs)).rejects.toThrow(
      /mídia original/,
    );
  });
});

describe("Graph sem o template no envio", () => {
  const CATALOG_URL = "https://scontent.whatsapp.net/v/t61/catalogo.jpg?oe=1";

  function failingClient() {
    return {
      phoneId: "phone-2",
      uploadMedia: vi.fn(async () => "media-catalogo-1"),
      getMessageTemplateByGraphId: vi.fn(async () => {
        throw new Error("(#100) Tried accessing nonexisting field");
      }),
      listMessageTemplates: vi.fn(async () => {
        throw new Error("Meta: WABA não configurada");
      }),
    };
  }

  it("usa a mídia original gravada do catálogo na criação da campanha", async () => {
    const client = failingClient();
    const out = await injectTemplateHeaderMediaComponent(client as never, {
      ...baseArgs,
      templateExampleUrl: CATALOG_URL,
    });
    expect((fetchMock.mock.calls[0] as unknown[])[0]).toBe(CATALOG_URL);
    expect(out?.[0]).toEqual({
      type: "header",
      parameters: [{ type: "image", image: { id: "media-catalogo-1" } }],
    });
  });

  it("sem fallback, o erro traz o motivo da Graph", async () => {
    const client = failingClient();
    await expect(injectTemplateHeaderMediaComponent(client as never, baseArgs)).rejects.toThrow(
      /Tried accessing nonexisting field/,
    );
  });
});

describe("parseCampaignTemplatePayload × headerMediaSource", () => {
  it("guarda a URL da mídia original do catálogo (só HTTPS)", () => {
    expect(
      parseCampaignTemplatePayload({
        headerMediaSource: "template",
        headerMediaType: "image",
        headerMediaExampleUrl: "https://scontent.whatsapp.net/x.jpg",
      }).headerMediaExampleUrl,
    ).toBe("https://scontent.whatsapp.net/x.jpg");
    expect(
      parseCampaignTemplatePayload({
        headerMediaSource: "template",
        headerMediaExampleUrl: "http://169.254.169.254/latest",
      }).headerMediaExampleUrl,
    ).toBeUndefined();
  });

  it("source=template ignora headerMediaUrl antigo", () => {
    expect(
      parseCampaignTemplatePayload({
        version: 1,
        headerMediaSource: "template",
        headerMediaType: "image",
        headerMediaUrl: "{{dealCustomFields.imagem}}",
      }),
    ).toEqual({
      version: 1,
      components: undefined,
      headerMediaUrl: null,
      headerMediaType: "image",
      headerMediaSource: "template",
    });
  });

  it("payload sem source continua igual (campo do CRM)", () => {
    expect(
      parseCampaignTemplatePayload({
        version: 1,
        headerMediaType: "image",
        headerMediaUrl: "{{dealCustomFields.imagem}}",
      }),
    ).toEqual({
      version: 1,
      components: undefined,
      headerMediaUrl: "{{dealCustomFields.imagem}}",
      headerMediaType: "image",
    });
  });
});
