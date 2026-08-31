import { describe, expect, it } from "vitest";

import {
  classifyTemplateMediaUrl,
  collectTemplateMediaUrls,
} from "@/lib/storage/repair-template-media";

const ORG = "cmrmbn2lh0uz2nm016beqgbwb";
const OTHER = "clxxxxxxxxxxxxxxxxxxxxxxx";

describe("classifyTemplateMediaUrl", () => {
  it("marca /api/storage da mesma org como repairable", () => {
    const got = classifyTemplateMediaUrl(
      `/api/storage/${ORG}/automation-media/auto_1.jpg`,
      ORG,
    );
    expect(got.status).toBe("repairable");
    if (got.status === "repairable") {
      expect(got.parsed.bucket).toBe("automation-media");
      expect(got.parsed.fileName).toBe("auto_1.jpg");
    }
  });

  it("marca /uploads/<file> como repairable (automation-media)", () => {
    const got = classifyTemplateMediaUrl("/uploads/auto_old.mp4", ORG);
    expect(got.status).toBe("repairable");
    if (got.status === "repairable") {
      expect(got.parsed.bucket).toBe("automation-media");
      expect(got.parsed.fileName).toBe("auto_old.mp4");
    }
  });

  it("rejeita org diferente e URL externa (sem SSRF)", () => {
    expect(
      classifyTemplateMediaUrl(`/api/storage/${OTHER}/automation-media/x.mp4`, ORG)
        .status,
    ).toBe("not_storage");
    expect(classifyTemplateMediaUrl("https://evil.example/secret.mp4", ORG).status).toBe(
      "not_storage",
    );
    expect(classifyTemplateMediaUrl("https://cdn.example/img.jpg", ORG).status).toBe(
      "not_storage",
    );
  });

  it("trata vazio", () => {
    expect(classifyTemplateMediaUrl("   ", ORG).status).toBe("empty");
  });
});

describe("collectTemplateMediaUrls", () => {
  it("deduplica mediaUrl espelhado em attachments[0]", () => {
    const url = `/api/storage/${ORG}/automation-media/auto_1.jpg`;
    expect(
      collectTemplateMediaUrls({
        mediaUrl: url,
        attachments: [{ url, mimeType: "image/jpeg", name: "foto.jpg" }],
      }),
    ).toEqual([url]);
  });

  it("inclui anexos extras", () => {
    const a = `/api/storage/${ORG}/automation-media/a.jpg`;
    const b = `/uploads/b.mp4`;
    expect(
      collectTemplateMediaUrls({
        mediaUrl: a,
        attachments: [{ url: a }, { url: b }],
      }),
    ).toEqual([a, b]);
  });
});
