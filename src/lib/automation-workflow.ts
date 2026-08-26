import {
  newBranchId,
  summarizeConditionConfig,
  type ConditionConfig,
} from "@/lib/automation-condition";
import {
  newRoundRobinOptionId,
  summarizeRoundRobinConfig,
  type RoundRobinConfig,
} from "@/lib/automation-round-robin";

export type AutomationTriggerType =
  | "stage_changed"
  | "tag_added"
  | "lead_score_reached"
  | "deal_created"
  | "deal_won"
  | "deal_lost"
  | "contact_created"
  | "conversation_created"
  | "lifecycle_changed"
  | "agent_changed"
  | "message_received"
  | "message_sent"
  | "call_received"
  | "call_made"
  | "call_permission_granted"
  | "conversation_tabulated"
  | "whatsapp_session_expiring"
  /** Distribuição Inteligente atribuiu um consultor HUMAN (1ª vez). */
  | "lead_distributed"
  | "manual";

export type AutomationStep = {
  id: string;
  type: string;
  config: Record<string, unknown>;
};

export const AUTOMATION_TRIGGER_TYPES: AutomationTriggerType[] = [
  "stage_changed",
  "tag_added",
  "lead_score_reached",
  "deal_created",
  "deal_won",
  "deal_lost",
  "contact_created",
  "conversation_created",
  "lifecycle_changed",
  "agent_changed",
  "message_received",
  "message_sent",
  "call_received",
  "call_made",
  "call_permission_granted",
  "conversation_tabulated",
  "whatsapp_session_expiring",
  "lead_distributed",
  "manual",
];

export const ACTION_STEP_TYPES = [
  "send_email",
  "move_stage",
  "mark_deal_won",
  "mark_deal_lost",
  "assign_owner",
  "transfer_department",
  "add_tag",
  "remove_tag",
  "update_field",
  "create_activity",
  "send_whatsapp_message",
  "send_whatsapp_template",
  "send_whatsapp_media",
  "send_whatsapp_interactive",
  "send_whatsapp_list",
  "webhook",
  "delay",
  "condition",
  "round_robin",
  "update_lead_score",
  "question",
  "wait_for_reply",
  "set_variable",
  "goto",
  "transfer_automation",
  "stop_automation",
  "finish",
  "create_deal",
  "finish_conversation",
  "tabulate_conversation",
  "business_hours",
  "check_agent_status",
  "ask_ai_agent",
  "transfer_to_ai_agent",
  "execute_distribution",
  "inventory.adjust",
  "send_product",
] as const;

export type ActionStepType = (typeof ACTION_STEP_TYPES)[number];

/**
 * Steps de "mensagem" que suportam seleção de canal (`config.channelId`).
 * `question` está incluído porque envia via WhatsApp/Meta (pergunta ao
 * lead) — mesmo picker/regra de herança dos demais envios WA.
 */
export const MESSAGE_CHANNEL_STEP_TYPES = [
  "send_whatsapp_message",
  "send_whatsapp_template",
  "send_whatsapp_media",
  "send_whatsapp_interactive",
  "send_whatsapp_list",
  "send_product",
  "send_email",
  "question",
] as const;

export function isMessageChannelStep(type: string): boolean {
  return (MESSAGE_CHANNEL_STEP_TYPES as readonly string[]).includes(type);
}

/** Índice do primeiro step de mensagem na ordem do array (= `position`). */
export function findFirstMessageStepIndex(steps: { type: string }[]): number {
  return steps.findIndex((s) => isMessageChannelStep(s.type));
}

/** Gatilhos cuja mensagem/ticket já define o canal de envio. */
export const INBOUND_CHANNEL_TRIGGER_TYPES = new Set([
  "message_received",
  "message_sent",
  "conversation_created",
  "call_received",
  "call_made",
]);

/** Conexões (`Channel.id`) do gatilho. Vazio = qualquer canal. */
export function readTriggerChannelIds(cfg: unknown): string[] {
  const c = asRecord(cfg);
  const many = Array.isArray(c.channelIds)
    ? c.channelIds.filter((x): x is string => typeof x === "string" && x.trim() !== "")
        .map((s) => s.trim())
    : [];
  if (many.length > 0) return [...new Set(many)];
  const one = typeof c.channelId === "string" ? c.channelId.trim() : "";
  return one ? [one] : [];
}

