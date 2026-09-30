/**
 * SEC-15 — /api/csp-report só loga (nunca persiste) e limita o corpo.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { warn } = vi.hoisted(() => ({ warn: vi.fn() }));

vi.mock("@/lib/logger", () => ({
  getLogger: () => ({ warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { POST } from "./route";

function post(body: string, headers: Record<string, string> = {}): Request {
  return new Request("http://localhost/api/csp-report", {
    method: "POST",
    headers: { "content-type": "application/csp-report", ...headers },
    body,
  });
}

describe("POST /api/csp-report", () => {
  beforeEach(() => warn.mockReset());

  it("204 e loga só os campos relevantes do relatório", async () => {
    const res = await POST(
      post(
        JSON.stringify({
          "csp-report": {
            "document-uri": "https://api.test/x",
            "violated-directive": "script-src",
            "blocked-uri": "inline",
            "script-sample": "alert(1) // não deve ser logado",
          },
        }),
      ),
    );
    expect(res.status).toBe(204);
    expect(warn).toHaveBeenCalledTimes(1);
    const payload = warn.mock.calls[0][0] as { cspReport: Record<string, unknown> };
    expect(payload.cspReport["violated-directive"]).toBe("script-src");
    expect(payload.cspReport["script-sample"]).toBeUndefined();
  });

  it("413 quando o corpo passa do limite", async () => {
    const res = await POST(post("x".repeat(20 * 1024)));
    expect(res.status).toBe(413);
    expect(warn).not.toHaveBeenCalled();
  });

  it("JSON inválido → 204 silencioso", async () => {
    const res = await POST(post("{nope"));
    expect(res.status).toBe(204);
    expect(warn).not.toHaveBeenCalled();
  });
});
