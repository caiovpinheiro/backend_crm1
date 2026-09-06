/**
 * Catálogo de códigos de erro da WhatsApp Cloud API (Meta), traduzido para
 * PT-BR com motivo claro + ação recomendada.
 *
 * A Meta recomenda construir a lógica de tratamento em cima do `code`
 * numérico (o texto em `error_data.details` pode mudar). Aqui mapeamos os
 * códigos mais comuns de ENVIO para uma explicação acionável em português,
 * que é prefixada na mensagem persistida (`CampaignRecipient.errorMessage`,
 * `Message.sendError`) para que o operador entenda o motivo sem precisar
 * abrir a documentação.
 *
 * @see https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes
 */
export type MetaErrorInfo = {
  /** Motivo curto e claro do erro. */
  reason: string;
  /** O que o operador/admin deve fazer para resolver. */
  action?: string;
};

/**
 * Códigos transitórios de infra/serviço Meta (downtime, overload, 5xx interno).
 * NÃO confundir com 131047 (fora da janela 24h) nem com 190 (token).
 * Adequados para retry com backoff curto.
 *
 * @see https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes
 */
export const META_TRANSIENT_SERVICE_CODES = new Set([
  1, // API Unknown — possível server error
  2, // API Service — downtime / overloaded (HTTP 503)
  131000, // Something went wrong (erro interno)
  131016, // Serviço temporariamente indisponível
  133004, // Servidor temporariamente indisponível
]);

export function isMetaTransientServiceCode(
  code: number | null | undefined,
): boolean {
  return typeof code === "number" && META_TRANSIENT_SERVICE_CODES.has(code);
}

/**
 * Códigos de NÃO-entrega por elegibilidade — não é falha que o operador
 * consiga "resolver" na conversa, então NÃO devem levar o ticket para a
 * fila Erro. A mensagem continua `failed` na thread (histórico), e o
 * healthcheck do canal continua sendo atualizado separadamente.
 *
 * Diferente de `META_TRANSIENT_SERVICE_CODES`: aquele é sobre retry
 * (downtime/overload); este é sobre "não é um problema acionável na
 * conversa".
 */
export const META_NON_CONVERSATION_ERROR_CODES = new Set([
  131047, // fora da janela 24h — só template reengaja; usuário humano já é
          // bloqueado no composer, então quem gera isso é automação/campanha
  131049, // Meta limitou marketing para preservar engajamento
  131026, // mensagem não entregue ao destinatário (sem WhatsApp / não aceitou termos)
  130472, // número faz parte de experimento da Meta (marketing)
  131050, // destinatário recusou mensagens de marketing (opt-out)
  133010, // conta não existe na Cloud API (número perdido/não registrado)
]);

export function isMetaNonConversationErrorCode(
  code: number | null | undefined,
): boolean {
  return typeof code === "number" && META_NON_CONVERSATION_ERROR_CODES.has(code);
}

