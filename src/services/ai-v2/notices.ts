/**
 * Avisos temporários: uma situação com início e fim que muda o que o
 * agente deve dizer enquanto dura (manutenção de um sistema, instabilidade,
 * prazo prorrogado, atendimento suspenso). Quem configura escreve o fato e
 * o que o cliente deve fazer; o motor:
 *  - põe os avisos em vigor no prompt, com prioridade, e como fonte (a
 *    checagem não barra o que o aviso afirma);
 *  - quando o cliente relata uma falha depois de uma orientação e um aviso
 *    em vigor explica essa falha, responde com o aviso em vez de transferir
 *    (uma vez por aviso na conversa; se o cliente insistir, segue o caminho
 *    normal).
 * Fora da janela o aviso não existe para o motor: expira sozinho.
 * Nenhum domínio de cliente: o conteúdo é da configuração.
 */

import type { V2AgentConfig, V2Notice } from "@/lib/ai-v2/types";

import { matchV2Theme } from "./themes";

/** Aviso sem fim vale este tempo depois do início (o validador avisa). */
export const NOTICE_DEFAULT_HOURS = 24;
export const NOTICE_LIMITS = { max: 20, messageChars: 600 };

const DEFAULT_TZ = "America/Sao_Paulo";

/** Diferença (ms) entre o relógio do fuso e UTC naquele instante. */
function tzOffsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(at);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - at.getTime();
}

/**
 * Data e hora como a tela grava ("2026-10-11T08:00", sem fuso) no fuso do
 * agente → instante. Com fuso explícito (ISO completo), vale o que veio.
 */
export function noticeInstant(value: string | undefined, timeZone: string = DEFAULT_TZ): Date | null {
  if (!value) return null;
  const v = value.trim();
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(v)) {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const m = v.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?$/);
  if (!m) return null;
  const [, y, mo, d, h = "00", mi = "00"] = m;
  const guess = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi));
  // Duas passadas: o deslocamento pode mudar perto de troca de horário.
  let ts = guess - tzOffsetMs(new Date(guess), timeZone);
  ts = guess - tzOffsetMs(new Date(ts), timeZone);
  return new Date(ts);
}

export type NoticeWindow = { start: Date; end: Date; endGuessed: boolean };

export function noticeWindow(notice: Pick<V2Notice, "startsAt" | "endsAt">, timeZone: string = DEFAULT_TZ): NoticeWindow | null {
  const start = noticeInstant(notice.startsAt, timeZone);
  if (!start) return null;
  const end = noticeInstant(notice.endsAt, timeZone);
  if (end && end.getTime() > start.getTime()) return { start, end, endGuessed: false };
  return { start, end: new Date(start.getTime() + NOTICE_DEFAULT_HOURS * 3_600_000), endGuessed: true };
}

const tzOf = (config: Pick<V2AgentConfig, "businessHours">) => config.businessHours?.timezone || DEFAULT_TZ;

/** Avisos em vigor no instante (início ≤ agora < fim). */
export function activeNotices(config: Pick<V2AgentConfig, "notices" | "businessHours">, now: Date = new Date()): V2Notice[] {
  const tz = tzOf(config);
  return (config.notices ?? []).filter((n) => {
    if (!n.message?.trim()) return false;
    const w = noticeWindow(n, tz);
    return !!w && w.start.getTime() <= now.getTime() && now.getTime() < w.end.getTime();
  });
}

/** O aviso vale para o assunto do turno: sem assuntos escolhidos, vale para todos. */
export function noticeCoversTheme(notice: V2Notice, themeId: string | undefined | null): boolean {
  const ids = notice.themeIds ?? [];
  return ids.length === 0 || (!!themeId && ids.includes(themeId));
}

/** A mensagem cita um gatilho do aviso (mesma regra de casamento dos assuntos). */
export function noticeTriggered(notice: V2Notice, message: string): boolean {
  const when = (notice.when ?? []).filter((w) => w.trim());
  if (when.length === 0 || !message.trim()) return false;
  return matchV2Theme({ when, examples: [] } as never, message).score > 0;
}

/** Avisos que vão para o prompt deste turno: os do assunto (ou de todos) e os que a mensagem cita. */
export function noticesForTurn(config: Pick<V2AgentConfig, "notices" | "businessHours">, args: { themeId?: string | null; message?: string; now?: Date }): V2Notice[] {
  return activeNotices(config, args.now).filter((n) => noticeCoversTheme(n, args.themeId) || noticeTriggered(n, args.message ?? ""));
}

/** Seção do prompt com os avisos em vigor. Vazia sem aviso. */
export function noticesPromptSection(notices: V2Notice[], _config?: Pick<V2AgentConfig, "businessHours">): string {
  if (notices.length === 0) return "";
  // A validade do aviso NÃO vai junto do texto: "Título (até 11/10 23:59):"
  // fazia o modelo dizer ao cliente que a situação acabava nesse horário.
  // Ela é só quando o aviso deixa de valer, e o modelo não deve repassá-la.
  const lines = notices.map((n) => {
    const title = n.title?.trim() ? `${n.title.trim()}: ` : "";
    return `- ${title}${n.message.trim().slice(0, NOTICE_LIMITS.messageChars)}`;
  });
  return [
    "# Avisos em vigor (prioridade)",
    "Situações temporárias informadas pela empresa, válidas agora. Quando o pedido do cliente tiver relação com um aviso, o aviso vale acima dos materiais: explique a situação com suas palavras, diga o que o cliente deve fazer conforme o aviso e não transfira por causa da situação descrita no aviso. Não acrescente prazo, previsão de retorno, valor ou condição que o texto do aviso não diz: se o cliente perguntar quando volta e o aviso não disser, diga que ainda não há previsão informada. Pedido sem relação com os avisos: ignore-os e não os mencione.",
    ...lines,
  ].join("\n");
}

/**
 * Aviso que explica a falha que o cliente relatou depois de uma orientação
 * e que segura a transferência: em vigor, com "segurar transferência"
 * ligado, do assunto do turno (ou de todos) ou citado pela mensagem, e
 * ainda não dito nesta conversa.
 */
export function noticeExplainingFailure(
  config: Pick<V2AgentConfig, "notices" | "businessHours">,
  args: { themeId?: string | null; message: string; now?: Date; alreadyShown?: string[] },
): V2Notice | null {
  const shown = new Set(args.alreadyShown ?? []);
  return (
    noticesForTurn(config, args).find((n) => n.holdTransfers !== false && !shown.has(n.id)) ?? null
  );
}
