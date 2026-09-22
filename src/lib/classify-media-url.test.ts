import { describe, expect, it } from "vitest";

import { classifyMediaUrl, extractMediaProxyTarget } from "./classify-media-url";
import { isAllowedMetaMediaUrl } from "./meta-media-url";

describe("extractMediaProxyTarget", () => {
  it("lê a URL da query do proxy", () => {
    const inner = "https://lookaside.fbsbx.com/whatsapp_file/?x=1";
    const raw = `/api/media/proxy?url=${encodeURIComponent(inner)}`;
    expect(extractMediaProxyTarget(raw)).toBe(inner);
  });
});

describe("classifyMediaUrl", () => {
  it("classifica proxy Meta, storage e uploads", () => {
    const meta = "https://scontent.whatsapp.net/v/t.ogg";
    expect(classifyMediaUrl(`/api/media/proxy?url=${encodeURIComponent(meta)}`)).toEqual({
      kind: "meta",
      url: meta,
    });
    expect(
      classifyMediaUrl("/api/storage/clxxxxxxxxxxxxxxxxxxxxxxxxx/inbound-media/a.ogg"),
    ).toMatchObject({ kind: "storage", bucket: "inbound-media" });
    expect(classifyMediaUrl("/uploads/audio.ogg")).toEqual({
      kind: "uploads",
      relative: "audio.ogg",
    });
  });

  it("não trata loopback como storage", () => {
    expect(classifyMediaUrl("http://127.0.0.1/secret")).toEqual({
      kind: "meta",
      url: "http://127.0.0.1/secret",
    });
    expect(isAllowedMetaMediaUrl("http://127.0.0.1/secret")).toBe(false);
  });
});
