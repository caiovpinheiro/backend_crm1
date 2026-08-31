import { describe, expect, it } from "vitest";

import {
  firstNonNull,
  isReusableVideoFileName,
  locateReuseDeadlineMs,
  LOCATE_REUSE_DEADLINE_MS,
  LOCATE_REUSE_VIDEO_DEADLINE_MS,
  resolveOrgOwnedReuseUrl,
  resolveOutboundAttachmentMime,
  reuseFileNameAliases,
} from "@/lib/storage/local";

const ORG = "cmrmbn2lh0uz2nm016beqgbwb";
const OTHER = "clxxxxxxxxxxxxxxxxxxxxxxx";

describe("resolveOrgOwnedReuseUrl", () => {
  it("aceita /api/storage/<org>/automation-media/<file> da mesma org", () => {
    const got = resolveOrgOwnedReuseUrl(
      `/api/storage/${ORG}/automation-media/auto_1784899629445_x7741m.mp4`,
      ORG,
    );
    expect(got).toEqual({
      url: `/api/storage/${ORG}/automation-media/auto_1784899629445_x7741m.mp4`,
      orgId: ORG,
      bucket: "automation-media",
      fileName: "auto_1784899629445_x7741m.mp4",
    });
  });

  it("aceita URL absoluta cujo pathname é /api/storage/...", () => {
    const got = resolveOrgOwnedReuseUrl(
      `https://api.bwipo.com/api/storage/${ORG}/attachments/att_1.jpg`,
      ORG,
    );
    expect(got?.bucket).toBe("attachments");
    expect(got?.fileName).toBe("att_1.jpg");
    expect(got?.orgId).toBe(ORG);
  });

  it("aceita URL absoluta do tenant (pathname /api/storage/...)", () => {
    const got = resolveOrgOwnedReuseUrl(
      `https://acme.bwipo.com/api/storage/${ORG}/automation-media/auto_1785342090743_56a2o7.jpg`,
      ORG,
    );
    expect(got?.bucket).toBe("automation-media");
    expect(got?.fileName).toBe("auto_1785342090743_56a2o7.jpg");
    expect(got?.orgId).toBe(ORG);
  });

  it("alias jpg ↔ jpeg no mesmo stem", () => {
    expect(reuseFileNameAliases("auto_1.jpg")).toEqual(
      expect.arrayContaining(["auto_1.jpg", "auto_1.jpeg"]),
    );
    expect(reuseFileNameAliases("auto_1.jpeg")).toEqual(
      expect.arrayContaining(["auto_1.jpeg", "auto_1.jpg"]),
    );
    expect(reuseFileNameAliases("clip.mp4")).toEqual(
      expect.arrayContaining(["clip.mp4", "clip.MP4"]),
    );
  });

  it("rejeita org diferente (sem SSRF / tenant escape)", () => {
    expect(
      resolveOrgOwnedReuseUrl(`/api/storage/${OTHER}/automation-media/x.mp4`, ORG),
    ).toBeNull();
  });

  it("rejeita bucket fora da whitelist de reuse", () => {
    expect(
      resolveOrgOwnedReuseUrl(`/api/storage/${ORG}/branding/logo.png`, ORG),
    ).toBeNull();
    expect(
      resolveOrgOwnedReuseUrl(`/api/storage/${ORG}/avatars/u.jpg`, ORG),
    ).toBeNull();
  });

  it("rejeita esquemas perigosos e URL externa que não é storage", () => {
    expect(resolveOrgOwnedReuseUrl("https://evil.example/secret.mp4", ORG)).toBeNull();
    expect(resolveOrgOwnedReuseUrl("data:video/mp4;base64,xxxx", ORG)).toBeNull();
    expect(resolveOrgOwnedReuseUrl("//evil.example/x.mp4", ORG)).toBeNull();
    expect(resolveOrgOwnedReuseUrl("file:///etc/passwd", ORG)).toBeNull();
  });

  it("mapeia /uploads/<file> para automation-media da org", () => {
    const got = resolveOrgOwnedReuseUrl("/uploads/auto_old.mp4", ORG);
    expect(got).toMatchObject({
      orgId: ORG,
      bucket: "automation-media",
      fileName: "auto_old.mp4",
      legacyRelative: "auto_old.mp4",
    });
    expect(got?.url).toBe(`/api/storage/${ORG}/automation-media/auto_old.mp4`);
  });

  it("mapeia /uploads/<reuse-bucket>/<file>", () => {
    const got = resolveOrgOwnedReuseUrl("/uploads/attachments/att_1.jpg", ORG);
    expect(got).toMatchObject({
      bucket: "attachments",
      fileName: "att_1.jpg",
      legacyRelative: "attachments/att_1.jpg",
    });
  });

  it("rejeita /uploads/ com traversal ou bucket proibido", () => {
    expect(resolveOrgOwnedReuseUrl("/uploads/../etc/passwd", ORG)).toBeNull();
    expect(resolveOrgOwnedReuseUrl("/uploads/branding/logo.png", ORG)).toBeNull();
    expect(resolveOrgOwnedReuseUrl("/uploads/a/b/c.mp4", ORG)).toBeNull();
  });
});

