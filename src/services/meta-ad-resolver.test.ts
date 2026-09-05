import { describe, expect, it } from "vitest";
import { parseTrackingParams } from "./meta-ad-resolver";

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
