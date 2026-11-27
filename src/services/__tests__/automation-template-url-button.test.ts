/**
 * `send_whatsapp_template` com botão URL dinâmica
 * (`https://prova.cruzeiroead.com.br/{{1}}`): o valor do botão gravado no
 * passo pode ser um token do CRM e precisa chegar resolvido à Meta, no
 * componente `{ type: "button", sub_type: "url", index }`. Sufixo vazio
 * falha antes de chamar a Meta (que devolveria 132000 sem dizer o campo).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  delete process.env.REDIS_URL;
  process.env.CRM_SKIP_BACKGROUND_SERVERS = "1";
  const sendTemplate = vi.fn(async () => ({ messages: [{ id: "wamid.1" }] }));
  const client = { configured: true, sendText: vi.fn(), sendTemplate, sendMedia: vi.fn() };
  return {
    sendTemplate,
    client,
    metaClientFromConfig: vi.fn(() => client),
  };
});

vi.mock("@/lib/prisma", () => ({
  prisma: {
    channel: {
      findFirst: vi.fn(async () => ({
        provider: "META_CLOUD_API",
        config: { accessToken: "t", phoneNumberId: "p" },
        organizationId: "org-1",
      })),
      findUnique: vi.fn(async () => ({ name: "Cruzeiro", phoneNumber: "+5511" })),
    },
    conversation: {
      findUnique: vi.fn(async () => null),
      findFirst: vi.fn(async () => null),
      update: vi.fn(async () => ({})),
    },
    whatsAppTemplateConfig: { findFirst: vi.fn(async () => null) },
    message: { create: vi.fn(), findFirst: vi.fn(async () => null) },
    contact: { findUnique: vi.fn(async () => ({ organizationId: "org-1" })) },
  },
}));
vi.mock("@/lib/meta-whatsapp/client", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/meta-whatsapp/client")>();
  return { ...real, metaClientFromConfig: h.metaClientFromConfig, metaWhatsApp: h.client };
});
// Sem Graph no teste: o enriquecimento de Flow e a mídia do cabeçalho
// devolvem os componentes como vieram.
vi.mock("@/lib/meta-whatsapp/enrich-template-flow", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/meta-whatsapp/enrich-template-flow")>();
  return {
    ...real,
    enrichTemplateComponentsForFlowSend: vi.fn(async (_c: unknown, a: { components?: unknown[] }) => ({
      components: a.components,
      flowToken: null,
    })),
  };
});
vi.mock("@/lib/meta-whatsapp/template-header-media", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/meta-whatsapp/template-header-media")>();
  return {
    ...real,
    injectTemplateHeaderMediaComponent: vi.fn(async (_c: unknown, a: { components?: unknown[] }) => a.components),
  };
});
vi.mock("@/services/automation-triggers", () => ({
  fireTrigger: vi.fn(async () => undefined),
  notifyDealStageChanged: vi.fn(),
}));
vi.mock("@/lib/sse-bus", () => ({ sseBus: { publish: vi.fn() } }));

import { buildTemplateComponents } from "@/lib/meta-whatsapp/build-template-components";
import { MetaSendFailureError, executeStep } from "@/services/automation-executor";

function runtime(dealCustomFields: Record<string, unknown>) {
  return {
    automationId: "auto-1",
    automationName: "Prova liberada",
    contactId: null,
    dealId: null,
    event: "deal_tag_added",
    data: {},
    contact: { id: "ct-1", name: "Aluno", phone: "+5511999990000", whatsappBsuid: null },
    deal: null,
    conversation: null,
    contactTagIds: [],
    contactTagNames: [],
    dealTagIds: [],
    dealTagNames: ["Prova liberada"],
    contactCustomFields: {},
    dealCustomFields,
    depth: 0,
  };
}

const cfg = {
  channelId: "ch-meta",
  templateName: "inscricao_com_link_da_prova",
  languageCode: "pt_BR",
  bodyPreview: "Olá {{1}}, sua prova foi liberada.",
  components: buildTemplateComponents([
    { component: "body", key: "1", value: "{{contact.name}}" },
    {
      component: "button",
      key: "1",
      value: "{{dealCustomFields.codigo_da_prova}}",
      buttonIndex: 0,
    },
  ]),
};

beforeEach(() => {
  h.sendTemplate.mockClear();
});

describe("send_whatsapp_template × botão URL dinâmico", () => {
  it("resolve o token do negócio no sufixo da URL e envia o componente do botão", async () => {
    await executeStep(
      "send_whatsapp_template",
      cfg,
      runtime({ codigo_da_prova: "PRV-2026-0042" }) as never,
    );

    expect(h.sendTemplate).toHaveBeenCalledTimes(1);
    const [to, name, lang, components] = h.sendTemplate.mock.calls[0] as unknown as [
      string,
      string,
      string,
      unknown[],
    ];
    expect(to).toBe("5511999990000");
    expect(name).toBe("inscricao_com_link_da_prova");
    expect(lang).toBe("pt_BR");
    expect(components).toEqual([
      { type: "body", parameters: [{ type: "text", text: "Aluno" }] },
      {
        type: "button",
        sub_type: "url",
        index: "0",
        parameters: [{ type: "text", text: "PRV-2026-0042" }],
      },
    ]);
  });

  it("campo do negócio vazio falha com mensagem clara, sem chamar a Meta", async () => {
    const err = await executeStep("send_whatsapp_template", cfg, runtime({}) as never).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(MetaSendFailureError);
    expect((err as Error).message).toMatch(/final da URL do botão 1 ficou vazio/);
    expect((err as Error).message).toContain("{{dealCustomFields.codigo_da_prova}}");
    expect(h.sendTemplate).not.toHaveBeenCalled();
  });

  it("template sem botão dinâmico mantém o payload", async () => {
    await executeStep(
      "send_whatsapp_template",
      {
        ...cfg,
        components: buildTemplateComponents([{ component: "body", key: "1", value: "Fixo" }]),
      },
      runtime({}) as never,
    );
    const components = (h.sendTemplate.mock.calls[0] as unknown as unknown[])[3];
    expect(components).toEqual([{ type: "body", parameters: [{ type: "text", text: "Fixo" }] }]);
  });
});
