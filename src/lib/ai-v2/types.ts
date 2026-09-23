/**
 * Tipos canônicos do motor v2 de agentes de IA.
 * Nenhum domínio de cliente aqui: nomes genéricos e configuração declarativa.
 */

export type V2Owner = "pessoa" | "automation" | "agente" | "ninguem";

export type V2Stage =
  | "idle"
  | "confirming"
  | "identifying"
  | "active"
  | "closed";

export type V2CloseReason =
  | "resolved"
  | "inactivity"
  | "transferred"
  | "human_closed"
  | "automation_closed"
  | "out_of_scope";

export type V2MediaAction = "transcribe" | "ask_text" | "handoff" | "describe";

export type V2FieldPermission = "read" | "cite" | "write";

export type V2Flow = "reception" | "full" | "onboarding";

export type V2AutonomyMode = "auto" | "suggest";

export type V2Sentiment = "neutral" | "dissatisfied" | "angry";

export type V2SurveyType = "nps" | "csat" | "binary";

export interface V2FieldConfig {
  key: string;
  label?: string;
  permissions: V2FieldPermission[];
}

export interface V2Variable {
  key: string;
  value: string;
}

export interface V2FallbackConfig {
  unknown?: {
    message?: string;
    action?: "handoff" | "silence";
    retries?: number;
  };
  humanRequest?: { message?: string };
  noSource?: { message?: string };
  error?: { message?: string };
}

export interface V2ScopeConfig {
  message?: string;
  onInsist?: "handoff" | "close";
  forbidden?: { subject: string; destination?: V2Destination }[];
}

export interface V2InactivityConfig {
  enabled?: boolean;
  nudgeAfter?: number;
  nudgeMessage?: string;
  closeAfter?: number;
}

export interface V2TabulationConfig {
  enabled?: boolean;
  when?: "on_close" | "on_transfer" | "always";
  required?: boolean;
  fallbackId?: string;
  byTheme?: Record<string, string>;
  mode?: "suggest" | "require";
}

export interface V2Destination {
  type: "department" | "distribution_rule" | "user" | "ai_agent" | "automation";
  id?: string;
  /** Mensagem específica deste destino; se omitida, usa a mensagem padrão. */
  message?: string;
}

export interface V2ProductPolicy {
  enabled: boolean;
  maxItems: number;
  showPrice: boolean;
  showConditions: boolean;
  showImage: boolean;
  showLink: boolean;
  /** Campos do produto que podem ser citados. */
  citableFields: string[];
  /** IDs de produtos específicos permitidos. Vazio = todos ativos. */
  allowedProductIds: string[];
  /** Filtros fixos de categoria/ativo/etc. */
  filter?: Record<string, string>;
  /** IDs de ações ligadas ao produto permitidas no tema. */
  actions?: string[];
}

export interface V2Theme {
  id: string;
  name: string;
  /** Palavras-chave ou frases que indicam este tema. */
  when: string[];
  /** Exemplos de mensagens do cliente para o tema. */
  examples: string[];
  /** Instruções específicas quando o tema está ativo. */
  instructions: string;
  /** IDs das tools permitidas neste tema. */
  allowedTools: string[];
  /** IDs dos knowledge docs permitidos neste tema. */
  allowedKnowledgeDocIds: string[];
  /** IDs dos modelos de mensagem permitidos neste tema. */
  allowedMessageModelIds: string[];
  /** Política de produtos para este tema. Desligada por padrão. */
  productPolicy: V2ProductPolicy;
  /** Destino de handoff padrão deste tema. */
  handoffDestination?: V2Destination;
  /** Tabulação sugerida ao encerrar/transferir por este tema. */
  tabulationId?: string;
  /** Máximo de turnos neste tema antes de handoff (0 = sem limite). */
  maxTurns?: number;
  /** IDs dos documentos de conhecimento permitidos neste tema. */
  knowledgeDocIds?: string[];
  /** IDs dos modelos de mensagem permitidos neste tema. */
  messageModelIds?: string[];
  /** Quem responde neste tema: "self" ou id de outro agente de IA. */
  answerBy?: "self" | string;
}

export type V2RuleConditionType =
  | "message_type"
  | "keywords"
  | "contact_tag"
  | "first_message"
  | "out_of_hours"
  | "deal_stage"
  | "field_equals"
  | "no_deal"
  | "survey_received"
  | "media_kind";

