/**
 * Exportação das regras do agente: uma ficha legível (Markdown) com toda a
 * configuração, os nomes (e ids) no lugar dos ids e, no topo, os pontos de
 * atenção que dá para detectar só olhando a configuração (gaps). Traz também
 * "Como o motor decide", para uma pessoa ou uma IA cruzar a ficha com o
 * relatório de ações. Nenhum domínio de cliente.
 */

import type { V2AgentConfig, V2Destination, V2FieldConfig, V2PostCloseCaseBehavior, V2ReplyEnding, V2Rule, V2Theme } from "@/lib/ai-v2/types";
import { HUMAN_REQUEST_PHRASES, isHumanRequestRule } from "@/lib/ai-v2/config";
import { V2_MODELS } from "@/lib/ai-v2/models";
import { FACT_IN_SENTENCE } from "./ground-reply";
import { extractUrls, isUrlAllowed } from "./output-guard";
import { QUERY_TOOL_NAMES } from "./theme-prompt";
import { sameWordStem } from "./themes";

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
  channels?: Record<string, string>;
};

export const EMPTY_EXPORT_NAMES: V2ExportNames = {
  departments: {}, users: {}, distributionRules: {}, aiAgents: {}, messageModels: {}, docs: {}, customFields: {}, tabulations: {}, stages: {}, tags: {}, channels: {},
};

export type V2ExportGap = {
  id?: string;
  level: "alta" | "média" | "baixa";
  area: string;
  text: string;
  fix: string;
};

export type V2ExportContext = {
  /** Id deste agente (transferência para ele mesmo). */
  agentId?: string;
  /** Versão exportada: o modo sugestão só é problema na publicada. */
  version?: "published" | "draft";
  now?: Date;
};

const LEVEL_ORDER: Record<V2ExportGap["level"], number> = { alta: 0, "média": 1, baixa: 2 };

const BEHAVIOR: Record<string, string> = { objective: "Objetivo", balanced: "Equilibrado", natural: "Natural", creative: "Criativo" };
const LENGTH: Record<string, string> = { short: "Curtas", medium: "Médias", long: "Longas" };
const EMOJIS: Record<string, string> = { none: "Sem emojis", light: "Poucos", moderate: "Moderado" };
const BOLD: Record<string, string> = { auto: "Automático", key: "Destacar o importante", off: "Sem negrito" };
const MEDIA: Record<string, string> = { transcribe: "Transcrever", describe: "Descrever", ask_text: "Pedir para escrever", handoff: "Transferir" };
const PERM: Record<string, string> = { read: "Usar", cite: "Dizer", write: "Gravar" };
const MASK: Record<string, string> = { none: "inteiro", partial: "mascarado", email: "e-mail mascarado" };
const FLOW: Record<string, string> = { full: "Atendimento completo", reception: "Recepção (triagem)", onboarding: "Primeiros dias (etapas)" };
const TAB_WHEN: Record<string, string> = { on_close: "ao encerrar", on_transfer: "ao transferir", always: "ao encerrar e ao transferir" };
const THRESHOLD: Record<string, string> = { any: "qualquer sinal de insatisfação", dissatisfied: "cliente insatisfeito", angry: "cliente bravo" };
const SENTIMENT_ACTION: Record<string, string> = { handoff: "transfere", notify_and_continue: "continua atendendo (só registra)", log_only: "só registra no rastro" };
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
  handoff: "Transferir",
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
/** Palavras que aparecem em quase toda mensagem: gatilho com elas pega tudo. */
const GENERIC_TRIGGERS = new Set(["ajuda", "duvida", "problema", "informacao", "quero", "preciso", "sim", "nao", "ok", "oi", "ola", "bom dia", "boa tarde", "boa noite", "obrigado", "obrigada"]);
const DEFAULT_HUMAN_WORDS = new Set(["humano", "pessoa", "atendente", "consultor"]);
const WEEKDAY = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];

const norm = (s: string) => s.trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
const mediaLabel = (a: string | undefined) => (a ? MEDIA[a] ?? a : "—");
const q = (s: string | undefined | null) => (s && s.trim() ? `“${s.trim()}”` : "_(vazio)_");
/** Vazio: diz o que o motor usa no lugar. */
const qd = (s: string | undefined | null, fallback: string) => (s && s.trim() ? `“${s.trim()}”` : `_(vazio → o motor usa: “${fallback}”)_`);
const yesNo = (b: boolean | undefined) => (b ? "sim" : "não");
const list = (items: string[]) => (items.length > 0 ? items.join(", ") : "_(nenhum)_");

function dateBr(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}

function block(text: string | undefined | null): string {
  if (!text || !text.trim()) return "_(vazio)_";
  return text.trim().split("\n").map((l) => `> ${l}`).join("\n");
}

function destinationText(d: V2Destination | undefined, names: V2ExportNames): string {
  if (!d?.type) return "destino padrão";
  const id = d.id ?? "";
  switch (d.type) {
    case "department":
      return id ? `departamento ${names.departments[id] ?? `(não encontrado: ${id})`}` : "departamento (nenhum escolhido)";
    case "user":
      return `pessoa ${names.users[id] ?? `(não encontrada: ${id})`}`;
    case "distribution_rule":
      return `regra de distribuição ${names.distributionRules[id] ?? `(não encontrada: ${id})`}`;
    case "ai_agent": {
      const a = names.aiAgents[id];
      return a ? `agente de IA ${a.name} (id: ${id})${a.engine !== "simple" ? " (motor antigo)" : ""}${a.active ? "" : " (desligado)"}` : `agente de IA (não encontrado: ${id})`;
    }
    default:
      return "automação";
  }
}

const BUILTIN_FIELD: Record<string, string> = { name: "Nome", phone: "Telefone", email: "E-mail", stage: "Etapa", status: "Situação", value: "Valor" };

function fieldName(key: string | undefined, names: V2ExportNames): string {
  const k = key ?? "";
  return names.customFields[k] || BUILTIN_FIELD[k] || k || "—";
}

function fieldLine(f: V2FieldConfig, entity: "contact" | "deal", names: V2ExportNames): string {
  const label = f.label || fieldName(f.key, names);
  const perms = f.permissions.map((p) => PERM[p] ?? p).join("/") || "nenhuma";
  return `- ${label} (${entity === "contact" ? "contato" : "negócio"}): ${perms}${f.mask && f.mask !== "none" ? ` · ${MASK[f.mask] ?? f.mask}` : ""}`;
}

