/**
 * Exportação das regras do agente: uma ficha legível (Markdown) com toda a
 * configuração, os nomes no lugar dos ids e, no topo, os pontos de atenção
 * que dá para detectar só olhando a configuração (gaps). Serve para revisar
 * com a equipe ou colar numa IA para análise. Nenhum domínio de cliente.
 */

import type { V2AgentConfig, V2Destination, V2FieldConfig, V2PostCloseCaseBehavior, V2ReplyEnding, V2Rule, V2Theme } from "@/lib/ai-v2/types";
import { HUMAN_REQUEST_PHRASES } from "@/lib/ai-v2/config";
import { FACT_IN_SENTENCE } from "./ground-reply";

export type V2ExportNames = {
  departments: Record<string, string>;
  users: Record<string, string>;
  distributionRules: Record<string, string>;
  aiAgents: Record<string, { name: string; engine: string; active: boolean }>;
  messageModels: Record<string, string>;
  docs: Record<string, { title: string; status: string; validUntil: string | null; attachments: number }>;
  customFields: Record<string, string>;
  tabulations: Record<string, string>;
  stages: Record<string, string>;
  tags: Record<string, string>;
};

export const EMPTY_EXPORT_NAMES: V2ExportNames = {
  departments: {}, users: {}, distributionRules: {}, aiAgents: {}, messageModels: {}, docs: {}, customFields: {}, tabulations: {}, stages: {}, tags: {},
};

export type V2ExportGap = {
  level: "alta" | "média" | "baixa";
  area: string;
  text: string;
  fix: string;
};

const LEVEL_ORDER: Record<V2ExportGap["level"], number> = { alta: 0, "média": 1, baixa: 2 };

const BEHAVIOR: Record<string, string> = { objective: "Objetivo", balanced: "Equilibrado", natural: "Natural", creative: "Criativo" };
const LENGTH: Record<string, string> = { short: "Curtas", medium: "Médias", long: "Longas" };
const EMOJIS: Record<string, string> = { none: "Sem emojis", light: "Poucos", moderate: "Moderado" };
const BOLD: Record<string, string> = { auto: "Automático", key: "Destacar o importante", off: "Sem negrito" };
const MEDIA: Record<string, string> = { transcribe: "Transcrever", describe: "Descrever", ask_text: "Pedir para escrever", handoff: "Transferir" };
const PERM: Record<string, string> = { read: "Usar", cite: "Dizer", write: "Gravar" };
const MASK: Record<string, string> = { none: "inteiro", partial: "mascarado", email: "e-mail mascarado" };
const POST_CLOSE: Record<V2PostCloseCaseBehavior, string> = {
  no_reply: "Não responder",
  short_reply: "Resposta curta",
  reopen_and_route: "Reabrir e atender",
  ask_with_options: "Perguntar com botões",
  handoff: "Transferir para a equipe",
};
const CONDITION: Record<string, string> = {
  message_type: "Tipo de mensagem",
  keywords: "Palavras-chave",
  contact_tag: "Etiqueta do contato",
  first_message: "Primeira mensagem",
  out_of_hours: "Fora do horário",
  deal_stage: "Etapa do negócio",
  field_equals: "Campo igual a",
  no_deal: "Sem negócio",
  survey_received: "Resposta de pesquisa",
  media_kind: "Tipo de mídia",
};
const ACTION: Record<string, string> = {
  send_message: "Enviar mensagem",
  set_theme: "Definir assunto",
  handoff: "Transferir",
  add_tag: "Adicionar etiqueta",
  close_conversation: "Encerrar",
  no_reply: "Não responder",
  send_message_model: "Enviar mensagem pronta",
  send_whatsapp_template: "Enviar template oficial",
  set_variable: "Definir variável",
  record_knowledge_gap: "Registrar dúvida sem resposta",
};
const TOOL: Record<string, string> = {
  knowledge_search: "Buscar nos materiais",
  search_crm_records: "Consultar o CRM",
  search_products: "Buscar produtos",
  list_message_models: "Listar mensagens prontas",
  add_tag: "Adicionar etiqueta",
  update_field: "Atualizar campo",
  add_note: "Registrar anotação",
  create_deal: "Criar negócio",
  move_stage: "Mover etapa",
  create_activity: "Criar atividade",
  send_product: "Enviar produto",
  send_whatsapp_template: "Enviar template oficial",
  ask_with_options: "Perguntar com opções",
  tabulate_conversation: "Classificar atendimento",
  start_survey: "Pesquisa de satisfação",
  record_knowledge_gap: "Registrar dúvida sem resposta",
};

