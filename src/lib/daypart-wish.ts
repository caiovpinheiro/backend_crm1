/**
 * Cumprimento conforme o período do dia (fuso America/Sao_Paulo) e a
 * correção de "boa noite" de manhã. Nenhum domínio de cliente.
 */

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
