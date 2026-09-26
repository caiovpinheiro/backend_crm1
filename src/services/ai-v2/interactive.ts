/**
 * Mensagens interativas da v2: botões, listas, fallback numerado (SPEC 3.12).
 *
 * O motor manda as opções como botões (até 3, rótulo até 20 caracteres) ou
 * lista (até 10) do WhatsApp; onde não dá (Baileys, modo sugestão, envio
 * interativo recusado) vão como lista numerada no texto. No turno seguinte
 * o clique, o rótulo digitado ou o número voltam para a opção escolhida.
 * Nenhum domínio de cliente.
 */

import type { V2PendingInteractiveOption } from "@/lib/ai-v2/types";

export type V2InteractiveFormat = "buttons" | "list" | "numbered_text";

/** Limites da Cloud API. */
const BUTTON_TITLE_MAX = 20;
const LIST_TITLE_MAX = 24;
const LIST_DESCRIPTION_MAX = 72;
const BODY_MAX = 1024;
const MAX_OPTIONS = 10;

/** Corpo curto quando a resposta não cabe no corpo da mensagem interativa. */
const SHORT_BODY = "Escolha uma opção:";
const LIST_BUTTON = "Ver opções";

export function decideInteractiveFormat(options: Array<Pick<V2PendingInteractiveOption, "label">>, sessionWindowOpen: boolean): V2InteractiveFormat {
  if (!sessionWindowOpen || options.length === 0) return "numbered_text";
  if (options.length <= 3 && options.every((o) => o.label.length <= BUTTON_TITLE_MAX)) return "buttons";
  if (options.length <= MAX_OPTIONS) return "list";
  return "numbered_text";
}

export function buildInteractiveText(options: Array<Pick<V2PendingInteractiveOption, "label">>): string {
  return options.map((opt, i) => `${i + 1}. ${opt.label}`).join("\n");
}

function truncate(label: string, max: number): string {
  return label.length <= max ? label : `${label.slice(0, max - 1)}…`;
}

/** Mensagem interativa pronta para o canal (neutra: serve à Meta ou a outro). */
export type V2InteractivePayload = {
  kind: "buttons" | "list";
  /** Texto enviado antes, quando a resposta não cabe no corpo interativo. */
  leadText?: string;
  body: string;
  options: Array<{ id: string; title: string; description?: string }>;
  listButton: string;
  /** Como a mensagem fica registrada na conversa (inbox e histórico do modelo). */
  displayContent: string;
};

/**
 * Resposta + opções → mensagem interativa e o texto numerado de reserva.
 * Sem opções válidas, `payload` é null e o texto é a própria resposta.
 */
export function buildV2Interactive(reply: string, rawLabels: string[]): { payload: V2InteractivePayload | null; fallbackText: string; labels: string[] } {
  const seen = new Set<string>();
  const all: string[] = [];
  for (const raw of rawLabels) {
    const label = raw.replace(/\s+/g, " ").trim();
    const key = fold(label);
    if (!label || !key || seen.has(key)) continue;
    seen.add(key);
    all.push(label);
  }
  const labels = all.slice(0, MAX_OPTIONS);
  const body = reply.trim();
  const fallbackText = [body, buildInteractiveText(labels.map((label) => ({ label })))].filter(Boolean).join("\n\n");
  const format = decideInteractiveFormat(labels.map((label) => ({ label })), true);
  if (format === "numbered_text") return { payload: null, fallbackText, labels };

  const options = labels.map((label, i) =>
    format === "buttons"
      ? { id: `v2opt_${i + 1}`, title: label }
      : {
          id: `v2opt_${i + 1}`,
          title: truncate(label, LIST_TITLE_MAX),
          ...(label.length > LIST_TITLE_MAX ? { description: truncate(label, LIST_DESCRIPTION_MAX) } : {}),
        },
  );
  const fits = body.length > 0 && body.length <= BODY_MAX;
  const tag = format === "buttons" ? "Botões" : "Lista";
  return {
    payload: {
      kind: format,
      ...(fits || !body ? {} : { leadText: body }),
      body: fits ? body : SHORT_BODY,
      options,
      listButton: LIST_BUTTON,
      displayContent: `${body || SHORT_BODY}\n[${tag}: ${labels.join(", ")}]`,
    },
    fallbackText,
    labels,
  };
}

/**
 * Opções que a mensagem do agente ofereceu, pela marca "[Botões: a, b]" /
 * "[Lista: a, b]" do fim. Serve à conversa de teste, que só tem o
 * histórico. Linhas numeradas não contam: um passo a passo comum viraria
 * opção e o "2" do cliente mudaria de sentido.
 */
export function optionsFromAgentMessage(text: string | null | undefined): string[] {
  const lines = (text ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const tag = lines[lines.length - 1]?.match(/^\[(?:Botões|Lista): (.+)\]$/);
  return tag ? tag[1].split(", ").map((l) => l.trim()).filter(Boolean).slice(0, MAX_OPTIONS) : [];
}

function fold(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Mensagem do cliente → opção pendente: clique no botão/lista (chega como o
 * título, e na lista também a descrição), o rótulo digitado ou o número
 * ("2", "2.", "opção 2"). Texto livre que não é nenhuma delas → null.
 */
export function matchPendingOption(labels: string[], text: string): string | null {
  if (labels.length === 0) return null;
  const msg = fold(text);
  if (!msg) return null;
  const num = msg.match(/^(?:opcao|op|numero|n)?\s*(\d{1,2})$/);
  if (num) {
    const idx = Number.parseInt(num[1], 10) - 1;
    return idx >= 0 && idx < labels.length ? labels[idx] : null;
  }
  const lines = text.split(/\r?\n/).map(fold).filter(Boolean);
  for (const label of labels) {
    const full = fold(label);
    const shown = fold(truncate(label, LIST_TITLE_MAX));
    if (msg === full || lines.includes(full) || lines[0] === shown) return label;
  }
  return null;
}