const norm = (s: string) => s.trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ");
const mediaLabel = (a: string | undefined) => (a ? MEDIA[a] ?? a : "—");
const q = (s: string | undefined | null) => (s && s.trim() ? `“${s.trim()}”` : "_(vazio)_");
const yesNo = (b: boolean | undefined) => (b ? "sim" : "não");
const list = (items: string[]) => (items.length > 0 ? items.join(", ") : "_(nenhum)_");

function block(text: string | undefined | null): string {
  if (!text || !text.trim()) return "_(vazio)_";
  return text.trim().split("\n").map((l) => `> ${l}`).join("\n");
}

function destinationText(d: V2Destination | undefined, names: V2ExportNames): string {
  if (!d?.type) return "destino padrão";
  const id = d.id ?? "";
  switch (d.type) {
    case "department":
      return id ? `departamento ${names.departments[id] ?? `(não encontrado: ${id})`}` : "departamento (qualquer)";
    case "user":
      return `pessoa ${names.users[id] ?? `(não encontrada: ${id})`}`;
    case "distribution_rule":
      return `regra de distribuição ${names.distributionRules[id] ?? `(não encontrada: ${id})`}`;
    case "ai_agent": {
      const a = names.aiAgents[id];
      return a ? `agente de IA ${a.name}${a.engine !== "simple" ? " (motor antigo)" : ""}${a.active ? "" : " (desligado)"}` : `agente de IA (não encontrado: ${id})`;
    }
    default:
      return "automação";
  }
}

function fieldLine(f: V2FieldConfig, entity: "contact" | "deal", names: V2ExportNames): string {
  const builtin: Record<string, string> = { name: "Nome", phone: "Telefone", email: "E-mail", stage: "Etapa", status: "Situação", value: "Valor" };
  const label = f.label || names.customFields[f.key] || builtin[f.key] || f.key;
  const perms = f.permissions.map((p) => PERM[p] ?? p).join("/") || "nenhuma";
  return `- ${label} (${entity === "contact" ? "contato" : "negócio"}): ${perms}${f.mask && f.mask !== "none" ? ` · ${MASK[f.mask] ?? f.mask}` : ""}`;
}

function endingText(e: V2ReplyEnding | undefined): string[] {
  if (!e) return ["- _(sem fecho configurado)_"];
  if (e.inherit) return ["- Usa o fecho geral do agente"];
  const rule = (name: string, r: { enabled: boolean; phrases: string[]; buttons?: string[] }) =>
    `- ${name}: ${r.enabled ? `${list(r.phrases.map((p) => q(p)))}${r.buttons?.length ? ` · botões: ${list(r.buttons)}` : ""}` : "desligado"}`;
  return [rule("Depois de passo a passo", e.procedure), rule("Depois de informação", e.info)];
}

function docsText(ids: string[], names: V2ExportNames): string {
  return list(ids.map((id) => {
    const d = names.docs[id];
    if (!d) return `(não encontrado: ${id})`;
    const flags = [
      d.status !== "READY" ? `status ${d.status}` : "",
      d.validUntil && new Date(d.validUntil) < new Date() ? "vencido" : "",
      d.attachments > 0 ? `${d.attachments} anexo(s)` : "",
    ].filter(Boolean);
    return `${d.title}${flags.length ? ` (${flags.join(", ")})` : ""}`;
  }));
}

