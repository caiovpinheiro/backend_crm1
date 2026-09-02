import { describe, expect, it } from "vitest";

import {
  departmentTransferDistributionInput,
  transferDistributionFromQueueOutcome,
} from "../transfer-distribution";

describe("departmentTransferDistributionInput", () => {
  it("reassign quando só o departamento é escolhido", () => {
    expect(
      departmentTransferDistributionInput({
        conversationId: "c1",
        contactId: "ct1",
        departmentId: "d1",
        explicitAgent: false,
      }).reassign,
    ).toBe(true);
  });

  it("não reassign quando o operador já escolheu um agente", () => {
    expect(
      departmentTransferDistributionInput({
        conversationId: "c1",
        contactId: "ct1",
        departmentId: "d1",
        explicitAgent: true,
      }).reassign,
    ).toBe(false);
  });
});

describe("transferDistributionFromQueueOutcome", () => {
  it("QUEUED conta como sucesso (worker ainda vai atribuir)", () => {
    expect(
      transferDistributionFromQueueOutcome({
        kind: "queued",
        jobId: "job-1",
      }),
    ).toEqual({
      success: true,
      reason: "QUEUED",
      selectedUserId: null,
      selectedUserName: null,
    });
  });

  it("propaga o resultado do motor", () => {
    expect(
      transferDistributionFromQueueOutcome({
        kind: "result",
        result: {
          success: false,
          reason: "NO_ELIGIBLE_RESPONSIBLE",
          selectedUserId: null,
          selectedUserName: null,
          evaluated: [],
        },
      }),
    ).toMatchObject({
      success: false,
      reason: "NO_ELIGIBLE_RESPONSIBLE",
    });
  });

  it("fila indisponível não inventa sucesso", () => {
    expect(
      transferDistributionFromQueueOutcome({ kind: "unavailable" }),
    ).toBeNull();
  });
});
