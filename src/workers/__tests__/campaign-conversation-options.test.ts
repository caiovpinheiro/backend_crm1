/**
 * O ticket onde a campanha grava o envio é o do número que enviou. Sem o
 * canal, o ensure caía no canal padrão da org e abria ticket em outro número.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/prisma-base", () => ({ prismaBase: {} }));

import { campaignConversationOptions } from "@/workers/campaigns-worker";

describe("campaignConversationOptions", () => {
  it("passa o canal da campanha para o ticket", () => {
    expect(campaignConversationOptions("cand")).toEqual({
      inheritAssignee: false,
      skipActivityLog: true,
      skipTriggers: true,
      channelId: "cand",
    });
  });
  it("sem canal, mantém só as opções de sempre", () => {
    expect(campaignConversationOptions(null)).toEqual({
      inheritAssignee: false,
      skipActivityLog: true,
      skipTriggers: true,
    });
  });
});
