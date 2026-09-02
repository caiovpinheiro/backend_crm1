/**
 * Política quando não há consultor humano elegível:
 *  - avisa com empatia e oferece continuar com a IA;
 *  - fora do expediente (antes das 8h/9h ou a partir da pausa pré-fim), informa o próximo horário;
 *  - dentro do expediente, não promete "em breve" como se já houvesse alguém na linha.
 *
 * Expediente humano (SP): seg–sex 8h–19h, sábado 9h–16h.
 * Pausa na fila: 30 min antes da saída → janela efetiva até 18h30 (seg–sex)
 * e 15h30 (sábado).
 */

const TZ = "America/Sao_Paulo";

/** Fim oficial do expediente em dias úteis (hora cheia). */
export const HUMAN_ATTENDANCE_END_HOUR = 19;
/** Fim oficial do expediente no sábado (hora cheia). */
export const HUMAN_ATTENDANCE_SATURDAY_END_HOUR = 16;
/** Minutos de pausa na fila antes da saída (não oferece lead perto do fim). */
export const HUMAN_ATTENDANCE_PRE_END_MINUTES = 30;

const HOURS_FOOTER_TEXT =
  "segunda a sexta das 8h às 19h e sábado das 9h às 16h";

function normalizeMsg(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function clockInSaoPaulo(now = new Date()): {
  weekday: string;
  hour: number;
  minute: number;
} {
  const weekday = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    weekday: "short",
  }).format(now);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return { weekday, hour: hour === 24 ? 0 : hour, minute };
}

/** Minuto-do-dia em que a janela fecha (fim − pausa pré-fim). */
export function humanAttendanceEffectiveEndMinutes(
  now = new Date(),
): number {
  const { weekday } = clockInSaoPaulo(now);
  const endHour =
    weekday === "Sat"
      ? HUMAN_ATTENDANCE_SATURDAY_END_HOUR
      : HUMAN_ATTENDANCE_END_HOUR;
  return endHour * 60 - HUMAN_ATTENDANCE_PRE_END_MINUTES;
}

/**
 * Próximo horário de início do atendimento humano (SP).
 * Considera manhã (ainda não abriu) e noite (já fechou / pausa pré-fim).
 */
export function humanAttendanceStartHint(now = new Date()): {
  startHour: 8 | 9;
  dayLabel: string;
} {
  const { weekday, hour, minute } = clockInSaoPaulo(now);
  const mins = hour * 60 + minute;
  const endMins = humanAttendanceEffectiveEndMinutes(now);

  if (weekday === "Sun") {
    return { startHour: 8, dayLabel: "segunda-feira" };
  }

  if (weekday === "Sat") {
    if (mins < 9 * 60) {
      return { startHour: 9, dayLabel: "hoje (sábado)" };
    }
    // Após pausa pré-fim / fechamento no sábado → segunda.
    if (mins >= endMins) {
      return { startHour: 8, dayLabel: "segunda-feira" };
    }
    return { startHour: 9, dayLabel: "hoje (sábado)" };
  }

  // Seg–sex
  if (mins < 8 * 60) {
    return { startHour: 8, dayLabel: "hoje" };
  }
  if (mins >= endMins) {
    if (weekday === "Fri") {
      return { startHour: 8, dayLabel: "segunda-feira" };
    }
    return { startHour: 8, dayLabel: "amanhã" };
  }
  return { startHour: 8, dayLabel: "hoje" };
}

/**
 * True se estamos na janela em que faz sentido prometer atendimento humano
 * "no mesmo dia" (SP): após abertura e antes da pausa pré-fim.
 */
export function isHumanAttendanceWindowOpen(now = new Date()): boolean {
  const { weekday, hour, minute } = clockInSaoPaulo(now);
  if (weekday === "Sun") return false;
  const startHour = weekday === "Sat" ? 9 : 8;
  const mins = hour * 60 + minute;
  const endMins = humanAttendanceEffectiveEndMinutes(now);
  return mins >= startHour * 60 && mins < endMins;
}

function hoursFooter(now = new Date()): string {
  if (isHumanAttendanceWindowOpen(now)) {
    return (
      `Assim que um(a) consultor(a) puder, te atendem ` +
      `(expediente: ${HOURS_FOOTER_TEXT}).`
    );
  }
  const { startHour, dayLabel } = humanAttendanceStartHint(now);
  return (
    `O atendimento humano retoma às *${startHour}h* ${dayLabel} ` +
    `(${HOURS_FOOTER_TEXT}).`
  );
}

export function buildHumanUnavailableOfferMessage(now = new Date()): string {
  if (isHumanAttendanceWindowOpen(now)) {
    return (
      `Combinado — já pedi para a equipe te atender. Assim que um(a) ` +
      `consultor(a) puder, continua com você por aqui, tá? ` +
      `Enquanto isso, se quiser tirar alguma dúvida, *estou aqui* contigo. ` +
      `Se preferir só esperar com calma, também tudo bem — me avisa 💛`
    );
  }
  const { startHour, dayLabel } = humanAttendanceStartHint(now);
  return (
    `Combinado — já registrei seu pedido com a equipe. O atendimento humano ` +
    `retoma às *${startHour}h* ${dayLabel} ` +
    `(${HOURS_FOOTER_TEXT}). ` +
    `Enquanto isso, se quiser tirar alguma dúvida, *estou aqui* contigo. ` +
    `Se preferir só esperar, também tudo bem — me avisa 💛`
  );
}

