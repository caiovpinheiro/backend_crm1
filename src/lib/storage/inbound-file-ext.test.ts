import { describe, expect, it } from "vitest";

import { inboundFileExt, mimeFromFilename } from "@/lib/storage/local";

const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

describe("inboundFileExt", () => {
  it("usa a extensão do tipo conhecido", () => {
    expect(inboundFileExt("application/pdf", "cv.pdf")).toBe("pdf");
    expect(inboundFileExt("image/jpeg", null)).toBe("jpg");
    expect(inboundFileExt("audio/ogg; codecs=opus", null)).toBe("ogg");
  });

  it("conhece pptx, ppt, odt, rtf, txt e markdown (DNAWORK #80191)", () => {
    expect(inboundFileExt(PPTX, "cv_drielly.pptx")).toBe("pptx");
    expect(inboundFileExt(PPTX, null)).toBe("pptx");
    expect(inboundFileExt("application/vnd.ms-powerpoint", null)).toBe("ppt");
    expect(inboundFileExt("application/vnd.oasis.opendocument.text", null)).toBe("odt");
    expect(inboundFileExt("application/rtf", null)).toBe("rtf");
    expect(inboundFileExt("text/plain", null)).toBe("txt");
    expect(inboundFileExt("text/markdown", null)).toBe("md");
  });

  it("tipo desconhecido ou genérico usa a extensão do nome original", () => {
    expect(inboundFileExt("application/octet-stream", "curriculo.docx")).toBe("docx");
    expect(inboundFileExt("application/x-iwork-pages-sffpages", "CV.Pages")).toBe("pages");
  });

  it("sem nome útil, não inventa extensão longa a partir do tipo", () => {
    expect(inboundFileExt("application/x-iwork-pages-sffpages", null)).toBe("bin");
    expect(inboundFileExt("application/octet-stream", "sem_extensao")).toBe("bin");
    expect(inboundFileExt("application/octet-stream", null)).toBe("bin");
  });

  it("subtipo curto e limpo continua valendo (heic, tiff, zip)", () => {
    expect(inboundFileExt("image/heic", null)).toBe("heic");
    expect(inboundFileExt("image/tiff", null)).toBe("tiff");
    expect(inboundFileExt("application/zip", null)).toBe("zip");
  });

  it("ignora extensão do nome com caracteres estranhos", () => {
    expect(inboundFileExt("application/octet-stream", "cv.p d/f")).toBe("bin");
  });
});

describe("mimeFromFilename (tipo servido ao n8n)", () => {
  it("serve pptx, odt e md com o tipo certo", () => {
    expect(mimeFromFilename("in_1_ab.pptx")).toBe(PPTX);
    expect(mimeFromFilename("in_1_ab.odt")).toBe("application/vnd.oasis.opendocument.text");
    expect(mimeFromFilename("in_1_ab.md")).toBe("text/markdown");
    expect(mimeFromFilename("in_1_ab.pdf")).toBe("application/pdf");
  });
});
