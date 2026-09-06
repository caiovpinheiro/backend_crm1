/**
 * Tipos e helpers para os controles operacionais ("piloting") do
 * agente de IA — ficam acima do prompt LLM e não dependem dele pra
 * serem respeitados.
 *
 * Esses controles vivem em colunas do `AIAgentConfig`:
 *
 *  - `openingMessage`          — saudação inicial.
 *  - `inactivityTimerMs`       — tempo pra handoff por silêncio.
 *  - `inactivityHandoffMode`   — pra quem transferir.
 *  - `keywordHandoffs`         — gatilhos textuais de handoff.
 *  - `qualificationQuestions`  — perguntas obrigatórias.
 *  - `businessHours`           — horário de atendimento.
 *  - `outputStyle`             — estilo de saída (conversational|structured).
 *  - `autoClosePolicy`         — quando a IA pode encerrar o ticket.
 *
 * O schema guarda `qualificationQuestions`, `businessHours` e
 * `autoClosePolicy` como JSONB; este módulo centraliza a normalização
 * e validação pra que o resto do código nunca precise lidar com `unknown`.
 */

export type HandoffMode = "KEEP_OWNER" | "SPECIFIC_USER" | "UNASSIGN";

export const HANDOFF_MODES: HandoffMode[] = [
  "KEEP_OWNER",
  "SPECIFIC_USER",
  "UNASSIGN",
];

export function isHandoffMode(v: unknown): v is HandoffMode {
  return typeof v === "string" && HANDOFF_MODES.includes(v as HandoffMode);
}

export type OutputStyle = "conversational" | "structured";

export function normalizeOutputStyle(v: unknown): OutputStyle {
  return v === "structured" ? "structured" : "conversational";
}

// ── Comportamento humano (typing + read receipts) ─────────────

/**
 * Calcula o tempo em ms que o indicador "digitando…" deve ficar
 * visível antes de enviar a mensagem. Proporcional ao tamanho do
 * texto, com base mínima e cap na janela máxima que a Meta aceita
 * manter o indicator ativo (25 segundos).
 *
 * Fórmula: `max(baseMs, min(baseMs + len * perCharMs, 25_000))`
 */
export function computeTypingDelayMs(textLength: number, perCharMs: number): number {
  const base = 1500;
  const normalizedPerChar = Math.max(0, Math.min(perCharMs, 200));
  const raw = base + Math.max(0, textLength) * normalizedPerChar;
  return Math.min(Math.max(base, Math.round(raw)), 25_000);
}

// ── Qualification questions ───────────────────────────────────

export type QualificationQuestion = {
  id: string;
  /// Texto da pergunta que o agente deve fazer ou coletar a
  /// informação equivalente.
  question: string;
  /// Dica opcional do formato esperado (ex.: "email", "cidade").
  hint?: string;
};

export function normalizeQualificationQuestions(
  v: unknown,
): QualificationQuestion[] {
  if (!Array.isArray(v)) return [];
  const out: QualificationQuestion[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const question = typeof r.question === "string" ? r.question.trim() : "";
    if (!question) continue;
    out.push({
      id:
        typeof r.id === "string" && r.id.trim()
          ? r.id.trim()
          : makeShortId(),
      question,
      hint: typeof r.hint === "string" && r.hint.trim() ? r.hint.trim() : undefined,
    });
  }
  return out;
}

function makeShortId(): string {
  return Math.random().toString(36).slice(2, 10);
}

// ── Business hours ────────────────────────────────────────────

export type BusinessHoursSlot = {
  /// 0=Dom, 1=Seg, … 6=Sáb (alinhado com JS Date.getDay()).
  day: number;
  /// "HH:mm" 24h.
  start: string;
  end: string;
};

export type BusinessHoursConfig = {
  enabled: boolean;
  /// IANA timezone, ex.: "America/Sao_Paulo". Default pt-BR.
  timezone: string;
  /// Slots permitidos. Se o dia não tem slot, está fora do expediente.
  weekdays: BusinessHoursSlot[];
  /// Mensagem enviada automaticamente fora do expediente (opcional).
  offHoursMessage?: string;
};