export interface V2RuleCondition {
  type: V2RuleConditionType;
  /** Palavras-chave, tags, nomes de campo, tipos de mídia etc. */
  values?: string[];
  /** Para field_equals: nome do campo. */
  field?: string;
  /** Para field_equals: valor esperado. */
  expected?: string;
  /** Se true, a condição é satisfeita quando o valor NÃO casa. */
  negate?: boolean;
}

export type V2RuleActionType =
  | "send_message"
  | "set_theme"
  | "handoff"
  | "add_tag"
  | "close_conversation"
  | "no_reply"
  | "send_message_model"
  | "send_whatsapp_template"
  | "set_variable"
  | "record_knowledge_gap";

export interface V2RuleAction {
  type: V2RuleActionType;
  /** Mensagem a enviar (send_message) ou id do modelo/template. */
  message?: string;
  themeId?: string;
  destination?: V2Destination;
  tag?: string;
  variable?: { key: string; value: string };
  /** Id do modelo de mensagem/template. */
  modelId?: string;
}

export interface V2Rule {
  id: string;
  name: string;
  /** Ordem de avaliação. */
  order: number;
  conditions: V2RuleCondition[];
  actions: V2RuleAction[];
}

export interface V2EntryConfig {
  /** Se a mensagem de abertura está habilitada. */
  openingEnabled?: boolean;
  /** Mensagem de abertura na primeira mensagem do cliente. */
  openingMessage?: string;
  /** Mensagem de confirmação após encontrar o negócio. */
  confirmationMessage?: string;
  /** Mensagem pedindo identificação quando não encontra negócio. */
  identificationMessage?: string;
  /** O que fazer quando não encontra negócio. */
  onDealNotFound: "ask_identification" | "create_deal" | "handoff";
  /** Se deve confirmar identidade antes de atender. */
  confirmContact: boolean;
  /** Campos usados para confirmar o cadastro. */
  confirmationFields: string[];
  /** Como entregar a confirmação em relação às boas-vindas. */
  confirmationMode?: "combined" | "separate_turn";
  /** Mapeamento variável da automação → variável do agente. */
  automationVariablesMapping: Record<string, string>;
  /** Máximo de tentativas de identificação antes de transferir. */
  maxAttempts?: number;
}

export interface V2HandoffConfig {
  /** Destino padrão quando nenhum tema/regra define outro. */
  defaultDestination: V2Destination;
  /** Mensagem padrão de handoff. */
  message: string;
  /** Palavras-chave que disparam pedido de humano. */
  humanRequestKeywords: string[];
}

export type V2PostCloseCaseBehavior =
  | "no_reply"
  | "short_reply"
  | "reopen_and_route"
  | "ask_with_options";

export interface V2ClosureConfig {
  /** Janela pós-encerramento em horas (padrão 6). */
  postCloseWindowHours: number;
  /** Comportamento quando a mensagem é cortesia/despedida. */
  courtesyBehavior: V2PostCloseCaseBehavior;
  /** Comportamento quando é nova demanda. */
  newDemandBehavior: V2PostCloseCaseBehavior;
  /** Comportamento quando é ambíguo. */
  ambiguousBehavior: V2PostCloseCaseBehavior;
  /** Mensagem de despedida ao encerrar. */
  goodbyeMessage?: string;
  /** Se deve devolver o card à etapa de origem ao fechar. */
  returnToOriginStage: boolean;
  /** Step da automação para continuar ao encerrar, se houver. */
  nextAutomationStepId?: string;
  /** Campos do contato/negócio a atualizar automaticamente ao encerrar. */
  fieldUpdates?: Array<{ entity: "contact" | "deal"; key: string; value: string }>;
}

export interface V2LimitsConfig {
  /** Máximo de respostas a cortesia por atendimento. */
  maxCourtesyReplies: number;
  /** Máximo de ofertas de ajuda adicionais. */
  maxHelpOffers: number;
  /** Máximo de trocas sem avanço antes de ação. */
  maxStalledExchanges: number;
  /** Ação após trocas sem avanço. */
  stalledExchangesAction: "handoff" | "close";
  /** Limite de mensagens seguidas sem sentido. */
  nonsenseLimit: number;
  /** Ação após mensagens sem sentido. */
  nonsenseAction: "warn_and_silence" | "handoff";
  /** Minutos de silêncio temporário. */
  silenceMinutes: number;
  /** Janela de minutos para detectar loop. */
  loopDetectionWindowMinutes: number;
  /** Máximo de repetições considerado loop. */
  maxLoopCount: number;
  /** Máximo de transferências entre agentes de IA antes de ir para uma pessoa. */
  maxAiTransfers: number;
}

