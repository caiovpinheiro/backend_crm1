import { describe, expect, it } from "vitest";

import {
  MEDIA_PROCESS_MAX_BYTES,
  MEDIA_PROXY_MAX_BYTES,
  MediaTooLargeError,
  contentLengthExceeds,
  readResponseBodyLimited,
} from "./media-byte-limits";

describe("contentLengthExceeds", () => {
  it("bloqueia Content-Length acima do teto do proxy", () => {
    const res = new Response(null, {
      headers: { "content-length": String(MEDIA_PROXY_MAX_BYTES + 1) },
    });
    expect(contentLengthExceeds(res, MEDIA_PROXY_MAX_BYTES)).toBe(true);
  });

  it("aceita abaixo do teto de transcrição", () => {
    const res = new Response(null, {
      headers: { "content-length": String(MEDIA_PROCESS_MAX_BYTES) },
    });
    expect(contentLengthExceeds(res, MEDIA_PROCESS_MAX_BYTES)).toBe(false);
  });
});

describe("readResponseBodyLimited", () => {
  it("lança  quando o header já estoura", async () => {
    const res = new Response("x", {
      headers: { "content-length": String(MEDIA_PROCESS_MAX_BYTES + 10) },
    });
    await expect(readResponseBodyLimited(res, MEDIA_PROCESS_MAX_BYTES)).rejects.toBeInstanceOf(
      MediaTooLargeError,
    );
  });

  it("lê body pequeno", async () => {
    const res = new Response(Buffer.from("abc"), {
      headers: { "content-length": "3" },
    });
    const buf = await readResponseBodyLimited(res, MEDIA_PROCESS_MAX_BYTES);
    expect(buf.toString()).toBe("abc");
  });
});