function endingText(e: V2ReplyEnding | undefined): string[] {
  if (!e) return ["- _(sem fecho configurado)_"];
  if (e.inherit) return ["- Usa o fecho geral do agente"];
  const rule = (name: string, r: { enabled: boolean; phrases: string[]; buttons?: string[] }) =>
    `- ${name}: ${r.enabled ? `${list(r.phrases.map((p) => q(p)))}${r.buttons?.length ? ` · botões: ${list(r.buttons.slice(0, 3))}${r.buttons.length > 3 ? ` (só os 3 primeiros saem; ${r.buttons.length - 3} ignorado(s))` : ""}` : ""}` : "desligado"}`;
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

/** Materiais do assunto: o motor soma as duas listas (e os gerais). */
function themeDocIds(t: V2Theme): string[] {
  return [...new Set([...(t.allowedKnowledgeDocIds ?? []), ...(t.knowledgeDocIds ?? [])])];
}

/** Mensagens prontas do assunto: a lista do assunto substitui as gerais. */
function themeModelIds(t: V2Theme): string[] {
  return t.allowedMessageModelIds?.length ? t.allowedMessageModelIds : t.messageModelIds ?? [];
}

function themeTabulationId(c: V2AgentConfig, t: V2Theme): string | undefined {
  return t.tabulationId || c.tabulation?.byTheme?.[t.id] || undefined;
}

function conditionText(c: V2Rule["conditions"][number], names: V2ExportNames): string {
  const label = CONDITION[c.type] ?? c.type;
  const values = (c.values ?? []).map((v) => (c.type === "contact_tag" ? names.tags[v] ?? v : v));
  const detail = c.type === "field_equals" ? `${fieldName(c.field, names)} = ${q(c.expected)}` : values.length ? list(values.map((v) => q(v))) : "";
  return `${c.negate ? "NÃO " : ""}${label}${detail ? `: ${detail}` : ""}`;
}

function actionText(a: V2Rule["actions"][number], names: V2ExportNames, config: V2AgentConfig): string {
  const label = ACTION[a.type] ?? a.type;
  if (a.type === "send_message") return `${label}: ${q(a.message)}`;
  if (a.type === "handoff") return `${label} para ${destinationText(a.destination, names)}`;
  if (a.type === "set_theme") return `${label}: ${config.themes.find((t) => t.id === a.themeId)?.name ?? `(não encontrado: ${a.themeId})`}`;
  if (a.type === "add_tag") return `${label}: ${names.tags[a.tag ?? ""] ?? a.tag}`;
  if (a.type === "send_message_model") return `${label}: ${names.messageModels[a.modelId ?? ""] ?? `(não encontrada: ${a.modelId})`}`;
  if (a.type === "set_variable") return `${label}: ${a.variable?.key} = ${q(a.variable?.value)}`;
  return label;
}

/** Todas as transferências configuradas, com onde estão. */
function allDestinations(c: V2AgentConfig): Array<{ where: string; d: V2Destination }> {
  const out: Array<{ where: string; d: V2Destination }> = [];
  if (c.handoff?.defaultDestination) out.push({ where: "Destino padrão", d: c.handoff.defaultDestination });
  for (const t of c.themes) if (t.handoffDestination?.type) out.push({ where: `Assunto “${t.name}”`, d: t.handoffDestination });
  for (const r of c.rules) for (const a of r.actions) if (a.type === "handoff" && a.destination?.type) out.push({ where: `Atalho “${r.name}”`, d: a.destination });
  for (const s of c.onboarding?.steps ?? []) if (s.handoffOnStuck?.type) out.push({ where: `Etapa “${s.name}”`, d: s.handoffOnStuck });
  return out;
}

/** Pontos de atenção detectáveis só pela configuração. */
export function detectConfigGaps(config: V2AgentConfig, names: V2ExportNames, ctx: V2ExportContext | Date = {}): V2ExportGap[] {
  const opts: V2ExportContext = ctx instanceof Date ? { now: ctx } : ctx;
  const now = opts.now ?? new Date();
  const c = config;
  const gaps: V2ExportGap[] = [];
  const add = (level: V2ExportGap["level"], area: string, text: string, fix: string) => gaps.push({ level, area, text, fix });
  const globalDocs = c.allowedKnowledgeDocIds ?? [];
  const onlyDirect = c.themes.length > 0 && c.themes.every((t) => t.directHandoff);
  const answers = c.flow !== "reception" && !onlyDirect;

  // Publicação
  if (c.autonomyMode === "suggest" && opts.version !== "draft") {
    add("alta", "Publicação", "Modo sugestão: as respostas viram rascunho (“Agente IA (rascunho)”) e não chegam ao cliente.", "Mude para automático quando validar.");
  }
  if ((c.allowedPhoneNumbers ?? []).length > 0 && c.autonomyMode === "auto") {
    add("alta", "Publicação", `Lista de números de teste preenchida (${(c.allowedPhoneNumbers ?? []).length}): só esses telefones recebem resposta; os demais clientes ficam sem atendimento.`, "Esvazie a lista de números de teste para atender todos.");
  }
  if ((c.channelIds ?? []).length === 0) {
    add("baixa", "Publicação", "Nenhum número de WhatsApp vinculado: conversa nova só chega a ele se for o primeiro agente sem vínculo (transferências chegam normalmente).", "Vincule o número que ele atende.");
  }
  if (c.model && !V2_MODELS.some((m) => m.id === c.model)) {
    add("alta", "Quem é o agente", `Modelo “${c.model}” não está na lista de modelos suportados.`, "Escolha um modelo da lista.");
  }

  // Quando não souber
  if (!c.fallback?.noSource?.message?.trim()) {
    add("alta", "Quando não souber", "Sem mensagem para quando nada nos materiais responde: nesse caso ele transfere direto.", "Escreva a mensagem “Se não achar a informação nos materiais”.");
  }
  if ((c.allowedDomains ?? []).length === 0) {
    add("média", "Quem é o agente", "Nenhum domínio de link liberado: qualquer link que ele escrever vai ao cliente.", "Liste os domínios que ele pode citar.");
  }
  if ((c.groundingCheck ?? "model") === "rules") {
    add("média", "Quando não souber", "Conferência só por regras: afirmações sem número (“é gratuito”, “não existe”) não são conferidas com os materiais.", "Use “Afirmação por afirmação”.");
  }
  if ((c.knowledgeSearch?.preset ?? "all") === "all" && globalDocs.length + c.themes.reduce((n, t) => n + themeDocIds(t).length, 0) > 10) {
    add("baixa", "O que ele sabe", "“Trechos que ele lê: todos” com muitos materiais: trechos pouco parecidos também vão para ele.", "Considere “Só os relacionados”.");
  }
  if (answers && globalDocs.length === 0 && c.themes.every((t) => themeDocIds(t).length === 0)) {
    add("alta", "O que ele sabe", "Nenhum material liberado: sem de onde responder, toda pergunta cai na mensagem “sem material” ou transfere.", "Libere os materiais em “O que ele sabe”.");
  }

  // Materiais e mensagens prontas
  const allDocIds = [...new Set([...globalDocs, ...c.themes.flatMap(themeDocIds)])];
  for (const id of allDocIds) {
    const d = names.docs[id];
    if (!d) add("alta", "O que ele sabe", `Material liberado que não existe mais neste agente (${id}).`, "Tire da lista de materiais.");
    else if (d.status !== "READY") add("média", "O que ele sabe", `Material “${d.title}” com status ${d.status}: não entra na busca.`, "Reprocesse ou corrija o material.");
    else if (d.validUntil && new Date(d.validUntil) < now) add("média", "O que ele sabe", `Material “${d.title}” vencido: não entra na busca.`, "Atualize a validade ou o conteúdo.");
  }
  const modelIds = [...new Set([
    ...(c.allowedMessageModelIds ?? []),
    ...c.themes.flatMap(themeModelIds),
    ...c.rules.flatMap((r) => r.actions.filter((a) => a.type === "send_message_model" && a.modelId).map((a) => a.modelId as string)),
  ])];
  for (const id of modelIds) {
    if (!names.messageModels[id]) add("alta", "O que ele sabe", `Mensagem pronta liberada ou usada num atalho que não existe mais (${id}).`, "Tire da lista ou escolha outra.");
  }

  // Links fora dos domínios liberados
  if ((c.allowedDomains ?? []).length > 0) {
    const places: Array<[string, string]> = [
      ...c.themes.map((t) => [`instruções de “${t.name}”`, t.instructions ?? ""] as [string, string]),
      ...c.variables.map((v) => [`informação “${v.key}”`, v.value] as [string, string]),
      ...c.globalRules.map((r, i) => [`regra geral ${i + 1}`, r] as [string, string]),
    ];
    for (const [where, text] of places) {
      for (const url of extractUrls(text)) {
        if (!isUrlAllowed(url, c.allowedDomains)) add("alta", "Quem é o agente", `Link ${url} (${where}) está fora dos domínios liberados: é apagado da resposta e o cliente recebe a frase sem o link.`, "Libere o domínio ou troque o link.");
      }
    }
  }

  // Assuntos
  const triggers: Array<{ theme: string; raw: string; key: string }> = [];
  for (const t of c.themes) {
    const docs = themeDocIds(t);
    const tools = t.allowedTools ?? [];
    if (!t.directHandoff && docs.length === 0 && globalDocs.length === 0 && c.flow !== "reception") {
      add("alta", "Assuntos", `Assunto “${t.name}” sem materiais (nem próprios nem gerais): não terá de onde responder e cai na mensagem “sem material” ou transfere.`, "Ligue materiais ao assunto ou marque transferência direta.");
    }
    if ((t.when ?? []).length === 0 && (t.examples ?? []).length === 0) {
      add("média", "Assuntos", `Assunto “${t.name}” sem gatilhos nem exemplos: só é reconhecido pelo sentido.`, "Acrescente frases que os clientes usam.");
    }
    if (!t.directHandoff && !(t.instructions ?? "").trim()) {
      add("baixa", "Assuntos", `Assunto “${t.name}” sem instruções: só o nome e os gatilhos orientam o agente.`, "Escreva o que ele deve fazer nesse assunto.");
    }
    if (t.directHandoff && ((t.instructions ?? "").trim() || docs.length > 0 || themeModelIds(t).length > 0)) {
      add("baixa", "Assuntos", `Assunto “${t.name}” transfere sem responder: as instruções, materiais e mensagens prontas dele não são usados.`, "Tire a transferência direta ou limpe o que não é usado.");
    }
    if (t.directHandoff && !t.handoffDestination?.id && !c.handoff?.defaultDestination?.id) {
      add("alta", "Assuntos", `Assunto “${t.name}” transfere direto, mas não há destino nem destino padrão.`, "Escolha para quem transferir.");
    }
    if (t.instructions && FACT_IN_SENTENCE.test(t.instructions)) {
      add("média", "Assuntos", `Instruções de “${t.name}” têm valor, data ou prazo: o que está nas instruções conta como fonte e não é conferido.`, "Mova valores e prazos para um material.");
    }
    // Lista de ferramentas do assunto com alguma consulta restringe as consultas.
    const queries = tools.filter((x) => (QUERY_TOOL_NAMES as readonly string[]).includes(x));
    if (queries.length > 0) {
      if ((docs.length > 0 || globalDocs.length > 0) && !queries.includes("knowledge_search")) {
        add("alta", "Assuntos", `Assunto “${t.name}”: a lista de ferramentas do assunto tem consulta mas não “Buscar nos materiais” — neste assunto ele não lê os materiais.`, "Inclua “Buscar nos materiais” nas ferramentas do assunto.");
      }
      if (themeModelIds(t).length > 0 && !queries.includes("list_message_models")) {
        add("baixa", "Assuntos", `Assunto “${t.name}”: mensagens prontas liberadas, mas “Listar mensagens prontas” fora da lista de consultas do assunto.`, "Inclua a consulta ou confirme que ele não precisa listar.");
      }
    }
    const tab = themeTabulationId(c, t);
    if (tab && !names.tabulations[tab]) add("média", "Começo e fim", `Tabulação do assunto “${t.name}” não existe mais ou está inativa.`, "Escolha a tabulação de novo.");
    for (const w of t.when ?? []) {
      const key = norm(w);
      const words = key.split(" ").filter(Boolean);
      if (!key || words.every((x) => x.length <= 2)) {
        add("média", "Assuntos", `Gatilho “${w}” de “${t.name}” nunca é reconhecido (palavras de 1 ou 2 letras não contam).`, "Troque por palavras com conteúdo.");
        continue;
      }
      if (GENERIC_TRIGGERS.has(key)) add("média", "Assuntos", `Gatilho “${w}” de “${t.name}” é genérico: quase toda mensagem leva a este assunto.`, "Use frases específicas do assunto.");
      triggers.push({ theme: t.name, raw: w, key });
    }
  }
  const reported = new Set<string>();
  for (let i = 0; i < triggers.length; i++) {
    for (let j = i + 1; j < triggers.length; j++) {
      const a = triggers[i];
      const b = triggers[j];
      if (a.theme === b.theme) continue;
      const same = a.key === b.key;
      const oneWord = !a.key.includes(" ") && !b.key.includes(" ");
      const stem = !same && oneWord && sameWordStem(a.key, b.key);
      if (!same && !stem) continue;
      const k = [a.theme, b.theme, a.key, b.key].sort().join("|");
      if (reported.has(k)) continue;
      reported.add(k);
      add("média", "Assuntos", same
        ? `Gatilho “${a.raw}” em mais de um assunto (${a.theme}, ${b.theme}): o empate é decidido pela ordem da lista.`
        : `Gatilhos “${a.raw}” (${a.theme}) e “${b.raw}” (${b.theme}) contam como a mesma palavra: o empate é decidido pela ordem da lista.`,
      "Deixe cada gatilho em um assunto só, ou use frases mais específicas.");
    }
  }

  // Transferências
  for (const { where, d } of allDestinations(c)) {
    const id = d.id ?? "";
    if (d.type === "automation") continue;
    if (!id) {
      if (where === "Destino padrão") add("alta", "Chamar a equipe", "Destino padrão de transferência sem departamento ou pessoa: a conversa transferida cai sem responsável.", "Escolha o destino padrão.");
      continue;
    }
    const exists = d.type === "department" ? !!names.departments[id]
      : d.type === "user" ? !!names.users[id]
        : d.type === "distribution_rule" ? !!names.distributionRules[id]
          : !!names.aiAgents[id];
    if (!exists) {
      const kind = d.type === "ai_agent" ? "agente de IA" : d.type === "user" ? "pessoa" : d.type === "department" ? "departamento" : "regra de distribuição";
      add("alta", "Chamar a equipe", `${where} transfere para um(a) ${kind} que não existe mais.`, "Escolha o destino de novo.");
      continue;
    }
    if (d.type === "ai_agent") {
      const a = names.aiAgents[id];
      if (opts.agentId && id === opts.agentId) add("alta", "Chamar a equipe", `${where} transfere para este mesmo agente: a conversa fica em círculo até o limite de transferências.`, "Escolha outro destino.");
      else if (!a.active) add("alta", "Chamar a equipe", `${where} transfere para ${a.name}, que está desligado.`, "Ligue o agente ou troque o destino.");
      else if (a.engine !== "simple") add("média", "Chamar a equipe", `${where} transfere para ${a.name}, do motor antigo.`, "Confirme se é esse o destino.");
    }
  }

  // Pedido de pessoa: vale sempre (no atalho, no prompt e na causa da transferência)
  const humanRule = c.rules.find((r) => r.enabled !== false && isHumanRequestRule(r, c));
  const humanWords = [...(humanRule?.conditions.flatMap((x) => (x.type === "keywords" ? x.values ?? [] : [])) ?? []), ...(c.handoff?.humanRequestKeywords ?? [])];
  const loose = [...new Set(humanWords.map(norm).filter((w) => w && !w.includes(" ") && !HUMAN_REQUEST_PHRASES.includes(w)))];
  if (loose.length > 0) {
    const custom = loose.filter((w) => !DEFAULT_HUMAN_WORDS.has(w));
    add(custom.length > 0 ? "média" : "baixa", "Chamar a equipe", `Pedido de pessoa por palavra solta (${loose.join(", ")}): “a pessoa que me atendeu disse…” também transfere.`, "Troque por frases (“falar com uma pessoa”).");
  }

  // Assunto que só repete o pedido de pessoa (o atalho já transfere antes).
  if (humanRule) {
    const hw = new Set(humanWords.map(norm));
    for (const t of c.themes) {
      const w = (t.when ?? []).map(norm).filter(Boolean);
      if (w.length > 0 && w.filter((x) => hw.has(x)).length >= Math.ceil(w.length / 2)) {
        add("baixa", "Assuntos", `Assunto “${t.name}” repete o pedido de pessoa: o atalho “${humanRule.name}” transfere antes de o assunto ser escolhido.`, "Apague o assunto ou deixe só o atalho.");
      }
    }
  }

  // Etiqueta citada em instruções e regras que não está liberada.
  const allowedTagNames = (c.actionOptions?.tags ?? []).map((id) => norm(names.tags[id] ?? id));
  if (allowedTagNames.length > 0) {
    const texts: Array<[string, string]> = [
      ...c.themes.map((t) => [`instruções de “${t.name}”`, t.instructions ?? ""] as [string, string]),
      ...c.globalRules.map((r, i) => [`regra geral ${i + 1}`, r] as [string, string]),
    ];
    for (const [where, text] of texts) {
      for (const m of text.matchAll(/(?:^|[^\p{L}])(?:tag|etiqueta)\s+["“']?([\p{L}\p{N}_-]{2,40})/giu)) {
        const tag = m[1];
        if (["de", "da", "do", "que", "para", "com"].includes(norm(tag))) continue;
        if (!allowedTagNames.includes(norm(tag))) add("alta", "Atalhos e ações", `A etiqueta “${tag}” (${where}) não está entre as etiquetas liberadas: a ação é barrada.`, `Libere “${tag}” em “O que ele pode fazer”.`);
      }
    }
  }

  // Regra mandando consultar o CRM em assuntos onde a consulta está bloqueada.
  const crmRule = [...c.globalRules, ...c.themes.map((t) => t.instructions ?? "")].some((r) => /search_crm_records|consult\w*\s+(?:os\s+)?(?:dados|cadastro)|consult\w*\s+o\s+crm/i.test(r));
  if (crmRule) {
    const blocked = c.themes.filter((t) => {
      const q = (t.allowedTools ?? []).filter((x) => (QUERY_TOOL_NAMES as readonly string[]).includes(x));
      return q.length > 0 && !q.includes("search_crm_records");
    });
    if (blocked.length > 0) add("média", "Atalhos e ações", `As regras mandam consultar o CRM, mas a consulta está bloqueada em ${blocked.length} assunto(s) (${blocked.map((t) => t.name).join(", ")}). Os dados do cliente configurados já chegam prontos para o agente.`, "Tire a regra de consultar o CRM ou libere a consulta nesses assuntos.");
  }

  // Ações liberadas sem opções
  const tools = new Set([...(c.enabledTools ?? []), ...c.themes.flatMap((t) => t.allowedTools ?? [])]);
  if (tools.has("move_stage")) {
    const stages = c.actionOptions?.stageIds ?? [];
    if (stages.length === 0) add("alta", "Atalhos e ações", "“Mover etapa” liberada sem etapas escolhidas: a ação nem é oferecida ao agente.", "Escolha as etapas.");
    for (const s of stages) if (!names.stages[s]) add("alta", "Atalhos e ações", `Etapa liberada que não existe mais (${s}).`, "Tire da lista.");
  }
  if (tools.has("add_tag")) {
    const tags = c.actionOptions?.tags ?? [];
    if (tags.length === 0) add("média", "Atalhos e ações", "“Adicionar etiqueta” liberada sem lista: só etiquetas citadas nas instruções.", "Escolha as etiquetas.");
  }
  if (c.survey?.enabled && !tools.has("start_survey")) {
    add("média", "Começo e fim", "Pesquisa de satisfação ligada, mas nenhuma ação a dispara.", "Libere a ação de pesquisa ou desligue.");
  }

  // Começo e fim
  const e = c.entry;
  if (e?.openingEnabled && !e.openingMessage?.trim()) add("média", "Começo e fim", "Boas-vindas ligadas sem mensagem: nada é enviado.", "Escreva as boas-vindas ou desligue.");
  if (e?.confirmContact && (e.confirmationFields ?? []).length === 0) add("baixa", "Começo e fim", "Confirmação de cadastro ligada sem campos para confirmar.", "Escolha os campos (ex.: nome).");
  const knownFieldKeys = new Set(["name", "phone", "email", ...c.contextFields.contact.map((f) => f.key), ...c.contextFields.deal.map((f) => f.key)]);
  for (const f of e?.confirmationFields ?? []) if (!knownFieldKeys.has(f)) add("média", "Começo e fim", `Campo “${fieldName(f, names)}” da confirmação não está entre os dados do cliente usados.`, "Adicione o campo em Dados do cliente ou tire da confirmação.");
  const ina = c.inactivity;
  if (!ina?.enabled) add("baixa", "Começo e fim", "Inatividade desligada: conversa parada fica aberta.", "Ligue o aviso e o encerramento por inatividade.");
  else {
    const nudge = ina.nudgeAfter ?? 0;
    const close = ina.closeAfter ?? 0;
    if (!nudge && !close) add("média", "Começo e fim", "Inatividade ligada sem prazos: nada acontece.", "Defina o aviso e o encerramento.");
    if (nudge > 0 && close > 0 && nudge >= close) add("média", "Começo e fim", `O aviso (${nudge} min) vem depois do encerramento (${close} min): o aviso nunca sai.`, "Deixe o aviso antes do encerramento.");
    if (nudge > 1440) add("baixa", "Começo e fim", "Aviso de inatividade depois de 24 h: o WhatsApp não entrega mensagem livre fora da janela.", "Use até 24 h.");
  }
  if (!c.closure?.goodbyeMessage?.trim() && (c.closure?.courtesyBehavior ?? "no_reply") === "no_reply") {
    add("baixa", "Começo e fim", "Sem despedida e cortesia pós-encerramento em “não responder”: o “obrigado” final fica sem resposta.", "Escreva a despedida ou uma resposta curta de cortesia.");
  }
  if (c.closure && c.closure.postCloseWindowHours === 0) add("baixa", "Começo e fim", "Sem janela pós-encerramento: “obrigado” depois de encerrar abre atendimento novo.", "Defina a janela (ex.: 6 h).");
  if (c.media?.image?.action === "handoff") add("baixa", "Começo e fim", "Imagem transfere na hora (o agente não vê a imagem).", "Considere “Descrever” ou “Pedir para escrever”.");
  if (c.media?.audio?.action === "handoff") add("baixa", "Começo e fim", "Áudio transfere na hora.", "Considere “Transcrever”.");
  if (c.media?.document?.action === "transcribe" || c.media?.document?.action === "describe") add("média", "Começo e fim", "Documento em transcrever/descrever: o agente não lê documentos.", "Use “Pedir para escrever” ou “Transferir”.");
  for (const fu of c.closure?.fieldUpdates ?? []) {
    const cfg = (fu.entity === "deal" ? c.contextFields.deal : c.contextFields.contact).find((f) => f.key === fu.key);
    if (!cfg?.permissions.includes("write")) add("alta", "Começo e fim", `Ao encerrar, o campo “${fieldName(fu.key, names)}” não será gravado: ele não tem a permissão Gravar.`, "Marque Gravar no campo em Dados do cliente.");
  }
  const tabu = c.tabulation;
  if (tabu?.enabled && tabu.strategy === "ai" && !tabu.fallbackId) {
    add("média", "Começo e fim", "“O agente avalia” sem tabulação padrão: quando ele não acha uma que sirva, o atendimento fica sem tabulação.", "Escolha a tabulação padrão.");
  }
  if (tabu?.enabled) {
    const anyLeaf = !!tabu.fallbackId || tabu.strategy === "ai" || c.themes.some((t) => themeTabulationId(c, t));
    if (!anyLeaf) add("média", "Começo e fim", `Tabulação ligada sem tabulação escolhida${(tabu.when ?? "on_close") === "on_close" ? " (ao encerrar vale a do departamento, se houver)" : ": ao transferir fica sem tabulação"}.`, "Escolha a tabulação padrão ou use “o agente avalia”.");
    const ids = [tabu.fallbackId, ...(tabu.allowedIds ?? []), ...Object.values(tabu.byTheme ?? {})].filter((x): x is string => !!x);
    for (const id of [...new Set(ids)]) if (!names.tabulations[id]) add("média", "Começo e fim", `Tabulação ${id} não existe mais ou está inativa.`, "Escolha de novo.");
    if (tabu.strategy === "ai" && (tabu.allowedIds ?? []).length > 0 && (tabu.allowedIds ?? []).every((id) => !names.tabulations[id])) add("alta", "Começo e fim", "“O agente avalia” só com tabulações que não existem mais.", "Escolha as tabulações de novo.");
  }

  // Horário
  const bh = c.businessHours;
  if (bh?.enabled) {
    if ((bh.weekdays ?? []).length === 0) add("média", "Chamar a equipe", "Horário ligado sem dias: vale como sempre aberto; atalhos “fora do horário” nunca disparam.", "Cadastre os dias e horários.");
    const days = (bh.weekdays ?? []).map((d) => d.day);
    const repeated = [...new Set(days.filter((d, i) => days.indexOf(d) !== i))];
    if (repeated.length > 0) add("média", "Chamar a equipe", `Horário com dia repetido (${repeated.map((d) => WEEKDAY[d] ?? d).join(", ")}): provável erro de digitação no lugar de outro dia.`, "Revise os dias do horário.");
    const missingWeek = [1, 2, 3, 4, 5].filter((d) => !days.includes(d));
    if (days.length > 0 && missingWeek.length > 0) add("baixa", "Chamar a equipe", `Horário sem ${missingWeek.map((d) => WEEKDAY[d]).join(", ")}: nesses dias ele conta como fora do horário.`, "Confirme se é isso mesmo.");
    for (const d of bh.weekdays ?? []) {
      if (!/^\d{2}:\d{2}$/.test(d.start) || !/^\d{2}:\d{2}$/.test(d.end) || d.end <= d.start) add("média", "Chamar a equipe", `Horário de ${WEEKDAY[d.day] ?? d.day} inválido (${d.start}–${d.end}): nesse dia nunca está dentro do horário.`, "Corrija o horário.");
    }
  }

  // Dados do cliente
  const sensitive = /\b(cpf|cnpj|rg|documento|senha|cart[aã]o)\b/i;
  for (const [entity, fields] of [["contact", c.contextFields.contact], ["deal", c.contextFields.deal]] as const) {
    for (const f of fields) {
      const label = f.label || fieldName(f.key, names);
      if (f.permissions.length === 0) add("baixa", "O que ele sabe", `Campo “${label}” sem permissão: não é usado.`, "Marque Usar ou tire da lista.");
      if (f.permissions.includes("cite") && sensitive.test(label) && (!f.mask || f.mask === "none")) {
        add("baixa", "O que ele sabe", `Campo “${label}” (${entity === "contact" ? "contato" : "negócio"}) pode ser dito inteiro (CPF e cartão são mascarados na saída; outros documentos não).`, "Use “mascarado” em Mostrar.");
      }
      if (f.permissions.includes("write") && !(c.closure?.fieldUpdates ?? []).some((u) => u.key === f.key) && !tools.has("update_field")) {
        add("baixa", "O que ele sabe", `Campo “${label}” com Gravar, mas nada atualiza esse campo.`, "Configure a atualização ao encerrar ou tire a permissão.");
      }
    }
  }

  // Atalhos
  const active = c.rules.filter((r) => r.enabled !== false).sort((a, b) => a.order - b.order);
  for (const r of active) {
    if (r.conditions.length === 0) add("média", "Atalhos e ações", `Atalho “${r.name}” sem condição: nunca dispara.`, "Defina a condição ou apague.");
    if (r.actions.length === 0) add("baixa", "Atalhos e ações", `Atalho “${r.name}” sem ação: casa e não faz nada (segue para o agente).`, "Defina a ação ou desligue.");
    for (const cond of r.conditions) {
      if (cond.type === "out_of_hours" && !(bh?.enabled && (bh.weekdays ?? []).length > 0)) add("média", "Atalhos e ações", `Atalho “${r.name}” usa “fora do horário”, mas o horário não está configurado: nunca dispara.`, "Configure o horário de atendimento.");
      if (cond.type === "survey_received" && !c.survey?.enabled) add("baixa", "Atalhos e ações", `Atalho “${r.name}” espera resposta de pesquisa com a pesquisa desligada.`, "Ligue a pesquisa ou ajuste o atalho.");
      if (cond.type === "media_kind" && (cond.values ?? []).some((v) => !["audio", "image", "document"].includes(v))) add("média", "Atalhos e ações", `Atalho “${r.name}” com tipo de mídia inválido.`, "Use áudio, imagem ou documento.");
      if (cond.type === "contact_tag" && Object.keys(names.tags).length > 0) {
        for (const v of cond.values ?? []) if (!names.tags[v] && !Object.values(names.tags).some((n) => norm(n) === norm(v))) add("média", "Atalhos e ações", `Atalho “${r.name}” usa etiqueta que não existe (${v}).`, "Escolha a etiqueta de novo.");
      }
      if (cond.type === "deal_stage" && Object.keys(names.stages).length > 0) {
        for (const v of cond.values ?? []) if (!Object.values(names.stages).some((n) => norm(n).endsWith(norm(v)))) add("média", "Atalhos e ações", `Atalho “${r.name}” usa etapa que não existe (${v}).`, "Escolha a etapa de novo.");
      }
    }
    for (const a of r.actions) {
      if (a.type === "set_theme" && !c.themes.some((t) => t.id === a.themeId)) add("alta", "Atalhos e ações", `Atalho “${r.name}” aponta para um assunto que não existe.`, "Escolha o assunto de novo.");
      if (a.type === "send_message" && !a.message?.trim()) add("média", "Atalhos e ações", `Atalho “${r.name}” envia mensagem vazia (segue para o agente).`, "Escreva a mensagem.");
    }
  }
  // Atalho escondido por outro que vem antes e casa nas mesmas situações.
  const sig = (r: V2Rule) => JSON.stringify(r.conditions.map((x) => ({ t: x.type, v: [...(x.values ?? [])].map(norm).sort(), f: x.field ?? "", e: x.expected ?? "", n: !!x.negate })).sort((p, o) => p.t.localeCompare(o.t)));
  const kwOnly = (r: V2Rule) => r.conditions.length === 1 && r.conditions[0].type === "keywords" && !r.conditions[0].negate;
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const a = active[i];
      const b = active[j];
      if (a.conditions.length === 0 || b.conditions.length === 0) continue;
      const bValues = b.conditions[0].values ?? [];
      const aValues = (a.conditions[0].values ?? []).map(norm);
      const shadowed = sig(a) === sig(b) || (kwOnly(a) && kwOnly(b) && bValues.length > 0 && bValues.every((v) => aValues.includes(norm(v))));
      if (shadowed) add("média", "Atalhos e ações", `Atalho “${b.name}” nunca dispara: “${a.name}” vem antes e casa nas mesmas situações.`, "Mude a ordem ou as condições.");
    }
  }

  // Fluxo "Primeiros dias"
  if (c.flow === "onboarding") {
    const steps = c.onboarding?.steps ?? [];
    if (steps.length === 0) add("alta", "Começo e fim", "Fluxo “Primeiros dias” sem etapas: cai no atendimento normal.", "Cadastre as etapas.");
    for (const s of steps) {
      const cc = s.completionCriteria;
      if ((cc?.type === "field_filled" && !cc.field) || (cc?.type === "stage" && !cc.value)) add("alta", "Começo e fim", `Etapa “${s.name}” com critério de conclusão incompleto: nunca conclui.`, "Complete o critério.");
    }
  }

  // Fecho: botões
  const endings: Array<[string, V2ReplyEnding | undefined]> = [["agente", c.replyEnding], ...c.themes.map((t) => [`assunto “${t.name}”`, t.replyEnding] as [string, V2ReplyEnding | undefined])];
  for (const [where, en] of endings) {
    if (!en || en.inherit) continue;
    for (const r of [en.procedure, en.info]) {
      if ((r?.buttons ?? []).length > 3 || (r?.buttons ?? []).some((b) => b.length > 20)) add("baixa", "Quem é o agente", `Fecho do ${where}: só 3 botões saem e cada rótulo é cortado em 20 caracteres.`, "Deixe até 3 botões curtos.");
      if (r?.enabled && !(r.phrases ?? []).some((p) => p.trim())) add("baixa", "Quem é o agente", `Fecho do ${where} ligado sem frase.`, "Escreva a frase ou desligue.");
    }
  }
  const pq = c.closure?.postCloseQuestion;
  if ((pq?.yesLabel?.length ?? 0) > 20 || (pq?.noLabel?.length ?? 0) > 20) add("baixa", "Começo e fim", "Botões da pergunta pós-encerramento com mais de 20 caracteres: são cortados.", "Encurte os rótulos.");

  // Calendário
  const events = c.calendar?.events ?? [];
  if (events.length > 0 && !events.some((ev) => new Date(ev.end ?? ev.start).getTime() >= now.getTime() - 30 * 86400000)) {
    add("baixa", "O que ele sabe", "Calendário só com datas antigas: nada chega ao agente.", "Atualize as datas.");
  }
  if (c.themes.length >= 5 && globalDocs.length > 0 && c.themes.every((t) => themeDocIds(t).length === 0)) {
    add("baixa", "O que ele sabe", "Todos os materiais são gerais: em qualquer assunto ele busca em tudo.", "Considere ligar materiais por assunto.");
  }

  return gaps
    .sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level])
    .map((g, i) => ({ ...g, id: `G-${String(i + 1).padStart(3, "0")}` }));
}

