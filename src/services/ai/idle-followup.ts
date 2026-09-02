/**
 * Follow-up de silêncio da IA.
 */

export const IDLE_NUDGE_MS = 30 * 60 * 1000;
export const IDLE_CLOSE_AFTER_NUDGE_MS = 30 * 60 * 1000;

/** Trecho estável para o worker reconhecer o check-in (não traduzir). */
export const IDLE_NUDGE_SIGNATURE =
  "faz uns 30 minutos que fiquei sem te ouvir";

export function normalizeIdleText(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .trim();
}

export function buildIdleNudgeMessage(): string {
  return (
    `Oi, tudo bem? Faz uns 30 minutos que fiquei sem te ouvir 😊 ` +
    `Ainda posso te ajudar em alguma coisa, ou você já resolveu?`
  );
}

export function isIdleNudgeContent(content?: string | null): boolean {
  return normalizeIdleText(content ?? "").includes(IDLE_NUDGE_SIGNATURE);
}

/** Resposta clara ao check-in de que não precisa mais — sem "obrigado" sozinho. */
export function userWantsSoftAiClose(userMessage?: string | null): boolean {
  const msg = normalizeIdleText(userMessage ?? "")
    .replace(/[!?.…,]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!msg || msg.length > 80) return false;
  if (
    /^(nao precisa( mais)?( de ajuda)?|nao preciso( mais)?( de (ajuda|nada))?)$/.test(
      msg,
    )
  ) {
    return true;
  }
  if (/^(era )?so isso( mesmo)?$/.test(msg) || /^e so isso$/.test(msg)) {
    return true;
  }
  if (/^(nao quero|pode deixar|deixa pra la|ja resolvi)$/.test(msg)) {
    return true;
  }
  return false;
}

export function daypartWish(now = new Date()): "dia" | "tarde" | "noite" {
  const hour = Number(
    new Intl.DateTimeFormat("pt-BR", {
      timeZone: "America/Sao_Paulo",
      hour: "numeric",
      hour12: false,
    }).format(now),
  );
  if (hour >= 5 && hour < 12) return "dia";
  if (hour >= 12 && hour < 18) return "tarde";
  return "noite";
}

export function formatLocalClockHint(now = new Date()): string {
  const hour = Number(
    new Intl.DateTimeFormat("pt-BR", {
      timeZone: "America/Sao_Paulo",
      hour: "2-digit",
      hour12: false,
    }).format(now),
  );
  const minute = new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    minute: "2-digit",
  }).format(now);
  const h = hour === 24 ? 0 : hour;
  const part = daypartWish(now);
  const label = part === "dia" ? "manhã" : part;
  const wish =
    part === "dia" ? "bom dia" : part === "tarde" ? "boa tarde" : "boa noite";
  return [
    "",
    `HORÁRIO ATUAL (America/Sao_Paulo): ${String(h).padStart(2, "0")}:${String(minute).padStart(2, "0")} — agora é ${label}.`,
    `- Despedida/cumprimento DEVE ser "${wish}".`,
    `- Se o aluno falar "à noite" / "depois" / "mais tarde" / "quando estiver estudando", isso é PLANO FUTURO — NÃO é o horário de agora.`,
    `- PROIBIDO dizer "boa noite" de manhã ou à tarde. PROIBIDO "bom dia" à tarde/noite.`,
  ].join("\n");
}

/** Corrige "boa noite"/"bom dia" quando o relógio de SP diz outro período. */
export function rewriteMismatchedDaypartWish(
  text: string,
  now = new Date(),
): string {
  const part = daypartWish(now);
  if (!text.trim()) return text;
  if (part === "noite") return text;
  const target = part === "dia" ? "Bom dia" : "Boa tarde";
  const targetLower = target.toLowerCase();
  return text
    .replace(/boa noite de estudos/gi, "Bons estudos")
    .replace(/tenha uma boa noite/gi, `tenha uma ${targetLower}`)
    .replace(/ótim[ao] noite/gi, part === "dia" ? "ótimo dia" : "ótima tarde")
    .replace(/otim[ao] noite/gi, part === "dia" ? "ótimo dia" : "ótima tarde")
    .replace(/boa noite/gi, target);
}

export function buildSoftCloseAfterNudgeReply(now = new Date()): string {
  return `Ok! Qualquer coisa é só chamar. Tenha um ótimo ${daypartWish(now)} 😊`;
}

export function buildNaturalAttendanceCloseReply(now = new Date()): string {
  const part = daypartWish(now);
  const wish =
    part === "dia" ? "um ótimo dia" : part === "tarde" ? "uma boa tarde" : "uma boa noite";
  return `Por nada! Qualquer dúvida depois é só chamar, tá? Tenha ${wish} 😊`;
}
