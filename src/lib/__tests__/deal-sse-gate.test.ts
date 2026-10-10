/**
 * Gate de posse do `card` do `deal_moved` (`buildDealSseGate`): o mesmo
 * critério do GET /api/deals/:id, avaliado em memória por evento.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  getVisibilityFilter: vi.fn(),
}));

vi.mock("@/lib/authz", () => ({ loadAuthzContext: vi.fn() }));
vi.mock("@/lib/visibility", async (importOriginal) => ({
  canSeeDealByOwner: (await importOriginal<typeof import("@/lib/visibility")>()).canSeeDealByOwner,
  getDepartmentScopeForConversations: vi.fn(),
  getVisibilityFilter: h.getVisibilityFilter,
  permissionsAllowKey: vi.fn(),
}));

import { buildDealSseGate } from "@/lib/inbox-sse-card-visibility";

const user = { id: "u1", role: "MEMBER" as const, organizationId: "org1", isSuperAdmin: false };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("buildDealSseGate", () => {
  it("'só meus': vê os próprios; não vê de outro dono; sem dono só com o eixo 'sem responsável'", async () => {
    h.getVisibilityFilter.mockResolvedValue({ canSeeAll: false, includeUnassigned: false });
    const gate = await buildDealSseGate(user);
    expect(gate({ ownerId: "u1" })).toBe(true);
    expect(gate({ ownerId: "u2" })).toBe(false);
    expect(gate({ ownerId: null })).toBe(false);
    // Dono desconhecido (publisher antigo): fail-closed.
    expect(gate({ ownerId: undefined })).toBe(false);
  });

  it("'só meus' + pool livre: vê também o negócio sem dono", async () => {
    h.getVisibilityFilter.mockResolvedValue({ canSeeAll: false, includeUnassigned: true });
    const gate = await buildDealSseGate(user);
    expect(gate({ ownerId: null })).toBe(true);
    expect(gate({ ownerId: "u2" })).toBe(false);
  });

  it("quem vê tudo recebe o card de qualquer dono (inclusive desconhecido)", async () => {
    h.getVisibilityFilter.mockResolvedValue({ canSeeAll: true, includeUnassigned: true });
    const gate = await buildDealSseGate({ ...user, role: "MANAGER" as never });
    expect(gate({ ownerId: "u2" })).toBe(true);
    expect(gate({ ownerId: undefined })).toBe(true);
  });

  it("super-admin não consulta visibilidade e vê tudo", async () => {
    const gate = await buildDealSseGate({ ...user, isSuperAdmin: true });
    expect(gate({ ownerId: "qualquer" })).toBe(true);
    expect(h.getVisibilityFilter).not.toHaveBeenCalled();
  });

  it("monta a visibilidade do usuário da conexão", async () => {
    h.getVisibilityFilter.mockResolvedValue({ canSeeAll: false, includeUnassigned: false });
    await buildDealSseGate(user);
    expect(h.getVisibilityFilter).toHaveBeenCalledWith({ id: "u1", role: "MEMBER" });
  });
});
