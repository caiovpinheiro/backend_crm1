import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const saveFile = vi.fn();
vi.mock("@/lib/storage/local", () => ({
  saveFile: (...args: unknown[]) => saveFile(...args),
  generateFileName: () => "referral-test.jpg",
}));

const lookupMock = vi.fn();
vi.mock("node:dns/promises", () => ({
  lookup: (...args: unknown[]) => lookupMock(...args),
}));

import {
  buildMessageReferral,
  compactReferral,
  parseReferral,
  referralFromJson,
  type ReferralInfo,
} from "./meta-referral";

const JPEG = Buffer.alloc(16, 0);
JPEG[0] = 0xff;
JPEG[1] = 0xd8;
JPEG[2] = 0xff;

function info(over: Partial<ReferralInfo> = {}): ReferralInfo {
  return {
    sourceId: null,
    sourceType: null,
    ctwaClid: null,
    headline: null,
    body: null,
    sourceUrl: null,
    mediaType: null,
    imageUrl: null,
    videoUrl: null,
    thumbnailUrl: null,
    ...over,
  };
}

beforeEach(() => {
  saveFile.mockReset();
  saveFile.mockImplementation(async (opts: { orgId: string; fileName: string }) => ({
    url: `/api/storage/${opts.orgId}/inbound-media/${opts.fileName}`,
  }));
  lookupMock.mockReset();
  lookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JPEG, { status: 200 })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("parseReferral", () => {
  it("captura os campos do referral, inclusive a mídia", () => {
    const parsed = parseReferral({
      referral: {
        source_id: "120",
        source_type: "ad",
        ctwa_clid: "clid-1",
        headline: "Terapia Ocupacional",
        body: "R$ 340/mês",
        source_url: "https://fb.me/2aaYyDdMi0",
        media_type: "image",
        image_url: "https://cdn.example/ad.jpg",
        video_url: "https://cdn.example/ad.mp4",
        thumbnail_url: "https://cdn.example/thumb.jpg",
      },
    });
    expect(parsed).toEqual({
      sourceId: "120",
      sourceType: "ad",
      ctwaClid: "clid-1",
      headline: "Terapia Ocupacional",
      body: "R$ 340/mês",
      sourceUrl: "https://fb.me/2aaYyDdMi0",
      mediaType: "image",
      imageUrl: "https://cdn.example/ad.jpg",
      videoUrl: "https://cdn.example/ad.mp4",
      thumbnailUrl: "https://cdn.example/thumb.jpg",
    });
  });

  it("mensagem sem referral não produz coluna", () => {
    expect(parseReferral({ type: "text", text: { body: "oi" } })).toBeNull();
    expect(compactReferral(info())).toBeNull();
  });

  it("persiste o JSON sem chaves vazias", () => {
    const json = compactReferral(
      info({
        sourceId: "120",
        sourceType: "ad",
        headline: "Terapia",
        imageUrl: "https://cdn.example/ad.jpg",
      }),
      { storedImageUrl: "/api/storage/org/inbound-media/referral-test.jpg" },
    );
    expect(json).toEqual({
      sourceId: "120",
      sourceType: "ad",
      headline: "Terapia",
      imageUrl: "https://cdn.example/ad.jpg",
      storedImageUrl: "/api/storage/org/inbound-media/referral-test.jpg",
    });
    expect(referralFromJson(json)).toEqual(json);
    expect(json && "body" in json).toBe(false);
  });
});

describe("buildMessageReferral", () => {
  it("falha no download não impede o referral", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("meta down");
      }),
    );
    const saved = await buildMessageReferral(
      "org_1",
      info({
        sourceId: "120",
        sourceType: "ad",
        imageUrl: "https://cdn.example/ad.jpg",
      }),
    );
    expect(saved).toMatchObject({
      sourceId: "120",
      sourceType: "ad",
      imageUrl: "https://cdn.example/ad.jpg",
    });
    expect(saved?.storedImageUrl).toBeUndefined();
    expect(saveFile).not.toHaveBeenCalled();
  });

  it("grava o criativo no storage da organização", async () => {
    const saved = await buildMessageReferral(
      "org_a",
      info({
        sourceId: "120",
        sourceType: "ad",
        imageUrl: "https://cdn.example/ad.jpg",
      }),
    );
    expect(saveFile).toHaveBeenCalledWith(
      expect.objectContaining({
        orgId: "org_a",
        bucket: "inbound-media",
      }),
    );
    expect(saved?.storedImageUrl).toBe(
      "/api/storage/org_a/inbound-media/referral-test.jpg",
    );
  });

  it("rejeita IP privado resolvido no DNS e não chama o storage", async () => {
    lookupMock.mockResolvedValue([{ address: "169.254.169.254", family: 4 }]);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const saved = await buildMessageReferral(
      "org_a",
      info({
        sourceId: "120",
        sourceType: "ad",
        imageUrl: "https://cdn.example/ad.jpg",
      }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(saveFile).not.toHaveBeenCalled();
    expect(saved?.imageUrl).toBe("https://cdn.example/ad.jpg");
    expect(saved?.storedImageUrl).toBeUndefined();
  });

  it("rejeita localhost e não chama o storage", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const saved = await buildMessageReferral(
      "org_a",
      info({
        sourceId: "120",
        sourceType: "ad",
        imageUrl: "http://127.0.0.1/ad.jpg",
      }),
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(saveFile).not.toHaveBeenCalled();
    expect(saved?.imageUrl).toBe("http://127.0.0.1/ad.jpg");
    expect(saved?.storedImageUrl).toBeUndefined();
  });
});
