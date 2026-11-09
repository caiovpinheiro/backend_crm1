/**
 * Passo de automação "Devolver atendimento" (`restore_attendance`): regras
 * puras, sem banco. A parte que lê/grava fica em
 * `services/automation-restore-attendance.ts`.
 *
 * Caso de uso: o atendente A transfere a conversa para o departamento B;
 * B atende e encerra (com ou sem tabulação). Um fluxo "Conversa encerrada"
 * filtrado em B devolve a conversa a A e ao departamento de origem — ou
 * remove os dois.
 */

export type RestoreMode = "keep" | "previous" | "clear";
export type RestoreNotFound = "keep" | "clear";

export type RestoreAttendanceConfig = {
  agentMode: RestoreMode;
  departmentMode: RestoreMode;
  /** Sem anterior no histórico: manter como está ou remover. */
  notFound: RestoreNotFound;
  /** Conversa já encerrada: reabrir como ticket novo com o resultado. */
  reopen: boolean;
};

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function readMode(v: unknown, fallback: RestoreMode): RestoreMode {
  return v === "keep" || v === "previous" || v === "clear" ? v : fallback;
}

export function readRestoreAttendanceConfig(raw: unknown): RestoreAttendanceConfig {
  const c = asRecord(raw);
  return {
    agentMode: readMode(c.agentMode, "previous"),
    departmentMode: readMode(c.departmentMode, "previous"),
    notFound: c.notFound === "clear" ? "clear" : "keep",
    reopen: c.reopen === true || c.reopen === "yes" || c.reopen === "true",
  };
}

/** Evento do feed (`ActivityEvent`) já reduzido ao que importa aqui. */
export type AttendanceEvent = {
  type: string;
  occurredAt: Date;
  meta: unknown;
};

export type PreviousAttendance = {
  /** `undefined` = histórico não diz; `null` = antes não havia responsável. */
  userId: string | null | undefined;
  /** `undefined` = histórico não diz; `null` = antes não havia departamento. */
  departmentId: string | null | undefined;
  /** De onde veio o agente — vai para a nota do log da automação. */
  agentSource: "transfer" | "before_transfer" | "after_transfer" | "holders" | "none";
};

/**
 * Atribuições que entram no mesmo pedido da transferência (agente + depto no
 * mesmo POST grava o ASSIGNEE_CHANGED milissegundos ANTES do evento de
 * departamento) contam como parte dela, não como "antes".
 */
export const TRANSFER_WINDOW_MS = 5_000;

const ASSIGNMENT_TYPES = new Set(["ASSIGNEE_CHANGED", "LEAD_DISTRIBUTED"]);

function hasKey(meta: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(meta, key);
}

function idOrNull(v: unknown): string | null {
  return typeof v === "string" && v.trim() !== "" ? v : null;
}

/** Para quem a atribuição passou (ASSIGNEE_CHANGED.toUserId / LEAD_DISTRIBUTED.selectedUserId). */
function assignedTo(ev: AttendanceEvent): string | null {
  const m = asRecord(ev.meta);
  if (ev.type === "LEAD_DISTRIBUTED") return idOrNull(m.selectedUserId);
  return idOrNull(m.toUserId);
}

/**
 * Descobre quem atendia e em qual departamento a conversa estava ANTES de
 * entrar no departamento que encerrou.
 *
 * Âncora: o último `CONVERSATION_DEPARTMENT_CHANGED` para um departamento
 * (de preferência `endedDepartmentId`). Agente, nesta ordem:
 *   1. `meta.fromAssigneeId` gravado na transferência (eventos novos);
 *   2. última atribuição antes da transferência;
 *   3. `fromUserId` da primeira troca depois dela.
 * Sem âncora (transferência antiga por automação, sem evento): o
 * responsável anterior ao último da sequência de responsáveis.
 *
 * `events` em qualquer ordem.
 */
export function pickPreviousAttendance(
  events: AttendanceEvent[],
  opts: { endedDepartmentId?: string | null } = {},
): PreviousAttendance {
  const sorted = [...events].sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());

  const deptChanges = sorted.filter((ev) => {
    if (ev.type !== "CONVERSATION_DEPARTMENT_CHANGED") return false;
    return idOrNull(asRecord(ev.meta).toDepartmentId) !== null;
  });
  const ended = opts.endedDepartmentId ?? null;
  const matching = ended
    ? deptChanges.filter((ev) => asRecord(ev.meta).toDepartmentId === ended)
    : [];
  const anchor = (matching.length > 0 ? matching : deptChanges).at(-1) ?? null;

  const assignments = sorted.filter((ev) => ASSIGNMENT_TYPES.has(ev.type));

  if (anchor) {
    const am = asRecord(anchor.meta);
    const departmentId = hasKey(am, "fromDepartmentId") ? idOrNull(am.fromDepartmentId) : undefined;

    if (hasKey(am, "fromAssigneeId")) {
      return { userId: idOrNull(am.fromAssigneeId), departmentId, agentSource: "transfer" };
    }

    const cutoff = anchor.occurredAt.getTime() - TRANSFER_WINDOW_MS;
    const before = assignments.filter((ev) => ev.occurredAt.getTime() < cutoff);
    const lastBefore = before.at(-1);
    if (lastBefore) {
      return { userId: assignedTo(lastBefore), departmentId, agentSource: "before_transfer" };
    }
    const firstAfter = assignments.find((ev) => ev.occurredAt.getTime() >= cutoff);
    if (firstAfter && firstAfter.type === "ASSIGNEE_CHANGED") {
      const fm = asRecord(firstAfter.meta);
      if (hasKey(fm, "fromUserId")) {
        return { userId: idOrNull(fm.fromUserId), departmentId, agentSource: "after_transfer" };
      }
    }
    return { userId: undefined, departmentId, agentSource: "none" };
  }

  // Sem âncora: sequência de responsáveis (sem nulos, sem repetição seguida).
  const holders: string[] = [];
  const push = (id: string | null) => {
    if (id && holders.at(-1) !== id) holders.push(id);
  };
  for (const ev of assignments) {
    if (ev.type === "ASSIGNEE_CHANGED") push(idOrNull(asRecord(ev.meta).fromUserId));
    push(assignedTo(ev));
  }
  if (holders.length >= 2) {
    return { userId: holders[holders.length - 2]!, departmentId: undefined, agentSource: "holders" };
  }
  return { userId: undefined, departmentId: undefined, agentSource: "none" };
}

/**
 * Valor final de um campo (agente ou departamento).
 * `{ change: false }` = não mexer.
 */
export function resolveRestoreTarget(
  mode: RestoreMode,
  previous: string | null | undefined,
  notFound: RestoreNotFound,
): { change: false } | { change: true; value: string | null } {
  if (mode === "keep") return { change: false };
  if (mode === "clear") return { change: true, value: null };
  if (previous !== undefined) return { change: true, value: previous };
  return notFound === "clear" ? { change: true, value: null } : { change: false };
}

export function summarizeRestoreAttendance(raw: unknown): string {
  const c = readRestoreAttendanceConfig(raw);
  const label = (m: RestoreMode) => (m === "previous" ? "anterior" : m === "clear" ? "remover" : "manter");
  const parts = [`Agente: ${label(c.agentMode)}`, `Depto: ${label(c.departmentMode)}`];
  if (c.reopen) parts.push("reabre");
  return parts.join(" · ");
}
