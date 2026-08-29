/**
 * Labels pt-BR dos tipos de step de automação. Compartilhado pelas rotas
 * que expõem "robôs em execução" (inbox/deal) sem importar o executor
 * inteiro, que carrega BullMQ/Meta client como side effect.
 */
export const STEP_LABELS: Record<string, string> = {
  send_email: "Enviando e-mail",
  move_stage: "Movendo estágio",
  assign_owner: "Atribuindo responsável",
  add_tag: "Adicionando tag",
  remove_tag: "Removendo tag",
  update_field: "Atualizando campo",
  create_activity: "Criando atividade",
  send_whatsapp_message: "Enviando mensagem",
  send_whatsapp_template: "Enviando template",
  send_whatsapp_media: "Enviando mídia",
  send_whatsapp_interactive: "Aguardando escolha do lead",
  send_whatsapp_list: "Aguardando escolha do lead",
  send_whatsapp_flow: "Aguardando formulário do lead",
  send_product: "Enviando produto",
  webhook: "Chamando webhook",
  delay: "Em espera (atraso)",
  condition: "Avaliando condição",
  update_lead_score: "Atualizando lead score",
  question: "Aguardando resposta do lead",
  wait_for_reply: "Aguardando resposta do lead",
  set_variable: "Definindo variável",
  goto: "Redirecionando fluxo",
  finish: "Finalizando",
  create_deal: "Criando negócio",
  finish_conversation: "Encerrando conversa",
  tabulate_conversation: "Tabulando conversa",
  business_hours: "Verificando horário",
  check_agent_status: "Verificando status do agente",
  execute_distribution: "Distribuindo lead",
};

const SEND_TYPES_THAT_PAUSE = new Set([
  "send_whatsapp_message",
  "send_whatsapp_template",
  "send_whatsapp_media",
]);

/** Rótulo do passo atual no painel de robôs. Envio com cronômetro = espera. */
export function labelForActiveStep(
  type: string,
  timeoutAt: Date | string | null,
): string {
  if (timeoutAt && SEND_TYPES_THAT_PAUSE.has(type)) {
    return "Aguardando resposta do lead";
  }
  return STEP_LABELS[type] ?? type;
}
