/**
 * Montagem do prompt da v2 simples.
 *
 * - Sem termos acadêmicos no código.
 * - Toda informação de domínio vem da configuração do agente.
 * - Saída obrigatória em JSON com shape conhecido (validado por Zod depois).
 */

import type { SimpleConfig, SimpleContext, SimpleMode } from "@/lib/ai-simple/types";

function renderTemplate(text: string, vars: Record<string, string | undefined>): string {
  return text.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_match, key) => {
    const value = vars[key];
    return value === undefined || value === null ? "" : String(value);
  });
}

export function buildSimpleSystemPrompt(
  config: SimpleConfig,
  ctx: SimpleContext,
): string {
  const lines: string[] = [];

  lines.push(`Você é um atendente virtual. Tom de voz: ${config.tone}.`);
  lines.push("Responda SEMPRE em português do Brasil.");
  lines.push("");

  if (config.rules.trim()) {
    lines.push("## REGRAS DE ATENDIMENTO");
    lines.push(config.rules.trim());
    lines.push("");
  }

  lines.push("## INSTRUÇÃO DE PLATAFORMA (sempre válida)");
  lines.push("- Nunca afirme ao cliente que realizou uma ação que não esteja no campo 'actions' da sua resposta.");
  lines.push("- Se não souber a resposta ou o tema exigir um humano, coloque 'handoff' = true.");
  lines.push("- As ações são executadas automaticamente. Só liste ações que realmente devem ser executadas neste turno.");
  lines.push("- Só pode alterar os campos listados em 'allowed_fields'.");
  lines.push("");

  if (config.knowledge.trim()) {
    lines.push("## BASE DE CONHECIMENTO");
    lines.push(config.knowledge.trim());
    lines.push("");
  }

  if (config.modes.length > 0) {
    lines.push("## MODOS DE ATENDIMENTO");
    for (const mode of config.modes) {
      lines.push(`- ${mode.id}: quando a mensagem for sobre "${mode.when}" → ${mode.instructions}`);
    }
    lines.push("Escolha um mode.id e coloque em 'mode' da resposta, ou null se nenhum casar.");
    lines.push("");
  }

  lines.push("## CONTEXTO DO CLIENTE");
  if (ctx.contact && Object.keys(ctx.contact).length > 0) {
    for (const key of config.contextFields.contact) {
      const value = pickField(ctx.contact, key);
      if (value !== undefined && value !== null && value !== "") {
        lines.push(`- ${key}: ${String(value)}`);
      }
    }
  }
  if (ctx.deal && Object.keys(ctx.deal).length > 0) {
    for (const key of config.contextFields.deal) {
      const value = pickField(ctx.deal, key);
      if (value !== undefined && value !== null && value !== "") {
        lines.push(`- deal.${key}: ${String(value)}`);
      }
    }
  } else {
    lines.push("- Nenhum negócio/deal aberto encontrado para este contato.");
  }
  lines.push("");

  lines.push("## ESTADO ATUAL DA CONVERSA");
  lines.push(`- stage: ${ctx.state.stage}`);
  lines.push(`- mode: ${ctx.state.mode ?? "nenhum"}`);
  lines.push("");

  lines.push("## FERRAMENTAS DISPONÍVEIS");
  lines.push("Você só pode usar as ferramentas listadas em 'actions'. NUNCA afirme que executou algo que não esteja em 'actions'.");
  for (const tool of config.allowedActions) {
    lines.push(`- ${tool}`);
  }
  lines.push("");

  lines.push("## FORMATO OBRIGATÓRIO DA RESPOSTA (JSON)");
  lines.push(JSON.stringify({
    reply: "texto da resposta ao cliente",
    confirmed: true,
    mode: "id de um mode ou null",
    actions: [
      { tool: "add_tag", args: { tagName: "nome_da_tag" } },
      { tool: "create_activity", args: { type: "NOTE", title: "Nota", description: "texto" } },
      { tool: "create_deal", args: { title: "Título do negócio", value: 0, notes: "nota" } },
      { tool: "move_stage", args: { stageName: "Nome do estágio", reason: "motivo" } },
      { tool: "search_products", args: { query: "termo", type: "PRODUCT", limit: 5 } },
      { tool: "send_whatsapp_template", args: { templateName: "nome_template", bodyVariables: ["var1"] } },
    ],
    handoff: false,
    reason: "motivo curto da decisão",
  }, null, 2));
  lines.push("");

  return lines.join("\n").trim();
}

function pickField(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function buildSimpleVars(ctx: SimpleContext): Record<string, string | undefined> {
  return {
    "contact.name": stringField(ctx.contact, "name"),
    "contact.firstName": stringField(ctx.contact, "name")?.split(/\s+/)[0],
    "contact.phone": stringField(ctx.contact, "phone"),
    "contact.email": stringField(ctx.contact, "email"),
    "deal.title": stringField(ctx.deal, "title"),
    "deal.stage.name": nestedString(ctx.deal, "stage", "name"),
  };
}

function stringField(obj: Record<string, unknown> | null, key: string): string | undefined {
  if (!obj) return undefined;
  const value = obj[key];
  return typeof value === "string" ? value : undefined;
}

function nestedString(
  obj: Record<string, unknown> | null,
  ...path: string[]
): string | undefined {
  if (!obj) return undefined;
  let current: unknown = obj;
  for (const part of path) {
    if (current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === "string" ? current : undefined;
}

export function buildSimpleConfirmationMessage(config: SimpleConfig, ctx: SimpleContext): string {
  return renderTemplate(config.confirmationMessage, buildSimpleVars(ctx));
}

export function buildSimpleIdentificationMessage(config: SimpleConfig, ctx: SimpleContext): string {
  return renderTemplate(config.identificationMessage, buildSimpleVars(ctx));
}

export function buildSimpleHandoffMessage(config: SimpleConfig, ctx: SimpleContext): string {
  return renderTemplate(config.handoffMessage, buildSimpleVars(ctx));
}
