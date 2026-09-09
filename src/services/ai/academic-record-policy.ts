/**
 * Política de exposição do relatório acadêmico para o agente de IA.
 *
 * Mesma regra do `crm-field-policy.ts`, aplicada à outra fonte de dados:
 * BUSCAR e LER são coisas diferentes. O casamento varre o relatório inteiro
 * (é assim que o telefone da conversa encontra a linha do aluno), mas o
 * modelo só recebe os campos que o operador liberou nominalmente em
 * `toolConfig.consultar_matricula.readableFields`. Nada é liberado por
 * default.
 *
 * O motivo está em `sensitive-fields.ts`: a tool já devolveu o registro
 * inteiro com um "NÃO DIVULGUE" em caixa alta no meio do payload, e o
 * modelo respondeu "seu curso está cancelado". Instrução dentro de payload
 * não é mecanismo de segurança.
 *
 * IDENTIDADE. Há um segundo risco que a allowlist não cobre: o casamento
 * por telefone cai para os últimos 8 dígitos quando o número exato não
 * bate (`lookupStudent`), e mesmo o número exato pode pertencer a duas
 * pessoas (o telefone da mãe cadastrado para dois filhos). Liberar campo
 * não pode significar entregar o dado de outra pessoa, então antes de
 * expor qualquer valor agrupamos os registros por identidade.
 */

/** Chave estável usada na configuração do operador. */
export type AcademicFieldKey =
  | "nome"
  | "curso"
  | "polo"
  | "serie"
  | "ciclo"
  | "rgm"
  | "emailAcademico"
  | "instituicao"
  | "tipoMatricula"
  | "dataMatricula"
  | "situacao";

export type AcademicFieldDescriptor = {
  key: AcademicFieldKey;
  /// Rótulo que o operador vê na tela e que o modelo recebe como nome.
  label: string;
  /// Aviso para a tela. NÃO bloqueia nada — quem decide é a allowlist.
  sensitiveHint: boolean;
  /// Texto do aviso, quando houver.
  warning?: string;
};

/**
 * Colunas do relatório que o operador PODE liberar.
 *
 * Ficam de fora, sem opção de liberar: `cpf`, `dataNascimento`, `phone`,
 * `email` (pessoal) e `raw` (a linha original inteira da planilha). São
 * chaves de identidade e dado de contato — servem para ACHAR o registro,
 * nunca para o agente falar em voz alta. É o mesmo veto incondicional que
 * `senha` tem no catálogo de campos do CRM: não existe configuração que
 * libere, porque não existe atendimento que precise.
 */
export const ACADEMIC_RECORD_FIELDS: AcademicFieldDescriptor[] = [
  { key: "nome", label: "Nome do aluno", sensitiveHint: false },
  { key: "curso", label: "Curso", sensitiveHint: false },
  { key: "polo", label: "Polo", sensitiveHint: false },
  { key: "serie", label: "Série / semestre", sensitiveHint: false },
  { key: "ciclo", label: "Ciclo", sensitiveHint: false },
  {
    key: "rgm",
    label: "RGM / número de matrícula",
    sensitiveHint: true,
    warning:
      "Identificador do aluno. Libere se o agente deve poder informar o RGM quando pedido.",
  },
  {
    key: "emailAcademico",
    label: "E-mail acadêmico",
    sensitiveHint: true,
    warning: "Dado de contato institucional.",
  },
  { key: "instituicao", label: "Instituição", sensitiveHint: false },
  {
    key: "tipoMatricula",
    label: "Tipo de matrícula (nova / rematrícula)",
    sensitiveHint: false,
  },
  {
    key: "dataMatricula",
    label: "Data da matrícula",
    sensitiveHint: true,
    warning: "Data de contrato. Raramente precisa ser dita ao aluno.",
  },
  {
    key: "situacao",
    label: "Situação da matrícula",
    sensitiveHint: true,
    warning:
      "Foi este campo que gerou o incidente: o agente respondeu 'seu curso está cancelado'. O acesso ao portal já é derivado dele sem expor o motivo — só libere se a operação realmente quiser que o agente diga a situação.",
  },
];

const FIELD_BY_KEY = new Map<string, AcademicFieldDescriptor>(
  ACADEMIC_RECORD_FIELDS.map((f) => [f.key, f]),
);

export const ACADEMIC_FIELD_KEYS: AcademicFieldKey[] =
  ACADEMIC_RECORD_FIELDS.map((f) => f.key);

/** Chave curinga que libera o relatório inteiro. */
export const ACADEMIC_WILDCARD = "matricula.*";

/**
 * Prefixo aceito nas chaves salvas. `readableFields` é compartilhado com
 * `search_crm_records` (que usa "entidade.campo"), então aceitamos as duas
 * formas: "polo" e "matricula.polo".
 */
const KEY_PREFIX = "matricula.";

