/**
 * Pilotagem "profunda" do agente — o que antes só existia em constantes
 * TypeScript e exigia deploy para mudar.
 *
 * Três campos novos no `AIAgentConfig`:
 *
 *  - `steeringRules` (texto) — regras de atendimento injetadas no system
 *    prompt. Vazio = fallback para `ACADEMIC_ATENDIMENTO_RULES`.
 *  - `toolConfig` (JSON) — por tool id, o que o consultor pode travar:
 *    args bloqueados, defaults, listas de tags/departamentos permitidos.
 *  - `inboxPolicy` (JSON) — limiar de confiança, keywords extras,
 *    aliases de departamento e toggles dos interceptos determinísticos
 *    do `inbox-handler`.
 *
 * REGRA DE OURO: campo vazio/ausente = comportamento atual do código.
 * Assim o primeiro deploy não muda nada até o consultor editar na tela.
 */

import { MEDIA_KINDS, type MediaKind } from "@/lib/ai-agents/media-placeholder";
import {
  normalizeMessageRules,
  type MessageRule,
} from "@/lib/ai-agents/message-rules";
import {
  normalizeBusinessHours,
  type BusinessHoursConfig,
} from "@/lib/ai-agents/piloting";
import { academicDefaultMessageRules } from "@/verticals/academic/default-message-rules";

// ── Tool config ───────────────────────────────────────────────

export type ToolPolicy = {
  /// Args que o LLM NÃO deve enviar. São removidos antes do execute
  /// e anunciados na description da tool.
  disabledArgs: string[];
  /// Texto livre por arg ("não envie X", "use Y quando…"). Vai na
  /// description da tool.
  argHints: Record<string, string>;
  /// Valores forçados por arg quando o LLM omitir (ou quando o arg
  /// estiver em `disabledArgs`).
  defaults: Record<string, string>;

  // add_tag
  allowedTagNames: string[];
  denyCreateNew: boolean;

  // transfer_to_department / execute_distribution / transfer_to_human
  allowedDepartments: string[];
  blockedDepartments: string[];

  // create_activity
  allowedTypes: string[];
  defaultType: string | null;

  // consultar_matricula
  policyText: string | null;
  transferMessage: string | null;

  // search_crm_records
  /// Campos que o agente pode LER, no formato "entidade.campo"
  /// (ex.: "deal.curso"). Aceita curinga "deal.*" e "*". Vazio = nenhum
  /// valor é devolvido ao modelo: a busca só confirma que há registro.
  /// A lista é do operador — o código não libera campo por conta própria.
  readableFields: string[];
  /// Permite procurar registros de terceiros (`scope: "organization"`).
  /// Falso = o agente só lê o cadastro de quem está na conversa.
  allowOrgWideSearch: boolean;
  /// Jargão desta organização que deve acender o aviso de "campo sensível"
  /// na tela de configuração (ex.: o nome que ela dá ao número de
  /// matrícula, ao prontuário, ao contrato). Somado aos termos genéricos do
  /// produto. É só aviso visual — não bloqueia leitura nem busca.
  sensitiveTerms: string[];
};

export type ToolConfigMap = Record<string, ToolPolicy>;

export function emptyToolPolicy(): ToolPolicy {
  return {
    disabledArgs: [],
    argHints: {},
    defaults: {},
    allowedTagNames: [],
    denyCreateNew: false,
    allowedDepartments: [],
    blockedDepartments: [],
    allowedTypes: [],
    defaultType: null,
    policyText: null,
    transferMessage: null,
    readableFields: [],
    allowOrgWideSearch: false,
    sensitiveTerms: [],
  };
}

function strList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const raw of v) {
    if (typeof raw !== "string") continue;
    const s = raw.trim();
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

function strMap(v: unknown): Record<string, string> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
    if (typeof raw !== "string") continue;
    const key = k.trim();
    const val = raw.trim();
    if (key && val) out[key] = val;
  }
  return out;
}

