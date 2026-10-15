import { afterEach, describe, expect, it } from "vitest";

import {
  publicMediaTokenMatches,
  rewriteStorageUrlsForWebhook,
  signPublicMediaToken,
  toPublicMediaUrl,
  verifyPublicMediaToken,
} from "@/lib/public-media-url";

const saved = { ...process.env };

afterEach(() => {
  process.env = { ...saved };
});

describe("URL pública da mídia recebida", () => {
  it("assina o arquivo e recusa outro caminho com o mesmo token", () => {
    process.env.AUTH_SECRET = "segredo-de-teste";
    process.env.NEXTAUTH_URL = "https://api.bwipo.com";
    const ref = {
      orgId: "org1",
      bucket: "inbound-media",
      fileName: "in_1_ab.pdf",
    };
    const token = signPublicMediaToken(ref);
    expect(token).toBeTruthy();
    expect(verifyPublicMediaToken(token!)).toEqual(ref);
    expect(publicMediaTokenMatches(token!, ref)).toBe(true);
    expect(
      publicMediaTokenMatches(token!, { ...ref, fileName: "in_1_ab.jpg" }),
    ).toBe(false);
    expect(verifyPublicMediaToken(`${token}x`)).toBeNull();
  });

  it("não publica bucket que não é mídia recebida", () => {
    process.env.AUTH_SECRET = "segredo-de-teste";
    expect(
      signPublicMediaToken({ orgId: "org1", bucket: "keeps", fileName: "a.pdf" }),
    ).toBeNull();
    expect(toPublicMediaUrl("/api/storage/org1/keeps/a.pdf")).toBeNull();
  });

  it("o webhook troca o caminho interno pela URL https com token", () => {
    process.env.AUTH_SECRET = "segredo-de-teste";
    process.env.NEXTAUTH_URL = "https://api.bwipo.com";
    const body = rewriteStorageUrlsForWebhook(
      '{"curso":"/api/storage/org1/inbound-media/in_1_ab.pdf"}',
    );
    expect(body.startsWith('{"curso":"https://api.bwipo.com/api/storage/org1/inbound-media/in_1_ab.pdf?t=')).toBe(
      true,
    );
    const again = rewriteStorageUrlsForWebhook(body);
    expect(again).toBe(body);
  });

  it("imagem já salva no campo também vira link público no webhook", () => {
    process.env.AUTH_SECRET = "segredo-de-teste";
    process.env.BACKEND_PUBLIC_URL = "https://api.bwipo.com";
    const url = toPublicMediaUrl("/api/storage/org1/inbound-media/in_2_cd.jpg");
    expect(url).toMatch(
      /^https:\/\/api\.bwipo\.com\/api\/storage\/org1\/inbound-media\/in_2_cd\.jpg\?t=/,
    );
  });
});