function fold(s: unknown): string {
  return String(s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function stripPrefix(raw: string): string {
  const k = raw.trim();
  return k.startsWith(KEY_PREFIX) ? k.slice(KEY_PREFIX.length) : k;
}

/** O curinga global, o do relatório e a chave exata liberam o campo. */
export function isAcademicFieldReadable(
  readableFields: string[],
  key: AcademicFieldKey,
): boolean {
  if (readableFields.length === 0) return false;
  return readableFields.some((raw) => {
    const k = raw.trim().toLowerCase();
    if (k === "*" || k === ACADEMIC_WILDCARD) return true;
    return stripPrefix(k) === key.toLowerCase();
  });
}

/** Só as chaves que existem no catálogo — descarta lixo e chave de outra tool. */
export function normalizeAcademicReadableFields(
  readableFields: string[],
): AcademicFieldKey[] {
  const out: AcademicFieldKey[] = [];
  for (const key of ACADEMIC_FIELD_KEYS) {
    if (isAcademicFieldReadable(readableFields, key) && !out.includes(key)) {
      out.push(key);
    }
  }
  return out;
}

/** Linha do relatório, no mínimo que esta política precisa ler. */
export type AcademicRecordLike = {
  cpf?: string | null;
  rgm?: string | null;
  nome?: string | null;
  curso?: string | null;
  serie?: string | null;
  polo?: string | null;
  ciclo?: string | null;
  instituicao?: string | null;
  situacao?: string | null;
  tipoMatricula?: string | null;
  dataMatricula?: Date | string | null;
  emailAcademico?: string | null;
};

function rawValue(
  record: AcademicRecordLike,
  key: AcademicFieldKey,
): string | null {
  if (key === "dataMatricula") {
    const v = record.dataMatricula;
    if (!v) return null;
    const d = v instanceof Date ? v : new Date(v);
    if (Number.isNaN(d.getTime())) return null;
    // Dia no fuso do relatório (datas do Excel chegam como UTC puro).
    return d.toISOString().slice(0, 10).split("-").reverse().join("/");
  }
  const v = record[key];
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

export type AcademicEnrollmentView = {
  /// Campos liberados desta matrícula — é o que chega ao modelo.
  campos: Array<{ label: string; valor: string }>;
};

export type AcademicFieldPartition = {
  matriculas: AcademicEnrollmentView[];
  /// Rótulos de campos que EXISTEM com valor mas não foram liberados. Só o
  /// rótulo: o modelo precisa saber que o dado existe (para encaminhar em
  /// vez de negar a existência) sem receber o conteúdo.
  camposOcultos: string[];
};

/**
 * Aplica a allowlist às linhas do aluno. Sem campo liberado, devolve
 * `matriculas: []` — a tool continua respondendo o bit de acesso ao portal,
 * que é o comportamento de hoje.
 */
export function partitionAcademicFields(
  records: AcademicRecordLike[],
  readableFields: string[],
): AcademicFieldPartition {
  const released = normalizeAcademicReadableFields(readableFields);
  const matriculas: AcademicEnrollmentView[] = [];
  const camposOcultos: string[] = [];

  for (const record of records) {
    const campos: Array<{ label: string; valor: string }> = [];
    for (const key of ACADEMIC_FIELD_KEYS) {
      const valor = rawValue(record, key);
      if (!valor) continue;
      const descriptor = FIELD_BY_KEY.get(key);
      if (!descriptor) continue;
      if (released.includes(key)) {
        campos.push({ label: descriptor.label, valor });
      } else if (!camposOcultos.includes(descriptor.label)) {
        camposOcultos.push(descriptor.label);
      }
    }
    if (campos.length > 0) matriculas.push({ campos });
  }

  return { matriculas, camposOcultos };
}

// ── Identidade ─────────────────────────────────────────────────

export type StudentIdentity =
  /// Nenhuma linha para este contato.
  | { kind: "none"; records: [] }
  /// Uma pessoa, uma matrícula.
  | { kind: "single"; records: AcademicRecordLike[] }
  /// Uma pessoa com várias matrículas (cursos/ciclos). Não é risco: o
  /// agente pode perguntar de qual curso ela quer falar.
  | { kind: "multi_enrollment"; records: AcademicRecordLike[] }
  /// Linhas de PESSOAS diferentes no mesmo contato. Nenhum valor sai daqui
  /// até o nome ser confirmado.
  | { kind: "ambiguous"; records: AcademicRecordLike[]; pessoas: number };

/**
 * Chave de identidade de uma linha. CPF quando existe (é único); senão o
 * nome normalizado, que é o que sobra quando a planilha vem sem documento.
 */
function identityKeyOf(record: AcademicRecordLike): string {
  const cpf = String(record.cpf ?? "").replace(/\D/g, "");
  if (cpf) return `cpf:${cpf}`;
  const nome = fold(record.nome);
  return nome ? `nome:${nome}` : "desconhecido";
}

/**
 * Todas as linhas são da mesma pessoa? Duas pessoas no mesmo telefone
 * acontece de verdade (número da mãe cadastrado para dois filhos), e o
 * fallback de 8 dígitos do `lookupStudent` cria o caso mesmo sem isso.
 */
export function resolveStudentIdentity(
  records: AcademicRecordLike[],
): StudentIdentity {
  if (records.length === 0) return { kind: "none", records: [] };

  const groups = new Set(records.map(identityKeyOf));
  if (groups.size > 1) {
    return { kind: "ambiguous", records, pessoas: groups.size };
  }
  return records.length === 1
    ? { kind: "single", records }
    : { kind: "multi_enrollment", records };
}

/**
 * Filtra as linhas pelo nome que o aluno confirmou no chat.
 *
 * Casamento por todos os tokens do que ele digitou: "maria silva" acha
 * "MARIA APARECIDA SILVA". Pedir nome completo é a pergunta natural e não
 * expõe dado sensível — pedir CPF no WhatsApp ensina a pessoa a mandar CPF
 * para quem pedir, e o CPF não está no cadastro do contato de qualquer
 * forma (ele só chegaria se o próprio aluno digitasse).
 */
export function filterByConfirmedName(
  records: AcademicRecordLike[],
  nomeCompleto: string,
): AcademicRecordLike[] {
  const tokens = fold(nomeCompleto)
    .split(" ")
    .filter((t) => t.length >= 2);
  if (tokens.length === 0) return [];
  return records.filter((r) => {
    const nome = fold(r.nome);
    return nome.length > 0 && tokens.every((t) => nome.includes(t));
  });
}

// ── Orientação (o texto que o modelo lê) ───────────────────────

/**
 * Vai na description da tool, que é o que o LLM efetivamente lê para
 * decidir usá-la. Vocabulário de atendimento, sem regra de cliente: o que
 * a instituição chama as coisas é assunto do prompt e da base dela.
 */
export const ACADEMIC_LOOKUP_GUIDANCE = [
  "COMO USAR",
  "- Chame no início do atendimento, antes de afirmar qualquer coisa sobre a pessoa. Se não chamou, você não sabe.",
  "- O casamento é automático pelo telefone/e-mail do contato. Não peça esses dados.",
  "- Chame UMA vez por assunto. Se voltou `encontrado: false`, não tente variações — não existe registro.",
  "",
  "O QUE FAZER COM O RESULTADO",
  "- `matriculas[].campos` é o que você PODE dizer, e vale mais que a sua memória: se um campo aqui contradiz o que você ia responder, o campo está certo.",
  "- Responda em fala natural, usando o rótulo do campo como a pessoa perguntou. Nunca cole o JSON.",
  "- `camposOcultos` lista rótulos de dados que EXISTEM e que você NÃO pode ler nem repassar. Não os cite, não os deduza, não confirme nem negue o conteúdo deles. Se a pessoa pedir justamente um deles, diga que confirma com a equipe e transfira.",
  "- `varias_matriculas`: a MESMA pessoa tem mais de uma matrícula. Diga quantas são, liste os cursos e pergunte sobre qual ela quer falar antes de responder o resto.",
  "- `confirmar_identidade`: as linhas encontradas podem ser de PESSOAS DIFERENTES. Nenhum dado foi devolvido. Peça o NOME COMPLETO em uma frase gentil e chame a ferramenta de novo passando `nomeCompleto`. PROIBIDO pedir CPF.",
  "- `nao_encontrado`: não há registro para este contato. Não invente e não diga que o sistema não achou: siga o atendimento e pergunte o que precisar (por exemplo o polo da pessoa) conforme as suas regras.",
  "",
  "NUNCA",
  "- Nunca diga um dado que não veio em `matriculas[].campos`. Campo ausente é campo que você não tem — nem que a pessoa afirme que o dado é dela.",
  "- Nunca repasse CPF, data de nascimento ou telefone do cadastro: eles servem para localizar o registro e não são devolvidos a você em nenhuma configuração.",
  "- Nunca responda sobre um campo pelo que você imagina que ele significa. Um campo parecido não é o campo pedido.",
].join("\n");

/** Resumo curto do que está liberado — vai junto da description. */
export function describeAcademicExposure(readableFields: string[]): string {
  const released = normalizeAcademicReadableFields(readableFields);
  if (released.length === 0) {
    return "CONFIGURAÇÃO ATUAL: o operador ainda não liberou nenhum campo do relatório. Você recebe apenas se a pessoa tem acesso ativo ao portal; nenhum outro valor será devolvido. Se ela pedir dado da própria matrícula, encaminhe para a equipe.";
  }
  const labels = released.map((k) => FIELD_BY_KEY.get(k)?.label ?? k);
  return `CONFIGURAÇÃO ATUAL: campos liberados para leitura — ${labels.join(", ")}. Qualquer outro campo volta apenas como rótulo em \`camposOcultos\`.`;
}
