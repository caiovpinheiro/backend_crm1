/**
 * Motor determinístico de auditoria de automações.
 *
 * Roda em cima do grafo de steps já salvo e detecta problemas que
 * NÃO precisam de IA pra identificar: referências quebradas, ramos
 * sem saída, steps inalcançáveis, loops sem pausa, etc.
 *
 * Também retorna *candidatos* a conflito entre automações (pares que
 * compartilham trigger ou se comunicam via transfer_automation); a
 * decisão semântica "isso colide de verdade?" fica pra IA analisar
 * com mais contexto.
 *
 * IMPORTANTE: esta lib é pura (sem I/O) — recebe as automações já
 * carregadas e devolve issues. Facilita reuso pelo endpoint de
 * auditoria, pelo copilot (via tool `run_audit`) e pelos testes.
 */

import {
  normalizeConditionConfig,
  type ConditionConfig,
} from "@/lib/automation-condition";
import { isStepIncomplete, stepTypeLabel } from "@/lib/automation-workflow";

export type AuditSeverity = "error" | "warning" | "info";

export type AuditIssue = {
  /// Código estável da regra — útil pra silenciar ou filtrar depois.
  code: string;
  severity: AuditSeverity;
  message: string;
  /// Step afetado (opcional). Quando presente, UI pode fazer scroll até ele.
  stepId?: string;
  /// Steps relacionados (outro endpoint da referência quebrada, steps
  /// envolvidos no loop, etc).
  relatedStepIds?: string[];
  /// Sugestão curta de como resolver — consumida pela UI e pelo LLM.
  hint?: string;
};

export type AuditReport = {
  automationId: string;
  automationName: string;
  triggerType: string;
  active: boolean;
  stepsCount: number;
  issues: AuditIssue[];
  errorCount: number;
  warningCount: number;
  infoCount: number;
};

export type StepLike = {
  id: string;
  type: string;
  config: unknown;
};

export type AutomationLike = {
  id: string;
  name: string;
  triggerType: string;
  triggerConfig?: unknown;
  active: boolean;
  steps: StepLike[];
};

/**
 * Tipos terminais — qualquer um deles encerra o ramo. Não é problema
 * um ramo desaguar num terminal; é problema um ramo NÃO-terminal
 * sem saída.
 */
const TERMINAL_TYPES = new Set(["finish", "stop_automation", "transfer_automation"]);

/**
 * Steps que pausam a execução esperando próxima mensagem do contato.
 * Quebram ciclos na detecção de loops e não precisam de "nextStepId"
 * linear (usam receivedGotoStepId/timeoutGotoStepId).
 */
const PAUSING_TYPES = new Set([
  "wait_for_reply",
  "question",
  "send_whatsapp_interactive",
  "send_whatsapp_list",
  "send_whatsapp_flow",
]);

/**
 * Steps que introduzem atraso real (quebram loops tight também).
 * Um loop com pelo menos um desses não é infinito.
 */
const DELAY_TYPES = new Set(["delay", ...PAUSING_TYPES]);