function themeDocIds(t: V2Theme): string[] {
  return t.allowedKnowledgeDocIds?.length ? t.allowedKnowledgeDocIds : t.knowledgeDocIds ?? [];
}

function themeModelIds(t: V2Theme): string[] {
  return t.allowedMessageModelIds?.length ? t.allowedMessageModelIds : t.messageModelIds ?? [];
}

function conditionText(c: V2Rule["conditions"][number], names: V2ExportNames): string {
  const label = CONDITION[c.type] ?? c.type;
  const values = (c.values ?? []).map((v) => (c.type === "contact_tag" ? names.tags[v] ?? v : v));
  const detail = c.type === "field_equals" ? `${names.customFields[c.field ?? ""] ?? c.field} = ${q(c.expected)}` : values.length ? list(values.map((v) => q(v))) : "";
  return `${c.negate ? "NÃO " : ""}${label}${detail ? `: ${detail}` : ""}`;
}

function actionText(a: V2Rule["actions"][number], names: V2ExportNames, config: V2AgentConfig): string {
  const label = ACTION[a.type] ?? a.type;
  if (a.type === "send_message") return `${label}: ${q(a.message)}`;
  if (a.type === "handoff") return `${label} para ${destinationText(a.destination, names)}`;
  if (a.type === "set_theme") return `${label}: ${config.themes.find((t) => t.id === a.themeId)?.name ?? a.themeId}`;
  if (a.type === "add_tag") return `${label}: ${names.tags[a.tag ?? ""] ?? a.tag}`;
  if (a.type === "send_message_model") return `${label}: ${names.messageModels[a.modelId ?? ""] ?? a.modelId}`;
  if (a.type === "set_variable") return `${label}: ${a.variable?.key} = ${q(a.variable?.value)}`;
  return label;
}

