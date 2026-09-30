/**
 * SEC2-3 / SEC2-12 — gateway de storage: `Content-Disposition: attachment`
 * para documentos nos buckets de anexo (mídia continua inline) e sem o
 * header `X-Storage-Tenant`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { auth, readStoredFile } = vi.hoisted(() => ({
  auth: vi.fn(),
  readStoredFile: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth }));
vi.mock("@/lib/storage/local", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storage/local")>();
  return {
    ...actual,
    readStoredFile,
    readStoredFileRange: vi.fn(),
    statStoredFile: vi.fn(async () => null),
  };
});
vi.mock("@/lib/storage/migrate-from-legacy", () => ({
  persistLegacyBytesToActiveDriver: vi.fn(async () => undefined),
}));
vi.mock("@/lib/storage-object-access", () => ({
  authorizeStorageObject: vi.fn(async () => true),
}));
vi.mock("@/lib/storage/upstream-fallback", () => ({
  tryUpstreamFallback: vi.fn(async () => null),
}));

import { GET } from "./route";

function get(path: string): Request {
  return new Request(`http://localhost/api/storage/${path}`);
}

function ctx(path: string) {
  return { params: Promise.resolve({ path: path.split("/") }) };
}

function stored(mimeType: string, bytes = "hello") {
  const buffer = Buffer.from(bytes);
  return { buffer, mimeType, size: buffer.length };
}

describe("GET /api/storage/[...path] — Content-Disposition e X-Storage-Tenant", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auth.mockResolvedValue({
      user: { id: "u1", organizationId: "org1", isSuperAdmin: false, role: "MEMBER" },
    });
  });

  it("PDF no bucket attachments sai como attachment e sem X-Storage-Tenant", async () => {
    readStoredFile.mockResolvedValue(stored("application/pdf"));
    const res = await GET(get("org1/attachments/att-1.pdf"), ctx("org1/attachments/att-1.pdf"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Disposition")).toBe('attachment; filename="att-1.pdf"');
    expect(res.headers.get("X-Storage-Tenant")).toBeNull();
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
  });

  it("documento no bucket keeps também é attachment", async () => {
    readStoredFile.mockResolvedValue(stored("text/csv"));
    const res = await GET(get("org1/keeps/keep-1.csv"), ctx("org1/keeps/keep-1.csv"));
    expect(res.headers.get("Content-Disposition")).toMatch(/^attachment; /);
  });

  it("imagem no bucket attachments continua inline (renderizada por <img>)", async () => {
    readStoredFile.mockResolvedValue(stored("image/png"));
    const res = await GET(get("org1/attachments/att-2.png"), ctx("org1/attachments/att-2.png"));
    expect(res.headers.get("Content-Disposition")).toBe('inline; filename="att-2.png"');
    expect(res.headers.get("X-Storage-Tenant")).toBeNull();
  });

  it("bucket que não é de anexo (branding) fica inline", async () => {
    readStoredFile.mockResolvedValue(stored("application/pdf"));
    const res = await GET(get("org1/branding/manual.pdf"), ctx("org1/branding/manual.pdf"));
    expect(res.headers.get("Content-Disposition")).toMatch(/^inline; /);
  });

  it("outra org → 404 (isolamento preservado)", async () => {
    readStoredFile.mockResolvedValue(stored("application/pdf"));
    const res = await GET(get("org2/attachments/att-1.pdf"), ctx("org2/attachments/att-1.pdf"));
    expect(res.status).toBe(404);
    expect(readStoredFile).not.toHaveBeenCalled();
  });
});
