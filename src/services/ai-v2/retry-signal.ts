/**
 * O cliente diz que já tentou e não deu certo ("já fiz 3 vezes", "continua
 * dando erro", "foi indeferido de novo"). Depois de uma orientação, repetir
 * o material ou o menu é a pior resposta: o atendimento vai para a equipe,
 * com o contexto. Só linguagem; nenhum domínio de cliente.
 */

const fold = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9?]+/g, " ")
    .trim();

/** "já tentei", "já fiz 3 vezes", "tentei de novo", "fiz várias vezes". */
const TRIED = /\b(?:ja|j)\s*(?:tentei|fiz|refiz|enviei|mandei|solicitei|pedi)\b|\btentei\s+(?:de novo|novamente|outra vez|varias vezes|\d+\s*vez)|\b(?:fiz|tentei)\s+\d+\s*(?:vez|vezes|tentativas?)\b|\b\d+\s*tentativas?\b/;

/** O resultado continua ruim: "não deu certo", "continua dando erro", "mesmo erro", "indeferido de novo". */
const FAILED =
  /\bnao\s+(?:deu certo|funcionou|funciona|resolveu|resolve|consegui|consigo|foi|aceitou|aceita|passou|passa|aparece|apareceu|libera|liberou|chegou|carrega|carregou|abre|abriu|entra|entrou|ta dando|esta dando|esta funcionando|ta funcionando)\b|\bcontinua\s+(?:dando|com|sem|igual|o mesmo|a mesma|aparecendo|sem funcionar)\b|\bmesm[oa]\s+(?:erro|problema|coisa|mensagem|situacao)\b|\b(?:de novo|novamente|outra vez|mais uma vez)\b|\b(?:indeferid|recusad|negad|rejeitad|reprovad|cancelad|bloquead)[oa]s?\b|\bda\s+(?:erro|indeferimento|recusa|negativa|problema)\b|\bsem sucesso\b|\bnada\s+(?:ainda|acontece|aconteceu|muda|mudou)\b|\be nada\b|\bnada\s*$/;

/**
 * Mensagem de erro de tela colada pelo cliente ("Não localizamos os dados
 * informados. Tente novamente.", "Usuário ou senha inválidos", "Ocorreu um
 * erro"): voz de sistema, não do cliente. Depois de uma orientação, é o
 * resultado da tentativa — e o agente não tem como "tentar de novo" por ele.
 */
const SYSTEM_ERROR =
  /\b(?:nao (?:localizamos|encontramos|foi possivel|conseguimos|reconhecemos|identificamos)|dados (?:informados|invalidos|incorretos)|tente (?:novamente|mais tarde|outra vez)|(?:senha|usuario|codigo|cpf|login|email|e mail|token|acesso) (?:invalid|incorret|nao (?:confere|encontrad|cadastrad|localizad))|acesso negado|sessao expirad|algo deu errado|ocorreu um erro|erro (?:ao|de|interno|desconhecido|\d{3})\b|falha (?:ao|na|no)\b|pagina nao encontrada|servico indisponivel|(?:usuario|conta) bloquead|nao autorizado)/;

export function looksLikeSystemError(text: string | null | undefined): boolean {
  const t = fold(text ?? "");
  return !!t && SYSTEM_ERROR.test(t);
}

/**
 * Sinal de "já tentei e não deu certo". Exige os dois lados (tentativa +
 * falha) ou uma falha que já carrega a repetição ("de novo", "continua",
 * "mesmo erro", "3 tentativas"). Pergunta pura ("e se não der certo?") não
 * conta.
 */
export function saysTriedAndFailed(text: string | null | undefined): boolean {
  const t = fold(text ?? "");
  if (!t) return false;
  const tried = TRIED.test(t);
  const failed = FAILED.test(t);
  if (tried && failed) return true;
  // Falha com repetição explícita, sem precisar dizer "tentei".
  if (failed && /\b(?:continua|de novo|novamente|outra vez|mais uma vez|mesm[oa]|ainda)\b/.test(t)) return true;
  // "Deu indeferimento 3 vezes" / "3 tentativas e nada".
  if (/\b\d+\s*(?:vez|vezes|tentativas?)\b/.test(t) && failed) return true;
  return false;
}
