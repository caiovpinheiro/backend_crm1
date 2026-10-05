import { describe, expect, it } from "vitest";

import type { AuthzContext } from "@/lib/authz";
import { projectDealMovedForViewer } from "@/lib/authz/deal-moved-visibility";

function ctx(partial: Partial<AuthzContext> = {}): AuthzContext {
  return {
    userId: "u1",
    organizationId: "org1",
    isSuperAdmin: false,
    isAdmin: false,
    permissions: new Set(),
    stageView: null,
    stageDeny: new Set(),
    pipelineDeny: new Set(),
    stageEdit: null,
    fieldDenyView: new Set(),
    fieldDenyEdit: new Set(),
    sharedInbox: true,
    mediaAccess: true,
    seeTeam: false,
    seeUnassigned: false,
    ...partial,
  };
}

const event = {
  organizationId: "org1",
  dealId: "d1",
  fromPipelineId: "pipe-a",
  toPipelineId: "pipe-b",
  fromStageId: "stage-a",
  toStageId: "stage-b",
  position: 1,
  updatedAt: "2026-10-05T12:00:00.000Z",
  card: { id: "d1", title: "Lead", status: "OPEN" },
};

describe("projectDealMovedForViewer", () => {
  it("admin recebe o payload intacto (mesma referência)", () => {
    const data = { ...event };
    expect(projectDealMovedForViewer(data, ctx({ isAdmin: true }))).toBe(data);
    expect(projectDealMovedForViewer(data, null)).toBe(data);
  });

  it("quem vê os dois lados recebe o card", () => {
    expect(projectDealMovedForViewer(event, ctx())).toBe(event);
  });

  it("quem só vê a origem recebe o evento sem card", () => {
    const projected = projectDealMovedForViewer(
      event,
      ctx({ pipelineDeny: new Set(["pipe-b"]) }),
    ) as Record<string, unknown>;
    expect(projected.dealId).toBe("d1");
    expect(projected.fromPipelineId).toBe("pipe-a");
    expect(projected.toPipelineId).toBe("pipe-b");
    expect(projected).not.toHaveProperty("card");
  });

  it("quem só vê o destino recebe o card", () => {
    const projected = projectDealMovedForViewer(
      event,
      ctx({ pipelineDeny: new Set(["pipe-a"]) }),
    );
    expect(projected).toBe(event);
  });

  it("quem não vê nenhum dos funis não recebe o evento", () => {
    expect(
      projectDealMovedForViewer(
        event,
        ctx({ pipelineDeny: new Set(["pipe-a", "pipe-b"]) }),
      ),
    ).toBeNull();
  });

  it("etapa destino bloqueada tira o card; etapa origem bloqueada e destino livre mantém", () => {
    const hiddenDest = projectDealMovedForViewer(
      event,
      ctx({ stageDeny: new Set(["stage-b"]) }),
    ) as Record<string, unknown>;
    expect(hiddenDest).not.toHaveProperty("card");

    expect(
      projectDealMovedForViewer(event, ctx({ stageDeny: new Set(["stage-a"]) })),
    ).toBe(event);
  });

  it("os dois lados de etapa bloqueados descartam o evento", () => {
    expect(
      projectDealMovedForViewer(
        event,
        ctx({ stageDeny: new Set(["stage-a", "stage-b"]) }),
      ),
    ).toBeNull();
  });

  it("payload legado só com pipelineId segue intacto para o gate genérico", () => {
    const legacy = { pipelineId: "pipe-a", dealId: "d1" };
    expect(projectDealMovedForViewer(legacy, ctx({ pipelineDeny: new Set(["pipe-a"]) }))).toBe(
      legacy,
    );
  });
});
