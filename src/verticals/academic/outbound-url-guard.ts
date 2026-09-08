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

import {
  OFFICIAL_DUDA_ANDROID_URL,
  OFFICIAL_DUDA_IOS_URL,
  OFFICIAL_FIRST_ACCESS_VIDEO_URL,
  OFFICIAL_INAUGURAL_CERTIFICATE_URL,
  OFFICIAL_STUDENT_PORTAL_URL,
} from "./atendimento-prompt";

/**
 * Hosts sempre liberados: os das constantes oficiais mais os domínios da
 * própria instituição e as duas lojas de app (o Duda é distribuído por elas).
 */
const ALWAYS_ALLOWED_HOSTS = new Set(
  [
    OFFICIAL_STUDENT_PORTAL_URL,
    OFFICIAL_INAUGURAL_CERTIFICATE_URL,
    OFFICIAL_FIRST_ACCESS_VIDEO_URL,
    OFFICIAL_DUDA_ANDROID_URL,
    OFFICIAL_DUDA_IOS_URL,
  ]
    .map(hostOf)
    .filter((h): h is string => h !== null),
);

/** Sufixos de domínio da instituição — cobre subdomínio novo sem recompilar. */
const ALLOWED_SUFFIXES = [
  "cruzeirodosul.edu.br",
  "cruzeirodosulvirtual.com.br",
  "cruzeiroead.com.br",
];

const URL_RE = /https?:\/\/[^\s<>()[\]{}"']+/gi;

function hostOf(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

function isAllowedHost(host: string): boolean {
  if (ALWAYS_ALLOWED_HOSTS.has(host)) return true;
  return ALLOWED_SUFFIXES.some(
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
