/**
 * Montagem do system prompt do agente (puro — sem side effects).
 * Usado pelo runner e pelo dump de baseline (Onda 0).
 */

import type { AIAgentAutonomy } from "@prisma/client";

import { getVerticalPack } from "@/verticals";
import type {
  OutputStyle,
  QualificationQuestion,
} from "@/lib/ai-agents/piloting";

/**
 * Regras de atendimento usadas quando `AIAgentConfig.steeringRules`
 * está vazio (agentes criados antes da pilotagem pelo CRM).
 * Pack null/ausente → string vazia (sem regras de vertical).
 */
export function fallbackSteeringRules(
  archetype: string,
  verticalPack?: string | null,
): string {
  return getVerticalPack(verticalPack)?.fallbackRules(archetype) ?? "";
}

export type TemplateVars = {
  agent_name?: string | null;
  company_name?: string | null;
  tone?: string | null;
  language?: string | null;
  contact_name?: string | null;
  contact_phone?: string | null;
  contact_tags?: string | null;
  deal_summary?: string | null;
  deal_stage?: string | null;
  deal_products?: string | null;
  last_human_interaction?: string | null;
};

const TEMPLATE_VAR_KEYS: Array<keyof TemplateVars> = [
  "agent_name",
  "company_name",
  "tone",
  "language",
  "contact_name",
  "contact_phone",
  "contact_tags",
  "deal_summary",
  "deal_stage",
  "deal_products",
  "last_human_interaction",
];

/**
 * Substitui `{{var}}` no template. Se alguma var da linha não tiver valor,
 * remove a linha inteira (não deixa string vazia).
 */
export function renderTemplateVars(
  template: string,
  vars: TemplateVars,
): string {
  const lines = template.split(/\r?\n/);
  const out: string[] = [];
  for (const line of lines) {
    const placeholders = [...line.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)];
    let drop = false;
    for (const m of placeholders) {
      const key = m[1] as keyof TemplateVars;
      if (!TEMPLATE_VAR_KEYS.includes(key)) continue;
      const val = vars[key];
      if (val == null || String(val).trim() === "") {
        drop = true;
        break;
      }
    }
    if (drop) continue;
    let rendered = line;
    for (const key of TEMPLATE_VAR_KEYS) {
      const val = vars[key];
      if (val == null || String(val).trim() === "") continue;
      const re = new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, "g");
      rendered = rendered.replace(re, String(val).trim());
    }
    out.push(rendered);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

export type RenderArgs = {
  template: string;
  override: string | null;
  productPolicy: string | null;
  hasProductSearch: boolean;
  hasEnrollmentLookup: boolean;
  tone: string;
  language: string;
  autonomyMode: AIAgentAutonomy;
  contact: {
    name: string | null;
    email: string | null;
    phone: string | null;
    lifecycleStage: string | null;
    tags: Array<{ tag: { name: string } }>;
  } | null;
  deal: {
    title: string;
    value: unknown;
    stage: {
      name: string;
      pipeline?: { name: string } | null;
    } | null;
  } | null;
  retrievalBlock: string;
  qualificationQuestions: QualificationQuestion[];
  outputStyle: OutputStyle;
  /** Variáveis `{{...}}` do template. */
  templateVars?: TemplateVars;
};

