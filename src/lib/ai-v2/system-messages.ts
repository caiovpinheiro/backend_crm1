/**
 * Mensagens que o próprio motor escreve ao cliente (não o modelo): aviso de
 * fila, material já enviado, reenvio de anexo, pedido de atendente sem
 * assunto… Cada empresa pode trocar o texto em "Mensagens automáticas";
 * vazio usa o padrão abaixo. Nenhum domínio de cliente.
 *
 * Marcadores aceitos: {{anexo}} ("o vídeo", "a imagem", "o arquivo") e
 * {{Anexo}} (o mesmo com inicial maiúscula); {{pergunta}} (a última pergunta
 * do agente, na mensagem de "não fui claro").
 */

export const SYSTEM_MESSAGE_DEFAULTS = {
  materialAlreadySent: "Te enviei esse material logo acima 👆 Se ficou alguma dúvida ou algo não funcionou, me conta que eu te ajudo.",
  attachmentAbove: "O arquivo que mencionei já está logo acima na conversa 👆",
  mediaResent: "Reenviei {{anexo}} agora 👇 Se não aparecer, me avisa.",
  mediaResentAfterFailure: "{{Anexo}} não saiu da primeira vez. Estou reenviando agora 👇 Se não chegar, me avisa que eu chamo alguém da equipe.",
  mediaCannotSend: "Não estou conseguindo enviar {{anexo}} por aqui. Vou chamar alguém da equipe para te mandar por outro caminho.",
  mediaNotArriving: "Já enviei {{anexo}} duas vezes e ele não está chegando aí. Vou chamar alguém da equipe para te mandar por outro caminho.",
  humanRequestAsk: "Claro! Antes de te passar para a equipe, me conta em uma frase o que você precisa, para eu encaminhar certo.",
  triedAndFailedHandoff: "Entendi que você já tentou e não deu certo. Vou passar para alguém da equipe olhar isso com você, com o que já conversamos aqui.",
  returnPromiseHandoff: "Preciso passar isso para um atendente da equipe que vai te ajudar agora.",
  loopWarning: "Recebi a mesma mensagem algumas vezes. Se precisar de algo diferente, me conta com outras palavras.",
  identificationRetry: "Não encontrei um e-mail ou documento na sua mensagem. Pode me enviar o e-mail ou o documento usado no cadastro?",
  queueOutsideHours: "Você já está na fila de atendimento. Sua mensagem fica registrada e alguém da equipe continua com você por aqui no próximo horário de atendimento.",
  queueCancel: "",
  queueUpset: "",
  queueCall: "",
  queueAgain: "",
  repeatAfterAnswer: "Ficou alguma dúvida sobre o que te passei? Me conta o que não ficou claro que eu explico de outro jeito.",
  stillHere: "Estou por aqui! Me conta o que você precisa que eu te ajudo.",
  confusionRephrase: "Desculpa, acho que não fui claro. {{pergunta}}",
  confusionAsk: "Desculpa, acho que não fui claro. O que ficou confuso? Me conta que eu explico de outro jeito.",
  optionsPrompt: "Escolha uma opção:",
  optionsButton: "Ver opções",
  deferralReply: "Combinado! Quando puder, é só me chamar por aqui. 😊",
} as const;

export type SystemMessageKey = keyof typeof SYSTEM_MESSAGE_DEFAULTS;

export type SystemMessages = Partial<Record<SystemMessageKey, string>>;

export const SYSTEM_MESSAGE_KEYS = Object.keys(SYSTEM_MESSAGE_DEFAULTS) as SystemMessageKey[];

/** Texto configurado pela empresa ou o padrão, com os marcadores preenchidos. */
export function systemMessage(
  config: { systemMessages?: SystemMessages | null } | null | undefined,
  key: SystemMessageKey,
  vars: Record<string, string> = {},
): string {
  const custom = config?.systemMessages?.[key]?.trim();
  const text = custom || SYSTEM_MESSAGE_DEFAULTS[key];
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (all, name: string) => vars[name] ?? all);
}

/** Só o texto que a empresa escreveu (vazio quando usa o padrão). */
export function customSystemMessage(
  config: { systemMessages?: SystemMessages | null } | null | undefined,
  key: SystemMessageKey,
): string {
  return config?.systemMessages?.[key]?.trim() ?? "";
}
