/**
 * Guarda de saída da v2: domínios permitidos e proibição de prometer retorno.
 * Nenhum domínio de cliente.
 */

import { maskOutgoing } from "./sensitive";

const URL_RE = /https?:\/\/[^\s)\]>,;!?]+/gi;

const RETURN_PROMISE_PATTERNS = [
  /vou (verificar|confirmar|analisar|consultar|checar) e (volto|retorno|te respondo|te aviso)/i,
  /(volto|retorno|te respondo|te aviso|te retorno) (logo|mais tarde|depois|em breve|assim que poss[íi]vel)/i,
  /vou (dar uma olhada|olhar) e (volto|retorno)/i,
  /(assim que|quando) (eu|a gente) (tiver|tivermos) (uma resposta|o retorno|a resposta)/i,
  /fica (no aguardo|aguardando|esperando) (do|pela|por) (retorno|resposta|nossa resposta)/i,
];

export function extractUrls(text: string): string[] {
  return text.match(URL_RE) ?? [];
}

export function isUrlAllowed(url: string, allowedDomains: string[]): boolean {
  if (allowedDomains.length === 0) return true; // sem restrição explícita, permite tudo
  try {
    const host = new URL(url).hostname.toLowerCase();
    return allowedDomains.some((d) => host === d.toLowerCase() || host.endsWith(`.${d.toLowerCase()}`));
  } catch {
    return false;
  }
}

export function removeUnauthorizedUrls(text: string, allowedDomains: string[]): { text: string; removed: string[] } {
  if (allowedDomains.length === 0) return { text, removed: [] };
  const removed: string[] = [];
  const cleaned = text.replace(URL_RE, (url) => {
    if (!isUrlAllowed(url, allowedDomains)) {
      removed.push(url);
      return "";
    }
    return url;
  });
  // Só espaços em sequência: juntar tudo com \s+ colava as linhas e
  // desmontava passo a passo e listas quando havia domínio liberado.
  return { text: cleaned.replace(/[ \t]{2,}/g, " ").replace(/[ \t]+\n/g, "\n").trim(), removed };
}

export function containsReturnPromise(text: string): boolean {
  return RETURN_PROMISE_PATTERNS.some((re) => re.test(text));
}

type ScrubContext = {
  contact: Record<string, unknown> | null;
  citableContact: Record<string, unknown> | null;
  selectedDeal: Record<string, unknown> | null;
  citableDeal: Record<string, unknown> | null;
};

function collectNonCitableValues(ctx: ScrubContext): string[] {
  const values = new Set<string>();
  function add(obj: Record<string, unknown> | null, exclude: Record<string, unknown> | null) {
    if (!obj) return;
    const excludeKeys = exclude ? Object.keys(exclude) : [];
    for (const [k, v] of Object.entries(obj)) {
      if (excludeKeys.includes(k)) continue;
      const s = typeof v === "string" ? v.trim() : v !== null && v !== undefined ? String(v) : "";
      if (s.length >= 2) values.add(s);
    }
  }
  add(ctx.contact, ctx.citableContact);
  add(ctx.selectedDeal, ctx.citableDeal);
  return Array.from(values).sort((a, b) => b.length - a.length);
}

export function scrubNonCitableFields(
  text: string,
  ctx: ScrubContext,
): { text: string; scrubbedFields: string[] } {
  const values = collectNonCitableValues(ctx);
  const scrubbedFields: string[] = [];
  let result = text;
  for (const value of values) {
    if (!result.includes(value)) continue;
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Só o valor inteiro: sem as bordas, o nome "Ana" virava
    // "[informação interna não compartilhada]polis" dentro de "Anápolis".
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "gu");
    let found = false;
    result = result.replace(re, () => {
      found = true;
      return "[informação interna não compartilhada]";
    });
    if (found) scrubbedFields.push(value);
  }
  return { text: result, scrubbedFields };
}

export function guardV2Output(
  text: string,
  allowedDomains: string[],
  ctx?: ScrubContext,
): { text: string; warnings: string[]; scrubbedFields?: string[]; forceHandoff?: boolean } {
  const warnings: string[] = [];
  let forceHandoff = false;
  let replyText = text;
  let scrubbedFields: string[] | undefined;
  if (ctx) {
    const scrub = scrubNonCitableFields(replyText, ctx);
    replyText = scrub.text;
    if (scrub.scrubbedFields.length > 0) {
      scrubbedFields = scrub.scrubbedFields;
      warnings.push("Campos marcados apenas como 'Ler' foram removidos da resposta enviada ao cliente.");
    }
  }
  // Senha/código e cartão não saem; documento sai mascarado — mesmo que
  // venha do material, de uma ferramenta ou do próprio modelo.
  const sensitive = maskOutgoing(replyText);
  if (sensitive.kinds.length > 0) {
    replyText = sensitive.text;
    warnings.push(`Dado sensível removido/mascarado da resposta: ${sensitive.kinds.join(", ")}.`);
  }
  const urlResult = removeUnauthorizedUrls(replyText, allowedDomains);
  if (urlResult.removed.length > 0) {
    warnings.push(`URLs removidas por domínio não autorizado: ${urlResult.removed.join(", ")}`);
  }
  if (containsReturnPromise(urlResult.text)) {
    // O texto dizia "vou passar para um atendente" mas ninguém transferia:
    // o motor precisa do sinal para fazer o handoff de verdade.
    warnings.push("Promessa de retorno detectada. Substituída por handoff.");
    urlResult.text = "Preciso passar isso para um atendente da equipe que vai te ajudar agora.";
    forceHandoff = true;
  }
  return { text: urlResult.text, warnings, scrubbedFields, forceHandoff };
}