export function normalizeBusinessHours(
  v: unknown,
): BusinessHoursConfig | null {
  if (!v || typeof v !== "object") return null;
  const r = v as Record<string, unknown>;
  const enabled = Boolean(r.enabled);
  const timezone =
    typeof r.timezone === "string" && r.timezone.trim()
      ? r.timezone.trim()
      : "America/Sao_Paulo";
  const weekdays: BusinessHoursSlot[] = [];
  if (Array.isArray(r.weekdays)) {
    for (const raw of r.weekdays) {
      if (!raw || typeof raw !== "object") continue;
      const rr = raw as Record<string, unknown>;
      const day = Number(rr.day);
      if (!Number.isInteger(day) || day < 0 || day > 6) continue;
      const start =
        typeof rr.start === "string" && /^\d{1,2}:\d{2}$/.test(rr.start)
          ? padTime(rr.start)
          : null;
      const end =
        typeof rr.end === "string" && /^\d{1,2}:\d{2}$/.test(rr.end)
          ? padTime(rr.end)
          : null;
      if (!start || !end) continue;
      weekdays.push({ day, start, end });
    }
  }
  const offHoursMessage =
    typeof r.offHoursMessage === "string" && r.offHoursMessage.trim()
      ? r.offHoursMessage.trim()
      : undefined;
  return { enabled, timezone, weekdays, offHoursMessage };
}

function padTime(v: string): string {
  const [h, m] = v.split(":");
  return `${h.padStart(2, "0")}:${m.padStart(2, "0")}`;
}

/**
 * Retorna true se `now` (default=agora) cai dentro de pelo menos um
 * slot da configuração. Se `enabled=false`, sempre true (= aberto
 * 24/7). Conversão pra timezone configurada é feita via Intl.
 */
export function isWithinBusinessHours(
  config: BusinessHoursConfig | null,
  now: Date = new Date(),
): boolean {
  if (!config || !config.enabled) return true;
  if (config.weekdays.length === 0) return false; // enabled sem slots => sempre off
  const { day, hhmm } = getLocalDayAndTime(now, config.timezone);
  return config.weekdays.some(
    (s) => s.day === day && hhmm >= s.start && hhmm < s.end,
  );
}

function getLocalDayAndTime(
  date: Date,
  timezone: string,
): { day: number; hhmm: string } {
  try {
    // en-US nos garante ordem consistente de weekday/hora.
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour12: false,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
    const parts = fmt.formatToParts(date);
    const weekday = parts.find((p) => p.type === "weekday")?.value ?? "Sun";
    const hour = parts.find((p) => p.type === "hour")?.value ?? "00";
    const minute = parts.find((p) => p.type === "minute")?.value ?? "00";
    const dayMap: Record<string, number> = {
      Sun: 0,
      Mon: 1,
      Tue: 2,
      Wed: 3,
      Thu: 4,
      Fri: 5,
      Sat: 6,
    };
    return {
      day: dayMap[weekday] ?? 0,
      hhmm: `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`,
    };
  } catch {
    // Timezone inválida — fallback local.
    return {
      day: date.getDay(),
      hhmm: `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`,
    };
  }
}

// ── Keyword matching ─────────────────────────────────────────

/**
 * Retorna a keyword encontrada (lowercased) ou null. Match por
 * substring, case-insensitive, normalizando acentos. A lista
 * recebida pode ter espaços e pontuação — a gente só ignora vazias.
 */
export function matchHandoffKeyword(
  userMessage: string,
  keywords: string[],
): string | null {
  if (!userMessage || keywords.length === 0) return null;
  const haystack = stripAccents(userMessage.toLowerCase());
  for (const raw of keywords) {
    const needle = stripAccents(raw.trim().toLowerCase());
    if (!needle) continue;
    if (haystack.includes(needle)) return raw;
  }
  return null;
}