/** Render do system prompt — mesma função usada pelo runner em produção. */
export function renderSystemPrompt(args: RenderArgs): string {
  const lines: string[] = [];
  const rawTemplate = args.template ?? "";
  const templateHadToneOrLang =
    /\{\{\s*tone\s*\}\}/i.test(rawTemplate) ||
    /\{\{\s*language\s*\}\}/i.test(rawTemplate);

  const renderedTemplate = renderTemplateVars(rawTemplate, {
    tone: args.tone,
    language: args.language,
    contact_name: args.contact?.name ?? null,
    contact_phone: args.contact?.phone ?? null,
    contact_tags:
      args.contact?.tags.map((t) => t.tag.name).filter(Boolean).join(", ") ||
      null,
    deal_summary: args.deal?.title ?? null,
    deal_stage: args.deal?.stage?.name ?? null,
    ...args.templateVars,
  });

  if (renderedTemplate) lines.push(renderedTemplate);
  lines.push("");

  // Evita duplicar tom/idioma quando o template já usa {{tone}}/{{language}}.
  if (!templateHadToneOrLang) {
    lines.push(`Idioma: ${args.language}. Tom: ${args.tone}.`);
  }

  if (args.autonomyMode === "DRAFT") {
    lines.push(
      "IMPORTANTE: você está em modo RASCUNHO. Sua resposta será revisada por um humano antes de ser enviada. Seja conciso.",
    );
  }

  if (args.contact) {
    lines.push("");
    lines.push("CONTATO:");
    if (args.contact.name) lines.push(`- Nome: ${args.contact.name}`);
    if (args.contact.email) lines.push(`- Email: ${args.contact.email}`);
    if (args.contact.phone) lines.push(`- Telefone: ${args.contact.phone}`);
    if (args.contact.lifecycleStage)
      lines.push(`- Estágio do ciclo: ${args.contact.lifecycleStage}`);
    const tags = args.contact.tags.map((t) => t.tag.name).filter(Boolean);
    if (tags.length) lines.push(`- Tags: ${tags.join(", ")}`);
  }

  if (args.deal) {
    lines.push("");
    lines.push("DEAL ATUAL:");
    lines.push(`- Título: ${args.deal.title}`);
    if (args.deal.value) lines.push(`- Valor: R$ ${String(args.deal.value)}`);
    if (args.deal.stage?.pipeline?.name)
      lines.push(`- Funil: ${args.deal.stage.pipeline.name}`);
    if (args.deal.stage) lines.push(`- Estágio: ${args.deal.stage.name}`);
    lines.push(
      "- Funil/Estágio é só contexto. NÃO transfira só por causa do funil — atenda primeiro; use departamento certo só quando for distribuir de verdade.",
    );
  }

  if (args.hasEnrollmentLookup) {
    lines.push("");
    lines.push(
      "Lembrete: chame `consultar_matricula` cedo no atendimento para personalizar com o relatório de matriculados.",
    );
  }

  if (args.override?.trim()) {
    lines.push("");
    lines.push("INSTRUÇÕES ESPECÍFICAS:");
    lines.push(args.override.trim());
  }

  if (args.outputStyle === "conversational") {
    lines.push("");
    lines.push("ESTILO DE RESPOSTA (regra dura):");
    lines.push(
      "- Você está escrevendo no WhatsApp. Responda como atendente humano, em texto corrido. Nunca use listas com bullets, tabelas, cabeçalhos em markdown, ou frases template tipo 'Aqui estão os detalhes:'.",
    );
    lines.push(
      "- PROIBIDO: formato de ficha técnica como '*Curso:* X', '*Modalidade:* Y', '*Duração:* Z' com ícones/emojis por linha. Isso soa robótico.",
    );
    lines.push(
      "- Use no máximo 1–2 emojis discretos na mensagem inteira, e só se combinar com o tom.",
    );
    lines.push(
      "- Prefira 1 a 4 frases curtas. Pode terminar com UMA pergunta curta **só se** ainda faltar um dado para ajudar.",
    );
    lines.push(
      "- Se o contato já pediu o passo a passo/site/link ou disse sim/pode ser/envie: ENTREGUE a orientação (com link das refs se houver). NÃO termine de novo perguntando se ele quer as instruções.",
    );
    lines.push(
      "- PROIBIDO prometer ou fingir envio de vídeo/arquivo (ex.: 'vou te enviar o vídeo', '[Envio do vídeo]'). Sem URL nas refs, só texto; com URL, cole o link.",
    );
  }

  if (args.qualificationQuestions.length > 0) {
    lines.push("");
    lines.push(
      "QUALIFICAÇÃO — informações que você DEVE coletar antes de encerrar a conversa ou transferir para humano:",
    );
    for (const q of args.qualificationQuestions) {
      const hint = q.hint ? ` (formato: ${q.hint})` : "";
      lines.push(`- ${q.question}${hint}`);
    }
    lines.push(
      "Regras: não peça tudo de uma vez. Vá coletando naturalmente no fluxo da conversa, uma pergunta por vez quando fizer sentido. NÃO chame `transfer_to_human` enquanto tiver informação pendente dessa lista, salvo se o cliente pedir explicitamente pra falar com atendente ou demonstrar irritação.",
    );
  }

  if (args.hasProductSearch) {
    lines.push("");
    lines.push("CONSULTA DE PRODUTOS — regras obrigatórias:");
    lines.push(
      "- Sempre que o cliente mencionar um produto, curso, serviço, preço ou característica, chame `search_products` ANTES de responder. Nunca invente preço, duração, modalidade ou condição.",
    );
    lines.push(
      "- Se a busca não encontrar, diga naturalmente que vai confirmar com o time e ofereça transferir pra um atendente. Não force uma resposta.",
    );
    lines.push("");
    lines.push("COMO APRESENTAR O PRODUTO (MUITO IMPORTANTE):");
    lines.push(
      "- Responda como um atendente humano no WhatsApp, não como uma ficha técnica. O objetivo é avançar a conversa, não cuspir dados.",
    );
    lines.push(
      "- PROIBIDO: listas com bullets de atributos (ex.: '*Nome:* ... *Preço:* ... *Duração:* ...'), markdown pesado, frases como 'Aqui estão os detalhes:'. Isso assusta o cliente e soa robótico.",
    );
    lines.push(
      "- Responda em 1 a 3 frases curtas, em texto corrido, misturando as informações naturalmente. Ex.: 'O curso de Administração é EAD, dura 4 anos (8 semestres) e sai por R$ 145 por mês — e agora ainda tem 45% de desconto ativo. Quer que eu te ajude a seguir com a inscrição?'",
    );
    lines.push(
      "- Sempre termine com UMA única pergunta curta que faça a conversa avançar (ex.: 'quer que eu te mande o link de inscrição?', 'faz sentido pra você começar em que mês?'). Evite múltiplas perguntas na mesma mensagem.",
    );
    lines.push(
      "- Só detalhe (em texto corrido, ainda sem bullets) mais atributos se o cliente pedir explicitamente. Em dúvida, mostre o essencial e pergunte o que mais ele quer saber.",
    );
    lines.push(
      "- Use no máximo 1 emoji discreto quando fizer sentido pelo tom configurado. Não repita emojis.",
    );
    lines.push(
      "- Dados técnicos da tool (`priceFormatted`, `customFields`, etc.) servem como FONTE, não como TEMPLATE de saída. Transforme em fala natural.",
    );
    if (args.productPolicy?.trim()) {
      lines.push("");
      lines.push("POLÍTICA ADICIONAL DE APRESENTAÇÃO DE PRODUTOS (do operador):");
      lines.push(args.productPolicy.trim());
    }
  }

  if (args.retrievalBlock) {
    lines.push(args.retrievalBlock);
  }

  return lines.join("\n");
}
