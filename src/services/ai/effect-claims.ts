/**
 * Auditoria determinística de efeito afirmado.
 *
 * O modelo dizia ao cliente "já te passei para um consultor" enquanto
 * `execute_distribution` tinha devolvido `assigned: false`. Instrução no
 * system prompt não resolve isso — o modelo não é confiável para relatar o
 * próprio sucesso. Aqui comparamos o TEXTO com o RESULTADO real das tools
 * de efeito e barramos a mensagem quando ela afirma algo que não aconteceu.
 *
 * Só olha tools que mudam o mundo. Consulta (`consultar_matricula`,
 * `search_products`) não entra: afirmar que consultou não engana ninguém.
 */

export type EffectKind =
  | "transfer"
  | "deal_created"
  | "stage_moved"
  | "template_sent"
  | "conversation_closed";

export const EFFECT_TOOLS: Record<string, EffectKind> = {
  execute_distribution: "transfer",
  transfer_to_human: "transfer",
  transfer_to_department: "transfer",
  create_deal: "deal_created",
  move_stage: "stage_moved",
  send_whatsapp_template: "template_sent",
  close_conversation: "conversation_closed",
};

/**
 * Mensagem usada quando a resposta é descartada. Não promete nada e devolve
 * a palavra ao cliente. (Parametrizar isso na pilotagem é trabalho à parte —
 * hoje não existe campo para essa copy.)
 */
export const NEUTRAL_EFFECT_FALLBACK =
  "Ainda não consegui concluir isso por aqui. Me conta com um pouco mais de detalhe o que você precisa que eu sigo te ajudando.";

/** Minúsculas, sem acento — deixa os padrões abaixo legíveis. */
function fold(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

/**
 * O efeito prometido ao cliente aconteceu de verdade?
 *
 * `ok: true` sozinho não basta: `execute_distribution` devolve `ok` mesmo
 * quando ninguém foi atribuído (é resultado de negócio, não erro), e
 * `transfer_to_department` apenas roteia o departamento — não coloca humano
 * nenhum na conversa.
 */
export function effectToolSucceeded(
  toolName: string,
  result: unknown,
): boolean {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return false;
  }
  const r = result as Record<string, unknown>;
  if (r.ok !== true) return false;
  switch (toolName) {
    case "execute_distribution":
    case "transfer_to_human":
      // `assigned` = consultor na conversa. `queuedWaiting` = o handoff
      // rodou, a conversa saiu da IA e o cliente está na fila — aí "já
      // registrei seu pedido" é verdade. `assigned: false` sem fila é a
      // promessa vazia que o aluno recebeu sete vezes.
      return r.assigned === true || r.queuedWaiting === true;
    case "transfer_to_department":
      return false;
    case "create_deal":
      return typeof r.dealId === "string" && r.dealId.length > 0;
    case "move_stage":
      return typeof r.stageId === "string" && r.stageId.length > 0;
    case "send_whatsapp_template":
      return typeof r.externalId === "string" && r.externalId.length > 0;
    case "close_conversation":
      return r.closed === true;
    default:
      return false;
  }
}

const CLAIM_PATTERNS: Record<EffectKind, RegExp[]> = {
  transfer: [
    /\b(vou|irei|ja vou)\s+(te\s+)?(transferir|passar|conectar|encaminhar|direcionar)/,
    /\bja\s+(te\s+)?(transferi|passei|conectei|encaminhei|direcionei)/,
    /\bja\s+(registrei|iniciei|pedi|chamei|acionei|solicitei)\b[^.!?]{0,60}\b(consultor|consultora|atendente|humano|equipe|setor|departamento|secretaria)/,
    /\b(voce|vc)\s+(ja\s+)?esta\s+(na\s+)?fila\b/,
    /\b(um|uma)\s+(consultor|consultora|atendente)\s+(vai|ira|já vai)\s+(te\s+)?(atender|falar|continuar|assumir)/,
    /\bte\s+(passei|passo|coloquei)\s+(para|pro|pra)\b/,
    /\bseu (pedido|atendimento) (ja )?(esta|foi) (com|encaminhad|transferid)/,
  ],
  deal_created: [
    /\bja\s+(criei|abri|registrei)\b[^.!?]{0,40}\b(negocio|oportunidade|proposta|cadastro)/,
  ],
  stage_moved: [
    /\bja\s+(movi|atualizei|mudei)\b[^.!?]{0,40}\b(etapa|estagio|fase|funil)/,
  ],
  template_sent: [
    /\bja\s+(te\s+)?(enviei|mandei)\b[^.!?]{0,40}\b(mensagem|template|link|formulario)/,
  ],
  conversation_closed: [
    /\b(vou|irei)\s+encerrar\s+(o\s+)?(atendimento|conversa)/,
    /\b(atendimento|conversa)\s+(foi\s+)?encerrad[ao]\b/,
  ],
};

export type EffectClaimAudit = {
  /// A resposta afirma efeito que não aconteceu.
  blocked: boolean;
  /// Efeitos afirmados sem ferramenta bem-sucedida.
  unsupported: EffectKind[];
  /// Efeitos que de fato aconteceram neste run.
  achieved: EffectKind[];
};

export function auditEffectClaims(input: {
  text: string;
  toolCalls: Array<{ toolName: string; result?: unknown }>;
}): EffectClaimAudit {
  const achieved = new Set<EffectKind>();
  for (const call of input.toolCalls) {
    const kind = EFFECT_TOOLS[call.toolName];
    if (!kind) continue;
    if (effectToolSucceeded(call.toolName, call.result)) achieved.add(kind);
  }

  const folded = fold(input.text ?? "");
  const unsupported: EffectKind[] = [];
  for (const [kind, patterns] of Object.entries(CLAIM_PATTERNS) as Array<
    [EffectKind, RegExp[]]
  >) {
    if (achieved.has(kind)) continue;
    if (patterns.some((p) => p.test(folded))) unsupported.push(kind);
  }

  return {
    blocked: unsupported.length > 0,
    unsupported,
    achieved: [...achieved],
  };
}