/** Como o motor usa a configuração (texto fixo, para quem analisa a ficha). */
const HOW_IT_DECIDES = [
  "1. Mensagens seguidas do cliente viram um turno só; um turno por vez em cada conversa.",
  "2. Atalhos automáticos rodam antes de tudo, na ordem da lista: o primeiro que casa vence. Atalho sem condição nunca casa.",
  "3. Assunto: gatilho casado > mais próximo em sentido (conforme “Reconhecimento”) > assunto atual. Empate de gatilhos: vence o mais específico e, persistindo, a ordem da lista.",
  "4. Materiais: os do assunto somam aos gerais. Mensagens prontas do assunto substituem as gerais. Se a lista de ferramentas do assunto tem alguma consulta, só essas consultas ficam liberadas.",
  "5. Antes de responder ele busca nos materiais; se nada responde, é orientado a dizer que não tem a informação.",
  "6. A resposta é conferida: valores, datas, prazos, telefones, e-mails, nomes entre aspas e caminhos de tela precisam estar nas fontes; com “Afirmação por afirmação”, um modelo confere o resto. Sem fonte: reescreve; persistindo, mensagem “sem material” (ou transfere).",
  "7. Instruções dos assuntos e informações da empresa contam como fonte (não são conferidas).",
  "8. Pedido de pessoa: palavras de “Chamar a equipe” + frases fixas (“falar com a equipe”…).",
  "9. Horário de atendimento só vale para a condição “Fora do horário” dos atalhos.",
  "10. Campos gravados ao encerrar precisam da permissão Gravar.",
  "11. Transferência para outro agente de IA: o agente de destino responde a mesma mensagem em seguida.",
].join("\n");

