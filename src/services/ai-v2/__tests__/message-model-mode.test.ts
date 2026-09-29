import { describe, expect, it } from "vitest";

import { v2AgentConfigSchema } from "@/lib/ai-v2/config";
import { messageModelFilesOnly, messageModelModeFor, messageModelPromptRule } from "@/lib/ai-v2/message-model-mode";

describe("material + mensagem pronta — modo escolhido pelo administrador", () => {
  const config = { messageModelMode: "both" as const, themes: [{ id: "a", messageModelMode: "combine" as const }, { id: "b" }] };

  it("assunto com modo próprio vale; sem modo, o do agente; sem nada, automático", () => {
    expect(messageModelModeFor(config, "a")).toBe("combine");
    expect(messageModelModeFor(config, "b")).toBe("both");
    expect(messageModelModeFor({}, "b")).toBe("auto");
  });

  it("só a resposta e combinar mandam só os arquivos da mensagem pronta", () => {
    expect(messageModelFilesOnly("answer")).toBe(true);
    expect(messageModelFilesOnly("combine")).toBe(true);
    expect(messageModelFilesOnly("both")).toBe(false);
    expect(messageModelFilesOnly("message_model")).toBe(false);
  });

  it("a instrução ao modelo muda com o modo", () => {
    expect(messageModelPromptRule("message_model")).toContain("frase curta de introdução");
    expect(messageModelPromptRule("both")).toContain("Responda normalmente");
    expect(messageModelPromptRule("combine")).toContain("junte o conteúdo");
    expect(messageModelPromptRule("answer")).toContain("só os arquivos");
  });

  it("a config aceita o modo no agente e no assunto", () => {
    const parsed = v2AgentConfigSchema.parse({ name: "A", tone: "cordial", messageModelMode: "answer", themes: [{ id: "t", name: "T", instructions: "", messageModelMode: "combine" }] });
    expect(parsed.messageModelMode).toBe("answer");
    expect(parsed.themes[0].messageModelMode).toBe("combine");
  });
});
