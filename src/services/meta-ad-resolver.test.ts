import { describe, expect, it } from "vitest";
import { expandUrlTagMacros, parseTrackingParams } from "./meta-ad-resolver";

describe("expandUrlTagMacros", () => {
  const ctx = {
    adId: "120252525077210627",
    adName: "CC Pedagogia R$245 & bônus",
    adsetId: "as_1",
    adsetName: "Conjunto 1",
    campaignId: "cp_1",
    campaignName: "cs.grad.whats.0826",
  };

  it("expande ad.name e campaign.name (url_tags real do CTWA)", () => {
    const tags =
      "utm_source=Meta&utm_medium=whatsapp_ads&utm_campaign=cs.grad.whats.0826.ciencia-computacao&utm_content={{ad.name}}&utm_term={{campaign.name}}";
    const t = parseTrackingParams(expandUrlTagMacros(tags, ctx));
    expect(t.utmSource).toBe("Meta");
    expect(t.utmMedium).toBe("whatsapp_ads");
    expect(t.utmCampaign).toBe("cs.grad.whats.0826.ciencia-computacao");
    expect(t.utmContent).toBe("CC Pedagogia R$245 & bônus");
    expect(t.utmTerm).toBe("cs.grad.whats.0826");
  });

  it("macro sem valor ou desconhecida vira vazio, nunca {{…}}", () => {
    const t = parseTrackingParams(
      expandUrlTagMacros("utm_content={{ad.name}}&utm_term={{placement}}", {
        ...ctx,
        adName: null,
      }),
    );
    expect(t.utmContent).toBe("");
    expect(t.utmTerm).toBe("");
  });

  it("aceita espaços e caixa diferente na macro", () => {
    expect(expandUrlTagMacros("x={{ Campaign.Name }}", ctx)).toBe("x=cs.grad.whats.0826");
  });
});

describe("parseTrackingParams", () => {
  it("extrai UTMs de url_tags", () => {
    const t = parseTrackingParams(
      "utm_source=facebook&utm_medium=cpc&utm_campaign=black&utm_content=v1&utm_term=lead&utm_id=99&gclid=G.1&fbclid=F.2",
    );
    expect(t.utmSource).toBe("facebook");
    expect(t.utmMedium).toBe("cpc");
    expect(t.utmCampaign).toBe("black");
    expect(t.utmContent).toBe("v1");
    expect(t.utmTerm).toBe("lead");
    expect(t.utmId).toBe("99");
    expect(t.gclid).toBe("G.1");
    expect(t.fbclid).toBe("F.2");
  });

  it("extrai de URL absoluta (source_url)", () => {
    const t = parseTrackingParams(
      "https://lp.example.com/oferta?utm_source=ig&utm_medium=paid&fbclid=abc&ttad_id=tt1",
    );
    expect(t.utmSource).toBe("ig");
    expect(t.utmMedium).toBe("paid");
    expect(t.fbclid).toBe("abc");
    expect(t.ttadId).toBe("tt1");
    expect(t.referrer).toBe("https://lp.example.com/oferta");
  });
});
