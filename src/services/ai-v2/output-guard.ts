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

const SCRUB_MARKER = "[informação interna não compartilhada]";
/** Valores de campo que são palavra comum, não dado interno. */
const COMMON_VALUES = new Set(["sim", "nao", "não", "yes", "no", "true", "false", "ok", "n/a", "na", "null", "none", "ativo", "inativo", "aberto", "fechado", "pendente"]);

/**
 * Valor que não identifica nada: palavra comum ("Sim", "Não", "Ativo"),
 * número pequeno ou booleano. Um campo só-leitura "Sim" mascarava o "Sim"
 * com que a resposta começava. Nome curto ("Ana") continua sendo dado.
 */
export function isCommonFieldValue(value: string): boolean {
  const v = value.trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  if (COMMON_VALUES.has(v)) return true;
  if (/^\d{1,4}$/.test(v)) return true;
  return false;
}

function collectNonCitableValues(ctx: ScrubContext): string[] {
  const values = new Set<string>();
  function add(obj: Record<string, unknown> | null, exclude: Record<string, unknown> | null) {
    if (!obj) return;
    const excludeKeys = exclude ? Object.keys(exclude) : [];
    for (const [k, v] of Object.entries(obj)) {
      if (excludeKeys.includes(k)) continue;
      const s = typeof v === "string" ? v.trim() : v !== null && v !== undefined ? String(v) : "";
      if (s.length >= 2 && !isCommonFieldValue(s)) values.add(s);
    }
  }
  add(ctx.contact, ctx.citableContact);
  add(ctx.selectedDeal, ctx.citableDeal);
  return Array.from(values).sort((a, b) => b.length - a.length);
}

/**
 * Marcador no começo de frase ou linha sai junto com a vírgula que o
 * seguia ("[…], Ana! Vou te enviar" → "Ana! Vou te enviar"); no meio da
 * frase ele fica, para a frase não mudar de sentido.
 */
function tidyScrubMarkers(text: string): string {
  const marker = SCRUB_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text
    .replace(new RegExp(`(^|\\n|[.!?]\\s+)${marker}[,;:]?\\s*(\\p{L})`, "gu"), (_m, before: string, next: string) => `${before}${next.toUpperCase()}`)
    .replace(new RegExp(`(^|\\n|[.!?]\\s+)${marker}[,;:]?\\s*`, "gu"), "$1");
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
      return SCRUB_MARKER;
    });
    if (found) scrubbedFields.push(value);
  }
  return { text: scrubbedFields.length > 0 ? tidyScrubMarkers(result) : result, scrubbedFields };
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
  // venha do material, de uma ferramenta ou do próprio modelo. Exceção: o
  // valor exato que a configuração marca "pode dizer" a este cliente
  // (ex.: um código de acesso montado dos campos dele).
  const citable = new Set(
    [ctx?.citableContact, ctx?.citableDeal]
      .flatMap((o) => Object.values(o ?? {}))
      .filter((v): v is string | number => typeof v === "string" || typeof v === "number")
      .map((v) => String(v).trim())
      .filter((v) => v.length >= 3),
  );
  const sensitive = maskOutgoing(replyText, citable);
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
