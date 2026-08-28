const DEFAULT_TZ = process.env.DEFAULT_TIMEZONE ?? "America/Sao_Paulo";

export type CallBizOpaque = { userId?: string; agentName?: string };

export function buildCallBizOpaquePayload(userId: string, displayName: string): string {
  const n = (displayName.trim() || "Agente").slice(0, 200);
  const base = { u: userId, n };
  let s = JSON.stringify(base);
  if (s.length <= 512) return s;
  let name = n;
  while (name.length > 1) {
    name = name.slice(0, -1);
    s = JSON.stringify({ u: userId, n: name });
    if (s.length <= 512) return s;
  }
  return JSON.stringify({ u: userId }).slice(0, 512);
}

export function parseCallBizOpaque(raw: string | null | undefined): CallBizOpaque {
  if (!raw?.trim()) return {};
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    const userId =
      typeof o.u === "string"
        ? o.u
        : typeof o.userId === "string"
          ? o.userId
          : undefined;
    const agentName =
      typeof o.n === "string"
        ? o.n
        : typeof o.name === "string"
          ? o.name
          : undefined;
    return { userId, agentName };
  } catch {
    return {};
  }
}

export function formatCallHm(d: Date, timeZone = DEFAULT_TZ): string {
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

function asObj(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function asStr(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/** SDP no webhook `calls` — `session` (oficial) ou `connection.webrtc` (variante Meta). */
export function extractWhatsappCallSdpSession(
  callObj: Record<string, unknown>,
  opts?: { defaultSdpType?: string },
): { sdp_type: string; sdp: string } | null {
  const sess = asObj(callObj.session);
  let sdpType = asStr(sess.sdp_type);
  let sdp = asStr(sess.sdp);
  if (!sdp) {
    const webrtc = asObj(asObj(callObj.connection).webrtc);
    sdp = asStr(webrtc.sdp);
  }
  if (sdp && !sdpType) {
    sdpType = opts?.defaultSdpType || "answer";
  }
  if (!sdp || !sdpType) return null;
  return { sdp_type: sdpType, sdp };
}

/** Lê o SDP guardado em `WhatsappCallEvent.errorsJson`. */
export function sessionFromCallEventErrorsJson(
  raw: unknown,
): { sdp_type: string; sdp: string } | null {
  const o = asObj(raw);
  const sess = asObj(o.session);
  const sdpType = asStr(sess.sdp_type);
  const sdp = asStr(sess.sdp);
  if (!sdpType || !sdp) return null;
  return { sdp_type: sdpType, sdp };
}

export function extractRecordingUrl(callObj: Record<string, unknown>): string | null {
  const top = typeof callObj.recording_url === "string" ? callObj.recording_url.trim() : "";
  if (/^https?:\/\//i.test(top)) return top;
  const r = callObj.recording;
  if (r && typeof r === "object" && !Array.isArray(r)) {
    const ro = r as Record<string, unknown>;
    const u = typeof ro.url === "string" ? ro.url.trim() : "";
    if (/^https?:\/\//i.test(u)) return u;
  }
  const s = typeof callObj.recording === "string" ? callObj.recording.trim() : "";
  if (/^https?:\/\//i.test(s)) return s;
  return null;
}

/**
 * Atendimento real: a Meta manda `connect` (SDP) e `COMPLETED` mesmo
 * sem o cliente atender. Duração / start_time / ACCEPTED é que importam.
 * @see https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/business-initiated-calls
 */
export function wasWhatsappCallPickedUp(params: {
  durationSec?: number | null;
  startTime?: Date | null;
  endTime?: Date | null;
  signalingStatuses?: Array<string | null | undefined>;
}): boolean {
  if (typeof params.durationSec === "number" && params.durationSec > 0) return true;
  if (params.startTime) return true;
  if (params.endTime) return true;
  return (params.signalingStatuses ?? []).some(
    (s) => (s ?? "").toUpperCase() === "ACCEPTED",
  );
}

export function classifyWhatsappCallEnd(params: {
  terminateStatus: string;
  pickedUp: boolean;
  rejected?: boolean;
}): "failed" | "missed" | "completed" {
  const st = (params.terminateStatus || "").toUpperCase();
  if (st === "FAILED" || st === "ERROR") return "failed";
  if (
    params.rejected ||
    st === "REJECTED" ||
    st === "MISSED" ||
    st === "USER_BUSY"
  ) {
    return "missed";
  }
  if (!params.pickedUp) return "missed";
  return "completed";
}

/**
 * String enxuta gerada quando o cliente atende (sinalização ACCEPTED)
 * ou, em entrada, quando o webhook `connect` chega da Meta.
 * Mantém apenas Chamada + direção (entrada/saída) + horário — sem
 * `agente: X` redundante (o nome do agente já aparece como
 * `senderName`/avatar da mensagem). O CallActivityItem usa "entrada"/
 * "saída" como heurística de fallback caso `direction` não venha.
 */
export function buildConnectChatLine(params: {
  direction: string;
  eventTime: Date;
  agentName?: string;
}): string {
  const hm = formatCallHm(params.eventTime);
  if (params.direction === "USER_INITIATED") {
    return `Chamada recebida pelo WhatsApp · ${hm}`;
  }
  return `Chamada realizada pelo WhatsApp · ${hm}`;
}

/**
 * String enxuta gerada quando a chamada termina. Preserva os tokens que o
 * `CallActivityItem` (`chat-window.tsx`) regex-extrai:
 *  - `fim`        → marca terminate
 *  - `falhou`     → marca falha
 *  - `13s`/`1m20s`→ duração
 *  - `18:22`      → horário
 *
 * Removidos: `· ok` (decoração — ausência de "falhou" já indica sucesso),
 * `· agente: X` (redundante com avatar/sender da mensagem) e o span
 * `HH:MM–HH:MM` quando início == fim (chamada de poucos segundos).
 */
export function buildTerminateChatLine(params: {
  terminateStatus: string;
  durationSec: number | null;
  startDate: Date | null;
  endDate: Date;
  agentName?: string;
  pickedUp?: boolean;
  rejected?: boolean;
}): string {
  const durShort =
    params.durationSec != null && params.durationSec > 0
      ? params.durationSec >= 60
        ? `${Math.floor(params.durationSec / 60)}m${String(params.durationSec % 60).padStart(2, "0")}s`
        : `${params.durationSec}s`
      : "";
  const hmStart = params.startDate ? formatCallHm(params.startDate) : null;
  const hmEnd = formatCallHm(params.endDate);
  const span = hmStart && hmStart !== hmEnd ? `${hmStart}–${hmEnd}` : hmEnd;
  const pickedUp =
    params.pickedUp ??
    wasWhatsappCallPickedUp({
      durationSec: params.durationSec,
      startTime: params.startDate,
    });
  const outcome = classifyWhatsappCallEnd({
    terminateStatus: params.terminateStatus,
    pickedUp,
    rejected: params.rejected,
  });

  if (outcome === "failed") {
    return `Chamada WhatsApp · fim · falhou · ${span}`;
  }
  if (outcome === "missed") {
    return `Chamada WhatsApp · fim · não atendida · ${span}`;
  }
  return durShort
    ? `Chamada WhatsApp · fim · ${durShort} · ${span}`
    : `Chamada WhatsApp · fim · ${span}`;
}

/**
 * Resumo minimalista para a mensagem `whatsapp_call_recording`.
 * O chat renderiza esta mensagem como "Activity Item" compacto
 * (ver `chat-window.tsx`); este texto é o fallback/legenda.
 */
export function buildConversationTimelineCallRecordingContent(params: {
  callId: string;
  direction: string;
  agentName?: string;
  startDate: Date | null;
  endDate: Date;
  durationSec: number | null;
  terminateStatus: string;
  hasRecordingUrl: boolean;
}): string {
  const hmS = params.startDate ? formatCallHm(params.startDate) : null;
  const hmE = formatCallHm(params.endDate);
  const dirLabel = params.direction === "USER_INITIATED" ? "entrada" : "saída";
  const durShort =
    params.durationSec != null && params.durationSec > 0
      ? params.durationSec >= 60
        ? `${Math.floor(params.durationSec / 60)}m${String(params.durationSec % 60).padStart(2, "0")}s`
        : `${params.durationSec}s`
      : null;
  const spanShort = hmS ? `${hmS}–${hmE}` : hmE;
  const pieces = [
    `Chamada WhatsApp · ${dirLabel}`,
    durShort ? `· ${durShort}` : null,
    `· ${spanShort}`,
  ].filter(Boolean);
  return pieces.join(" ");
}