const CATALOG: Record<number, MetaErrorInfo> = {
  // ── Genéricos / infra ───────────────────────────────────────
  1: {
    reason: "Erro desconhecido ao enviar pela Meta.",
    action:
      "Tente reenviar. Se persistir, verifique a saúde da conta WhatsApp e o status da Cloud API.",
  },
  2: {
    // Oficial: "Temporary due to downtime or due to being overloaded."
    // O Graph costuma devolver message "Something went wrong" — isso NÃO é
    // janela 24h (131047) nem token inválido (190).
    reason: "Serviço da Meta temporariamente indisponível.",
    action: "Tente novamente em alguns minutos.",
  },
  // ── Autenticação / autorização ──────────────────────────────
  0: {
    reason: "Falha de autenticação com a Meta.",
    action: "Verifique o token de acesso do canal nas configurações.",
  },
  3: {
    reason: "A app não tem permissão para esta ação na Cloud API.",
    action: "Confira as permissões (whatsapp_business_messaging) no app da Meta.",
  },
  10: {
    reason: "Permissão negada pela Meta para esta operação.",
    action: "Revise as permissões e o status do app no Gerenciador de Negócios.",
  },
  190: {
    reason: "Token de acesso expirado ou inválido.",
    action: "Reconecte o canal WhatsApp para gerar um novo token.",
  },
  200: {
    reason: "Permissão de API ausente para enviar mensagens.",
    action: "Adicione a permissão whatsapp_business_messaging ao app.",
  },
  // ── Limites / throttling ────────────────────────────────────
  4: {
    reason: "Limite de requisições da API atingido (rate limit).",
    action: "Reduza a velocidade de envio da campanha e tente novamente.",
  },
  80007: {
    reason: "Limite de taxa da conta WhatsApp Business (WABA) atingido.",
    action: "Aguarde e reduza a velocidade de envio.",
  },
  130429: {
    reason: "Limite de throughput de mensagens atingido (Cloud API).",
    action: "Diminua a velocidade de disparo; o envio será reenfileirado.",
  },
  131048: {
    reason: "Limite de spam atingido — qualidade da conta restringiu envios.",
    action: "Melhore a qualidade das mensagens; aguarde a recuperação do número.",
  },
  131056: {
    reason: "Muitas mensagens para o mesmo destinatário em pouco tempo (pair rate limit).",
    action: "Espace os envios para o mesmo contato.",
  },
  // ── Elegibilidade / billing ─────────────────────────────────
  131042: {
    reason: "Não há método de pagamento configurado na conta WhatsApp Business.",
    action:
      "Adicione um cartão/forma de pagamento no Billing Hub da Meta (Gerenciador de Negócios) para liberar os envios.",
  },
  131031: {
    reason: "Conta WhatsApp Business bloqueada por violação de política.",
    action: "Verifique notificações da Meta e a saúde da conta no Gerenciador.",
  },
  368: {
    reason: "Conta temporariamente bloqueada por violações de política.",
    action: "Aguarde o desbloqueio e revise as políticas da Meta.",
  },
  // ── Entregabilidade / janela 24h ────────────────────────────
  131026: {
    reason: "Mensagem não pôde ser entregue ao destinatário.",
    action:
      "O número pode não ter WhatsApp, não ter aceitado os termos, ou estar inalcançável. Confirme o número.",
  },
  131047: {
    reason: "Fora da janela de 24h — só é possível reengajar com template aprovado.",
    action: "Use uma campanha de template (HSM) aprovado em vez de texto livre.",
  },
  133010: {
    reason: "A conta/número não existe mais na Cloud API da Meta.",
    action:
      "Verifique o registro do número no Gerenciador de Negócios e o healthcheck do canal — este não é um problema da conversa em si.",
  },
  131049: {
    reason:
      "Meta limitou esta mensagem de marketing para preservar o engajamento do ecossistema.",
    action: "Envie menos mensagens de marketing ao mesmo usuário; espace os disparos.",
  },
  130472: {
    reason: "Número do usuário faz parte de um experimento da Meta (marketing).",
    action: "Comportamento esperado em alguns números; tente outro destinatário.",
  },
  131050: {
    reason: "O destinatário recusou mensagens de marketing neste WhatsApp.",
    action:
      "Não reenvie marketing a este número. Use conversa de serviço (janela 24h) ou outro canal.",
  },
  131021: {
    reason: "O destinatário não pode ser o próprio remetente.",
    action: "Use um número de destino diferente do número de envio.",
  },
  // ── Parâmetros / payload ────────────────────────────────────
  100: {
    reason: "Parâmetro inválido na requisição à Meta.",
    action: "Revise o conteúdo/variáveis da mensagem ou template.",
  },
  131008: {
    reason: "Parâmetro obrigatório ausente na requisição.",
    action: "Verifique se todos os campos do template/mensagem foram preenchidos.",
  },
  131009: {
    reason: "Valor de parâmetro inválido.",
    action: "Revise os valores enviados (telefone, variáveis, mídia).",
  },
  131051: {
    reason: "Tipo de mensagem não suportado.",
    action: "Verifique o tipo de conteúdo enviado.",
  },
  131052: {
    reason: "Falha ao baixar a mídia do destinatário.",
    action: "Tente reenviar; verifique a URL/arquivo de mídia.",
  },
  131053: {
    reason: "Falha ao enviar a mídia para a Meta.",
    action: "Verifique o formato/tamanho do arquivo e tente novamente.",
  },
  // ── Templates ───────────────────────────────────────────────
  132000: {
    reason: "Número de variáveis do template não bate com o esperado.",
    action: "Ajuste a quantidade de variáveis para corresponder ao template aprovado.",
  },
  132001: {
    reason: "Este template não está aprovado na WABA deste número WhatsApp.",
    action:
      "Cadastre o template nesse canal ou restrinja os canais do passo. O envio não muda de número.",
  },
  132005: {
    reason: "Texto do template ficou longo demais após preencher as variáveis.",
    action: "Reduza o tamanho do conteúdo das variáveis.",
  },
  132007: {
    reason: "Conteúdo viola a política de templates da Meta.",
    action: "Revise o texto do template conforme as políticas da Meta.",
  },
  132012: {
    reason: "Formato de parâmetro do template incorreto.",
    action: "Confira o formato esperado das variáveis do template.",
  },
  132015: {
    reason: "Template pausado por baixa qualidade.",
    action: "Use outro template ou aguarde a reativação na Meta.",
  },
  132016: {
    reason: "Template desativado por violação de política.",
    action: "Crie/aprove um novo template em conformidade.",
  },
  // ── Infra / temporários ─────────────────────────────────────
  131000: {
    reason: "Erro genérico da Meta ao processar o envio.",
    action: "Tente novamente; se persistir, verifique o fbtrace_id com o suporte.",
  },
  131016: {
    reason: "Serviço da Meta temporariamente indisponível.",
    action: "Tente novamente em alguns minutos.",
  },
  133004: {
    reason: "Servidor da Meta temporariamente indisponível.",
    action: "Tente novamente em alguns minutos.",
  },
  131057: {
    reason: "Conta em manutenção na Meta.",
    action: "Aguarde a manutenção terminar e tente novamente.",
  },
};

/**
 * Retorna a explicação PT-BR de um código de erro da Meta, ou `null` se
 * o código não estiver catalogado.
 */
export function describeMetaError(code: number | null | undefined): MetaErrorInfo | null {
  if (typeof code !== "number") return null;
  return CATALOG[code] ?? null;
}

/**
 * Monta o prefixo human-readable (motivo + ação) para um código de erro.
 * Ex.: "Não há método de pagamento configurado na conta WhatsApp Business.
 *       Adicione um cartão no Billing Hub da Meta..."
 * Retorna string vazia quando o código não está catalogado.
 */
export function metaErrorReason(code: number | null | undefined): string {
  const info = describeMetaError(code);
  if (!info) return "";
  return info.action ? `${info.reason} ${info.action}` : info.reason;
}

/** Extrai o `code N` persistido em `errorMessage` / `sendError`. */
export function extractMetaErrorCode(
  message: string | null | undefined,
): number | null {
  if (!message) return null;
  const labeled =
    message.match(/\bcode\s+(\d+)/i) ?? message.match(/\bc[oó]d\.\s*(\d+)/i);
  if (!labeled) return null;
  const code = Number(labeled[1]);
  return Number.isFinite(code) ? code : null;
}