function stripAccents(s: string): string {
  return s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

// ── Encerramento automático ──────────────────────────────────

export type AutoCloseMode = "off" | "explicit" | "understood";

export const AUTO_CLOSE_MODES: AutoCloseMode[] = [
  "off",
  "explicit",
  "understood",
];

export function isAutoCloseMode(v: unknown): v is AutoCloseMode {
  return typeof v === "string" && AUTO_CLOSE_MODES.includes(v as AutoCloseMode);
}

export type AutoClosePolicy = {
  /// off = nunca encerra. explicit = só detector/keywords.
  /// understood = detector + a IA pode chamar close_conversation.
  mode: AutoCloseMode;
  /// Termos extras (além do detector do código) que forçam encerrar.
  keywords: string[];
  /// Texto enviado ao encerrar. Null = frase padrão do código.
  message: string | null;
};

export function defaultAutoClosePolicy(): AutoClosePolicy {
  return { mode: "understood", keywords: [], message: null };
}

export function normalizeAutoClosePolicy(v: unknown): AutoClosePolicy {
  const base = defaultAutoClosePolicy();
  if (!v || typeof v !== "object" || Array.isArray(v)) return base;
  const r = v as Record<string, unknown>;
  const keywords: string[] = [];
  if (Array.isArray(r.keywords)) {
    for (const raw of r.keywords) {
      if (typeof raw !== "string") continue;
      const s = raw.trim();
      if (s && !keywords.includes(s)) keywords.push(s);
    }
  }
  return {
    mode: isAutoCloseMode(r.mode) ? r.mode : base.mode,
    keywords,
    message:
      typeof r.message === "string" && r.message.trim()
        ? r.message.trim()
        : null,
  };
}

/** Tool `close_conversation` só no modo understood. */
export function llmMayCloseConversation(policy: AutoClosePolicy): boolean {
  return policy.mode === "understood";
}

/** Bloco injetado no system prompt — vale acima da regra do arquétipo. */
export function buildAutoClosePromptBlock(policy: AutoClosePolicy): string {
  if (policy.mode === "off") {
    return [
      "ENCERRAMENTO AUTOMÁTICO (pilotagem): DESLIGADO.",
      "NÃO chame `close_conversation`. Nunca encerre o ticket.",
      "Se o aluno se despedir, responda com educação e continue disponível.",
    ].join("\n");
  }
  if (policy.mode === "explicit") {
    return [
      "ENCERRAMENTO AUTOMÁTICO (pilotagem): só pedido explícito.",
      "NÃO chame `close_conversation`. O sistema encerra sozinho quando o aluno pedir para encerrar/finalizar ou usar uma palavra-chave configurada.",
      "Não interprete \"obrigado\", \"boa noite\" ou \"qualquer dúvida eu pergunto\" como encerramento.",
    ].join("\n");
  }
  return [
    "ENCERRAMENTO AUTOMÁTICO (pilotagem): a IA pode encerrar.",
    "Chame `close_conversation` quando entender que o aluno concluiu (não precisa mais, despedida clara, \"era só isso\") e AINDA NÃO houve consultor humano.",
    "NÃO encerre só por \"obrigado\", \"ok\" ou \"boa noite\" se o assunto ainda estiver aberto.",
    "Não peça confirmação extra se a intenção de encerrar estiver clara.",
  ].join("\n");
}

// ── Opening message templating ───────────────────────────────

/**
 * Substitui variáveis simples no texto de saudação/despedida.
 * Suporta `{{contact.firstName}}`, `{{contact.name}}`,
 * `{{deal.title}}`, `{{stage.name}}`. Valores ausentes viram string
 * vazia (preferível a quebrar a mensagem pro cliente).
 */
export function renderTemplate(
  template: string,
  vars: {
    contactName?: string | null;
    dealTitle?: string | null;
    stageName?: string | null;
  },
): string {
  const firstName = (vars.contactName ?? "").trim().split(/\s+/)[0] ?? "";
  return template
    .replace(/\{\{\s*contact\.firstName\s*\}\}/gi, firstName)
    .replace(/\{\{\s*contact\.name\s*\}\}/gi, vars.contactName ?? "")
    .replace(/\{\{\s*deal\.title\s*\}\}/gi, vars.dealTitle ?? "")
    .replace(/\{\{\s*stage\.name\s*\}\}/gi, vars.stageName ?? "");
}
