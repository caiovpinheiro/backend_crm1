import { z } from "zod";

export const SUPPORTED_V2_MODELS = [
  { id: "gpt-4o-mini", label: "GPT-4o mini" },
  { id: "gpt-4o", label: "GPT-4o" },
  { id: "gpt-4-turbo", label: "GPT-4 Turbo" },
  { id: "gpt-3.5-turbo", label: "GPT-3.5 Turbo" },
] as const;

import type {
  V2AgentConfig,
  V2Destination,
  V2ProductPolicy,
  V2Sentiment,
  V2SurveyType,
} from "./types";

/**
 * Texto que a tela grava vazio ("") quando a pessoa apaga o campo. Vazio
 * vale como "não preenchido": sem isto, `mensagem ?? padrão` mandava
 * mensagem em branco e o cliente era transferido ou questionado sem texto.
 */
const optionalText = z.preprocess(
  (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
  z.string().optional(),
);

const destinationSchema = z.object({
  type: z.enum(["department", "distribution_rule", "user", "ai_agent", "automation"]),
  id: z.string().optional(),
  message: optionalText,
});

const productPolicySchema = z.object({
  enabled: z.boolean(),
  maxItems: z.number().int().min(1).max(10).optional().default(3),
  showPrice: z.boolean().optional().default(false),
  showConditions: z.boolean().optional().default(false),
  showImage: z.boolean().optional().default(false),
  showLink: z.boolean().optional().default(false),
  citableFields: z.array(z.string()).optional().default([]),
  allowedProductIds: z.array(z.string()).optional().default([]),
  filter: z.record(z.string(), z.string()).optional(),
  actions: z.array(z.string()).optional().default([]),
});

const fieldConfigSchema = z.object({
  key: z.string(),
  label: z.string().optional(),
  permissions: z.array(z.enum(["read", "cite", "write"])).optional().default(["read"]),
});

const themeSchema = z.object({
  id: z.string(),
  name: z.string(),
  when: z.array(z.string()).optional().default([]),
  examples: z.array(z.string()).optional().default([]),
  instructions: z.string(),
  allowedTools: z.array(z.string()).optional().default([]),
  allowedKnowledgeDocIds: z.array(z.string()).optional().default([]),
  allowedMessageModelIds: z.array(z.string()).optional().default([]),
  knowledgeDocIds: z.array(z.string()).optional().default([]),
  messageModelIds: z.array(z.string()).optional().default([]),
  productPolicy: productPolicySchema.optional().default({
    enabled: false,
    maxItems: 3,
    showPrice: false,
    showConditions: false,
    showImage: false,
    showLink: false,
    citableFields: [],
    allowedProductIds: [],
    actions: [],
  } as any),
  handoffDestination: destinationSchema.optional(),
  // A tela tinha o botão, mas o schema descartava o valor ao salvar.
  directHandoff: z.boolean().optional().default(false),
  tabulationId: z.string().optional(),
  maxTurns: z.number().int().min(0).optional(),
  answerBy: z.enum(["self"]).or(z.string()).optional().default("self"),
});

const ruleConditionSchema = z.object({
  type: z.enum([
    "message_type",
    "keywords",
    "contact_tag",
    "first_message",
    "out_of_hours",
    "deal_stage",
    "field_equals",
    "no_deal",
    "survey_received",
    "media_kind",
  ]),
  values: z.array(z.string()).optional().default([]),
  field: z.string().optional(),
  expected: z.string().optional(),
  negate: z.boolean().optional(),
});

const ruleActionSchema = z.object({
  type: z.enum([
    "send_message",
    "set_theme",
    "handoff",
    "add_tag",
    "close_conversation",
    "no_reply",
    "send_message_model",
    "send_whatsapp_template",
    "set_variable",
    "record_knowledge_gap",
  ]),
  message: optionalText,
  themeId: z.string().optional(),
  destination: destinationSchema.optional(),
  tag: z.string().optional(),
  variable: z
    .object({ key: z.string(), value: z.string() })
    .optional(),
  modelId: z.string().optional(),
});

const ruleSchema = z.object({
  id: z.string(),
  name: z.string(),
  order: z.number().int().min(0).optional().default(0),
  // A tela liga/desliga a regra; sem o campo no schema o valor sumia ao
  // salvar e a regra desligada continuava rodando.
  enabled: z.boolean().optional().default(true),
  conditions: z.array(ruleConditionSchema).optional().default([]),
  actions: z.array(ruleActionSchema).optional().default([]),
});

const fallbackSchema = z.object({
  unknown: z.object({
    message: optionalText,
    action: z.enum(["handoff", "silence"]).optional(),
    retries: z.number().int().min(0).optional(),
  }).optional(),
  humanRequest: z.object({ message: optionalText }).optional(),
  noSource: z.object({ message: optionalText }).optional(),
  error: z.object({ message: optionalText }).optional(),
}).optional();

const scopeSchema = z.object({
  message: optionalText,
  onInsist: z.enum(["handoff", "close"]).optional(),
  forbidden: z.array(z.object({
    subject: z.string(),
    destination: destinationSchema.optional(),
  })).optional().default([]),
}).optional();

const inactivitySchema = z.object({
  enabled: z.boolean().optional().default(false),
  nudgeAfter: z.number().int().min(0).optional().default(30),
  nudgeMessage: optionalText,
  closeAfter: z.number().int().min(0).optional().default(1440),
}).optional();

const tabulationSchema = z.object({
  enabled: z.boolean().optional().default(false),
  when: z.enum(["on_close", "on_transfer", "always"]).optional().default("on_close"),
  required: z.boolean().optional().default(false),
  fallbackId: z.string().optional(),
  byTheme: z.record(z.string(), z.string()).optional().default({}),
  mode: z.enum(["suggest", "require"]).optional().default("suggest"),
}).optional();

const entryConfigSchema = z.object({
  openingEnabled: z.boolean().optional().default(true),
  openingMessage: optionalText,
  confirmationMessage: optionalText,
  identificationMessage: optionalText,
  onDealNotFound: z.enum(["ask_identification", "create_deal", "handoff"]).optional().default("ask_identification"),
  confirmContact: z.boolean().optional().default(true),
  confirmationFields: z.array(z.string()).optional().default([]),
  confirmationMode: z.enum(["combined", "separate_turn"]).optional().default("combined"),
  automationVariablesMapping: z.record(z.string(), z.string()).optional().default({}),
  maxAttempts: z.number().int().min(1).optional().default(2),
});

const closureConfigSchema = z.object({
  postCloseWindowHours: z.number().min(0).optional().default(6),
  courtesyBehavior: z.enum(["no_reply", "short_reply", "reopen_and_route", "ask_with_options"]).optional().default("no_reply"),
  newDemandBehavior: z.enum(["no_reply", "short_reply", "reopen_and_route", "ask_with_options"]).optional().default("reopen_and_route"),
  ambiguousBehavior: z.enum(["no_reply", "short_reply", "reopen_and_route", "ask_with_options"]).optional().default("ask_with_options"),
  goodbyeMessage: optionalText,
  returnToOriginStage: z.boolean().optional().default(true),
  nextAutomationStepId: z.string().optional(),
  fieldUpdates: z
    .array(z.object({ entity: z.enum(["contact", "deal"]), key: z.string(), value: z.string() }))
    .optional()
    .default([]),
});

const limitsConfigSchema = z.object({
  maxCourtesyReplies: z.number().int().min(0).optional().default(1),
  maxHelpOffers: z.number().int().min(0).optional().default(1),
  maxStalledExchanges: z.number().int().min(0).optional().default(2),
  stalledExchangesAction: z.enum(["handoff", "close"]).optional().default("handoff"),
  nonsenseLimit: z.number().int().min(0).optional().default(3),
  nonsenseAction: z.enum(["warn_and_silence", "handoff"]).optional().default("warn_and_silence"),
  silenceMinutes: z.number().int().min(0).optional().default(30),
  loopDetectionWindowMinutes: z.number().int().min(0).optional().default(60),
  maxLoopCount: z.number().int().min(0).optional().default(3),
  maxAiTransfers: z.number().int().min(0).optional().default(3),
});

const mediaKindConfigSchema = z.object({
  action: z.enum(["transcribe", "ask_text", "handoff", "describe"]),
  askTextMessage: optionalText,
  handoffMessage: optionalText,
  notUnderstoodMessage: optionalText,
});

const mediaConfigSchema = z.object({
  audio: mediaKindConfigSchema.optional().default({ action: "handoff" }),
  image: mediaKindConfigSchema.optional().default({ action: "handoff" }),
  document: mediaKindConfigSchema.optional().default({ action: "handoff" }),
  confirmUnderstanding: z.boolean().optional().default(true),
  maxDurationSeconds: z.number().int().optional(),
  maxSizeBytes: z.number().int().optional(),
});

const sentimentConfigSchema = z.object({
  enabled: z.boolean().optional().default(false),
  threshold: z.enum(["any", "dissatisfied", "angry"]).optional().default("dissatisfied"),
  action: z.enum(["handoff", "notify_and_continue", "log_only"]).optional().default("handoff"),
  notifyUserId: z.string().optional(),
});

const surveyConfigSchema = z.object({
  enabled: z.boolean().optional().default(false),
  type: z.enum(["nps", "csat", "binary"]).optional().default("nps"),
  when: z.enum(["immediate", "after_hours", "next_day"]).optional().default("immediate"),
  question: z.string().optional().default("Como foi o atendimento?"),
  askReason: z.boolean().optional().default(true),
  maxFrequencyDays: z.number().int().min(0).optional().default(30),
});

const onboardingStepSchema = z.object({
  id: z.string(),
  name: z.string(),
  goal: z.string(),
  openingMessage: optionalText,
  collectFields: z.array(z.string()).optional().default([]),
  completionCriteria: z.object({
    type: z.enum(["field_filled", "client_reply", "stage", "action"]),
    field: z.string().optional(),
    value: z.string().optional(),
    action: z.string().optional(),
  }),
  allowedTools: z.array(z.string()).optional().default([]),
  knowledgeDocIds: z.array(z.string()).optional().default([]),
  messageModelIds: z.array(z.string()).optional().default([]),
  handoffOnStuck: destinationSchema,
  maxAttempts: z.number().int().min(1).optional().default(2),
  reminderHours: z.number().int().min(0).optional().default(24),
});

const onboardingConfigSchema = z.object({
  steps: z.array(onboardingStepSchema).optional().default([]),
  onEmptyDeal: z.enum(["ask", "generic", "handoff"]).optional().default("ask"),
  trackProgress: z.boolean().optional().default(true),
  finalActions: z.array(z.record(z.string(), z.unknown())).optional().default([]),
  deliveryAgentId: z.string().optional(),
});

const costCapSchema = z.object({
  maxUsdPerDay: z.number().min(0),
  maxUsdPerMonth: z.number().min(0),
  action: z.enum(["handoff"]).optional().default("handoff"),
});

export const v2AgentConfigSchema = z.object({
  name: z.string(),
  flow: z.enum(["reception", "full", "onboarding"]).optional().default("full"),
  channelIds: z.array(z.string()).optional().default([]),
  model: z.string().optional().default("gpt-4o-mini"),
  responseBehavior: z.enum(["objective", "balanced", "natural", "creative"]).optional().default("balanced"),
  tone: z.string().min(1),
  globalRules: z.array(z.string()).optional().default([]),
  variables: z.array(z.object({ key: z.string(), value: z.string() })).optional().default([]),
  contextFields: z.object({
    contact: z.array(fieldConfigSchema).optional().default([]),
    deal: z.array(fieldConfigSchema).optional().default([]),
  }).optional().default({ contact: [], deal: [] }),
  dealSelection: z.enum(["latest", "ask"]).optional().default("latest"),
  entry: entryConfigSchema.optional().default({} as any),
  themes: z.array(themeSchema).optional().default([]),
  rules: z.array(ruleSchema).optional().default([]),
  handoff: z.object({
    defaultDestination: destinationSchema,
    message: optionalText.default("Vou transferir para um atendente."),
    humanRequestKeywords: z.array(z.string()).optional().default(["humano", "pessoa", "atendente", "consultor"]),
  }).optional().default({
    defaultDestination: { type: "department" } as V2Destination,
    message: "Vou transferir para um atendente.",
    humanRequestKeywords: ["humano", "pessoa", "atendente", "consultor"],
  } as any),
  closure: closureConfigSchema.optional().default({} as any),
  limits: limitsConfigSchema.optional().default({} as any),
  media: mediaConfigSchema.optional().default({} as any),
  productPolicy: productPolicySchema.optional(),
  sentiment: sentimentConfigSchema.optional().default({} as any),
  survey: surveyConfigSchema.optional().default({} as any),
  onboarding: onboardingConfigSchema.optional(),
  allowedDomains: z.array(z.string()).optional().default([]),
  autonomyMode: z.enum(["auto", "suggest"]).optional().default("suggest"),
  simulateTyping: z.boolean().optional().default(true),
  typingPerCharMs: z.number().int().min(0).max(200).optional().default(25),
  markMessagesRead: z.boolean().optional().default(true),
  costCap: costCapSchema.optional(),
  dailyTokenCap: z.number().int().min(0).optional(),
  enabledTools: z.array(z.string()).optional().default([]),
  toolGovernor: z
    .object({
      maxCallsPerTurn: z.number().int().min(1).optional().default(6),
      maxRepeatsPerTool: z.number().int().min(1).optional().default(2),
    })
    .optional()
    .default({ maxCallsPerTurn: 6, maxRepeatsPerTool: 2 } as any),
  allowedKnowledgeDocIds: z.array(z.string()).optional().default([]),
  allowedMessageModelIds: z.array(z.string()).optional().default([]),
  allowedPhoneNumbers: z.array(z.string()).optional().default([]),
  responseLength: z.enum(["short", "medium", "long"]).optional().default("medium"),
  emojis: z.enum(["none", "light", "moderate"]).optional().default("none"),
  calendar: z
    .object({
      // Linha incompleta (recém-adicionada na tela, sem descrição ou data)
      // é descartada em vez de recusar o rascunho inteiro.
      events: z.preprocess(
        (v) =>
          Array.isArray(v)
            ? v
                .filter((e) => e && typeof e === "object" && typeof e.title === "string" && e.title.trim() && /^\d{4}-\d{2}-\d{2}$/.test(String(e.start)))
                .map((e) => ({ ...e, title: e.title.trim(), end: /^\d{4}-\d{2}-\d{2}$/.test(String(e.end ?? "")) && e.end >= e.start ? e.end : undefined }))
                .slice(0, 500)
            : [],
        z.array(
          z.object({
            id: z.string(),
            start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
            end: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
            title: z.string().min(1),
          }),
        ),
      ),
    })
    .optional(),
  structuredOutput: z.boolean().optional().default(false),
  fallback: fallbackSchema,
  scope: scopeSchema,
  inactivity: inactivitySchema,
  tabulation: tabulationSchema,
  businessHours: z
    .object({
      enabled: z.boolean().optional().default(false),
      timezone: z.string().optional().default("America/Sao_Paulo"),
      weekdays: z
        .array(
          z.object({
            day: z.number().int().min(0).max(6),
            start: z.string(),
            end: z.string(),
          }),
        )
        .optional()
        .default([]),
      offHoursMessage: optionalText,
      outsideAction: z.enum(["message", "handoff", "silence"]).optional().default("message"),
    })
    .optional()
    .nullable()
    .default(null),
});

export type V2AgentConfigInput = z.input<typeof v2AgentConfigSchema>;

export function validateV2Config(input: unknown): { ok: true; data: V2AgentConfig } | { ok: false; errors: z.ZodError } {
  const parsed = v2AgentConfigSchema.safeParse(input);
  if (!parsed.success) return { ok: false, errors: parsed.error };
  return { ok: true, data: parsed.data as V2AgentConfig };
}

export function normalizeV2Config(input: unknown): V2AgentConfig {
  const parsed = v2AgentConfigSchema.parse(input);
  return parsed as V2AgentConfig;
}

/** Preset base compartilhado. */
function basePreset(): V2AgentConfig {
  return normalizeV2Config({
    name: "",
    flow: "full",
    channelIds: [],
    model: "gpt-4o-mini",
    responseBehavior: "balanced",
    tone: "Profissional, direto e educado.",
    // Fontes, não prometer retorno e não afirmar ação já estão no prompt
    // fixo; repetidas aqui, em caixa alta, puxavam para transferir demais.
    globalRules: [],
    variables: [],
    contextFields: {
      contact: [
        { key: "name", permissions: ["read", "cite"] },
        { key: "phone", permissions: ["read"] },
        { key: "email", permissions: ["read", "cite"] },
      ],
      deal: [
        { key: "stage", permissions: ["read"] },
        { key: "status", permissions: ["read"] },
        { key: "value", permissions: ["read", "cite"] },
      ],
    },
    entry: {
      onDealNotFound: "ask_identification",
      confirmContact: true,
      confirmationFields: ["name", "email"],
      confirmationMode: "combined",
    },
    themes: [],
    rules: [
      {
        id: "human_request",
        name: "Pedido de humano",
        order: 0,
        conditions: [{ type: "keywords", values: ["humano", "pessoa", "atendente", "consultor"] }],
        actions: [{ type: "handoff" }],
      },
    ],
    handoff: {
      defaultDestination: { type: "department" },
      message: "Vou transferir você para um atendente da equipe.",
      humanRequestKeywords: ["humano", "pessoa", "atendente", "consultor"],
    },
    closure: {
      postCloseWindowHours: 6,
      returnToOriginStage: true,
    },
    limits: {
      maxCourtesyReplies: 1,
      maxHelpOffers: 1,
      maxStalledExchanges: 2,
      nonsenseLimit: 3,
    },
    media: {
      audio: { action: "handoff" },
      image: { action: "handoff" },
      document: { action: "handoff" },
      confirmUnderstanding: true,
    },
    sentiment: { enabled: false },
    survey: { enabled: false },
    allowedDomains: [],
    autonomyMode: "suggest",
  });
}

function emptyProductPolicy(): V2ProductPolicy {
  return {
    enabled: false,
    maxItems: 3,
    showPrice: false,
    showConditions: false,
    showImage: false,
    showLink: false,
    citableFields: [],
    allowedProductIds: [],
  };
}

export function receptionPreset(): V2AgentConfig {
  const base = basePreset();
  base.name = "Recepção";
  base.flow = "reception";
  base.globalRules = [
    ...base.globalRules,
    "Você é uma recepção: identifica o cliente, confirma o cadastro e encaminha para o assunto certo. Não responde dúvidas técnicas.",
  ];
  base.entry.openingMessage = "Olá! Sou o assistente virtual. Para te direcionar, preciso confirmar seus dados. Qual o seu e-mail ou CPF?";
  base.themes = [
    {
      id: "atendimento",
      name: "Atendimento",
      when: ["suporte", "ajuda", "problema", "dúvida"],
      examples: [],
      instructions: "Encaminhar para atendimento humano após confirmar identidade.",
      allowedTools: ["handoff"],
      allowedKnowledgeDocIds: [],
      allowedMessageModelIds: [],
      productPolicy: emptyProductPolicy(),
      handoffDestination: { type: "department", id: "" },
    },
    {
      id: "vendas",
      name: "Vendas",
      when: ["comprar", "preço", "produto", "vendedor"],
      examples: [],
      instructions: "Encaminhar para vendas após confirmar identidade.",
      allowedTools: ["handoff"],
      allowedKnowledgeDocIds: [],
      allowedMessageModelIds: [],
      productPolicy: emptyProductPolicy(),
      handoffDestination: { type: "department", id: "" },
    },
  ];
  return base;
}

export function fullAgentPreset(): V2AgentConfig {
  const base = basePreset();
  base.name = "Atendimento";
  base.flow = "full";
  base.globalRules = [
    ...base.globalRules,
    "Resolva o máximo possível dentro dos materiais e ferramentas disponíveis.",
  ];
  base.entry.openingMessage = "Olá! Sou seu assistente virtual. Vi aqui seu cadastro. Posso te ajudar com o que precisa?";
  base.themes = [
    {
      id: "suporte",
      name: "Suporte",
      when: ["suporte", "ajuda", "problema", "dúvida"],
      examples: [],
      instructions: "Resolver dúvidas usando materiais e modelos de mensagem permitidos. Se não souber, transfira.",
      allowedTools: ["search_crm_records", "knowledge_search", "list_message_models", "send_message_model", "ask_with_options", "handoff"],
      allowedKnowledgeDocIds: [],
      allowedMessageModelIds: [],
      productPolicy: emptyProductPolicy(),
    },
    {
      id: "vendas",
      name: "Vendas",
      when: ["comprar", "preço", "produto", "vendedor"],
      examples: [],
      instructions: "Se o tema tiver productPolicy habilitado, busque produtos. Caso contrário, transfira para vendas.",
      allowedTools: ["search_products", "search_crm_records", "knowledge_search", "handoff"],
      allowedKnowledgeDocIds: [],
      allowedMessageModelIds: [],
      productPolicy: emptyProductPolicy(),
    },
  ];
  return base;
}

export function salesPreset(): V2AgentConfig {
  const base = basePreset();
  base.name = "Vendas";
  base.flow = "full";
  base.globalRules = [
    ...base.globalRules,
    "Você ajuda o cliente a conhecer produtos e dar o próximo passo. Nunca invente preço, condição ou disponibilidade.",
  ];
  base.themes = [
    {
      id: "vendas",
      name: "Vendas",
      when: ["comprar", "preço", "produto", "vendedor", "orçamento"],
      examples: [],
      instructions: "Use search_products para buscar no catálogo. Responda só com dados retornados. ProductPolicy habilitado.",
      allowedTools: ["search_products", "search_crm_records", "send_product", "create_deal", "move_stage", "ask_with_options", "handoff"],
      allowedKnowledgeDocIds: [],
      allowedMessageModelIds: [],
      productPolicy: {
        enabled: true,
        maxItems: 3,
        showPrice: true,
        showConditions: true,
        showImage: true,
        showLink: true,
        citableFields: ["name", "price", "description"],
        allowedProductIds: [],
      },
    },
  ];
  return base;
}

export function supportPreset(): V2AgentConfig {
  const base = basePreset();
  base.name = "Suporte técnico";
  base.flow = "full";
  base.globalRules = [
    ...base.globalRules,
    "Você resolve problemas técnicos usando apenas os materiais oficiais.",
  ];
  base.themes = [
    {
      id: "suporte",
      name: "Suporte técnico",
      when: ["erro", "bug", "não funciona", "falha", "suporte técnico"],
      examples: [],
      instructions: "Use knowledge_search e list_message_models. Se não resolver, transfira.",
      allowedTools: ["search_crm_records", "knowledge_search", "list_message_models", "send_message_model", "create_activity", "handoff"],
      allowedKnowledgeDocIds: [],
      allowedMessageModelIds: [],
      productPolicy: emptyProductPolicy(),
    },
  ];
  return base;
}

export function onboardingPreset(): V2AgentConfig {
  const base = basePreset();
  base.name = "Primeiros dias";
  base.flow = "onboarding";
  base.globalRules = [
    ...base.globalRules,
    "Você acompanha o cliente novo nas primeiras etapas. Não assume dados que não existem.",
  ];
  base.onboarding = {
    steps: [
      {
        id: "boas_vindas",
        name: "Boas-vindas",
        goal: "Confirmar cadastro e explicar próximos passos.",
        collectFields: ["name", "email"],
        completionCriteria: { type: "field_filled", field: "email" },
        handoffOnStuck: { type: "department" },
        maxAttempts: 2,
        reminderHours: 24,
        allowedTools: [],
        knowledgeDocIds: [],
        messageModelIds: [],
      },
      {
        id: "primeiro_acesso",
        name: "Primeiro acesso",
        goal: "Garantir que o cliente conseguiu acessar a área do cliente.",
        collectFields: ["login_ok"],
        completionCriteria: { type: "client_reply" },
        handoffOnStuck: { type: "department" },
        maxAttempts: 2,
        reminderHours: 24,
        allowedTools: [],
        knowledgeDocIds: [],
        messageModelIds: [],
      },
    ],
    onEmptyDeal: "ask",
    trackProgress: true,
    finalActions: [],
  };
  return base;
}

export function blankPreset(): V2AgentConfig {
  const base = basePreset();
  base.name = "";
  base.flow = "full";
  base.themes = [];
  base.rules = [];
  return base;
}

export function listV2Presets(): Array<{ key: string; label: string; config: V2AgentConfig }> {
  return [
    { key: "reception", label: "Recepção", config: receptionPreset() },
    { key: "full", label: "Atendimento", config: fullAgentPreset() },
    { key: "sales", label: "Vendedor", config: salesPreset() },
    { key: "support", label: "Suporte técnico", config: supportPreset() },
    { key: "onboarding", label: "Primeiros dias", config: onboardingPreset() },
    { key: "blank", label: "Em branco", config: blankPreset() },
  ];
}
