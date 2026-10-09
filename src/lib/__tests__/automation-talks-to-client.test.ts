import { describe, expect, it } from "vitest";

import { automationTalksToClient } from "@/lib/automation-workflow";

describe("automationTalksToClient", () => {
  it("fluxo com mensagem, botões, pergunta ou espera fala com o cliente", () => {
    expect(automationTalksToClient([{ type: "move_stage" }, { type: "send_whatsapp_interactive" }])).toBe(true);
    expect(automationTalksToClient([{ type: "wait_for_reply" }])).toBe(true);
    expect(automationTalksToClient([{ type: "question" }])).toBe(true);
  });
  it("fluxo só de CRM (etapa, tag, campo, nota, distribuição) não fala com o cliente", () => {
    expect(automationTalksToClient([{ type: "move_stage" }, { type: "add_tag" }, { type: "update_field" }, { type: "create_conversation_note" }, { type: "execute_distribution" }])).toBe(false);
    expect(automationTalksToClient([])).toBe(false);
  });
});
