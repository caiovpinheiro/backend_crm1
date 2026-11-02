/**
 * Marcas de atendimento gravadas na conversa pelo canal webchat
 * (`lib/webchat/routing.ts`, docs/decisoes/webchat-widget.md §9.12). Só
 * constantes: agente de IA e distribuição leem sem carregar um ao outro.
 */

/**
 * `assignedVia` do atendimento. Mesma proteção do bloco "Atribuir responsável":
 * o inbound não solta esse responsável para a IA nem para a fila. Quem reavalia
 * a pessoa é o próprio atendimento.
 */
export const WEBCHAT_ROUTING_VIA = "webchat_routing";

/** `routeMode`: o atendimento mandou para pessoas; a IA não assume. */
export const HUMAN_ROUTE_MODE = "human";
