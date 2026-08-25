/**
 * Erros conhecidos do Graph na API de chamadas WhatsApp (Cloud API).
 * Sempre devolve JSON acionável — nunca deixar o Graph/timeout virar HTML 502
 * no Traefik (o operador via "Servidor temporariamente indisponível").
 *
 * @see https://developers.facebook.com/docs/whatsapp/cloud-api/calling
 * @see https://developers.facebook.com/documentation/business-messaging/whatsapp/calling/troubleshooting/
 */
import {
  isMetaGraphError,
  MetaGraphNetworkError,
  MetaGraphTimeoutError,
} from "@/lib/meta-whatsapp/client";
import {
  isMetaTransientServiceCode,
  metaErrorReason,
} from "@/lib/meta-whatsapp/error-catalog";

const ONGOING_WITH_CONTACT =
  "Já existe uma chamada em curso com este contato no WhatsApp. Use «Encerrar ligação» (ou «Encerrar chamada» se estiver ativa no histórico), aguarde alguns segundos e tente de novo.";

const CALLING_CODE_MESSAGES: Record<number, { status: number; message: string }> = {
  138000: {
    status: 401,
    message:
      "Chamadas WhatsApp não estão ativas neste número. Ative Calling nas configurações do canal na Meta.",
  },
  138001: {
    status: 400,
    message:
      "Este contato não pode receber ligação pelo WhatsApp (número, versão do app ou termos da Meta).",
  },
  138002: {
    status: 429,
    message: "Limite de chamadas simultâneas da Meta atingido. Tente em instantes.",
  },
  138003: {
    status: 409,
    message: ONGOING_WITH_CONTACT,
  },
  138004: {
    status: 503,
    message: "A Meta não conseguiu estabelecer a ligação. Tente novamente.",
  },
  138005: {
    status: 429,
    message: "Limite de ligações da Meta atingido. Aguarde e tente de novo.",
  },
  138006: {
    status: 403,
    message:
      "O cliente precisa aceitar o pedido de permissão de chamada no WhatsApp antes de ligar.",
  },
  138007: {
    status: 504,
    message: "A Meta expirou ao conectar a chamada. Tente novamente.",
  },
  138009: {
    status: 429,
    message: "Limite de pedidos de permissão de chamada atingido. Aguarde e tente de novo.",
  },
  138012: {
    status: 429,
    message: "Limite diário de ligações da empresa atingido. Tente amanhã.",
  },
  131055: {
    status: 400,
    message:
      "Este número está em modo SIP. Chamadas Cloud API (WebRTC) não se aplicam — use o softphone.",
  },
};

function fromRawString(raw: string): { status: number; message: string } | null {
  const lower = raw.trim().toLowerCase();
  if (!lower) return null;
  if (lower.includes("already ongoing") && lower.includes("receiver")) {
    return { status: 409, message: ONGOING_WITH_CONTACT };
  }
  if (lower.includes("already ongoing")) {
    return {
      status: 409,
      message: "Já existe uma chamada em curso. Termine-a na Meta antes de iniciar outra.",
    };
  }
  return null;
}

export function mapMetaWhatsappCallGraphError(err: unknown): {
  status: number;
  message: string;
} {
  if (isMetaGraphError(err)) {
    if (err.code != null && CALLING_CODE_MESSAGES[err.code]) {
      return CALLING_CODE_MESSAGES[err.code];
    }
    const fromDetails = fromRawString(
      [err.details, err.userMsg, err.message].filter(Boolean).join(" "),
    );
    if (fromDetails) return fromDetails;
    if (isMetaTransientServiceCode(err.code) || err.httpStatus === 502 || err.httpStatus === 503) {
      return {
        status: 503,
        message: "Servidor da Meta temporariamente indisponível. Tente novamente em instantes.",
      };
    }
    const catalog = metaErrorReason(err.code);
    const status =
      err.httpStatus >= 400 && err.httpStatus < 600 ? err.httpStatus : 502;
    return { status, message: catalog || err.message };
  }

  if (err instanceof MetaGraphTimeoutError) {
    return {
      status: 504,
      message: "A Meta não respondeu a tempo ao iniciar a ligação. Tente novamente.",
    };
  }
  if (err instanceof MetaGraphNetworkError) {
    return {
      status: 503,
      message: "Falha de rede ao falar com a Meta. Tente novamente.",
    };
  }

  const raw = err instanceof Error ? err.message : String(err);
  const fromRaw = fromRawString(raw);
  if (fromRaw) return fromRaw;

  return {
    status: 500,
    message: raw.trim() || "Erro na chamada WhatsApp.",
  };
}