/** Ficha do agente em Markdown. */
export function buildAgentRulesMarkdown(args: {
  config: V2AgentConfig;
  names: V2ExportNames;
  agentName: string;
  version: string;
  agentId?: string;
  versionKind?: "published" | "draft";
  generatedAt?: Date;
}): string {
  const { config: c, names } = args;
  const at = (args.generatedAt ?? new Date()).toLocaleString("pt-BR", { timeZone: c.businessHours?.timezone || "America/Sao_Paulo" });
  const gaps = detectConfigGaps(c, names, { agentId: args.agentId, version: args.versionKind, now: args.generatedAt });
  const out: string[] = [];
  const h = (t: string) => out.push("", `## ${t}`, "");
  const count = (lvl: V2ExportGap["level"]) => gaps.filter((g) => g.level === lvl).length;
  const allDocs = [...new Set([...(c.allowedKnowledgeDocIds ?? []), ...c.themes.flatMap(themeDocIds)])];

  out.push(
    `# Regras do agente ${args.agentName}`,
    "",
    `Versão: ${args.version}${args.agentId ? ` · id: ${args.agentId}` : ""} · gerado em ${at}`,
    `Resumo: ${c.themes.length} assunto(s) · ${c.rules.length} atalho(s) · ${allDocs.length} material(is) · pontos de atenção: ${count("alta")} alta, ${count("média")} média, ${count("baixa")} baixa`,
  );

  h(`Pontos de atenção (${gaps.length})`);
  if (gaps.length === 0) out.push("Nenhum ponto detectado pela configuração. Gaps de conteúdo (perguntas que os materiais não cobrem) aparecem no relatório de ações e no Comparar com a equipe.");
  for (const g of gaps) out.push(`- **${g.id} · ${g.level}** · ${g.area}: ${g.text} → ${g.fix}`);

  h("Como o motor decide");
  out.push(HOW_IT_DECIDES);

  h("Publicação");
  out.push(
    `- Modo: ${c.autonomyMode === "auto" ? "automático" : "sugestão (rascunho, não chega ao cliente)"}`,
    `- Fluxo: ${FLOW[c.flow ?? "full"] ?? c.flow}`,
    `- Números de WhatsApp: ${list((c.channelIds ?? []).map((id) => names.channels?.[id] ?? id))}`,
    `- Números de teste: ${(c.allowedPhoneNumbers ?? []).length ? `${(c.allowedPhoneNumbers ?? []).length} (só eles recebem resposta)` : "nenhum (atende todos)"}`,
    `- “Digitando…”: ${c.simulateTyping === false ? "não" : `sim (${c.typingPerCharMs ?? 25} ms por letra)`} · marca como lida: ${yesNo(c.markMessagesRead !== false)}`,
    ...(c.dailyTokenCap ? [`- Teto diário de tokens: ${c.dailyTokenCap} (ao estourar, transfere)`] : []),
  );

  h("Quem é o agente");
  out.push(
    `- Modelo: ${c.model} · estilo: ${BEHAVIOR[c.responseBehavior] ?? c.responseBehavior} · respostas: ${LENGTH[c.responseLength ?? "medium"] ?? c.responseLength}`,
    `- Emojis: ${EMOJIS[c.emojis ?? "light"] ?? c.emojis} · negrito: ${BOLD[c.bold ?? "auto"] ?? c.bold}`,
    `- Links liberados: ${(c.allowedDomains ?? []).length ? list(c.allowedDomains) : "_(nenhum → qualquer link passa)_"}`,
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
    ...(c.includeLostDeals ? ["- Negócio perdido: usa o mais recente quando o cliente não tem outro negócio"] : []),
    ...(c.productPolicy?.enabled ? [`- Catálogo: até ${c.productPolicy.maxItems} produto(s) · preço: ${yesNo(c.productPolicy.showPrice)} · link: ${yesNo(c.productPolicy.showLink)}${c.productPolicy.allowedProductIds?.length ? ` · ${c.productPolicy.allowedProductIds.length} produto(s) liberado(s)` : ""}`] : []),
    "", "**Dados do cliente**",
    ...[...c.contextFields.contact.map((f) => fieldLine(f, "contact", names)), ...c.contextFields.deal.map((f) => fieldLine(f, "deal", names))],
    ...(c.contextFields.contact.length + c.contextFields.deal.length === 0 ? ["_(nenhum campo)_"] : []),
    "", "**Informações da empresa**",
    ...(c.variables.length ? c.variables.map((v) => `- @${v.key}: ${q(v.value)}`) : ["_(nenhuma)_"]),
    "", "**Informações montadas**",
    ...((c.derivedFields ?? []).length
      ? (c.derivedFields ?? []).map((d) => `- ${d.label}: ${d.parts.map((p) => {
        if (p.kind === "text") return q(p.text);
        const what = p.charset === "digits" || p.digitsOnly ? "dígitos de " : p.charset === "letters" ? "letras de " : "";
        const take = p.take && p.take !== "all" ? `${p.take === "first" ? "primeiros" : "últimos"} ${p.count ?? ""} ` : "";
        const kase = p.letterCase && p.letterCase !== "keep" ? ` (${({ upper: "maiúsculas", lower: "minúsculas", capitalize: "primeira maiúscula" } as Record<string, string>)[p.letterCase]})` : "";
        return `${take}${what}${fieldName(p.key, names)} (${p.entity === "deal" ? "negócio" : "contato"})${kase}`;
      }).join(" + ")}${d.mask && d.mask !== "none" ? ` · ${MASK[d.mask]}` : ""}`)
      : ["_(nenhuma)_"]),
    "", "**Calendário**",
    ...((c.calendar?.events ?? []).length ? (c.calendar?.events ?? []).map((ev) => `- ${dateBr(ev.start)}${ev.end ? ` a ${dateBr(ev.end)}` : ""}: ${ev.title}`) : ["_(vazio)_"]),
  );

  h(`Assuntos (${c.themes.length})`);
  out.push(`Reconhecimento: ${({ strict: "rígido", balanced: "equilibrado", loose: "flexível" } as Record<string, string>)[c.themeRecognition?.preset ?? "balanced"]}`);
  if (c.themes.length > 0) {
    out.push(
      "", "| Assunto | id | Gatilhos | Materiais próprios | Transferência | Tabulação |", "|---|---|---|---|---|---|",
      ...c.themes.map((t) => {
        const tab = themeTabulationId(c, t);
        return `| ${t.name} | ${t.id} | ${(t.when ?? []).length} | ${themeDocIds(t).length} | ${t.directHandoff ? "direta" : t.handoffDestination?.type ? "própria" : "padrão"} | ${tab ? names.tabulations[tab] ?? "(não encontrada)" : "padrão"} |`;
      }),
    );
  }
  for (const t of c.themes) {
    const tools = t.allowedTools ?? [];
    const queries = tools.filter((x) => (QUERY_TOOL_NAMES as readonly string[]).includes(x));
    const actions = tools.filter((x) => !(QUERY_TOOL_NAMES as readonly string[]).includes(x));
    const tab = themeTabulationId(c, t);
    out.push(
      "", `### ${t.name} (id: ${t.id})`,
      `- Gatilhos: ${list((t.when ?? []).map((w) => q(w)))}`,
      `- Exemplos: ${list((t.examples ?? []).map((w) => q(w)))}`,
      `- Materiais: ${themeDocIds(t).length ? `${docsText(themeDocIds(t), names)} (somados aos gerais)` : "só os gerais"}`,
      `- Mensagens prontas: ${themeModelIds(t).length ? `${list(themeModelIds(t).map((id) => names.messageModels[id] ?? `(não encontrada: ${id})`))} (substituem as gerais neste assunto)` : "só as gerais"}`,
      `- Consultas: ${queries.length ? `${list(queries.map((x) => TOOL[x] ?? x))} (só estas neste assunto)` : "as mesmas do agente"}`,
      `- Ações: ${actions.length ? list(actions.map((x) => TOOL[x] ?? x)) : "as mesmas do agente"}`,
      `- Transferência: ${t.directHandoff ? "direta (sem responder) para " : ""}${destinationText(t.handoffDestination, names)}${t.handoffDestination?.message ? ` · mensagem: ${q(t.handoffDestination.message)}` : ""}`,
      `- Tabulação: ${tab ? names.tabulations[tab] ?? `(não encontrada: ${tab})` : "_(padrão)_"}`,
      "", "Instruções:", block(t.instructions),
    );
    if (t.replyEnding && !t.replyEnding.inherit) out.push("", "Fecho próprio:", ...endingText(t.replyEnding));
  }

  h(`Atalhos automáticos (${c.rules.length})`);
  const rules = [...c.rules].sort((a, b) => a.order - b.order);
  if (rules.length === 0) out.push("_(nenhum)_");
  for (const r of rules) {
    out.push(`- **${r.name}** (id: ${r.id})${r.enabled === false ? " (desligado)" : ""}: se ${r.conditions.map((x) => conditionText(x, names)).join(" e ") || "_(sem condição → nunca dispara)_"} → ${r.actions.map((a) => actionText(a, names, c)).join("; ") || "_(sem ação)_"}`);
  }
  out.push(
    "", `- Ações liberadas: ${list((c.enabledTools ?? []).map((x) => TOOL[x] ?? x))}`,
    `- Etiquetas que pode usar: ${list((c.actionOptions?.tags ?? []).map((id) => names.tags[id] ?? id))}`,
    `- Etapas para onde pode mover: ${list((c.actionOptions?.stageIds ?? []).map((id) => names.stages[id] ?? id))}`,
    "", "**Fora do escopo**",
    `- Mensagem: ${qd(c.scope?.message, "Aqui eu só consigo ajudar com o atendimento. Quando precisar de algo sobre isso, é só me chamar.")}`,
    ...(c.scope?.forbidden ?? []).map((f) => `- Não atende: ${q(f.subject)}`),
  );

  h("Começo e fim da conversa");
  const e = c.entry;
  const mediaLine = (kind: "audio" | "image" | "document", label: string) => {
    const m = c.media?.[kind];
    const msg = m?.action === "ask_text" ? m.askTextMessage : m?.action === "handoff" ? m.handoffMessage : undefined;
    return `- ${label}: ${mediaLabel(m?.action)}${msg ? ` (${q(msg)})` : ""}${m?.notUnderstoodMessage ? ` · se não entender: ${q(m.notUnderstoodMessage)}` : ""}`;
  };
  const onDeal = e?.onDealNotFound ?? "ask_identification";
  out.push(
    `- Boas-vindas: ${e?.openingEnabled ? (e.openingMessage?.trim() ? q(e.openingMessage) : "_(ligadas sem mensagem → nada é enviado)_") : "desligadas"}`,
    `- Confirmar cadastro: ${yesNo(e?.confirmContact)}${e?.confirmContact ? ` (${e.confirmationMode === "separate_turn" ? "na mensagem seguinte" : "junto das boas-vindas"}) · campos: ${list((e.confirmationFields ?? []).map((f) => fieldName(f, names)))} · mensagem: ${q(e.confirmationMessage)}` : ""}`,
    `- Sem cadastro: ${({ ask_identification: "pede e-mail ou documento e passa para a equipe", create_deal: "cria negócio e segue", handoff: "passa para a equipe" } as Record<string, string>)[onDeal]}${onDeal === "ask_identification" ? ` · mensagem: ${q(e?.identificationMessage)} · tentativas: ${e?.maxAttempts ?? 2}` : ""}`,
    ...(Object.keys(e?.automationVariablesMapping ?? {}).length ? [`- Variáveis vindas da automação: ${Object.entries(e?.automationVariablesMapping ?? {}).map(([from, to]) => `${from} → ${to}`).join(", ")}`] : []),
    mediaLine("audio", "Áudio"), mediaLine("image", "Imagem"), mediaLine("document", "Documento"),
    `- Confirma o que entendeu da mídia: ${yesNo(c.media?.confirmUnderstanding)}`,
    `- Despedida: ${q(c.closure?.goodbyeMessage)} (sem despedida, sai a resposta do agente)`,
    `- Depois de encerrar (${c.closure?.postCloseWindowHours ?? "—"} h):`,
    `  - cortesia → ${POST_CLOSE[c.closure?.courtesyBehavior ?? "no_reply"]}${c.closure?.postCloseMessages?.courtesy ? ` (${q(c.closure.postCloseMessages.courtesy)})` : ""}`,
    `  - pedido novo → ${POST_CLOSE[c.closure?.newDemandBehavior ?? "reopen_and_route"]}${c.closure?.postCloseMessages?.new_demand ? ` (${q(c.closure.postCloseMessages.new_demand)})` : ""}`,
    `  - dúvida → ${POST_CLOSE[c.closure?.ambiguousBehavior ?? "ask_with_options"]}${c.closure?.postCloseMessages?.ambiguous ? ` (${q(c.closure.postCloseMessages.ambiguous)})` : ""}`,
    `  - pergunta: ${q(c.closure?.postCloseQuestion?.message ?? "Você precisa de ajuda com algo novo?")} · botões: ${q((c.closure?.postCloseQuestion?.yesLabel ?? "Preciso de ajuda").slice(0, 20))} / ${q((c.closure?.postCloseQuestion?.noLabel ?? "Só agradecer").slice(0, 20))}`,
    `- Campos gravados ao encerrar: ${list((c.closure?.fieldUpdates ?? []).map((u) => `${fieldName(u.key, names)} (${u.entity === "deal" ? "negócio" : "contato"}) = ${q(u.value)}`))}`,
    ...(c.closure?.nextAutomationStepId ? [`- Ao encerrar, segue a automação no passo ${c.closure.nextAutomationStepId}`] : []),
    `- Volta o negócio para a etapa de origem ao encerrar: ${yesNo(c.closure?.returnToOriginStage)}`,
    `- Inatividade: ${c.inactivity?.enabled ? `aviso em ${c.inactivity.nudgeAfter ?? "—"} min (${qd(c.inactivity.nudgeMessage, "Ainda está por aí?")}), encerra em ${c.inactivity.closeAfter ?? "—"} min (${q(c.inactivity.closeMessage)})` : "desligada"}`,
    `- Tabulação: ${c.tabulation?.enabled ? `${c.tabulation.strategy === "ai" ? "o agente avalia" : "fixa"} · ${TAB_WHEN[c.tabulation.when ?? "on_close"] ?? c.tabulation.when} · padrão: ${c.tabulation.fallbackId ? names.tabulations[c.tabulation.fallbackId] ?? c.tabulation.fallbackId : "—"}${c.tabulation.strategy === "ai" ? ` · pode escolher: ${list((c.tabulation.allowedIds ?? []).map((id) => names.tabulations[id] ?? id))}` : ""}${c.tabulation.instructions ? ` · instruções: ${q(c.tabulation.instructions)}` : ""}` : "desligada"}`,
    ...(c.survey?.enabled ? [`- Pesquisa de satisfação: ${q(c.survey.question)}`] : []),
  );
  if (c.flow === "onboarding") {
    out.push("", "**Primeiros dias (etapas)**");
    for (const s of c.onboarding?.steps ?? []) out.push(`- ${s.name}: ${s.goal} · conclui quando: ${s.completionCriteria?.type ?? "—"}${s.completionCriteria?.field ? ` ${fieldName(s.completionCriteria.field, names)}` : ""}${s.completionCriteria?.value ? ` = ${s.completionCriteria.value}` : ""} · travou: ${destinationText(s.handoffOnStuck, names)}`);
    if (!(c.onboarding?.steps ?? []).length) out.push("_(nenhuma etapa)_");
  }

  h("Quando chama a equipe");
  const bh = c.businessHours;
  out.push(
    `- Destino padrão: ${destinationText(c.handoff?.defaultDestination, names)}`,
    `- Mensagem de transferência: ${q(c.handoff?.message)}`,
    `- Pedido de pessoa: ${list([...(c.handoff?.humanRequestKeywords ?? []), ...HUMAN_REQUEST_PHRASES].map((w) => q(w)))}`,
    `- Enquanto espera na fila: ${c.handoff?.whileQueued === "answer" ? "responde" : "só avisa"} (${qd(c.handoff?.queuedMessage, "Você já está na fila de atendimento. Em instantes alguém da equipe continua com você por aqui.")})`,
    `- Horário de atendimento (usado pela condição “Fora do horário” dos atalhos): ${bh?.enabled ? ((bh.weekdays ?? []).length ? bh.weekdays.map((d) => `${WEEKDAY[d.day] ?? d.day} ${d.start}–${d.end}`).join(", ") : "ligado sem dias → sempre aberto") : "desligado"}`,
    `- Cliente irritado: ${c.sentiment?.enabled ? `${SENTIMENT_ACTION[c.sentiment.action] ?? c.sentiment.action} (a partir de: ${THRESHOLD[c.sentiment.threshold] ?? c.sentiment.threshold})` : "desligado"}`,
    `- Sem material: ${qd(c.fallback?.noSource?.message, "transfere com a mensagem de transferência")}`,
    `- Cliente não entendeu: ${c.fallback?.confusion?.action === "handoff" ? "o agente decide" : "refaz a pergunta"}`,
    `- Erro: ${qd(c.fallback?.error?.message, c.handoff?.message || "mensagem de transferência")}`,
    `- Limites: respostas a agradecimento depois de encerrar ${c.limits?.maxCourtesyReplies ?? "—"} · mensagens fora do assunto seguidas ${c.limits?.nonsenseLimit ?? "—"} (${c.limits?.nonsenseAction === "handoff" ? "transfere" : "avisa e silencia"}) · mesma mensagem repetida ${c.limits?.maxLoopCount ?? "—"} · transferências entre agentes de IA ${c.limits?.maxAiTransfers ?? "—"}`,
  );

  return out.join("\n").replace(/\n{3,}/g, "\n\n") + "\n";
}