/** Pontos de atenção detectáveis só pela configuração. */
export function detectConfigGaps(config: V2AgentConfig, names: V2ExportNames, now: Date = new Date()): V2ExportGap[] {
  const gaps: V2ExportGap[] = [];
  const add = (level: V2ExportGap["level"], area: string, text: string, fix: string) => gaps.push({ level, area, text, fix });
  const globalDocs = config.allowedKnowledgeDocIds ?? [];

  if (!config.fallback?.noSource?.message?.trim()) {
    add("alta", "Quando não souber", "Sem mensagem para quando nada nos materiais responde: nesse caso ele transfere direto.", "Escreva a mensagem “Se não achar a informação nos materiais”.");
  }
  if (config.autonomyMode === "suggest") {
    add("alta", "Publicação", "Modo sugestão: as respostas viram rascunho e não chegam ao cliente.", "Mude para automático quando validar.");
  }
  if ((config.allowedDomains ?? []).length === 0) {
    add("média", "Quem é o agente", "Nenhum domínio de link liberado: qualquer link que ele escrever vai ao cliente.", "Liste os domínios que ele pode citar.");
  }
  if ((config.groundingCheck ?? "model") === "rules") {
    add("média", "Quando não souber", "Conferência só por regras: afirmações sem número (“é gratuito”, “não existe”) não são conferidas com os materiais.", "Use “Afirmação por afirmação”.");
  }
  if ((config.knowledgeSearch?.preset ?? "all") === "all") {
    add("baixa", "O que ele sabe", "“Trechos que ele lê: todos”: trechos pouco parecidos também vão para ele.", "Considere “Só os relacionados”.");
  }
  if (globalDocs.length === 0 && config.themes.every((t) => themeDocIds(t).length === 0)) {
    add("alta", "O que ele sabe", "Nenhum material liberado: ele não tem de onde responder.", "Libere os materiais em “O que ele sabe”.");
  }

  // Materiais
  const allDocIds = [...new Set([...globalDocs, ...config.themes.flatMap(themeDocIds)])];
  for (const id of allDocIds) {
    const d = names.docs[id];
    if (!d) add("alta", "O que ele sabe", `Material liberado que não existe mais (${id}).`, "Tire da lista de materiais.");
    else if (d.status !== "READY") add("média", "O que ele sabe", `Material “${d.title}” com status ${d.status}: não entra na busca.`, "Reprocesse ou corrija o material.");
    else if (d.validUntil && new Date(d.validUntil) < now) add("média", "O que ele sabe", `Material “${d.title}” vencido: não entra na busca.`, "Atualize a validade ou o conteúdo.");
  }
  const allModelIds = [...new Set([...(config.allowedMessageModelIds ?? []), ...config.themes.flatMap(themeModelIds)])];
  for (const id of allModelIds) {
    if (!names.messageModels[id]) add("média", "O que ele sabe", `Mensagem pronta liberada que não existe mais (${id}).`, "Tire da lista.");
  }

  // Assuntos
  const triggerOwners = new Map<string, string[]>();
  for (const t of config.themes) {
    if (themeDocIds(t).length === 0 && globalDocs.length === 0 && !t.directHandoff) {
      add("alta", "Assuntos", `Assunto “${t.name}” sem materiais (nem próprios nem gerais): responde sem fonte.`, "Ligue materiais ao assunto ou marque transferência direta.");
    }
    if ((t.when ?? []).length === 0 && (t.examples ?? []).length === 0) {
      add("média", "Assuntos", `Assunto “${t.name}” sem gatilhos nem exemplos: só é reconhecido pelo sentido.`, "Acrescente frases que os clientes usam.");
    }
    if (t.instructions && FACT_IN_SENTENCE.test(t.instructions)) {
      add("média", "Assuntos", `Instruções de “${t.name}” têm valor, data ou prazo: o que está nas instruções conta como fonte e não é conferido.`, "Mova valores e prazos para um material.");
    }
    if (t.instructions && /https?:\/\//i.test(t.instructions)) {
      add("baixa", "Assuntos", `Instruções de “${t.name}” têm link.`, "Prefira o link dentro do material.");
    }
    if (t.handoffDestination?.type === "ai_agent" && t.handoffDestination.id) {
      const a = names.aiAgents[t.handoffDestination.id];
      if (!a) add("alta", "Assuntos", `Assunto “${t.name}” transfere para um agente de IA que não existe mais.`, "Escolha o destino de novo.");
      else if (!a.active) add("alta", "Assuntos", `Assunto “${t.name}” transfere para ${a.name}, que está desligado.`, "Ligue o agente ou troque o destino.");
      else if (a.engine !== "simple") add("média", "Assuntos", `Assunto “${t.name}” transfere para ${a.name}, do motor antigo.`, "Confirme se é esse o destino.");
    }
    for (const w of t.when ?? []) {
      const k = norm(w);
      if (!k) continue;
      triggerOwners.set(k, [...(triggerOwners.get(k) ?? []), t.name]);
    }
  }
  for (const [trigger, owners] of triggerOwners) {
    const unique = [...new Set(owners)];
    if (unique.length > 1) add("média", "Assuntos", `Gatilho “${trigger}” em mais de um assunto (${unique.join(", ")}): o agente pode escolher o errado.`, "Deixe cada gatilho em um assunto só.");
  }

  // Pedido de pessoa
  const humanRule = config.rules.find((r) => r.id === "human_request" && r.enabled !== false);
  const humanWords = [...(humanRule?.conditions.flatMap((c) => (c.type === "keywords" ? c.values ?? [] : [])) ?? []), ...(config.handoff?.humanRequestKeywords ?? [])];
  const loose = [...new Set(humanWords.map(norm).filter((w) => w && !w.includes(" ") && !HUMAN_REQUEST_PHRASES.includes(w)))];
  if (humanRule && loose.length > 0) {
    add("média", "Chamar a equipe", `Pedido de pessoa por palavra solta (${loose.join(", ")}): “a pessoa que me atendeu disse…” também transfere.`, "Troque por frases (“falar com uma pessoa”).");
  }

  // Transferência
  const def = config.handoff?.defaultDestination;
  if (!def?.id && def?.type !== "department") add("média", "Chamar a equipe", "Destino padrão de transferência sem escolha.", "Escolha o destino padrão.");
  if (def?.type === "department" && def.id && !names.departments[def.id]) add("alta", "Chamar a equipe", "Destino padrão aponta para um departamento que não existe mais.", "Escolha o destino de novo.");

  // Começo e fim
  if (config.entry.confirmContact && (config.entry.confirmationFields ?? []).length === 0) {
    add("baixa", "Começo e fim", "Confirmação de cadastro ligada sem campos para confirmar.", "Escolha os campos (ex.: nome).");
  }
  if (!config.inactivity?.enabled) add("baixa", "Começo e fim", "Inatividade desligada: conversa parada fica aberta.", "Ligue o aviso e o encerramento por inatividade.");
  if (!config.closure?.goodbyeMessage?.trim() && (config.closure?.courtesyBehavior ?? "no_reply") === "no_reply") {
    add("baixa", "Começo e fim", "Sem despedida e cortesia pós-encerramento em “não responder”: o “obrigado” final fica sem resposta.", "Escreva a despedida ou uma resposta curta de cortesia.");
  }
  if (config.media?.image?.action === "handoff") add("baixa", "Começo e fim", "Imagem transfere na hora (o agente não vê a imagem).", "Considere “Descrever” ou “Pedir para escrever”.");
  if (config.media?.audio?.action === "handoff") add("baixa", "Começo e fim", "Áudio transfere na hora.", "Considere “Transcrever”.");
  if (config.tabulation?.enabled && !config.tabulation.fallbackId && config.tabulation.strategy !== "ai" && !config.themes.some((t) => t.tabulationId)) {
    add("média", "Começo e fim", "Tabulação ligada sem nenhuma tabulação escolhida.", "Escolha a tabulação padrão ou use “o agente avalia”.");
  }

  // Dados do cliente
  const sensitive = /\b(cpf|cnpj|rg|documento|senha|cart[aã]o)\b/i;
  for (const [entity, fields] of [["contact", config.contextFields.contact], ["deal", config.contextFields.deal]] as const) {
    for (const f of fields) {
      const label = f.label || names.customFields[f.key] || f.key;
      if (f.permissions.length === 0) add("baixa", "O que ele sabe", `Campo “${label}” sem permissão: não é usado.`, "Marque Usar ou tire da lista.");
      if (f.permissions.includes("cite") && sensitive.test(label) && (!f.mask || f.mask === "none")) {
        add("média", "O que ele sabe", `Campo “${label}” (${entity === "contact" ? "contato" : "negócio"}) pode ser dito inteiro ao cliente.`, "Use “mascarado” em Mostrar.");
      }
    }
  }

  // Atalhos
  for (const r of config.rules) {
    if (r.enabled === false) continue;
    if (r.conditions.length === 0) add("média", "Atalhos", `Atalho “${r.name}” sem condição: vale para toda mensagem.`, "Defina a condição.");
    if (r.actions.length === 0) add("baixa", "Atalhos", `Atalho “${r.name}” sem ação.`, "Defina a ação ou desligue.");
  }

  return gaps.sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]);
}

