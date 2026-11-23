/**
 * Resolução CTWA: cache não copia rastreio de outro contato, macros do
 * url_tags são expandidas e falta de permissão não vira "ok".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { contactUpdate, contactFindUnique, contactFindFirst } = vi.hoisted(() => ({
  contactUpdate: vi.fn(async (_args?: unknown) => ({})),
  contactFindUnique: vi.fn(async (_args?: unknown) => null as unknown),
  contactFindFirst: vi.fn(async (_args?: unknown) => null),
}));

vi.mock("@/lib/prisma", () => ({
  prisma: {
    contact: {
      update: contactUpdate,
      findUnique: contactFindUnique,
      findFirst: contactFindFirst,
    },
  },
}));
vi.mock("@/lib/logger", () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock("@/lib/meta-graph-version", () => ({ getMetaGraphApiVersion: () => "v21.0" }));

import {
  __resetAdCacheForTests,
  resolveAdAndPersistAsync,
} from "@/services/meta-ad-resolver";

const fetchMock = vi.fn();

const AD_JSON = {
  id: "ad_1",
  name: "Ciência da Computação: R$169/mês",
  // Formato real da Graph: url_tags vive no criativo, não no Ad.
  creative: {
    id: "cr_1",
    url_tags:
      "utm_source=Meta&utm_medium=whatsapp_ads&utm_campaign=cs.grad.whats.0826.ciencia-computacao&utm_content={{ad.name}}&utm_term={{campaign.name}}",
  },
  adset: { id: "as_1", name: "Conjunto", campaign: { id: "cp_1", name: "Campanha CC" } },
};

function lastUpdateData(): Record<string, unknown> {
  const calls = contactUpdate.mock.calls;
  return (calls[calls.length - 1][0] as { data: Record<string, unknown> }).data;
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  contactUpdate.mockClear();
  contactFindUnique.mockReset();
  contactFindUnique.mockResolvedValue(null);
  contactFindFirst.mockClear();
  __resetAdCacheForTests();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const args = (contactId: string) => ({
  contactId,
  organizationId: "org_1",
  sourceId: "ad_1",
  sourceType: "ad",
  accessToken: "tok",
});

describe("meta-ad-resolver CTWA", () => {
  it("grava UTMs da Meta com macros expandidas", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(AD_JSON), { status: 200 }));
    await resolveAdAndPersistAsync(args("c1"));
    const d = lastUpdateData();
    expect(d.adUtmSource).toBe("Meta");
    expect(d.adUtmMedium).toBe("whatsapp_ads");
    expect(d.adUtmContent).toBe("Ciência da Computação: R$169/mês");
    expect(d.adUtmTerm).toBe("Campanha CC");
    expect(d.adResolvedCampaignName).toBe("Campanha CC");
    expect(d.adResolveStatus).toBe("ok");
    const fields = new URL(String(fetchMock.mock.calls[0][0])).searchParams.get("fields");
    expect(fields).toContain("creative{url_tags}");
    expect(fields).not.toMatch(/(^|,)url_tags/);
  });

  it("cache reusa só o anúncio — não lê nem copia rastreio de outro contato", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(AD_JSON), { status: 200 }));
    await resolveAdAndPersistAsync(args("c1"));
    await resolveAdAndPersistAsync(args("c2"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(contactFindFirst).not.toHaveBeenCalled();
    const d = lastUpdateData();
    expect(d.adUtmSource).toBe("Meta");
    expect(d.gclid).toBeUndefined();
    expect(d.referrer).toBeUndefined();
  });

  it("sem permissão (400 subcode 33) grava no_access, mas mantém o ad_id", async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          error: {
            message:
              "Unsupported get request. Object with ID 'ad_1' does not exist, cannot be loaded due to missing permissions",
            code: 100,
            error_subcode: 33,
          },
        }),
        { status: 400 },
      ),
    );
    await resolveAdAndPersistAsync(args("c1"));
    const d = lastUpdateData();
    expect(d.adResolveStatus).toBe("no_access");
    expect(String(d.adResolveError)).toContain("missing permissions");
    expect(d.adResolvedId).toBe("ad_1");
    // falha não entra no cache: próxima mensagem tenta a Graph de novo
    await resolveAdAndPersistAsync(args("c2"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("UTMs padrão de lead CTWA (sem url_tags)", () => {
  const PERM_ERROR = () =>
    new Response(
      JSON.stringify({ error: { message: "missing permissions", code: 100, error_subcode: 33 } }),
      { status: 400 },
    );

  it("sem permissão: Meta / whatsapp_ads / título do anúncio", async () => {
    fetchMock.mockResolvedValue(PERM_ERROR());
    await resolveAdAndPersistAsync({ ...args("c1"), headline: "Óptica e Optometria: R$535/mês" });
    const d = lastUpdateData();
    expect(d.adResolveStatus).toBe("no_access");
    expect(d.adUtmSource).toBe("Meta");
    expect(d.adUtmMedium).toBe("whatsapp_ads");
    expect(d.adUtmContent).toBe("Óptica e Optometria: R$535/mês");
    expect(d.adUtmCampaign).toBeUndefined();
  });

  it("sem token: também marca como Meta", async () => {
    await resolveAdAndPersistAsync({ ...args("c1"), accessToken: null, headline: "Pedagogia" });
    const d = lastUpdateData();
    expect(d.adResolveStatus).toBe("no_access");
    expect(d.adUtmSource).toBe("Meta");
    expect(d.adUtmContent).toBe("Pedagogia");
  });

  it("não sobrescreve UTM que o contato já tem", async () => {
    contactFindUnique.mockResolvedValue({ adUtmSource: "google_cruzeiroead", adUtmMedium: "adsforms" });
    fetchMock.mockResolvedValue(PERM_ERROR());
    await resolveAdAndPersistAsync({ ...args("c1"), headline: "Fono" });
    const d = lastUpdateData();
    expect(d.adUtmSource).toBeUndefined();
    expect(d.adUtmMedium).toBeUndefined();
    expect(d.adUtmContent).toBe("Fono");
  });

  it("com url_tags da Graph, o url_tags prevalece", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(AD_JSON), { status: 200 }));
    await resolveAdAndPersistAsync({ ...args("c1"), headline: "Título do anúncio" });
    const d = lastUpdateData();
    expect(d.adUtmSource).toBe("Meta");
    expect(d.adUtmContent).toBe("Ciência da Computação: R$169/mês");
  });

  it("Graph ok mas anúncio sem url_tags: usa o padrão", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ ...AD_JSON, creative: { id: "cr_1" } }), { status: 200 }),
    );
    await resolveAdAndPersistAsync({ ...args("c1"), headline: "Título" });
    const d = lastUpdateData();
    expect(d.adResolveStatus).toBe("ok");
    expect(d.adUtmSource).toBe("Meta");
    expect(d.adUtmMedium).toBe("whatsapp_ads");
    expect(d.adUtmContent).toBe("Título");
  });
});