const NONE_ID = "__none__";

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function strOrEmpty(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/**
 * Retorna todas as "saídas" de um step (step ids pra onde ele pode ir).
 * Considera:
 *  - nextStepId linear
 *  - condition.branches[].nextStepId + condition.elseStepId
 *  - business_hours.elseStepId (fora do horário)
 *  - check_agent_status.elseStepId (agente offline)
 *  - wait_for_reply.receivedGotoStepId + timeoutGotoStepId
 *  - question/send_whatsapp_interactive.buttons[].gotoStepId + elseGotoStepId + timeoutGotoStepId
 *  - failureGotoStepId (saída "Falha ao enviar" dos passos Meta)
 *  - goto.targetStepId
 *  - transfer_automation.targetAutomationId (cross — retornado como cross-ref)
 *
 * NONE_ID ("__none__") é ignorado (significa fim explícito).
 */
export type StepOutgoing = {
  local: Array<{ label: string; targetStepId: string }>;
  crossAutomation: Array<{ label: string; targetAutomationId: string }>;
};

const META_SEND_FAILURE_TYPES = new Set([
  "send_whatsapp_message",
  "send_whatsapp_template",
  "send_whatsapp_media",
  "send_whatsapp_interactive",
  "send_whatsapp_list",
  "send_whatsapp_flow",
  "question",
]);

export function getStepOutgoing(step: StepLike): StepOutgoing {
  const c = asRecord(step.config);
  const local: StepOutgoing["local"] = [];
  const cross: StepOutgoing["crossAutomation"] = [];

  const push = (label: string, id: unknown) => {
    const s = strOrEmpty(id);
    if (s && s !== NONE_ID) local.push({ label, targetStepId: s });
  };

  switch (step.type) {
    case "condition": {
      const cond: ConditionConfig = normalizeConditionConfig(step.config);
      cond.branches.forEach((b, i) => {
        if (b.nextStepId) push(b.label || `branch #${i + 1}`, b.nextStepId);
      });
      if (cond.elseStepId) push("else (nenhuma bateu)", cond.elseStepId);
      break;
    }
    case "business_hours": {
      push("fora do horário", c.elseStepId);
      push("dentro do horário", c.nextStepId);
      break;
    }
    case "check_agent_status": {
      push("offline", c.elseStepId);
      push("disponível", c.nextStepId);
      break;
    }
    case "wait_for_reply": {
      push("recebeu resposta", c.receivedGotoStepId);
      push("timeout (cronômetro)", c.timeoutGotoStepId);
      break;
    }
    case "question":
    case "send_whatsapp_interactive": {
      const buttons = Array.isArray(c.buttons) ? (c.buttons as Record<string, unknown>[]) : [];
      buttons.forEach((b, i) => {
        const label = strOrEmpty(b.title) || strOrEmpty(b.text) || `botão #${i + 1}`;
        push(label, b.gotoStepId);
      });
      push("else (nenhum botão bateu)", c.elseGotoStepId);
      push("timeout", c.timeoutGotoStepId);
      push("linear (após enviar)", c.nextStepId);
      break;
    }
    case "send_whatsapp_list": {
      const rows = Array.isArray(c.rows) ? (c.rows as Record<string, unknown>[]) : [];
      rows.forEach((r, i) => {
        const label = strOrEmpty(r.title) || `item #${i + 1}`;
        push(label, r.gotoStepId);
      });
      push("else (nenhum item bateu)", c.elseGotoStepId);
      push("timeout", c.timeoutGotoStepId);
      push("linear (após enviar)", c.nextStepId);
      break;
    }
    case "send_whatsapp_message":
    case "send_whatsapp_template":
    case "send_whatsapp_flow": {
      if (step.type === "send_whatsapp_template") {
        const buttons = Array.isArray(c.buttons) ? (c.buttons as Record<string, unknown>[]) : [];
        buttons.forEach((b, i) => {
          const label = strOrEmpty(b.title) || strOrEmpty(b.text) || `botão #${i + 1}`;
          push(label, b.gotoStepId);
        });
        push("else (nenhum botão bateu)", c.elseGotoStepId);
      }
      push("timeout (sem resposta)", c.timeoutGotoStepId);
      push("linear", c.nextStepId);
      break;
    }
    case "goto": {
      push("goto", c.targetStepId ?? c.nextStepId);
      break;
    }
    case "transfer_automation": {
      const tid = strOrEmpty(c.targetAutomationId);
      if (tid) cross.push({ label: "transfer_automation", targetAutomationId: tid });
      break;
    }
    default: {
      push("linear", c.nextStepId);
      break;
    }
  }

  if (META_SEND_FAILURE_TYPES.has(step.type) && c.failureAction === "goto") {
    push("falha ao enviar", c.failureGotoStepId);
  }

  return { local, crossAutomation: cross };
}

/**
 * Descobre quais steps são alcançáveis a partir do primeiro step
 * (que é o ponto de entrada após o trigger). Usado pra flaggear
 * steps "ilha".
 */
function collectReachable(steps: StepLike[]): Set<string> {
  const reachable = new Set<string>();
  if (steps.length === 0) return reachable;

  const byId = new Map(steps.map((s) => [s.id, s]));
  const queue: string[] = [steps[0].id];
  reachable.add(steps[0].id);

  while (queue.length > 0) {
    const id = queue.shift()!;
    const step = byId.get(id);
    if (!step) continue;
    const { local } = getStepOutgoing(step);
    for (const out of local) {
      if (byId.has(out.targetStepId) && !reachable.has(out.targetStepId)) {
        reachable.add(out.targetStepId);
        queue.push(out.targetStepId);
      }
    }
  }
  return reachable;
}

/**
 * Detecta ciclos que NÃO passam por nenhum step de pausa/delay.
 * Um ciclo com wait_for_reply, delay ou interactive no meio é
 * legítimo (ex.: "pergunta em loop"). Um ciclo tight (só actions
 * síncronas) vai consumir CPU/DB numa execução real.
 */
function findTightLoops(steps: StepLike[]): Array<string[]> {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const loops: Array<string[]> = [];
  const seenLoopSignature = new Set<string>();

  const visit = (id: string, path: string[], pathSet: Set<string>) => {
    const step = byId.get(id);
    if (!step) return;
    // Ciclo legítimo (tem pausa/delay no path)? Não reporta.
    // A checagem é no path inteiro — se QUALQUER step do ciclo pausa,
    // o loop não é tight.
    if (pathSet.has(id)) {
      const startIdx = path.indexOf(id);
      const cycle = path.slice(startIdx);
      const hasPause = cycle.some((sid) => {
        const s = byId.get(sid);
        return s && DELAY_TYPES.has(s.type);
      });
      if (!hasPause) {
        const sig = [...cycle].sort().join(",");
        if (!seenLoopSignature.has(sig)) {
          seenLoopSignature.add(sig);
          loops.push(cycle);
        }
      }
      return;
    }

    path.push(id);
    pathSet.add(id);
    const { local } = getStepOutgoing(step);
    for (const out of local) {
      if (byId.has(out.targetStepId)) {
        visit(out.targetStepId, path, pathSet);
      }
    }
    path.pop();
    pathSet.delete(id);
  };

  for (const step of steps) {
    visit(step.id, [], new Set());
  }

  return loops;
}

/**
 * Aplica todas as regras determinísticas de uma automação.
 */
export function auditAutomation(automation: AutomationLike): AuditReport {
  const issues: AuditIssue[] = [];
  const steps = automation.steps;
  const byId = new Map(steps.map((s) => [s.id, s]));

  if (steps.length === 0) {
    issues.push({
      code: "empty_automation",
      severity: "warning",
      message: "Automação sem passos.",
      hint: "Adicione pelo menos um passo pra que o gatilho faça algo útil.",
    });
  }

  // Regras por step
  for (const step of steps) {
    const cfg = asRecord(step.config);
    const label = stepTypeLabel(step.type);

    // Config mínima obrigatória (reusa o helper já existente)
    if (isStepIncomplete(step.type, cfg)) {
      issues.push({
        code: "step_incomplete_config",
        severity: "error",
        message: `${label} está sem configuração obrigatória.`,
        stepId: step.id,
        hint: "Abra o passo e preencha os campos em destaque.",
      });
    }

    // Referências quebradas — todos os outgoing precisam apontar pra step existente
    const { local, crossAutomation } = getStepOutgoing(step);
    for (const out of local) {
      if (!byId.has(out.targetStepId)) {
        issues.push({
          code: "broken_reference",
          severity: "error",
          message: `${label} (${out.label}) referencia passo inexistente.`,
          stepId: step.id,
          relatedStepIds: [out.targetStepId],
          hint: "O passo de destino foi excluído. Reconecte esse ramo a outro passo válido ou remova a conexão.",
        });
      }
    }

    // Ramos sem saída (step não-terminal sem nenhuma conexão válida)
    const isTerminal = TERMINAL_TYPES.has(step.type);
    const hasExplicitEdges = cfg.__hasExplicitEdges === true;
    const hasAnyOut = local.length > 0 || crossAutomation.length > 0;
    const isLinearStep = !["condition", "wait_for_reply", "question", "send_whatsapp_interactive", "send_whatsapp_list", "business_hours", "check_agent_status", "goto"].includes(step.type);
    const nextId = strOrEmpty(cfg.nextStepId);
    const isDeadEndLinear = isLinearStep && hasExplicitEdges && !hasAnyOut && nextId !== NONE_ID && !isTerminal;
    if (isDeadEndLinear) {
      issues.push({
        code: "linear_dead_end",
        severity: "info",
        message: `${label} é uma folha sem passo seguinte.`,
        stepId: step.id,
        hint: "Se isso é intencional (fim de fluxo), ignore. Caso contrário, adicione um próximo passo ou um Finalizar.",
      });
    }

    // Regras específicas por tipo
    if (step.type === "condition") {
      const cond = normalizeConditionConfig(step.config);
      if (cond.branches.length === 0) {
        issues.push({
          code: "condition_no_branches",
          severity: "error",
          message: "Condição sem nenhum branch configurado.",
          stepId: step.id,
          hint: "Adicione ao menos um branch com regra, ou substitua por um passo simples.",
        });
      } else {
        cond.branches.forEach((b, i) => {
          if (!b.rules || b.rules.length === 0) {
            issues.push({
              code: "condition_branch_no_rules",
              severity: "warning",
              message: `Branch "${b.label || `#${i + 1}`}" da condição não tem regras.`,
              stepId: step.id,
              hint: "Adicione pelo menos uma regra ou remova o branch.",
            });
          }
          if (!b.nextStepId) {
            issues.push({
              code: "condition_branch_no_target",
              severity: "warning",
              message: `Branch "${b.label || `#${i + 1}`}" não aponta pra nenhum passo.`,
              stepId: step.id,
              hint: "Conecte esse branch ao próximo passo arrastando do handle correspondente.",
            });
          }
        });
        if (!cond.elseStepId) {
          issues.push({
            code: "condition_no_else",
            severity: "info",
            message: "Condição sem ramo 'else' (nenhum branch bateu).",
            stepId: step.id,
            hint: "Se ninguém bater, o fluxo termina. Considere conectar um else explícito.",
          });
        }
      }
    }

    if (step.type === "wait_for_reply") {
      const tMs = Number(cfg.timeoutMs ?? 0);
      if (!tMs || tMs <= 0) {
        issues.push({
          code: "wait_for_reply_no_timeout",
          severity: "warning",
          message: "Aguardar resposta sem cronômetro configurado.",
          stepId: step.id,
          hint: "Defina um tempo limite (ex.: 1h) ou o contato pode ficar preso no passo indefinidamente se nunca responder.",
        });
      }
      if (!strOrEmpty(cfg.receivedGotoStepId)) {
        issues.push({
          code: "wait_for_reply_no_received",
          severity: "error",
          message: "Aguardar resposta sem ramo 'recebeu resposta' conectado.",
          stepId: step.id,
          hint: "Arraste do handle 'Até a mensagem recebida' pra um próximo passo.",
        });
      }
      if (!strOrEmpty(cfg.timeoutGotoStepId)) {
        issues.push({
          code: "wait_for_reply_no_timeout_branch",
          severity: "info",
          message: "Aguardar resposta sem ramo de cronômetro conectado.",
          stepId: step.id,
          hint: "Sem isso, o fluxo termina se o contato não responder dentro do tempo limite.",
        });
      }
    }

    if (step.type === "question" || step.type === "send_whatsapp_interactive") {
      const buttons = Array.isArray(cfg.buttons) ? (cfg.buttons as Record<string, unknown>[]) : [];
      if (buttons.length === 0 && step.type === "send_whatsapp_interactive") {
        issues.push({
          code: "interactive_no_buttons",
          severity: "error",
          message: "Botões WhatsApp sem nenhum botão configurado.",
          stepId: step.id,
        });
      } else if (buttons.length > 3 && step.type === "send_whatsapp_interactive") {
        issues.push({
          code: "interactive_too_many_buttons",
          severity: "warning",
          message: `Botões WhatsApp com ${buttons.length} botões — WhatsApp só aceita até 3.`,
          stepId: step.id,
          hint: "Remova botões excedentes; a API vai rejeitar a mensagem em runtime.",
        });
      }
      buttons.forEach((b, i) => {
        if (!strOrEmpty(b.gotoStepId)) {
          issues.push({
            code: "button_no_target",
            severity: "warning",
            message: `Botão "${strOrEmpty(b.title) || strOrEmpty(b.text) || `#${i + 1}`}" sem passo de destino.`,
            stepId: step.id,
            hint: "Conecte esse botão a um passo, ou o clique vai cair no 'else' (se existir) ou finalizar.",
          });
        }
      });
    }

    if (step.type === "send_whatsapp_list") {
      if (!strOrEmpty(cfg.body)) {
        issues.push({
          code: "list_no_body",
          severity: "error",
          message: "Lista WhatsApp sem texto da mensagem.",
          stepId: step.id,
        });
      }
      if (!strOrEmpty(cfg.button)) {
        issues.push({
          code: "list_no_button",
          severity: "error",
          message: "Lista WhatsApp sem rótulo do botão que abre a lista.",
          stepId: step.id,
        });
      }
      const rows = Array.isArray(cfg.rows) ? (cfg.rows as Record<string, unknown>[]) : [];
      if (rows.length === 0) {
        issues.push({
          code: "list_no_rows",
          severity: "error",
          message: "Lista WhatsApp sem nenhum item configurado.",
          stepId: step.id,
        });
      } else if (rows.length > 10) {
        issues.push({
          code: "list_too_many_rows",
          severity: "warning",
          message: `Lista WhatsApp com ${rows.length} itens — WhatsApp só aceita até 10.`,
          stepId: step.id,
        });
      }
      rows.forEach((r, i) => {
        if (!strOrEmpty(r.title)) {
          issues.push({
            code: "list_row_no_title",
            severity: "error",
            message: `Item #${i + 1} da lista sem título.`,
            stepId: step.id,
          });
        }
        if (!strOrEmpty(r.gotoStepId)) {
          issues.push({
            code: "list_row_no_target",
            severity: "warning",
            message: `Item "${strOrEmpty(r.title) || `#${i + 1}`}" sem passo de destino.`,
            stepId: step.id,
            hint: "Conecte esse item a um passo, ou o clique vai cair no 'else' (se existir) ou finalizar.",
          });
        }
      });
    }

    if (step.type === "business_hours") {
      if (!strOrEmpty(cfg.elseStepId)) {
        issues.push({
          code: "business_hours_no_off_branch",
          severity: "warning",
          message: "Horário comercial sem ramo 'fora do horário' conectado.",
          stepId: step.id,
          hint: "Conecte o handle 'fora do horário' ou contatos que chegarem fora do expediente vão ter fluxo encerrado sem resposta.",
        });
      }
    }

    if (step.type === "check_agent_status") {
      if (!strOrEmpty(cfg.elseStepId)) {
        issues.push({
          code: "check_agent_status_no_offline_branch",
          severity: "warning",
          message: "Status do agente sem ramo 'offline' conectado.",
          stepId: step.id,
          hint: "Conecte o handle 'offline' ou o fluxo encerra quando o responsável não estiver ONLINE.",
        });
      }
    }

    if (step.type === "goto") {
      const tgt = strOrEmpty(cfg.targetStepId) || strOrEmpty(cfg.nextStepId);
      if (tgt && !byId.has(tgt)) {
        // Já coberto por broken_reference, mas a mensagem fica mais clara.
        // (não adiciona duplicado porque getStepOutgoing já resolveu o target)
      }
    }
  }

  // Steps inalcançáveis (ilhas)
  const reachable = collectReachable(steps);
  for (const step of steps) {
    if (!reachable.has(step.id)) {
      issues.push({
        code: "unreachable_step",
        severity: "warning",
        message: `${stepTypeLabel(step.type)} é inalcançável a partir do gatilho.`,
        stepId: step.id,
        hint: "Nenhum passo anterior aponta pra este. Conecte-o ao fluxo ou remova.",
      });
    }
  }

  // Loops sem pausa/delay
  const loops = findTightLoops(steps);
  for (const cycle of loops) {
    issues.push({
      code: "tight_loop",
      severity: "error",
      message: `Loop sem delay/pausa (${cycle.length} passos).`,
      relatedStepIds: cycle,
      hint: "Inclua um 'Delay', 'Aguardar resposta' ou condição de saída no caminho — senão o fluxo executa os mesmos passos em rajada.",
    });
  }

  const errorCount = issues.filter((i) => i.severity === "error").length;
  const warningCount = issues.filter((i) => i.severity === "warning").length;
  const infoCount = issues.filter((i) => i.severity === "info").length;

  return {
    automationId: automation.id,
    automationName: automation.name,
    triggerType: automation.triggerType,
    active: automation.active,
    stepsCount: steps.length,
    issues,
    errorCount,
    warningCount,
    infoCount,
  };
}

// ── Análise cruzada entre automações ─────────────────────────────────

/**
 * Categorias semânticas de ação — usadas pra detectar conflitos
 * entre automações (ex.: duas automações que atribuem responsável
 * diferente ao mesmo contato no mesmo evento).
 */
export type ActionCategory =
  | "messaging"
  | "assignment"
  | "stage_move"
  | "lifecycle_change"
  | "tag_change"
  | "field_update"
  | "ai_handoff"
  | "deal_creation"
  | "conversation_close"
  | "other";

function categorizeStepType(type: string): ActionCategory {
  switch (type) {
    case "send_whatsapp_message":
    case "send_whatsapp_template":
    case "send_whatsapp_media":
    case "send_whatsapp_interactive":
    case "send_whatsapp_list":
    case "send_whatsapp_flow":
    case "question":
    case "send_email":
      return "messaging";
    case "assign_owner":
      return "assignment";
    case "move_stage":
      return "stage_move";
    case "add_tag":
    case "remove_tag":
      return "tag_change";
    case "update_field":
      return "field_update";
    case "transfer_to_ai_agent":
    case "ask_ai_agent":
      return "ai_handoff";
    case "create_deal":
      return "deal_creation";
    case "finish_conversation":
    // Encerra junto por padrão (`closeConversation`), então disputa o mesmo
    // evento que qualquer outro fechamento automático.
    case "tabulate_conversation":
      return "conversation_close";
    default:
      return "other";
  }
}

export type CrossConflictCandidate = {
  /// Conjunto de automações que podem colidir.
  automationIds: string[];
  automationNames: string[];
  triggerType: string;
  /// Categoria de ação compartilhada (ambas fazem isso).
  sharedActionCategory: ActionCategory;
  /// Severidade determinística inicial — pode ser rebaixada pela IA
  /// depois de ler a semântica.
  suggestedSeverity: AuditSeverity;
  /// Razão humana da flaggem — input pro prompt da IA.
  reason: string;
};

/**
 * Retorna PARES de automações ativas que podem disputar o mesmo
 * evento com o mesmo tipo de ação. NÃO afirma que é conflito real
 * — a IA decide depois.
 *
 * Regras:
 *  - Mesmo `triggerType`
 *  - Categorias de ação que costumam colidir (assignment, stage_move,
 *    ai_handoff em primeiro lugar — essas são quase sempre problema;
 *    messaging, tag_change, field_update viram warning).
 */
export function detectCrossConflictCandidates(
  automations: AutomationLike[],
): CrossConflictCandidate[] {
  const activeOnes = automations.filter((a) => a.active);
  const candidates: CrossConflictCandidate[] = [];

  // Agrupa por triggerType
  const byTrigger = new Map<string, AutomationLike[]>();
  for (const a of activeOnes) {
    const list = byTrigger.get(a.triggerType) ?? [];
    list.push(a);
    byTrigger.set(a.triggerType, list);
  }

  for (const [trigger, group] of byTrigger.entries()) {
    if (group.length < 2) continue;

    // Pra cada automação, descobre as categorias que ela executa.
    const catMap = new Map<string, Set<ActionCategory>>();
    for (const a of group) {
      const cats = new Set<ActionCategory>();
      for (const s of a.steps) cats.add(categorizeStepType(s.type));
      catMap.set(a.id, cats);
    }

    // Pra cada par, intersecta categorias.
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i];
        const b = group[j];
        const ca = catMap.get(a.id)!;
        const cb = catMap.get(b.id)!;

        const shared: ActionCategory[] = [];
        for (const c of ca) {
          if (cb.has(c) && c !== "other") shared.push(c);
        }

        for (const cat of shared) {
          let severity: AuditSeverity = "info";
          let reason = "";
          switch (cat) {
            case "assignment":
              severity = "error";
              reason =
                "Duas automações ativas atribuem responsável no mesmo gatilho — a última a rodar sobrescreve a outra.";
              break;
            case "ai_handoff":
              severity = "error";
              reason =
                "Duas automações ativas fazem handoff para IA no mesmo gatilho — o contato pode receber respostas de agentes diferentes.";
              break;
            case "stage_move":
              severity = "warning";
              reason =
                "Duas automações ativas movem de etapa no mesmo gatilho — o resultado depende da ordem de execução.";
              break;
            case "lifecycle_change":
              severity = "warning";
              reason =
                "Duas automações ativas alteram lifecycle no mesmo gatilho.";
              break;
            case "messaging":
              severity = "warning";
              reason =
                "Duas automações ativas enviam mensagens no mesmo gatilho — o contato pode receber duas mensagens em sequência.";
              break;
            case "conversation_close":
              severity = "warning";
              reason =
                "Duas automações ativas encerram conversa no mesmo gatilho.";
              break;
            case "deal_creation":
              severity = "warning";
              reason =
                "Duas automações ativas criam negócio no mesmo gatilho — pode gerar duplicidade.";
              break;
            default:
              severity = "info";
              reason = `Ambas executam ações do tipo ${cat} no mesmo gatilho.`;
          }

          candidates.push({
            automationIds: [a.id, b.id],
            automationNames: [a.name, b.name],
            triggerType: trigger,
            sharedActionCategory: cat,
            suggestedSeverity: severity,
            reason,
          });
        }
      }
    }
  }

  return candidates;
}

/**
 * Retorna uma representação compacta e textual da automação — útil
 * pra enviar ao LLM (análise semântica de conflito) sem gastar
 * tokens descrevendo o JSON bruto de config.
 */
export function describeAutomationForLLM(automation: AutomationLike): string {
  const lines: string[] = [];
  lines.push(`Automação "${automation.name}" (id=${automation.id}, gatilho=${automation.triggerType})`);
  automation.steps.forEach((s, i) => {
    const label = stepTypeLabel(s.type);
    const { local, crossAutomation } = getStepOutgoing(s);
    const outs = [
      ...local.map((o) => `${o.label}→${o.targetStepId.slice(0, 6)}`),
      ...crossAutomation.map((o) => `${o.label}→auto:${o.targetAutomationId.slice(0, 6)}`),
    ].join(", ");
    lines.push(`  ${i + 1}. [${s.id.slice(0, 6)}] ${label}${outs ? ` → ${outs}` : ""}`);
  });
  return lines.join("\n");
}