/** Ficha do agente em Markdown. */
export function buildAgentRulesMarkdown(args: {
  config: V2AgentConfig;
  names: V2ExportNames;
  agentName: string;
  version: string;
  generatedAt?: Date;
}): string {
  const { config: c, names } = args;
  const at = (args.generatedAt ?? new Date()).toLocaleString("pt-BR", { timeZone: c.businessHours?.timezone || "America/Sao_Paulo" });
  const gaps = detectConfigGaps(c, names, args.generatedAt);
  const out: string[] = [];
  const h = (t: string) => out.push("", `## ${t}`, "");

  out.push(`# Regras do agente ${args.agentName}`, "", `Versão: ${args.version} · gerado em ${at}`);

  h(`Pontos de atenção (${gaps.length})`);
  if (gaps.length === 0) out.push("Nenhum ponto detectado pela configuração. Gaps de conteúdo (perguntas que os materiais não cobrem) aparecem no relatório de ações e no Comparar com a equipe.");
  for (const g of gaps) out.push(`- **${g.level}** · ${g.area}: ${g.text} → ${g.fix}`);

  h("Quem é o agente");
  out.push(
    `- Modelo: ${c.model} · estilo: ${BEHAVIOR[c.responseBehavior] ?? c.responseBehavior} · respostas: ${LENGTH[c.responseLength ?? "medium"] ?? c.responseLength}`,
    `- Emojis: ${EMOJIS[c.emojis ?? "light"] ?? c.emojis} · negrito: ${BOLD[c.bold ?? "auto"] ?? c.bold}`,
    `- Modo: ${c.autonomyMode === "auto" ? "automático" : "sugestão (rascunho)"}`,
    `- Links liberados: ${list(c.allowedDomains ?? [])}`,
    "", "**Tom de voz**", block(c.tone),
    "", "**Regras que ele sempre segue**",
    ...(c.globalRules.length ? c.globalRules.map((r) => `- ${r}`) : ["_(nenhuma)_"]),
    "", "**Como terminar as respostas**", ...endingText(c.replyEnding),
  );

  h("O que ele sabe");
  out.push(
    `- Materiais gerais: ${docsText(c.allowedKnowledgeDocIds ?? [], names)}`,
    `- Trechos que ele lê: ${({ all: "todos", related: "só os relacionados", close: "só os muito parecidos" } as Record<string, string>)[c.knowledgeSearch?.preset ?? "all"]}`,
    `- Conferência das respostas: ${(c.groundingCheck ?? "model") === "model" ? "afirmação por afirmação" : "só números, datas e nomes"}`,
    `- Mensagens prontas gerais: ${list((c.allowedMessageModelIds ?? []).map((id) => names.messageModels[id] ?? `(não encontrada: ${id})`))} · adaptar à conversa: ${yesNo(c.messageModelAdapt)}`,
    `- Negócio usado: ${c.dealSelection === "ask" ? "pergunta quando há mais de um" : "o mais recente"}`,
    "", "**Dados do cliente**",
    ...[...c.contextFields.contact.map((f) => fieldLine(f, "contact", names)), ...c.contextFields.deal.map((f) => fieldLine(f, "deal", names))],
    ...(c.contextFields.contact.length + c.contextFields.deal.length === 0 ? ["_(nenhum campo)_"] : []),
    "", "**Informações da empresa**",
    ...(c.variables.length ? c.variables.map((v) => `- ${v.key}: ${q(v.value)}`) : ["_(nenhuma)_"]),
    "", "**Informações montadas**",
    ...((c.derivedFields ?? []).length
      ? (c.derivedFields ?? []).map((d) => `- ${d.label}: ${d.parts.map((p) => (p.kind === "text" ? q(p.text) : `${p.take && p.take !== "all" ? `${p.take === "first" ? "primeiros" : "últimos"} ${p.count ?? ""} de ` : ""}${names.customFields[p.key ?? ""] ?? p.key}`)).join(" + ")}`)
      : ["_(nenhuma)_"]),
    "", "**Calendário**",
    ...((c.calendar?.events ?? []).length ? (c.calendar?.events ?? []).map((e) => `- ${e.start}${e.end ? ` a ${e.end}` : ""}: ${e.title}`) : ["_(vazio)_"]),
  );

  h(`Assuntos (${c.themes.length})`);
  out.push(`Reconhecimento: ${({ strict: "rígido", balanced: "equilibrado", loose: "flexível" } as Record<string, string>)[c.themeRecognition?.preset ?? "balanced"]}`);
  for (const t of c.themes) {
    out.push(
      "", `### ${t.name}`,
      `- Gatilhos: ${list((t.when ?? []).map((w) => q(w)))}`,
      `- Exemplos: ${list((t.examples ?? []).map((w) => q(w)))}`,
      `- Materiais: ${themeDocIds(t).length ? docsText(themeDocIds(t), names) : "só os gerais"}`,
      `- Mensagens prontas: ${themeModelIds(t).length ? list(themeModelIds(t).map((id) => names.messageModels[id] ?? `(não encontrada: ${id})`)) : "só as gerais"}`,
      `- Ações: ${(t.allowedTools ?? []).length ? list((t.allowedTools ?? []).map((x) => TOOL[x] ?? x)) : "as mesmas do agente"}`,
      `- Transferência: ${t.directHandoff ? "direta (sem responder) para " : ""}${destinationText(t.handoffDestination, names)}${t.handoffDestination?.message ? ` · mensagem: ${q(t.handoffDestination.message)}` : ""}`,
      `- Tabulação: ${t.tabulationId ? names.tabulations[t.tabulationId] ?? t.tabulationId : "_(padrão)_"}`,
      "", "Instruções:", block(t.instructions),
    );
    if (t.replyEnding && !t.replyEnding.inherit) out.push("", "Fecho próprio:", ...endingText(t.replyEnding));
  }

  h(`Atalhos automáticos (${c.rules.length})`);
  const rules = [...c.rules].sort((a, b) => a.order - b.order);
  if (rules.length === 0) out.push("_(nenhum)_");
  for (const r of rules) {
    out.push(`- **${r.name}**${r.enabled === false ? " (desligado)" : ""}: se ${r.conditions.map((x) => conditionText(x, names)).join(" e ") || "_(sem condição)_"} → ${r.actions.map((a) => actionText(a, names, c)).join("; ") || "_(sem ação)_"}`);
  }
  out.push(
    "", `- Ações liberadas: ${list((c.enabledTools ?? []).map((x) => TOOL[x] ?? x))}`,
    `- Etiquetas que pode usar: ${list((c.actionOptions?.tags ?? []).map((id) => names.tags[id] ?? id))}`,
    `- Etapas para onde pode mover: ${list((c.actionOptions?.stageIds ?? []).map((id) => names.stages[id] ?? id))}`,
  );
  if (c.scope) {
    out.push(
      "", "**Fora do escopo**", `- Mensagem: ${q(c.scope.message)}`,
      ...(c.scope.forbidden ?? []).map((f) => `- Proibido: ${q(f.subject)}${f.destination ? ` → ${destinationText(f.destination, names)}` : ""}`),
    );
  }

  h("Começo e fim da conversa");
  const e = c.entry;
  out.push(
    `- Boas-vindas: ${e.openingEnabled ? q(e.openingMessage) : "desligadas"}`,
    `- Confirmar cadastro: ${yesNo(e.confirmContact)}${e.confirmContact ? ` (${e.confirmationMode === "separate_turn" ? "na mensagem seguinte" : "junto das boas-vindas"}) · campos: ${list(e.confirmationFields ?? [])} · mensagem: ${q(e.confirmationMessage)}` : ""}`,
    `- Sem cadastro: ${({ ask_identification: "pede e-mail ou documento e passa para a equipe", create_deal: "cria negócio e segue", handoff: "passa para a equipe" } as Record<string, string>)[e.onDealNotFound ?? "ask_identification"]}${(e.onDealNotFound ?? "ask_identification") === "ask_identification" ? ` · mensagem: ${q(e.identificationMessage)} · tentativas: ${e.maxAttempts ?? 2}` : ""}`,
    `- Áudio: ${mediaLabel(c.media?.audio?.action)} · imagem: ${mediaLabel(c.media?.image?.action)} · documento: ${mediaLabel(c.media?.document?.action)}`,
    `- Despedida: ${q(c.closure?.goodbyeMessage)}`,
    `- Depois de encerrar (${c.closure?.postCloseWindowHours ?? "—"} h): cortesia → ${POST_CLOSE[c.closure?.courtesyBehavior ?? "no_reply"]}${c.closure?.postCloseMessages?.courtesy ? ` (${q(c.closure.postCloseMessages.courtesy)})` : ""}; pedido novo → ${POST_CLOSE[c.closure?.newDemandBehavior ?? "reopen_and_route"]}; dúvida → ${POST_CLOSE[c.closure?.ambiguousBehavior ?? "ask_with_options"]}`,
    `- Pergunta pós-encerramento: ${q(c.closure?.postCloseQuestion?.message ?? "Você precisa de ajuda com algo novo?")}`,
    `- Inatividade: ${c.inactivity?.enabled ? `aviso em ${c.inactivity.nudgeAfter ?? "—"} min (${q(c.inactivity.nudgeMessage)}), encerra em ${c.inactivity.closeAfter ?? "—"} min (${q(c.inactivity.closeMessage)})` : "desligada"}`,
    `- Tabulação: ${c.tabulation?.enabled ? `${c.tabulation.strategy === "ai" ? "o agente avalia" : "fixa"} · quando: ${c.tabulation.when ?? "on_close"} · padrão: ${c.tabulation.fallbackId ? names.tabulations[c.tabulation.fallbackId] ?? c.tabulation.fallbackId : "—"}${c.tabulation.instructions ? ` · instruções: ${q(c.tabulation.instructions)}` : ""}` : "desligada"}`,
  );

  h("Quando chama a equipe");
  out.push(
    `- Destino padrão: ${destinationText(c.handoff?.defaultDestination, names)}`,
    `- Mensagem de transferência: ${q(c.handoff?.message)}`,
    `- Pedido de pessoa: ${list([...(c.handoff?.humanRequestKeywords ?? []), ...HUMAN_REQUEST_PHRASES].map((w) => q(w)))}`,
    `- Enquanto espera na fila: ${c.handoff?.whileQueued === "answer" ? "responde" : "só avisa"}${c.handoff?.queuedMessage ? ` (${q(c.handoff.queuedMessage)})` : ""}`,
    `- Horário de atendimento: ${c.businessHours?.enabled ? `${c.businessHours.weekdays.map((d) => `${["dom", "seg", "ter", "qua", "qui", "sex", "sáb"][d.day]} ${d.start}–${d.end}`).join(", ")} · fora do horário: ${c.businessHours.outsideAction ?? "message"}${c.businessHours.offHoursMessage ? ` (${q(c.businessHours.offHoursMessage)})` : ""}` : "sempre"}`,
    `- Cliente irritado: ${c.sentiment?.enabled ? `${c.sentiment.action === "handoff" ? "transfere" : c.sentiment.action === "notify_and_continue" ? "avisa e continua" : "só registra"} (a partir de ${c.sentiment.threshold})` : "desligado"}`,
    `- Sem material: ${q(c.fallback?.noSource?.message)}`,
    `- Cliente não entendeu: ${c.fallback?.confusion?.action === "handoff" ? "o agente decide" : "refaz a pergunta"}`,
    `- Erro: ${q(c.fallback?.error?.message)}`,
    `- Limites: cortesias ${c.limits?.maxCourtesyReplies ?? "—"} · fora do escopo ${c.limits?.nonsenseLimit ?? "—"} (${c.limits?.nonsenseAction === "handoff" ? "transfere" : "avisa e silencia"}) · repetição ${c.limits?.maxLoopCount ?? "—"} · trocas sem avanço ${c.limits?.maxStalledExchanges ?? "—"} (${c.limits?.stalledExchangesAction ?? "—"}) · transferências entre agentes ${c.limits?.maxAiTransfers ?? "—"}`,
  );

  return out.join("\n").replace(/\n{3,}/g, "\n\n") + "\n";
}
