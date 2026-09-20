/**
 * Guarda de saída da v2: domínios permitidos e proibição de prometer retorno.
 * Nenhum domínio de cliente.
 */

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
  return { text: cleaned.replace(/\s+/g, " ").trim(), removed };
}

export function containsReturnPromise(text: string): boolean {
  return RETURN_PROMISE_PATTERNS.some((re) => re.test(text));
}

export function guardV2Output(
  text: string,
  allowedDomains: string[],
): { text: string; warnings: string[] } {
  const warnings: string[] = [];
  const urlResult = removeUnauthorizedUrls(text, allowedDomains);
  if (urlResult.removed.length > 0) {
    warnings.push(`URLs removidas por domínio não autorizado: ${urlResult.removed.join(", ")}`);
  }
  if (containsReturnPromise(urlResult.text)) {
    warnings.push("Promessa de retorno detectada. Substituída por handoff.");
    urlResult.text = "Preciso passar isso para um atendente da equipe que vai te ajudar agora.";
  }
  return { text: urlResult.text, warnings };
}
