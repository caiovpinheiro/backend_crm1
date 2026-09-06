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
    !p.transferMessage
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

export type InboxPolicy = {
  /// Abaixo disso o backend distribui para humano. `null` = usa o
  /// default do código (0.4).
  confidenceThreshold: number | null;
  /// Liga/desliga o handoff automático por baixa confiança.
  lowConfidenceHandoff: boolean;

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
};

export function defaultInboxPolicy(): InboxPolicy {
  return {
    confidenceThreshold: null,
    lowConfidenceHandoff: true,
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
  };
}

function boolOr(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
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
    base.interceptCourseShopping = true;
    base.inauguralEnabled = true;
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

  return {
    confidenceThreshold: threshold,
    lowConfidenceHandoff: boolOr(r.lowConfidenceHandoff, base.lowConfidenceHandoff),
    interceptRetention: boolOr(r.interceptRetention, base.interceptRetention),
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
  };
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
