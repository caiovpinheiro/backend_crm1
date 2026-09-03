import { describe, expect, it } from "vitest";

import {
  campaignTemplatePayloadIsDynamic,
  interpolateCampaignTemplatePayload,
  interpolateCampaignTokenString,
  parseCampaignTemplatePayload,
  sanitizeTemplateParameterText,
  type CampaignInterpolationRoot,
} from "./campaign-template-variables";

const root: CampaignInterpolationRoot = {
  contact: {
    id: "c1",
    name: "Maria Silva",
    phone: "5511999",
    email: "a@b.com",
  },
  deal: { id: "d1", title: "Vaga X", value: "100", status: "OPEN" },
  contactCustomFields: {},
  dealCustomFields: {
    titulovaga1: "Engenharia",
    imagem_vaga: "https://cdn.example.com/vaga.png",
  },
  contactId: "c1",
  dealId: "d1",
};

describe("parseCampaignTemplatePayload", () => {
  it("aceita array legado", () => {
    expect(parseCampaignTemplatePayload([{ type: "body" }])).toEqual({
      components: [{ type: "body" }],
    });
  });

  it("aceita wrapper v1", () => {
    expect(
      parseCampaignTemplatePayload({
        version: 1,
        components: [{ type: "body" }],
        headerMediaUrl: "{{dealCustomFields.imagem_vaga}}",
      }),
    ).toEqual({
      version: 1,
      components: [{ type: "body" }],
      headerMediaUrl: "{{dealCustomFields.imagem_vaga}}",
    });
  });
});

describe("campaignTemplatePayloadIsDynamic", () => {
  it("detecta token no body", () => {
    expect(
      campaignTemplatePayloadIsDynamic({
        components: [
          {
            type: "body",
            parameters: [
              { type: "text", text: "{{dealCustomFields.titulovaga1}}" },
            ],
          },
        ],
      }),
    ).toBe(true);
  });

  it("detecta token no headerMediaUrl", () => {
    expect(
      campaignTemplatePayloadIsDynamic({
        headerMediaUrl: "{{dealCustomFields.imagem_vaga}}",
      }),
    ).toBe(true);
  });

  it("estático sem tokens", () => {
    expect(
      campaignTemplatePayloadIsDynamic({
        components: [
          { type: "body", parameters: [{ type: "text", text: "fixo" }] },
        ],
      }),
    ).toBe(false);
  });
});

describe("interpolateCampaignTokenString", () => {
  it("resolve dealCustomFields e filtro first_name", () => {
    expect(
      interpolateCampaignTokenString("{{dealCustomFields.titulovaga1}}", root as never),
    ).toBe("Engenharia");
    expect(
      interpolateCampaignTokenString("{{contact.name|first_name}}", root as never),
    ).toBe("Maria");
  });

  it("token ausente vira vazio", () => {
    expect(
      interpolateCampaignTokenString("{{dealCustomFields.inexistente}}", root as never),
    ).toBe("");
  });
});

describe("interpolateCampaignTemplatePayload", () => {
  it("interpola body e headerMediaUrl", () => {
    const out = interpolateCampaignTemplatePayload(
      {
        components: [
          {
            type: "body",
            parameters: [
              { type: "text", text: "{{dealCustomFields.titulovaga1}}" },
            ],
          },
        ],
        headerMediaUrl: "{{dealCustomFields.imagem_vaga}}",
      },
      root,
    );
    expect(out.headerMediaUrl).toBe("https://cdn.example.com/vaga.png");
    expect(out.components).toEqual([
      {
        type: "body",
        parameters: [{ type: "text", text: "Engenharia" }],
      },
    ]);
  });
});

describe("sanitizeTemplateParameterText", () => {
  it("remove quebras de linha", () => {
    expect(sanitizeTemplateParameterText("a\nb\tc")).toBe("a b c");
  });
});