export function buildHumanQueueWithHoursMessage(now = new Date()): string {
  return (
    `Combinado! Você já está na *fila* do atendimento humano. ` +
    `${hoursFooter(now)}`
  );
}

/** Aviso quando a conversa já foi atribuída a um consultor (não depender da automação). */
export function buildAssignedConsultantNotice(): string {
  return (
    "Já te passei para um *consultor* da equipe. Ele continua daqui — " +
    "pode levar um pouquinho, mas seu pedido já está com alguém, tá? 💛"
  );
}

/** Pedido explícito de fila / humano / consultor / distribuição. */
export function userWantsHumanDistribution(userMessage: string): boolean {
  const n = normalizeMsg(userMessage);
  if (!n) return false;
  if (
    /\b(atendente|humano|consultor|consultora|atendimento humano)\b/.test(n)
  ) {
    return true;
  }
  if (
    /falar com (alguem|atendente|humano|consultor)|quero (um )?atendente|passar (para|pro) (humano|atendente|consultor)/.test(
      n,
    )
  ) {
    return true;
  }
  if (
    /\b(fila|aguardar (o )?consultor|espera(r)? (o )?consultor|distribu)/.test(
      n,
    )
  ) {
    return true;
  }
  return false;
}

/** Aluno pede para a IA continuar (após oferta de indisponibilidade). */
export function userWantsAiContinue(userMessage: string): boolean {
  const n = normalizeMsg(userMessage);
  if (!n) return false;
  if (userWantsHumanDistribution(userMessage)) return false;
  return (
    /pode continuar|continua(r)?( me)? (ajud|atend)|voce (pode )?ajud|quero (sua|a) ajuda|pode me ajudar|segue( comigo)?|pode sim|quero (que )?voce/.test(
      n,
    ) ||
    /^(pode|quero|sim|continuar|continua)[\s!.]*$/.test(n)
  );
}

/** Mensagens já usadas neste fluxo (dedupe). */
export const HUMAN_QUEUE_MSG_PATTERNS = [
  "já pedi para a equipe",
  "ja pedi para a equipe",
  "já pedi para um(a) consultor",
  "ja pedi para um(a) consultor",
  "já registrei seu pedido",
  "ja registrei seu pedido",
  "estou aqui contigo",
  "em breve alguém da equipe",
  "o atendimento humano retoma",
  "já te encaminhei para a equipe",
  "ja te encaminhei para a equipe",
  "já te deixei na fila",
  "ja te deixei na fila",
  "assim que estiver livre",
  "atendimento humano está indisponível",
  "atendimento humano esta indisponivel",
  "nenhum consultor elegivel",
  "nenhum consultor elegível",
  "ninguém está disponível",
  "ninguem esta disponivel",
  "eu posso continuar",
  "já está na fila",
  "ja esta na fila",
  "expediente inicia",
  "atendimento humano inicia",
  "segunda a sexta às 8h",
  "segunda a sexta as 8h",
  "segunda a sexta das 8h",
  "a partir das 8h",
  "só mais um pouquinho",
  "so mais um pouquinho",
  "fala com você em breve",
  "fala com voce em breve",
  "vou te conectar",
  "já te passei para um consultor",
  "ja te passei para um consultor",
  "passei para um consultor",
  "seu pedido já está com alguém",
  "seu pedido ja esta com alguem",
] as const;

export function messageLooksLikeHumanQueueNotice(
  content: string | null | undefined,
): boolean {
  if (!content) return false;
  const n = normalizeMsg(content);
  return HUMAN_QUEUE_MSG_PATTERNS.some((p) => n.includes(normalizeMsg(p)));
}

/** Normaliza texto para comparação de near-duplicate. */
export function normalizeForDedupe(raw: string): string {
  return normalizeMsg(raw).replace(/[^\p{L}\p{N}\s]/gu, "");
}

/**
 * True se `candidate` é praticamente a mesma informação de `existing`
 * (template de fila/conexão ou overlap alto de tokens).
 */
export function isNearDuplicateBotText(
  candidate: string,
  existing: string,
): boolean {
  const a = normalizeForDedupe(candidate);
  const b = normalizeForDedupe(existing);
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) {
    const shorter = Math.min(a.length, b.length);
    const longer = Math.max(a.length, b.length);
    if (shorter >= 40 && shorter / longer >= 0.7) return true;
  }
  const queueA = messageLooksLikeHumanQueueNotice(candidate);
  const queueB = messageLooksLikeHumanQueueNotice(existing);
  if (queueA && queueB) return true;
  if (a.includes("vou te conectar") && b.includes("vou te conectar")) {
    return true;
  }
  const ta = new Set(a.split(" ").filter((w) => w.length > 2));
  const tb = new Set(b.split(" ").filter((w) => w.length > 2));
  if (ta.size === 0 || tb.size === 0) return false;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const union = ta.size + tb.size - inter;
  return union > 0 && inter / union >= 0.7;
}