export interface V2BusinessHoursSlot {
  /// 0=Dom, 1=Seg, … 6=Sáb.
  day: number;
  /// "HH:mm" 24h.
  start: string;
  end: string;
}

export interface V2BusinessHoursConfig {
  enabled: boolean;
  timezone: string;
  weekdays: V2BusinessHoursSlot[];
  offHoursMessage?: string;
  /** Ação quando chega mensagem fora do horário. */
  outsideAction?: "message" | "handoff" | "silence";
}

export interface V2MediaKindConfig {
  action: V2MediaAction;
  askTextMessage?: string;
  handoffMessage?: string;
  /** Mensagem quando não conseguiu entender a mídia. */
  notUnderstoodMessage?: string;
}

export interface V2MediaConfig {
  audio: V2MediaKindConfig;
  image: V2MediaKindConfig;
  document: V2MediaKindConfig;
  /** Perguntar se entendeu antes de agir. */
  confirmUnderstanding: boolean;
  maxDurationSeconds?: number;
  maxSizeBytes?: number;
}

export interface V2SentimentConfig {
  enabled: boolean;
  threshold: "any" | "dissatisfied" | "angry";
  action: "handoff" | "notify_and_continue" | "log_only";
  /** Usuário a notificar quando action = notify. */
  notifyUserId?: string;
}

export interface V2SurveyConfig {
  enabled: boolean;
  type: V2SurveyType;
  when: "immediate" | "after_hours" | "next_day";
  question: string;
  askReason: boolean;
  /** Frequência máxima em dias por cliente. */
  maxFrequencyDays: number;
}

export interface V2OnboardingStepCompletion {
  type: "field_filled" | "client_reply" | "stage" | "action";
  field?: string;
  value?: string;
  action?: string;
}

export interface V2OnboardingStep {
  id: string;
  name: string;
  goal: string;
  openingMessage?: string;
  collectFields: string[];
  completionCriteria: V2OnboardingStepCompletion;
  allowedTools: string[];
  knowledgeDocIds: string[];
  messageModelIds: string[];
  handoffOnStuck: V2Destination;
  maxAttempts: number;
  reminderHours: number;
}

export interface V2OnboardingConfig {
  steps: V2OnboardingStep[];
  /** O que fazer quando o cadastro está vazio/incompleto. */
  onEmptyDeal: "ask" | "generic" | "handoff";
  /** Mostrar progresso por cliente na UI. */
  trackProgress: boolean;
  /** Ações ao concluir todas as etapas. */
  finalActions: V2Action[];
  /** Agente para entregar ao concluir. */
  deliveryAgentId?: string;
}

export interface V2CostCap {
  maxUsdPerDay: number;
  maxUsdPerMonth: number;
  /** Ação ao estourar: apenas handoff por enquanto. */
  action: "handoff";
}