/** `all` = qualquer conexão; `selected` = só os ids em `channelIds`. */
export function readTriggerChannelScope(cfg: unknown): "all" | "selected" {
  const c = asRecord(cfg);
  if (c.channelScope === "selected") return "selected";
  if (c.channelScope === "all") return "all";
  return readTriggerChannelIds(cfg).length > 0 ? "selected" : "all";
}

/**
 * Allowlist do passo de envio. `null` = todos os canais ativos.
 * `channelId` legado sozinho NÃO vira filtro — era override de envio.
 */
export function readStepAllowedChannelIds(cfg: unknown): string[] | null {
  const c = asRecord(cfg);
  if (c.channelScope === "all") return null;
  const many = Array.isArray(c.channelIds)
    ? c.channelIds
        .filter((x): x is string => typeof x === "string" && x.trim() !== "")
        .map((s) => s.trim())
    : [];
  const unique = [...new Set(many)];
  if (c.channelScope === "selected") return unique;
  return unique.length > 0 ? unique : null;
}

export function inheritedChannelFromTrigger(triggerConfig: unknown): string {
  const ids = readTriggerChannelIds(triggerConfig);
  return ids.length === 1 ? ids[0]! : "";
}

export function triggerBindsInboundChannel(triggerType: string): boolean {
  return INBOUND_CHANNEL_TRIGGER_TYPES.has(triggerType);
}

/**
 * 1º passo de mensagem só exige `channelId` quando a org tem 2+ canais
 * E o gatilho não amarra o envio à entrada (inbound / 1 conexão).
 */
export function validateFirstMessageChannel(
  steps: { type: string; config?: unknown }[],
  connectedChannelCount: number,
  opts?: { triggerType?: string; triggerConfig?: unknown },
): string | null {
  if (connectedChannelCount < 2) return null;
  if (opts?.triggerType && triggerBindsInboundChannel(opts.triggerType)) return null;
  if (readTriggerChannelIds(opts?.triggerConfig).length === 1) return null;
  const idx = findFirstMessageStepIndex(steps);
  if (idx < 0) return null;
  const cfg = asRecord(steps[idx].config);
  const channelId = typeof cfg.channelId === "string" ? cfg.channelId.trim() : "";
  return channelId ? null : "MISSING_CHANNEL_ON_FIRST_MESSAGE_STEP";
}

export function triggerTypeLabel(t: string): string {
  const map: Record<string, string> = {
    stage_changed: "Estágio alterado",
    tag_added: "Tag adicionada",
    lead_score_reached: "Lead score atingido",
    deal_created: "Negócio criado",
    deal_won: "Negócio ganho",
    deal_lost: "Negócio perdido",
    contact_created: "Contato criado",
    conversation_created: "Conversa criada",
    lifecycle_changed: "Ciclo de vida alterado",
    agent_changed: "Agente alterado",
    message_received: "Mensagem recebida",
    message_sent: "Mensagem enviada",
    call_received: "Ligação recebida",
    call_made: "Ligação realizada",
    call_permission_granted: "Permissão de ligação concedida",
    conversation_tabulated: "Conversa encerrada",
    whatsapp_session_expiring: "Sessão do WhatsApp prestes a encerrar",
    lead_distributed: "Lead distribuído (consultor humano)",
    manual: "Manual (executar pela conversa)",
  };
  return map[t] ?? t;
}

