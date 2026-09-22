import { describe, expect, it } from "vitest";

import { resolveMetaMediaAccess, type MetaMediaLookup } from "./meta-media-access";

const ORG = "org_a";
const META = "https://lookaside.fbsbx.com/whatsapp_file/abc";

function lookup(partial: Partial<MetaMediaLookup>): MetaMediaLookup {
  return {
    findMessageChannel: async () => null,
    findContactAvatar: async () => false,
    findOrgMetaChannel: async () => null,
    ...partial,
  };
}

describe("resolveMetaMediaAccess", () => {
  it("recusa URL Meta sem vínculo com a org", async () => {
    const got = await resolveMetaMediaAccess(ORG, META, lookup({}), "env-token");
    expect(got).toBeNull();
  });

  it("recusa host fora da allowlist mesmo com mensagem", async () => {
    const got = await resolveMetaMediaAccess(
      ORG,
      "http://127.0.0.1/ssrf",
      lookup({
        findMessageChannel: async () => ({
          provider: "META_CLOUD_API",
          config: { accessToken: "tok" },
        }),
      }),
      "env-token",
    );
    expect(got).toBeNull();
  });

  it("aceita mídia da org e prefere token do canal", async () => {
    const got = await resolveMetaMediaAccess(
      ORG,
      META,
      lookup({
        findMessageChannel: async () => ({
          provider: "META_CLOUD_API",
          config: { accessToken: "channel-token" },
        }),
      }),
      "env-token",
    );
    expect(got).toEqual({ token: "channel-token" });
  });

  it("aceita avatar da org com token de ambiente se o canal não tiver", async () => {
    const got = await resolveMetaMediaAccess(
      ORG,
      META,
      lookup({ findContactAvatar: async () => true }),
      "env-token",
    );
    expect(got).toEqual({ token: "env-token" });
  });
});