function nullableText(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

export function normalizeToolPolicy(v: unknown): ToolPolicy {
  const base = emptyToolPolicy();
  if (!v || typeof v !== "object" || Array.isArray(v)) return base;
  const r = v as Record<string, unknown>;
  return {
    disabledArgs: strList(r.disabledArgs),
    argHints: strMap(r.argHints),
    defaults: strMap(r.defaults),
    allowedTagNames: strList(r.allowedTagNames),
    denyCreateNew: Boolean(r.denyCreateNew),
    allowedDepartments: strList(r.allowedDepartments),
    blockedDepartments: strList(r.blockedDepartments),
    allowedTypes: strList(r.allowedTypes),
    defaultType: nullableText(r.defaultType),
    policyText: nullableText(r.policyText),
    transferMessage: nullableText(r.transferMessage),
    readableFields: strList(r.readableFields),
    allowOrgWideSearch: Boolean(r.allowOrgWideSearch),
    sensitiveTerms: strList(r.sensitiveTerms),
  };
}

/** Uma policy é "vazia" quando não restringe nada — não precisa persistir. */
export function isEmptyToolPolicy(p: ToolPolicy): boolean {
  return (
    p.disabledArgs.length === 0 &&
    Object.keys(p.argHints).length === 0 &&
    Object.keys(p.defaults).length === 0 &&
    p.allowedTagNames.length === 0 &&
    !p.denyCreateNew &&
    p.allowedDepartments.length === 0 &&
    p.blockedDepartments.length === 0 &&
    p.allowedTypes.length === 0 &&
    !p.defaultType &&
    !p.policyText &&
    !p.transferMessage &&
    p.readableFields.length === 0 &&
    !p.allowOrgWideSearch &&
    p.sensitiveTerms.length === 0
  );
}

export function normalizeToolConfig(v: unknown): ToolConfigMap {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: ToolConfigMap = {};
  for (const [toolId, raw] of Object.entries(v as Record<string, unknown>)) {
    const id = toolId.trim();
    if (!id) continue;
    const policy = normalizeToolPolicy(raw);
    if (!isEmptyToolPolicy(policy)) out[id] = policy;
  }
  return out;
}

export function toolPolicyFor(
  config: ToolConfigMap | null | undefined,
  toolId: string,
): ToolPolicy {
  return config?.[toolId] ?? emptyToolPolicy();
}

/**
 * Sufixo anexado à description da tool para o LLM saber das travas.
 * Sem isso ele insiste em mandar o arg bloqueado e recebe erro em loop.
 */
export function describeToolPolicy(p: ToolPolicy): string {
  const lines: string[] = [];
  if (p.disabledArgs.length > 0) {
    lines.push(
      `NÃO envie os parâmetros: ${p.disabledArgs.join(", ")} (o sistema ignora).`,
    );
  }
  for (const [arg, hint] of Object.entries(p.argHints)) {
    lines.push(`${arg}: ${hint}`);
  }
  if (p.allowedTagNames.length > 0) {
    lines.push(`Tags permitidas (use exatamente uma): ${p.allowedTagNames.join(", ")}.`);
  } else if (p.denyCreateNew) {
    lines.push("Use somente tags que já existem — não crie tag nova.");
  }
  if (p.allowedDepartments.length > 0) {
    lines.push(`Departamentos permitidos: ${p.allowedDepartments.join(", ")}.`);
  }
  if (p.blockedDepartments.length > 0) {
    lines.push(`Departamentos proibidos: ${p.blockedDepartments.join(", ")}.`);
  }
  if (p.allowedTypes.length > 0) {
    lines.push(`Tipos permitidos: ${p.allowedTypes.join(", ")}.`);
  }
  if (p.defaultType) {
    lines.push(`Tipo padrão quando em dúvida: ${p.defaultType}.`);
  }
  if (Object.keys(p.defaults).length > 0) {
    const pairs = Object.entries(p.defaults)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    lines.push(`Defaults aplicados pelo sistema: ${pairs}.`);
  }
  if (lines.length === 0) return "";
  return `\n\nRESTRIÇÕES DO OPERADOR:\n- ${lines.join("\n- ")}`;
}

/**
 * Aplica `disabledArgs` + `defaults` no objeto de args recebido do LLM.
 * Args tipados como número/boolean no schema são preservados; só o
 * default (string) é coagido quando o valor original está ausente.
 */
export function applyArgPolicy<T extends Record<string, unknown>>(
  args: T,
  policy: ToolPolicy,
): T {
  const out: Record<string, unknown> = { ...args };
  for (const arg of policy.disabledArgs) {
    delete out[arg];
  }
  for (const [arg, value] of Object.entries(policy.defaults)) {
    if (out[arg] === undefined || out[arg] === null || out[arg] === "") {
      out[arg] = value;
    }
  }
  return out as T;
}

function fold(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .trim();
}

/** Match tolerante (sem acento/caixa) de um nome numa lista da policy. */
export function listAllows(list: string[], value: string): boolean {
  if (list.length === 0) return true;
  const v = fold(value);
  return list.some((item) => {
    const i = fold(item);
    return i === v || v.includes(i) || i.includes(v);
  });
}

export function listBlocks(list: string[], value: string): boolean {
  if (list.length === 0) return false;
  const v = fold(value);
  return list.some((item) => {
    const i = fold(item);
    return i === v || v.includes(i) || i.includes(v);
  });
}

// ── Inbox policy ──────────────────────────────────────────────

export type DepartmentAliasMap = {
  acolhimento: string[];
  retencao: string[];
  atendimento: string[];
};

/** O que fazer com a conversa que cai fora do escopo do agente. */
export type OutOfScopeAction = "handoff" | "ignore";

/**
 * Escopo de atendimento: em QUAIS conversas o agente pode entrar.
 * Avaliado antes de qualquer intercepto ou chamada ao LLM.
 *
 * Todas as listas vazias = atende tudo (comportamento legado).
 */
export type AttendanceScope = {
  /// Funis (pipelines) do deal aberto do contato. Vazio = qualquer.
  allowedPipelineIds: string[];
  blockedPipelineIds: string[];
  /// Etapas do funil. Vazio = qualquer.
  allowedStageIds: string[];
  blockedStageIds: string[];
  /// Tags do contato (match sem acento/caixa). Allow vazio = qualquer.
  allowedContactTags: string[];
  blockedContactTags: string[];
  /// Contato sem nenhum deal aberto: atende ou devolve para humano.
  /// Só tem efeito quando há restrição de funil/etapa.
  attendWithoutDeal: boolean;
  action: OutOfScopeAction;
  /// Mensagem enviada antes de sair. Vazio = sai sem falar nada.
  message: string | null;
};

export function defaultAttendanceScope(): AttendanceScope {
  return {
    allowedPipelineIds: [],
    blockedPipelineIds: [],
    allowedStageIds: [],
    blockedStageIds: [],
    allowedContactTags: [],
    blockedContactTags: [],
    attendWithoutDeal: true,
    action: "handoff",
    message: null,
  };
}

export function normalizeAttendanceScope(v: unknown): AttendanceScope {
  const base = defaultAttendanceScope();
  if (!v || typeof v !== "object" || Array.isArray(v)) return base;
  const r = v as Record<string, unknown>;
  return {
    allowedPipelineIds: strList(r.allowedPipelineIds),
    blockedPipelineIds: strList(r.blockedPipelineIds),
    allowedStageIds: strList(r.allowedStageIds),
    blockedStageIds: strList(r.blockedStageIds),
    allowedContactTags: strList(r.allowedContactTags),
    blockedContactTags: strList(r.blockedContactTags),
    attendWithoutDeal: boolOr(r.attendWithoutDeal, base.attendWithoutDeal),
    action: r.action === "ignore" ? "ignore" : "handoff",
    message: nullableText(r.message),
  };
}

/** true se o escopo não restringe nada — o agente atende qualquer conversa. */
export function isUnrestrictedScope(s: AttendanceScope): boolean {
  return (
    s.allowedPipelineIds.length === 0 &&
    s.blockedPipelineIds.length === 0 &&
    s.allowedStageIds.length === 0 &&
    s.blockedStageIds.length === 0 &&
    s.allowedContactTags.length === 0 &&
    s.blockedContactTags.length === 0
  );
}

// ── Mídia inbound ─────────────────────────────────────────────

/**
 * O que fazer quando o cliente manda SÓ mídia (sem legenda). O conteúdo
 * gravado é um placeholder (`[Imagem]`), nunca a pergunta dele — repassar
 * isso ao modelo é o defeito que respondeu sobre polo/prova para quem
 * perguntava de cancelamento.
 *
 *  - `handoff`  acolhe e passa para um atendente humano.
 *  - `ask_text` pede em texto o que a pessoa precisa, sem chamar o modelo.
 *  - `ignore`   não responde (registra o run com o motivo).
 */
export type MediaInboundAction = "handoff" | "ask_text" | "ignore";

export const MEDIA_INBOUND_ACTIONS: MediaInboundAction[] = [
  "handoff",
  "ask_text",
  "ignore",
];

export type MediaInboundPolicy = {
  /// Ação por tipo de mídia. Default seguro: nunca entrega o placeholder
  /// ao modelo.
  actions: Record<MediaKind, MediaInboundAction>;
  /// Frase enviada em `handoff`. `null` = texto padrão do código, que já
  /// varia com o tipo de mídia.
  handoffMessage: string | null;
  /// Frase enviada em `ask_text`. `null` = texto padrão do código.
  askTextMessage: string | null;
};

export function defaultMediaInboundPolicy(): MediaInboundPolicy {
  return {
    actions: {
      image: "handoff",
      video: "handoff",
      audio: "handoff",
      document: "handoff",
      // Figurinha não carrega pedido: acionar humano por 👍 só gera fila.
      sticker: "ignore",
      location: "handoff",
      contact: "handoff",
      other: "handoff",
    },
    handoffMessage: null,
    askTextMessage: null,
  };
}

/**
 * Rótulos da tela do agente — linguagem de operador, pt-BR. Servidos em
 * `GET /api/ai-agents/metadata` para o frontend não inventar tradução do
 * nome técnico.
 */
export const MEDIA_INBOUND_LABELS: {
  kinds: Array<{ id: MediaKind; label: string }>;
  actions: Array<{ id: MediaInboundAction; label: string; hint: string }>;
} = {
  kinds: [
    { id: "image", label: "Quando o cliente enviar uma imagem" },
    { id: "video", label: "Quando o cliente enviar um vídeo" },
    { id: "audio", label: "Quando o cliente enviar um áudio" },
    { id: "document", label: "Quando o cliente enviar um documento" },
    { id: "sticker", label: "Quando o cliente enviar uma figurinha" },
    { id: "location", label: "Quando o cliente enviar uma localização" },
    { id: "contact", label: "Quando o cliente compartilhar um contato" },
    { id: "other", label: "Quando o cliente enviar outro tipo de anexo" },
  ],
  actions: [
    {
      id: "handoff",
      label: "Passar para um atendente",
      hint: "O agente avisa que recebeu o anexo e coloca a conversa na fila humana.",
    },
    {
      id: "ask_text",
      label: "Pedir para escrever em texto",
      hint: "O agente responde pedindo que a pessoa conte por escrito o que precisa.",
    },
    {
      id: "ignore",
      label: "Não responder",
      hint: "O agente fica em silêncio e registra o anexo no histórico do atendimento.",
    },
  ],
};

function isMediaInboundAction(v: unknown): v is MediaInboundAction {
  return (
    typeof v === "string" &&
    MEDIA_INBOUND_ACTIONS.includes(v as MediaInboundAction)
  );
}

export function normalizeMediaInboundPolicy(v: unknown): MediaInboundPolicy {
  const base = defaultMediaInboundPolicy();
  if (!v || typeof v !== "object" || Array.isArray(v)) return base;
  const r = v as Record<string, unknown>;
  const rawActions =
    r.actions && typeof r.actions === "object" && !Array.isArray(r.actions)
      ? (r.actions as Record<string, unknown>)
      : {};
  const actions = { ...base.actions };
  for (const kind of MEDIA_KINDS) {
    const chosen = rawActions[kind];
    if (isMediaInboundAction(chosen)) actions[kind] = chosen;
  }
  return {
    actions,
    handoffMessage: nullableText(r.handoffMessage),
    askTextMessage: nullableText(r.askTextMessage),
  };
}

// ── Transferência para humano ─────────────────────────────────

/**
 * QUANDO o agente pode jogar a conversa na fila humana. Era método de
 * vertical (`isImmediateAcademicHandoffJustified`), então agente sem pack
 * não tinha política nenhuma e o gate ficava inerte.
 *
 *  - `always`             transfere sempre que julgar necessário.
 *  - `on_request_or_topic` só quando o cliente pede atendente humano ou o
 *    tema exige um departamento (o pack, se houver, define os temas).
 */
export type TransferPolicy = "always" | "on_request_or_topic";

export const TRANSFER_POLICIES: TransferPolicy[] = [
  "always",
  "on_request_or_topic",
];

/** Rótulos da tela do agente — linguagem de operador, pt-BR. */
export const TRANSFER_POLICY_LABELS: Array<{
  id: TransferPolicy;
  label: string;
  hint: string;
}> = [
  {
    id: "always",
    label: "Sempre que o agente julgar necessário",
    hint: "O agente pode passar a conversa para a equipe a qualquer momento.",
  },
  {
    id: "on_request_or_topic",
    label: "Só quando a pessoa pedir atendente ou o assunto exigir",
    hint: "Nos outros casos o agente continua o atendimento em vez de transferir.",
  },
];

function isTransferPolicy(v: unknown): v is TransferPolicy {
  return (
    typeof v === "string" && TRANSFER_POLICIES.includes(v as TransferPolicy)
  );
}

// ── Atendimento humano (horário + cópia da fila) ──────────────

/**
 * Rótulos pt-BR do bloco "atendimento humano" na tela do agente. O nome
 * técnico (`humanAttendanceHours`) nunca aparece para o operador.
 */
export const HUMAN_ATTENDANCE_LABELS = {
  hours: {
    label: "Horário em que há atendente humano",
    hint: "Fora desse horário o agente avisa quando a equipe retoma, em vez de prometer consultor agora.",
  },
  preEndMinutes: {
    label: "Parar de oferecer atendente antes do fim do horário (minutos)",
    hint: "Evita colocar alguém na fila minutos antes de a equipe encerrar o dia.",
  },
  queueMessage: {
    label: "Mensagem quando a pessoa entra na fila",
    hint: "Vazio = o agente usa o texto padrão, que já cita o horário da equipe.",
  },
  assignedConsultantMessage: {
    label: "Mensagem quando já há um atendente responsável",
    hint: "Vazio = texto padrão.",
  },
  audioHandoffMessage: {
    label: "Mensagem quando a pessoa manda áudio e o agente chama a equipe",
    hint: "Vazio = texto padrão, que muda conforme o horário da equipe.",
  },
  humanRequestKeywords: {
    label: "Termos que contam como pedido de atendente",
    hint: "Somados aos termos que o sistema já reconhece — nunca no lugar deles.",
  },
} as const;

export type InboxPolicy = {
  /// Abaixo disso o backend distribui para humano. `null` = usa o
  /// default do código (0.4).
  confidenceThreshold: number | null;
  /// Liga/desliga o handoff automático por baixa confiança.
  lowConfidenceHandoff: boolean;

  /// "Quando a mensagem for sobre ISTO, o próximo passo é AQUILO".
  /// Avaliadas NA ORDEM DA LISTA, antes de qualquer intercepto e antes do
  /// modelo. A primeira que casa decide o turno.
  messageRules: MessageRule[];

  /// Interceptos determinísticos do inbox-handler.
  interceptRetention: boolean;
  interceptCourseShopping: boolean;

  /// Termos EXTRA (somados aos regexes do código) que classificam a
  /// mensagem como retenção / dúvida comercial de curso.
  retentionKeywords: string[];
  courseShoppingKeywords: string[];

  /// Aliases usados para casar o `Department.name` do banco. Vazio =
  /// usa `ACADEMIC_DEPARTMENT_ALIASES`.
  departmentAliases: DepartmentAliasMap;

  /// Aula inaugural: intercepto que responde o link do YouTube sem LLM.
  inauguralEnabled: boolean;
  inauguralUrl: string | null;
  /// Datas "YYYY-MM-DD" (BRT) em que o intercepto vale. Vazio = usa
  /// `INAUGURAL_LINK_DATES` / default do código.
  inauguralDates: string[];

  /// Em quais conversas o agente pode entrar (funil, etapa, tag).
  scope: AttendanceScope;

  /// Mensagens de saída do atendimento. `null` = texto padrão do
  /// código, que já ajusta a frase ao expediente humano.
  handoffMessage: string | null;
  retentionHandoffMessage: string | null;

  /// Usa os Modelos internos (`MessageTemplate`) como fonte de RAG,
  /// além dos docs da base de conhecimento do agente. Era ligado só
  /// para `verticalPack=academic`; agora é escolha de configuração.
  useMessageModels: boolean;

  /// O que fazer quando o agente NÃO tem base para responder.
  ///  - `handoff`     admite e transfere para humano.
  ///  - `clarify`     pergunta pra tentar destravar; só transfere se insistir.
  ///  - `acknowledge` admite, registra a lacuna e segue o atendimento.
  unknownAnswerMode: UnknownAnswerMode;
  /// Frase que o agente deve usar ao admitir que não sabe. `null` =
  /// deixa o modelo formular com o tom configurado.
  unknownAnswerMessage: string | null;

  /// Orientação default quando um documento da base VENCE e o operador não
  /// escreveu um texto no próprio documento. `null` = o agente só para de
  /// usar o documento, sem instrução extra no prompt.
  knowledgeExpiredInstruction: string | null;

  /// O que fazer com mídia sem legenda (imagem, vídeo, documento…).
  media: MediaInboundPolicy;

  /// Teto temporal, em minutos, do lote de mensagens não respondidas que
  /// forma o turno atual. Mensagens mais antigas que isso não entram.
  /// `0` = sem teto (comportamento antigo, que arrastou mensagens de 30
  /// minutos antes atrás de um "oi").
  inboundBatchWindowMinutes: number;

  /// Quando o agente pode transferir para a fila humana.
  transferPolicy: TransferPolicy;

  /// Horário em que há atendente humano. `null` = usa o horário do
  /// próprio agente (`businessHours`) e, na falta dele, o default do
  /// código (seg–sex 8h–19h, sáb 9h–16h, America/Sao_Paulo).
  humanAttendanceHours: BusinessHoursConfig | null;
  /// Minutos antes do fim em que a fila para de oferecer consultor.
  /// `null` = 30 (default do código).
  humanAttendancePreEndMinutes: number | null;
  /// Texto de "você está na fila" (com horário). `null` = padrão.
  queueMessage: string | null;
  /// Texto de "já tem consultor responsável". `null` = padrão.
  assignedConsultantMessage: string | null;
  /// Texto do aviso de áudio que dispara transferência. `null` = padrão.
  audioHandoffMessage: string | null;
  /// Termos EXTRA que contam como pedido explícito de atendente humano.
  humanRequestKeywords: string[];
};

/** Teto default do lote de inbound (minutos). */
export const DEFAULT_INBOUND_BATCH_WINDOW_MINUTES = 15;

export type UnknownAnswerMode = "handoff" | "clarify" | "acknowledge";

export const UNKNOWN_ANSWER_MODES: UnknownAnswerMode[] = [
  "handoff",
  "clarify",
  "acknowledge",
];

function isUnknownAnswerMode(v: unknown): v is UnknownAnswerMode {
  return (
    typeof v === "string" &&
    UNKNOWN_ANSWER_MODES.includes(v as UnknownAnswerMode)
  );
}

export function defaultInboxPolicy(): InboxPolicy {
  return {
    confidenceThreshold: null,
    lowConfidenceHandoff: true,
    messageRules: [],
    interceptRetention: false,
    interceptCourseShopping: false,
    retentionKeywords: [],
    courseShoppingKeywords: [],
    departmentAliases: { acolhimento: [], retencao: [], atendimento: [] },
    inauguralEnabled: false,
    inauguralUrl: null,
    inauguralDates: [],
    scope: defaultAttendanceScope(),
    handoffMessage: null,
    retentionHandoffMessage: null,
    useMessageModels: false,
    unknownAnswerMode: "handoff",
    unknownAnswerMessage: null,
    knowledgeExpiredInstruction: null,
    media: defaultMediaInboundPolicy(),
    inboundBatchWindowMinutes: DEFAULT_INBOUND_BATCH_WINDOW_MINUTES,
    transferPolicy: "always",
    humanAttendanceHours: null,
    humanAttendancePreEndMinutes: null,
    queueMessage: null,
    assignedConsultantMessage: null,
    audioHandoffMessage: null,
    humanRequestKeywords: [],
  };
}

function boolOr(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function nonNegativeInt(v: unknown, fallback: number): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return fallback;
  return Math.floor(v);
}

/**
 * Normaliza inboxPolicy. Com `verticalPack` setado, aplica defaults do pack
 * (academic → interceptos ligados) como base antes do JSON salvo.
 * Defaults hardcoded por id para evitar ciclo steering ↔ verticals.
 */
export function normalizeInboxPolicy(
  v: unknown,
  verticalPack?: string | null,
): InboxPolicy {
  const base = defaultInboxPolicy();
  if (verticalPack === "academic") {
    base.interceptRetention = true;
    // Regras que antes eram regex fixo no `department-routing`. Agente do
    // pack que nunca salvou configuração continua com elas valendo.
    base.messageRules = academicDefaultMessageRules({
      interceptRetention: true,
    });
    base.interceptCourseShopping = true;
    base.inauguralEnabled = true;
    // Preserva o comportamento anterior, quando o RAG de modelos era
    // ligado por `pack?.id === "academic"` direto no runner.
    base.useMessageModels = true;
    // O pack fechava a transferência por método (`isImmediateAcademic
    // HandoffJustified`). Agora é declarativo — e o default preserva a
    // regra que já vale em produção para esses agentes.
    base.transferPolicy = "on_request_or_topic";
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) return base;
  const r = v as Record<string, unknown>;

  let threshold: number | null = null;
  if (typeof r.confidenceThreshold === "number" &&
      Number.isFinite(r.confidenceThreshold)) {
    threshold = Math.max(0, Math.min(1, r.confidenceThreshold));
  }

  const aliasesRaw =
    r.departmentAliases && typeof r.departmentAliases === "object"
      ? (r.departmentAliases as Record<string, unknown>)
      : {};

  const interceptRetention = boolOr(
    r.interceptRetention,
    base.interceptRetention,
  );
  // Lista salva vence sempre — inclusive vazia, que é o operador dizendo
  // "removi as regras". Só quem NUNCA salvou herda a base do pack, e é isso
  // que preserva o comportamento de hoje sem tocar em coluna nenhuma.
  const messageRules = Array.isArray(r.messageRules)
    ? normalizeMessageRules(r.messageRules)
    : verticalPack === "academic"
      ? academicDefaultMessageRules({ interceptRetention })
      : base.messageRules;

  return {
    confidenceThreshold: threshold,
    lowConfidenceHandoff: boolOr(r.lowConfidenceHandoff, base.lowConfidenceHandoff),
    messageRules,
    interceptRetention,
    interceptCourseShopping: boolOr(
      r.interceptCourseShopping,
      base.interceptCourseShopping,
    ),
    retentionKeywords: strList(r.retentionKeywords),
    courseShoppingKeywords: strList(r.courseShoppingKeywords),
    departmentAliases: {
      acolhimento: strList(aliasesRaw.acolhimento),
      retencao: strList(aliasesRaw.retencao),
      atendimento: strList(aliasesRaw.atendimento),
    },
    inauguralEnabled: boolOr(r.inauguralEnabled, base.inauguralEnabled),
    inauguralUrl: nullableText(r.inauguralUrl),
    inauguralDates: strList(r.inauguralDates).filter((d) =>
      /^\d{4}-\d{2}-\d{2}$/.test(d),
    ),
    scope: normalizeAttendanceScope(r.scope),
    handoffMessage: nullableText(r.handoffMessage),
    retentionHandoffMessage: nullableText(r.retentionHandoffMessage),
    useMessageModels: boolOr(r.useMessageModels, base.useMessageModels),
    unknownAnswerMode: isUnknownAnswerMode(r.unknownAnswerMode)
      ? r.unknownAnswerMode
      : base.unknownAnswerMode,
    unknownAnswerMessage: nullableText(r.unknownAnswerMessage),
    knowledgeExpiredInstruction: nullableText(r.knowledgeExpiredInstruction),
    media: normalizeMediaInboundPolicy(r.media),
    inboundBatchWindowMinutes: nonNegativeInt(
      r.inboundBatchWindowMinutes,
      base.inboundBatchWindowMinutes,
    ),
    transferPolicy: isTransferPolicy(r.transferPolicy)
      ? r.transferPolicy
      : base.transferPolicy,
    humanAttendanceHours: normalizeBusinessHours(r.humanAttendanceHours),
    humanAttendancePreEndMinutes:
      typeof r.humanAttendancePreEndMinutes === "number" &&
      Number.isFinite(r.humanAttendancePreEndMinutes) &&
      r.humanAttendancePreEndMinutes >= 0
        ? Math.floor(r.humanAttendancePreEndMinutes)
        : null,
    queueMessage: nullableText(r.queueMessage),
    assignedConsultantMessage: nullableText(r.assignedConsultantMessage),
    audioHandoffMessage: nullableText(r.audioHandoffMessage),
    humanRequestKeywords: strList(r.humanRequestKeywords),
  };
}

/**
 * Bloco de prompt que ensina o modelo a reconhecer que NÃO tem base e o
 * que fazer nesse caso.
 *
 * A regra de confiança morava em `pack.constants.confidenceRules`
 * (acadêmico). Sem pack o modelo nunca emitia `[CONFIANCA:x]`, então
 * `parseAgentConfidence` devolvia null e o handoff por baixa confiança
 * nunca disparava: o agente genérico preferia inventar a admitir.
 */
/**
 * A frase do operador promete transferência?
 *
 * Genérico: verbos de encaminhamento em pt-BR, nenhum tema de vertical.
 * "Vou verificar com a equipe" (que é justamente o que o modo `acknowledge`
 * manda dizer) NÃO conta — só a promessa de passar o atendimento adiante.
 */
export function messagePromisesTransfer(
  message: string | null | undefined,
): boolean {
  const n = fold(message ?? "").replace(/\s+/g, " ");
  if (!n) return false;
  return (
    /transfer|encaminh|redirecion|direcion|repass/.test(n) ||
    /\b(te |voce |vc )?(passo|passar|passando|passei) (voce |vc |te )?(para|pra|pro)\b/.test(n) ||
    /\b(te|voce|vc) (conecto|conectar|conectando|coloco|colocar) (com|na fila|para|pra|pro)\b/.test(n) ||
    /\bvou (te |voce |vc )?(conectar|colocar na fila)\b/.test(n)
  );
}

export function buildUnknownAnswerBlock(
  policy: InboxPolicy,
  opts?: { transferBlocked?: boolean },
): string {
  const threshold = policy.confidenceThreshold ?? 0.4;
  // Instruir `handoff` com o gate de transferência fechado fazia o modelo
  // prometer ao cliente uma transferência que a tool ia recusar, e o turno
  // seguinte repetia a promessa. O prompt nunca instrui o que o gate nega.
  const mode = opts?.transferBlocked ? "acknowledge" : policy.unknownAnswerMode;
  const lines = ["## QUANDO VOCÊ NÃO SOUBER (regra dura)"];

  if (policy.lowConfidenceHandoff) {
    lines.push(
      `Termine SEMPRE a resposta com a linha [CONFIANCA:X.X] (0.0 a 1.0).`,
      `- 0.85+ em saudação, agradecimento ou despedida — isso não é falta de base.`,
      `- 0.8+ quando as referências e modelos cobrem o que foi perguntado.`,
      `- abaixo de ${threshold.toFixed(2)} SÓ quando a pergunta é factual e nada na base cobre.`,
    );
  }

  lines.push(
    "PROIBIDO inventar dado, prazo, valor, link ou procedimento que não esteja nas referências.",
    "PROIBIDO usar \"geralmente\", \"normalmente\" ou \"acredito que\" para preencher lacuna.",
  );

  // A frase do operador foi escrita para o modo dele, não para o modo que
  // o gate impôs: mandar dizer "vou te transferir" no mesmo bloco que
  // proíbe transferir era o próprio código produzindo a contradição.
  // Descartada inteira (higienizar texto de operador é reescrever o que
  // ele escreveu) — a validação de configuração avisa quem configurou.
  const operatorMessage =
    mode === "acknowledge" && messagePromisesTransfer(policy.unknownAnswerMessage)
      ? null
      : policy.unknownAnswerMessage;

  if (operatorMessage) {
    lines.push(`Ao admitir que não sabe, use esta frase: "${operatorMessage}"`);
  } else {
    lines.push("Ao admitir que não sabe, seja direto e mantenha o tom configurado.");
  }

  if (mode === "handoff") {
    lines.push(
      "Sem base: admita em uma frase e transfira para um humano na MESMA resposta, usando as tools de transferência.",
    );
  } else if (mode === "clarify") {
    lines.push(
      "Sem base: faça UMA pergunta objetiva para tentar destravar.",
      "Se a resposta do cliente ainda não permitir responder com a base, aí sim admita e transfira.",
    );
  } else {
    lines.push(
      "Sem base: admita, diga que vai verificar com a equipe e siga o atendimento nos pontos que você domina.",
      "NÃO transfira só por não saber um item — continue disponível.",
    );
  }

  return lines.join("\n");
}

/** true se algum dos termos extras aparece na mensagem (sem acento/caixa). */
export function matchesAnyKeyword(
  message: string | null | undefined,
  keywords: string[],
): boolean {
  if (!message || keywords.length === 0) return false;
  const haystack = fold(message);
  return keywords.some((k) => {
    const needle = fold(k);
    return needle.length > 0 && haystack.includes(needle);
  });
}