describe("resolveOutboundAttachmentMime", () => {
  it("trata WhatsApp Video .mp4 e key .mp4 como vídeo, nunca audio/mp4", () => {
    expect(
      resolveOutboundAttachmentMime({
        fileNames: ["WhatsApp Video 2026-08-31 at 12.00.00.mp4"],
      }),
    ).toBe("video/mp4");
    expect(
      resolveOutboundAttachmentMime({
        rawType: "audio/mp4",
        fileNames: ["WhatsApp Video 2026-08-31 at 12.00.00.mp4"],
      }),
    ).toBe("video/mp4");
    expect(
      resolveOutboundAttachmentMime({
        rawType: "",
        fileNames: ["WhatsApp Video 2026-08-31 at 12.00.00.mp4", "auto_1.mp4"],
      }),
    ).toBe("video/mp4");
    expect(
      resolveOutboundAttachmentMime({
        rawType: "audio/mpeg",
        fileNames: ["nota.mp3", "auto_1785341950642_f7nyxi.mp4"],
      }),
    ).toBe("video/mp4");
  });

  it("preserva áudio real (ogg/opus/mp3/m4a)", () => {
    expect(
      resolveOutboundAttachmentMime({ fileNames: ["WhatsApp Audio 2026.ogg"] }),
    ).toBe("audio/ogg");
    expect(resolveOutboundAttachmentMime({ fileNames: ["voz.opus"] })).toBe(
      "audio/opus",
    );
    expect(resolveOutboundAttachmentMime({ fileNames: ["musica.mp3"] })).toBe(
      "audio/mpeg",
    );
    expect(resolveOutboundAttachmentMime({ fileNames: ["clip.m4a"] })).toBe("audio/mp4");
    expect(
      resolveOutboundAttachmentMime({
        rawType: "audio/ogg; codecs=opus",
        fileNames: ["ptt.ogg"],
      }),
    ).toBe("audio/ogg");
  });

  it("aceita mediaType/mimeType de modelo (video sem extensão no display)", () => {
    expect(
      resolveOutboundAttachmentMime({
        rawType: "video",
        fileNames: ["Apresentação"],
      }),
    ).toBe("video/mp4");
    expect(
      resolveOutboundAttachmentMime({
        rawType: "video/mp4",
        fileNames: ["Apresentação"],
      }),
    ).toBe("video/mp4");
  });
});

describe("locate reuse video vs image", () => {
  it("dá mais tempo para mp4 do que para jpg", () => {
    expect(isReusableVideoFileName("auto_1785341950642_f7nyxi.mp4")).toBe(true);
    expect(isReusableVideoFileName("auto_1.jpg")).toBe(false);
    expect(locateReuseDeadlineMs("auto_1.jpg")).toBe(LOCATE_REUSE_DEADLINE_MS);
    expect(locateReuseDeadlineMs("auto_1785341950642_f7nyxi.mp4")).toBe(
      LOCATE_REUSE_VIDEO_DEADLINE_MS,
    );
  });

  it("firstNonNull devolve o hit rápido sem esperar a promise lenta", async () => {
    const slow = new Promise<string | null>((resolve) => {
      setTimeout(() => resolve("late"), 250);
    });
    const fast = Promise.resolve("hit");
    const t0 = Date.now();
    await expect(firstNonNull([slow, fast])).resolves.toBe("hit");
    expect(Date.now() - t0).toBeLessThan(120);
  });
});
