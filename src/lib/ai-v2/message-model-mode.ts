/**
 * Material + mensagem pronta no mesmo turno: o que o cliente recebe. Escolha
 * do administrador (agente, com exceção por assunto). Nenhum domínio de
 * cliente.
 *
 * - auto: a mensagem pronta repete a resposta → a resposta vira introdução e
 *   a mensagem pronta segue; traz outra coisa → vão as duas.
 * - both: a resposta completa e, depois, a mensagem pronta.
 * - message_model: só a mensagem pronta (a resposta vira uma frase de
 *   introdução).
 * - answer: só a resposta; da mensagem pronta seguem apenas os arquivos.
 * - combine: o agente junta o conteúdo da mensagem pronta na resposta dele;
 *   os arquivos da mensagem pronta seguem depois.
 */

export const MESSAGE_MODEL_MODES = ["auto", "both", "message_model", "answer", "combine"] as const;

export type MessageModelMode = (typeof MESSAGE_MODEL_MODES)[number];

export function messageModelModeFor(
  config: { messageModelMode?: MessageModelMode | null; themes?: Array<{ id: string; messageModelMode?: MessageModelMode | null }> },
  themeId?: string | null,
): MessageModelMode {
  const theme = themeId ? (config.themes ?? []).find((t) => t.id === themeId) : undefined;
  return theme?.messageModelMode ?? config.messageModelMode ?? "auto";
}

/** Da mensagem pronta só saem os arquivos (o texto já está na resposta ou não vai). */
export function messageModelFilesOnly(mode: MessageModelMode): boolean {
  return mode === "answer" || mode === "combine";
}

/** Como o modelo deve escrever a resposta quando escolhe uma mensagem pronta. */
export function messageModelPromptRule(mode: MessageModelMode): string {
  switch (mode) {
    case "both":
      return "Ela chega ao cliente depois da sua reply, com os anexos. Responda normalmente com os materiais; a mensagem pronta complementa a sua resposta.";
    case "message_model":
      return "Ela chega ao cliente depois da sua reply, com os anexos. Ao usar, a reply deve ser só uma frase curta de introdução: não repita o conteúdo da mensagem pronta nem descreva o anexo.";
    case "answer":
      return "Do que você escolher, só os arquivos (imagem, vídeo, áudio, documento) chegam ao cliente, depois da sua reply; o texto da mensagem pronta não vai. Escreva a resposta completa com os materiais.";
    case "combine":
      return "Ao usar uma, junte o conteúdo dela na sua reply, numa mensagem só, com os mesmos links, números, datas e passos (o texto abaixo é a fonte); os arquivos dela chegam depois da sua reply. Não diga que vai mandar outra mensagem com o texto.";
    default:
      return "Ela chega ao cliente depois da sua reply, com os anexos (imagem, vídeo, áudio, documento). Use quando a mensagem pronta atende ao que o cliente pediu — principalmente quando ele precisa ver algo. Ao usar, a reply deve ser só uma frase curta de introdução: não repita o conteúdo da mensagem pronta nem descreva o anexo.";
  }
}