export function stepTypeLabel(t: string): string {
  const map: Record<string, string> = {
    send_email: "Enviar e-mail",
    move_stage: "Mover estágio",
    mark_deal_won: "Ganho",
    mark_deal_lost: "Perda",
    assign_owner: "Atribuir responsável",
    transfer_department: "Transferir para departamento",
    add_tag: "Adicionar tag",
    remove_tag: "Remover tag",
    update_field: "Atualizar campo",
    create_activity: "Criar atividade",
    send_whatsapp_message: "Mensagem WhatsApp",
    send_whatsapp_template: "Template WhatsApp",
    send_whatsapp_media: "Mídia WhatsApp",
    send_whatsapp_interactive: "Botões WhatsApp",
    send_whatsapp_list: "Lista WhatsApp",
    webhook: "Webhook",
    delay: "Atraso",
    condition: "Condição",
    round_robin: "Round Robin de caminhos",
    update_lead_score: "Atualizar lead score",
    question: "Pergunta ao lead",
    wait_for_reply: "Aguardar resposta",
    set_variable: "Definir variável",
    goto: "Ir para (Goto)",
    transfer_automation: "Transferir automação",
    stop_automation: "Encerrar automação",
    finish: "Finalizar fluxo",
    create_deal: "Criar negócio",
    finish_conversation: "Encerrar conversa",
    tabulate_conversation: "Tabular conversa",
    business_hours: "Horário comercial",
    check_agent_status: "Status do agente",
    ask_ai_agent: "Perguntar ao agente IA",
    transfer_to_ai_agent: "Transferir para agente IA",
    execute_distribution: "Executar distribuição",
    "inventory.adjust": "Ajustar alocação (estoque/vagas)",
    send_product: "Enviar produto",
  };
  return map[t] ?? t;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

export function summarizeTriggerConfig(
  triggerType: string,
  triggerConfig: unknown,
  lookup?: Record<string, string>,
): string {
  const c = asRecord(triggerConfig);
  switch (triggerType) {
    case "stage_changed": {
      const parts: string[] = [];
      if (c.fromStageId) {
        const id = String(c.fromStageId);
        parts.push(`De: ${lookup?.[id] ?? id}`);
      }
      if (c.toStageId) {
        const id = String(c.toStageId);
        parts.push(`Para: ${lookup?.[id] ?? id}`);
      }
      return parts.length ? parts.join(" · ") : "Qualquer mudança de estágio";
    }
    case "tag_added": {
      if (c.tagName) return `Tag: ${String(c.tagName)}`;
      if (c.tagId) return `ID: ${String(c.tagId)}`;
      return "Qualquer tag";
    }
    case "lead_score_reached":
      return `Mín.: ${c.threshold ?? c.minScore ?? "—"}`;
    case "deal_created":
    case "deal_won":
    case "deal_lost":
      return c.pipelineId ? `Pipeline: ${String(c.pipelineId)}` : "Qualquer pipeline";
    case "contact_created":
      return "Novo contato";
    case "conversation_created": {
      const ids = readTriggerChannelIds(c);
      if (ids.length === 1) {
        const id = ids[0]!;
        return `Conexão: ${lookup?.[id] ?? id.slice(0, 8)}`;
      }
      if (ids.length > 1) return `${ids.length} conexões`;
      return c.channel ? `Canal: ${String(c.channel)}` : "Qualquer canal";
    }
    case "lifecycle_changed": {
      const to = c.toLifecycle ?? c.lifecycleStage;
      const from = c.fromLifecycle ?? c.from;
      if (to && from) return `${String(from)} → ${String(to)}`;
      if (to) return `Para: ${String(to)}`;
      return "Qualquer mudança";
    }
    case "agent_changed": {
      const toAgent = c.toAgentId;
      return toAgent ? `Agente: ${String(toAgent)}` : "Qualquer agente";
    }
    case "message_received":
    case "message_sent": {
      const ch = c.channel;
      const ids = Array.isArray(c.channelIds)
        ? c.channelIds.filter((x): x is string => typeof x === "string" && x.trim() !== "")
        : typeof c.channelId === "string" && c.channelId.trim()
          ? [c.channelId.trim()]
          : [];
      if (ids.length === 1) {
        const id = ids[0];
        return `Conexão: ${lookup?.[id] ?? id.slice(0, 8)}`;
      }
      if (ids.length > 1) return `${ids.length} conexões`;
      return ch ? `Canal: ${String(ch)}` : "Qualquer canal";
    }
    case "call_received":
    case "call_made": {
      const status = c.status ? String(c.status) : "";
      const statusLabel: Record<string, string> = {
        answered: "Atendidas",
        missed: "Não atendidas",
      };
      return status ? (statusLabel[status] ?? status) : "Qualquer ligação";
    }
    case "call_permission_granted": {
      const t = c.consentType ? String(c.consentType) : "";
      if (t === "PERMANENT") return "Permanente";
      if (t === "TEMPORARY") return "Temporária 7 dias";
      return "Qualquer tipo";
    }
    case "manual":
      return "Disparada manualmente da conversa";
    case "lead_distributed": {
      if (c.departmentId) {
        return `Depto: ${String(c.departmentId).slice(0, 8)}…`;
      }
      return "Quando um consultor humano assume o lead";
    }
    case "conversation_tabulated": {
      if (c.tabulationLabel) return `Tabulação: ${String(c.tabulationLabel)}`;
      if (c.tabulationId) return `Tabulação ID: ${String(c.tabulationId).slice(0, 8)}…`;
      if (c.departmentId) return `Departamento: ${String(c.departmentId).slice(0, 8)}…`;
      return "Qualquer encerramento";
    }
    case "whatsapp_session_expiring":
      return `${String(c.hoursBeforeExpiry ?? 1)}h antes do encerramento`;
    default:
      return "—";
  }
}

export function summarizeStepConfig(stepType: string, config: unknown, lookup?: Record<string, string>): string {
  const c = asRecord(config);
  switch (stepType) {
    case "send_email":
      return c.subject ? String(c.subject) : c.to ? `Para: ${String(c.to)}` : "Configurar e-mail";
    case "move_stage": {
      if (c.stageName) return String(c.stageName);
      const sid = c.stageId ? String(c.stageId) : "";
      if (sid && lookup?.[sid]) return lookup[sid];
      return sid ? `Estágio: ${sid.slice(0, 12)}…` : "Definir estágio";
    }
    case "mark_deal_won": {
      if (c.pipelineName) return `Funil: ${String(c.pipelineName)}`;
      const pid = c.pipelineId ? String(c.pipelineId) : "";
      if (pid && lookup?.[pid]) return `Funil: ${lookup[pid]}`;
      return pid ? `Funil: ${pid.slice(0, 12)}…` : "Selecionar funil";
    }
    case "mark_deal_lost": {
      const pipelineLabel = c.pipelineName
        ? String(c.pipelineName)
        : c.pipelineId && lookup?.[String(c.pipelineId)]
          ? lookup[String(c.pipelineId)]
          : c.pipelineId
            ? `${String(c.pipelineId).slice(0, 12)}…`
            : "";
      const reason = c.lostReason ? String(c.lostReason) : "";
      if (pipelineLabel && reason) return `${pipelineLabel} · ${reason}`;
      if (pipelineLabel) return `Funil: ${pipelineLabel} (sem motivo)`;
      return "Selecionar funil e motivo";
    }
    case "assign_owner": {
      const target = c.target ? String(c.target) : "deal";
      const targetLabel = target === "both" ? "negócio e contato" : target === "contact" ? "contato" : "negócio";
      const userId = c.userId ? String(c.userId).trim() : "";
      if (!userId) return `Limpar responsável (${targetLabel})`;
      return `Usuário: ${userId} (${targetLabel})`;
    }
    case "transfer_department":
      return c.departmentName
        ? String(c.departmentName)
        : c.departmentId
          ? `Depto: ${String(c.departmentId).slice(0, 8)}…`
          : "Selecionar departamento";
    case "add_tag":
    case "remove_tag":
      return c.tagName ? String(c.tagName) : c.tagId ? `ID: ${String(c.tagId)}` : "Definir tag";
    case "update_field":
      return c.field ? `${String(c.field)} = ${String(c.value ?? "")}` : "Campo / valor";
    case "create_activity":
      return c.title ? String(c.title) : "Nova atividade";
    case "send_whatsapp_message":
      // sendAs: "bot" (padrão) | "assignee" (como o consultor responsável)
      return c.content
        ? `${c.sendAs === "assignee" ? "[Responsável] " : ""}${String(c.content).slice(0, 40)}${String(c.content).length > 40 ? "…" : ""}`
        : c.sendAs === "assignee"
          ? "Mensagem (como responsável)"
          : "Mensagem";
    case "send_whatsapp_template": {
      const tplLabel = c.templateLabel ? String(c.templateLabel) : "";
      const tplName = c.templateName ? String(c.templateName) : "";
      return tplLabel || tplName || "Template";
    }
    case "send_whatsapp_media": {
      const mtype = c.mediaType ?? "image";
      const mtypeLabel: Record<string, string> = { image: "Imagem", video: "Vídeo", audio: "Áudio", document: "Documento" };
      const caption = c.caption ? `: ${String(c.caption).slice(0, 30)}` : "";
      return `${mtypeLabel[String(mtype)] ?? String(mtype)}${caption}`;
    }
    case "send_whatsapp_interactive": {
      const btns = Array.isArray(c.buttons) ? c.buttons.length : 0;
      const bodyText = c.body ? String(c.body).slice(0, 30) : "";
      return btns > 0 ? `[${btns} botões] ${bodyText}` : bodyText || "Configurar botões";
    }
    case "send_whatsapp_list": {
      const rows = Array.isArray(c.rows) ? c.rows.length : 0;
      const bodyText = c.body ? String(c.body).slice(0, 30) : "";
      return rows > 0 ? `[${rows} itens] ${bodyText}` : bodyText || "Configurar lista";
    }
    case "webhook":
      return c.url ? String(c.url).replace(/^https?:\/\//, "").slice(0, 36) : "URL";
    case "delay": {
      const ms = Number(c.ms ?? c.milliseconds ?? 0);
      if (ms >= 86_400_000) return `${ms / 86_400_000} d`;
      if (ms >= 3_600_000) return `${ms / 3_600_000} h`;
      if (ms >= 60_000) return `${ms / 60_000} min`;
      return ms ? `${ms / 1000} s` : "Duração";
    }
    case "condition":
      return summarizeConditionConfig(c);
    case "round_robin":
      return summarizeRoundRobinConfig(c);
    case "update_lead_score":
      return "Recalcular score";
    case "question": {
      const msg = c.message ?? c.question;
      const btns = Array.isArray(c.buttons) ? c.buttons : [];
      const prefix = btns.length > 0 ? `[${btns.length} botões] ` : "";
      return msg ? prefix + String(msg).slice(0, 40) + (String(msg).length > 40 ? "…" : "") : "Aguardando resposta";
    }
    case "wait_for_reply": {
      const timeoutMs = Number(c.timeoutMs ?? 0);
      const parts: string[] = ["Até a mensagem recebida"];
      if (timeoutMs > 0) {
        if (timeoutMs >= 3_600_000) parts.push(`⏱ ${timeoutMs / 3_600_000}h`);
        else if (timeoutMs >= 60_000) parts.push(`⏱ ${timeoutMs / 60_000}min`);
        else parts.push(`⏱ ${timeoutMs / 1000}s`);
      }
      return parts.join(" · ");
    }
    case "finish":
      return "Encerrar automação";
    case "set_variable": {
      const name = c.variableName ?? c.name;
      return name ? `{{${String(name)}}} = ${String(c.value ?? "…")}` : "Definir variável";
    }
    case "goto": {
      const target = c.targetStepId;
      return target ? `Ir para: ${String(target).slice(0, 12)}` : "Definir destino";
    }
    case "transfer_automation": {
      const tName = c.targetAutomationName ?? c.targetAutomationId;
      return tName ? `→ ${String(tName)}` : "Selecionar automação";
    }
    case "stop_automation":
      return "Parar automação atual";
    case "create_deal": {
      const title = c.title ? String(c.title) : "";
      return title || "Novo negócio";
    }
    case "finish_conversation":
      return "Resolver conversas abertas";
    case "tabulate_conversation": {
      const label = c.tabulationLabel ? String(c.tabulationLabel) : "";
      const closes = c.closeConversation !== false;
      if (!label) return "Selecionar tabulação";
      return closes ? `${label} + encerrar` : label;
    }
    case "business_hours": {
      const tz = c.timezone ? String(c.timezone) : "America/Sao_Paulo";
      return `Fuso: ${tz}`;
    }
    case "check_agent_status":
      return "Responsável da conversa";
    case "ask_ai_agent": {
      const agentName = c.agentLabel ?? c.agentName;
      if (agentName) return `Agente: ${String(agentName)}`;
      return c.agentId ? `ID: ${String(c.agentId).slice(0, 8)}…` : "Selecionar agente";
    }
    case "transfer_to_ai_agent": {
      const agentName = c.agentLabel;
      if (agentName) return `→ ${String(agentName)}`;
      return c.agentUserId
        ? `ID: ${String(c.agentUserId).slice(0, 8)}…`
        : "Selecionar agente IA";
    }
    case "execute_distribution": {
      const names = Array.isArray(c.departmentNames)
        ? c.departmentNames.filter((v): v is string => typeof v === "string" && v.trim().length > 0)
        : [];
      const t = c.distributionType ? String(c.distributionType) : "";
      if (names.length > 0) {
        const deptLabel =
          names.length <= 2 ? names.join(", ") : `${names.slice(0, 2).join(", ")} +${names.length - 2}`;
        return t ? `${deptLabel} · ${t}` : deptLabel;
      }
      return t ? `Distribuição: ${t}` : "Distribuição padrão";
    }
    case "send_product": {
      const name = c.productName ? String(c.productName) : "";
      const channel = c.channel ? String(c.channel) : "";
      if (name && channel) return `${name} · ${channel}`;
      if (name) return `Produto: ${name}`;
      return c.productId ? `Produto: ${String(c.productId).slice(0, 8)}…` : "Selecionar produto";
    }
    default:
      return "—";
  }
}

/**
 * Retorna true quando o passo não tem a configuração mínima pra executar
 * sem falhar em runtime. Usado no canvas pra destacar visualmente steps
 * incompletos — o operador não precisa esperar a automação rodar e falhar
 * pra descobrir que esqueceu de preencher um texto obrigatório.
 */
export function isStepIncomplete(
  stepType: string,
  config: unknown,
  opts?: { requireChannel?: boolean },
): boolean {
  const c = typeof config === "object" && config !== null ? (config as Record<string, unknown>) : {};
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  if (opts?.requireChannel && isMessageChannelStep(stepType) && !str(c.channelId)) {
    return true;
  }
  switch (stepType) {
    case "mark_deal_won":
      return !str(c.pipelineId);
    case "mark_deal_lost":
      return !str(c.pipelineId) || !str(c.lostReason);
    case "send_whatsapp_message":
      return !str(c.content);
    case "send_product":
      return !str(c.productId);
    case "send_whatsapp_template":
      return !str(c.templateName);
    case "send_whatsapp_media":
      return !str(c.mediaUrl) && !str(c.mediaId);
    case "send_whatsapp_interactive":
      return !str(c.body) || !(Array.isArray(c.buttons) && c.buttons.length > 0);
    case "send_whatsapp_list":
      return (
        !str(c.body) ||
        !str(c.button) ||
        !(Array.isArray(c.rows) && c.rows.length > 0)
      );
    case "send_email":
      return !str(c.to) || !str(c.subject) || !str(c.body);
    case "webhook":
      return !str(c.url);
    case "question":
      return !(str(c.message) || str(c.question));
    case "goto":
      return !str(c.targetStepId);
    case "transfer_automation":
      return !str(c.targetAutomationId);
    case "ask_ai_agent":
      return !str(c.agentId);
    case "transfer_to_ai_agent":
      return !str(c.agentUserId);
    case "transfer_department":
      return !str(c.departmentId);
    default:
      return false;
  }
}

export function defaultStepConfig(stepType: string): Record<string, unknown> {
  switch (stepType) {
    case "send_email":
      return { to: "", subject: "", body: "" };
    case "move_stage":
      return { stageId: "" };
    case "mark_deal_won":
      return { pipelineId: "", pipelineName: "" };
    case "mark_deal_lost":
      return { pipelineId: "", pipelineName: "", lostReason: "" };
    case "assign_owner":
      return { userId: "", target: "deal" };
    case "transfer_department":
      return { departmentId: "", departmentName: "" };
    case "add_tag":
    case "remove_tag":
      return { tagName: "" };
    case "update_field":
      return { field: "", value: "" };
    case "create_activity":
      return { type: "TASK", title: "", description: "" };
    case "send_whatsapp_message":
      // sendAs: "bot" | "assignee"
      // - bot (padrão): authorType bot — conversa distribuída permanece em Entrada
      // - assignee: grava como o consultor HUMAN da conversa (hasHumanReply=true
      //   → Respondidas). Sem responsável humano → fallback bot.
      // UI do builder (frontend): dropdown "Enviar como" persistindo config.sendAs.
      return {
        content: "",
        sendAs: "bot",
        failureAction: "stop",
        failureGotoStepId: "",
        timeoutMs: 86_400_000,
        timeoutAction: "continue",
        timeoutGotoStepId: "",
      };
    case "send_product":
      // content: texto livre com variáveis {{produto.*}}. Vazio = monta um
      // resumo padrão do produto no executor.
      // unitPrice/discountPercent/channel: opção de preço do curso (quando houver).
      return {
        productId: "",
        productName: "",
        content: "",
        unitPrice: "",
        discountPercent: "",
        channel: "",
      };
    case "send_whatsapp_template":
      return {
        templateName: "",
        languageCode: "pt_BR",
        failureAction: "stop",
        failureGotoStepId: "",
        timeoutMs: 86_400_000,
        timeoutAction: "continue",
        timeoutGotoStepId: "",
      };
    case "send_whatsapp_media":
      return {
        mediaType: "image",
        mediaUrl: "",
        caption: "",
        failureAction: "stop",
        failureGotoStepId: "",
      };
    case "send_whatsapp_interactive":
      return {
        body: "",
        buttons: [],
        header: "",
        footer: "",
        elseGotoStepId: "",
        saveToVariable: "",
        failureAction: "stop",
        failureGotoStepId: "",
      };
    case "send_whatsapp_list":
      return {
        body: "",
        button: "Ver opções",
        sectionTitle: "",
        rows: [],
        header: "",
        footer: "",
        elseGotoStepId: "",
        saveToVariable: "",
        timeoutMs: 86_400_000,
        timeoutAction: "continue",
        timeoutGotoStepId: "",
        failureAction: "stop",
        failureGotoStepId: "",
      };
    case "webhook":
      return { url: "", method: "POST" };
    case "delay":
      return { ms: 60_000 };
    case "condition": {
      const cfg: ConditionConfig = {
        branches: [
          {
            id: newBranchId(),
            rules: [{ field: "", op: "eq", value: "" }],
          },
        ],
      };
      return cfg as unknown as Record<string, unknown>;
    }
    case "round_robin": {
      const cfg: RoundRobinConfig = {
        options: [{ id: newRoundRobinOptionId() }, { id: newRoundRobinOptionId() }],
      };
      return cfg as unknown as Record<string, unknown>;
    }
    case "update_lead_score":
      return {};
    case "question":
      return {
        message: "", buttons: [], saveToVariable: "",
        timeoutMs: 86_400_000, timeoutAction: "continue",
        timeoutGotoStepId: "", elseGotoStepId: "",
        failureAction: "stop", failureGotoStepId: "",
      };
    case "wait_for_reply":
      return {
        timeoutMs: 60_000, receivedGotoStepId: "", timeoutGotoStepId: "", saveToVariable: "",
      };
    case "finish":
      return { action: "stop" };
    case "set_variable":
      return { variableName: "", value: "" };
    case "goto":
      return { targetStepId: "" };
    case "transfer_automation":
      return { targetAutomationId: "", targetAutomationName: "" };
    case "inventory.adjust":
      return { operation: "consume", productId: "", poolId: "", qty: 1 };
    case "stop_automation":
      return {};
    case "create_deal":
      return { stageId: "", title: "Novo negócio", value: 0 };
    case "finish_conversation":
      return {};
    case "tabulate_conversation":
      // `closeConversation` liga por padrao: encerrar junto grava a tabulacao
      // na mesma operacao do fechamento. Tabular depois de encerrar perderia o
      // departamento da conversa (o fechamento limpa, salvo
      // `conversation.keepDepartmentOnEnd`).
      return {
        departmentId: "",
        tabulationId: "",
        tabulationLabel: "",
        closeConversation: true,
      };
    case "business_hours":
      return {
        schedule: [
          { days: [1, 2, 3, 4, 5], from: "09:00", to: "18:00" },
        ],
        timezone: "America/Sao_Paulo",
        elseStepId: "",
      };
    case "check_agent_status":
      return { elseStepId: "" };
    case "ask_ai_agent":
      return {
        agentId: "",
        agentLabel: "",
        /// Variáveis interpoladas com {{var}} são substituidas antes de
        /// enviar pro LLM. O resultado fica disponível como variável
        /// do contexto do nome abaixo.
        promptTemplate: "",
        saveToVariable: "ai_response",
      };
    case "transfer_to_ai_agent":
      return {
        agentUserId: "",
        agentLabel: "",
        // "deal" propaga via assignDealOwner; "contact" via
        // propagateOwnerToContactAndChat. Ambos acabam setando
        // conversation.assignedToId, que é o que `maybeReplyAsAIAgent`
        // olha pra decidir se assume a conversa.
        target: "deal",
      };
    case "execute_distribution":
      // distributionType opcional; departmentIds = pool opcional de departamentos.
      return { distributionType: "", departmentIds: [], departmentNames: [] };
    default:
      return {};
  }
}

export function newStepId(): string {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `step_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

export type ApiAutomationStep = {
  id: string;
  type: string;
  config: unknown;
  position: number;
};

function normalizeLegacyStepConfig(
  stepType: string,
  rawConfig: unknown,
): Record<string, unknown> {
  const cfg =
    typeof rawConfig === "object" && rawConfig !== null && !Array.isArray(rawConfig)
      ? { ...(rawConfig as Record<string, unknown>) }
      : {};

  // Compat legado (Kommo parser): vários passos usavam `_nextStepId`.
  if (
    (typeof cfg.nextStepId !== "string" || !cfg.nextStepId) &&
    typeof cfg._nextStepId === "string" &&
    cfg._nextStepId
  ) {
    cfg.nextStepId = cfg._nextStepId;
  }

  // Question legado podia salvar resposta em `_answeredGotoStepId`.
  if (
    stepType === "question" &&
    (typeof cfg.elseGotoStepId !== "string" || !cfg.elseGotoStepId) &&
    typeof cfg._answeredGotoStepId === "string" &&
    cfg._answeredGotoStepId
  ) {
    cfg.elseGotoStepId = cfg._answeredGotoStepId;
  }

  // Condition legado (import Kommo):
  // - `_branches[{ conditions, gotoStepId }]` -> `branches[{ rules, nextStepId }]`
  // - `_falseGotoStepId` -> `elseStepId`
  // - `_trueGotoStepId`  -> `nextStepId` (formato antigo de 1 regra)
  if (stepType === "condition") {
    if (
      (typeof cfg.nextStepId !== "string" || !cfg.nextStepId) &&
      typeof cfg._trueGotoStepId === "string" &&
      cfg._trueGotoStepId
    ) {
      cfg.nextStepId = cfg._trueGotoStepId;
    }

    if (
      (typeof cfg.elseStepId !== "string" || !cfg.elseStepId) &&
      typeof cfg._falseGotoStepId === "string" &&
      cfg._falseGotoStepId
    ) {
      cfg.elseStepId = cfg._falseGotoStepId;
    }

    if (!Array.isArray(cfg.branches) && Array.isArray(cfg._branches)) {
      const legacyBranches = cfg._branches as Record<string, unknown>[];
      cfg.branches = legacyBranches
        .map((branch) => {
          const rawRules = Array.isArray(branch.conditions)
            ? (branch.conditions as Record<string, unknown>[])
            : [];
          const rules = rawRules
            .map((rule) => {
              const field =
                typeof rule.field === "string"
                  ? rule.field
                  : typeof rule.path === "string"
                    ? rule.path
                    : "";
              if (!field) return null;
              return {
                field,
                op: typeof rule.op === "string" ? rule.op : "eq",
                value: rule.value ?? "",
              };
            })
            .filter((r) => r !== null);

          if (rules.length === 0) return null;

          return {
            id: newBranchId(),
            rules,
            nextStepId:
              typeof branch.gotoStepId === "string" && branch.gotoStepId
                ? branch.gotoStepId
                : undefined,
          };
        })
        .filter((b) => b !== null);
    }
  }

  return cfg;
}

export function apiStepsToWorkflow(steps: ApiAutomationStep[]): AutomationStep[] {
  return steps.map((s) => ({
    id: s.id,
    type: s.type,
    config: normalizeLegacyStepConfig(s.type, s.config),
  }));
}

export function workflowStepsToPayload(steps: AutomationStep[]): { id: string; type: string; config: unknown }[] {
  return steps.map(({ id, type, config }) => {
    return { id, type, config };
  });
}

export function defaultTriggerConfig(triggerType: string): Record<string, unknown> {
  switch (triggerType) {
    case "stage_changed":
      return { fromStageId: "", toStageId: "" };
    case "tag_added":
      return { tagName: "" };
    case "lead_score_reached":
      return { threshold: 50 };
    case "deal_created":
    case "deal_won":
    case "deal_lost":
      return { pipelineId: "" };
    case "contact_created":
      return {};
    case "conversation_created":
      return { channel: "", channelIds: [], channelScope: "all" };
    case "lifecycle_changed":
      return { fromLifecycle: "", toLifecycle: "" };
    case "agent_changed":
      return { toAgentId: "" };
    case "message_received":
    case "message_sent":
      return { channel: "", channelIds: [], channelScope: "all", pipelineId: "", stageId: "", dealStatus: "" };
    case "call_received":
    case "call_made":
      // status: "" (qualquer) | "answered" | "missed"
      return { status: "" };
    case "call_permission_granted":
      // consentType: "" (qualquer) | "PERMANENT" | "TEMPORARY"
      return { consentType: "" };
    case "manual":
      return {};
    case "lead_distributed":
      // Opcional: limitar a um departamento. Vazio = qualquer depto.
      return { departmentId: "" };
    case "conversation_tabulated":
      // Escopo por departamento + tabulacao especifica (opcional).
      // Sem tabulationId => casa qualquer tabulacao do departamento.
      // Sem departmentId => casa qualquer conversa encerrada.
      // requireTabulation=true exige tabulationId no payload (encerramento
      // tabulado); false = qualquer encerramento manual.
      // Matching considera ancestrais (mirar categoria pai vale pra
      // descendentes — ver evaluateTrigger em services/automations.ts).
      return { departmentId: "", tabulationId: "", tabulationLabel: "", requireTabulation: false };
    case "whatsapp_session_expiring":
      return { hoursBeforeExpiry: 1 };
    default:
      return {};
  }
}