export interface V2AgentConfig {
  name: string;
  flow: V2Flow;
  /** IDs dos canais vinculados. */
  channelIds: string[];
  /** Modelo da OpenAI. */
  model: string;
  /** Preset de temperatura. */
  responseBehavior: "objective" | "balanced" | "natural" | "creative";
  /** Tom de voz / persona. */
  tone: string;
  /** Regras globais. */
  globalRules: string[];
  /** Variáveis fixas da empresa (@Nome, @Link etc). */
  variables: V2Variable[];
  /** Campos do contato e negócio com permissões. */
  contextFields: {
    contact: V2FieldConfig[];
    deal: V2FieldConfig[];
  };
  /** Como escolher o negócio quando há mais de um aberto. */
  dealSelection: "latest" | "ask";
  entry: V2EntryConfig;
  themes: V2Theme[];
  rules: V2Rule[];
  handoff: V2HandoffConfig;
  closure: V2ClosureConfig;
  limits: V2LimitsConfig;
  media: V2MediaConfig;
  /** Política global de produtos; pode ser sobrescrita por tema. */
  productPolicy?: V2ProductPolicy;
  sentiment: V2SentimentConfig;
  survey: V2SurveyConfig;
  onboarding?: V2OnboardingConfig;
  /** Domínios cujos links podem aparecer nas respostas. */
  allowedDomains: string[];
  autonomyMode: V2AutonomyMode;
  /** Mostra “digitando…” no WhatsApp antes de enviar. */
  simulateTyping?: boolean;
  /** Milissegundos por caractere no indicador de digitação. */
  typingPerCharMs?: number;
  /** Marca a mensagem recebida como lida (✔✔ azul) antes de responder. */
  markMessagesRead?: boolean;
  costCap?: V2CostCap;
  dailyTokenCap?: number;
  /** Tools habilitadas globalmente (usadas quando o tema não restringe). */
  enabledTools?: string[];
  /** Limites de chamadas de ferramenta por turno. */
  toolGovernor?: V2ToolGovernorConfig;
  /** Horário de atendimento do agente. */
  businessHours?: V2BusinessHoursConfig | null;
  /** IDs globais dos documentos de conhecimento permitidos. */
  allowedKnowledgeDocIds?: string[];
  /** IDs globais dos modelos de mensagem permitidos. */
  allowedMessageModelIds?: string[];
  /** Telefones permitidos para resposta em modo de teste. Vazio = responde qualquer número. */
  allowedPhoneNumbers?: string[];
  /** Tamanho preferido das respostas. */
  responseLength?: "short" | "medium" | "long";
  /** Saídas quando o agente não soube, pediu pessoa, sem material ou deu erro. */
  fallback?: V2FallbackConfig;
  /** Fora do escopo / assuntos proibidos. */
  scope?: V2ScopeConfig;
  /** Inatividade do cliente. */
  inactivity?: V2InactivityConfig;
  /** Tabulação ao encerrar/transferir. */
  tabulation?: V2TabulationConfig;
}

export interface V2ToolGovernorConfig {
  maxCallsPerTurn: number;
  maxRepeatsPerTool: number;
}

/** Ação estruturada executada pelo motor (não confundir com V2RuleAction, que é config). */
export type V2ActionType =
  | "add_tag"
  | "update_field"
  | "add_note"
  | "create_deal"
  | "move_stage"
  | "create_activity"
  | "send_message_model"
  | "send_product"
  | "send_whatsapp_template"
  | "ask_with_options"
  | "close_conversation"
  | "tabulate_conversation"
  | "handoff"
  | "set_theme"
  | "set_variable"
  | "record_knowledge_gap"
  | "start_survey"
  | "send_message"
  | "no_reply";

export interface V2Action {
  type: V2ActionType;
  [key: string]: unknown;
}

export interface V2LLMOutput {
  reply: string;
  theme?: string;
  messageModel?: {
    id: string;
    adapt?: boolean;
    variables?: Record<string, string>;
  };
  handoff: boolean;
  concluded: boolean;
  confirmed: boolean | null;
  outOfScope: boolean;
  sentiment: V2Sentiment;
  tabulationId?: string;
  collected: Record<string, string>;
  reason: string;
  actions: V2Action[];
}

export interface V2TurnContext {
  organizationId: string;
  agentId: string;
  conversationId: string;
  contactId?: string;
  dealId?: string;
  channel: string;
  userMessage: string;
  messageType?: string;
  turnId?: string;
  /** Variáveis injetadas pela automação (já mapeadas). */
  automationVariables: Record<string, string>;
}

export interface V2CRMContext {
  contact: Record<string, unknown> | null;
  /// Campos do contato com chaves técnicas (para renderização de variáveis como @contact.name).
  contactRaw?: Record<string, unknown> | null;
  /// Campos do contato que o agente pode citar na resposta ao cliente.
  citableContact?: Record<string, unknown> | null;
  deals: Array<Record<string, unknown>>;
  selectedDeal: Record<string, unknown> | null;
  /// Campos do negócio selecionado com chaves técnicas (para variáveis como @deal.title).
  selectedDealRaw?: Record<string, unknown> | null;
  /// Campos do negócio selecionado que o agente pode citar na resposta.
  citableDeal?: Record<string, unknown> | null;
  fields: {
    contact: V2FieldConfig[];
    deal: V2FieldConfig[];
  };
  dealSelectionReason?: string;
}

export interface V2PendingInteractiveOption {
  id: string;
  label: string;
  target: V2Action;
}

export interface V2TraceEntry {
  turnId?: string;
  timestamp: string;
  owner: V2Owner;
  stage: V2Stage;
  themeId?: string;
  appliedRuleId?: string;
  crmSnapshot: V2CRMContext;
  prompt: string;
  llmOutput?: V2LLMOutput;
  executedActions: V2Action[];
  discardedActions: V2Action[];
  reply?: string;
  handoff: boolean;
  error?: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}
