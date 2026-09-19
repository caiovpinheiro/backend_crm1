/**
 * URL que o aluno recebe tem que existir.
 *
 * O prompt já proíbe inventar link (REGRAS ABSOLUTAS 1, regra 9a). Não basta:
 * em teste com conversas reais o agente mandou
 * `https://passwordreset.microsoftonline.com/` — domínio que não está na base
 * nem em nenhuma constante oficial — e continuou mandando depois de a proibição
 * ser escrita de forma explícita no prompt. Instrução negativa em prompt longo
 * não é garantia; esta guarda é.
 *
 * Mesma lógica do `effect-claims`: o modelo pode errar à vontade, o texto que
 * sai é conferido contra um fato do sistema.
 */

import { academicTenantConfig } from "@/verticals/academic/tenant-config";

/**
 * Hosts sempre liberados: os das URLs oficiais da org mais os sufixos de
 * domínio dela. Tudo vem da config (`vertical.academic.*`) — URL e domínio
 * são dados de tenant, e a lista muda por organização.
 */
function alwaysAllowedHosts(): Set<string> {
  const cfg = academicTenantConfig();
  return new Set(
    [
      cfg.portalUrl,
      cfg.inauguralCertificateUrl,
      cfg.firstAccessVideoUrl,
      cfg.appAndroidUrl,
      cfg.appIosUrl,
    ]
      .map(hostOf)
      .filter((h): h is string => h !== null),
  );
}

const URL_RE = /https?:\/\/[^\s<>()[\]{}"']+/gi;

function hostOf(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

function isAllowedHost(host: string): boolean {
  if (alwaysAllowedHosts().has(host)) return true;
  return academicTenantConfig().allowedUrlSuffixes.some(
    (suffix) => host === suffix || host.endsWith(`.${suffix}`),
  );
}

export type UrlGuardResult = {
  /** Texto sem as URLs não autorizadas. */
  text: string;
  /** Hosts removidos — vão para o log, para o operador ver o que o modelo tentou. */
  removed: string[];
};

/**
 * Remove do texto toda URL cujo host não seja oficial nem da instituição, e
 * cujo endereço não apareça no contexto que alimentou o turno.
 *
 * `contextText` é o bloco de referências/modelos do prompt: se o link veio de
 * um documento que o operador cadastrou, ele é legítimo mesmo em domínio de
 * terceiro (é o caso de tutorial em vídeo, formulário, etc.).
 */
export function stripUnofficialUrls(
  text: string,
  contextText = "",
): UrlGuardResult {
  const removed: string[] = [];
  if (!text) return { text: "", removed };

  const context = contextText.toLowerCase();

  const cleaned = text.replace(URL_RE, (match) => {
    // Pontuação final não faz parte da URL — "acesse https://x.com."
    const trailing = match.match(/[.,;:!?)]+$/)?.[0] ?? "";
    const url = trailing ? match.slice(0, -trailing.length) : match;

    const host = hostOf(url);
    if (!host) return match;
    if (isAllowedHost(host)) return match;
    if (context.includes(url.toLowerCase())) return match;

    removed.push(host);
    return trailing;
  });

  if (removed.length === 0) return { text, removed };

  // Sobra do link removido: "acesse  ." / linha que virou só pontuação.
  const tidied = cleaned
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+([.,;:!?])/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { text: tidied, removed };
}
