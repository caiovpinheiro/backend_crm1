/**
 * O relatório acadêmico como FONTE consultável, não como ferramenta.
 *
 * Antes isto era `consultar_matricula`: uma tool que o motor precisava
 * conhecer pelo nome, com regra de negócio embutida (derivava "pode acessar
 * o portal" de `situacao`) e uma allowlist paralela à do CRM. Todo tenant
 * novo herdava a pergunta "e a minha matrícula?" mesmo sem ter matrícula.
 *
 * Agora o relatório é uma entidade como contato ou negócio: o operador
 * escolhe na tela quais campos dela identificam a pessoa e quais o agente
 * pode ler, e a consulta acontece pela ferramenta genérica do núcleo. O
 * vocabulário ("aluno", "polo", "RGM") mora aqui, no pack, e em lugar
 * nenhum do motor.
 *
 * `StudentAcademicRecord` não passa pela extension multi-tenant do Prisma:
 * toda query abaixo filtra `organizationId` explicitamente.
 */
import { prisma } from "@/lib/prisma";
import {
  canonicalPhone,
  canonicalRgm,
  lookupStudent,
  normalizeCpf,
} from "@/services/academic-records";
import type { RawRecord, RecordSource } from "@/services/ai/record-sources";

/** Id da entidade. Prefixo das chaves de configuração ("matricula.polo"). */
export const ACADEMIC_RECORD_ENTITY = "matricula";

/**
 * Colunas do relatório.
 *
 * `readable: false` é veto estrutural, acima da allowlist do operador: CPF,
 * data de nascimento, telefone e e-mail pessoal servem para ACHAR a linha e
 * nunca para o agente dizer em voz alta. Não existe configuração que libere
 * — e é justamente por serem pesquisáveis que a pessoa consegue se
 * identificar com eles.
 */
const FIELDS: RecordSource["fields"] = [
  { name: "nome", label: "Nome do aluno" },
  { name: "curso", label: "Curso" },
  { name: "polo", label: "Polo" },
  { name: "serie", label: "Série / semestre" },
  { name: "ciclo", label: "Ciclo" },
  { name: "rgm", label: "RGM / número de matrícula" },
  { name: "emailAcademico", label: "E-mail acadêmico" },
  { name: "instituicao", label: "Instituição" },
  { name: "tipoMatricula", label: "Tipo de matrícula (nova / rematrícula)" },
  { name: "dataMatricula", label: "Data da matrícula" },
  { name: "situacao", label: "Situação da matrícula" },
  { name: "cpf", label: "CPF", readable: false },
  { name: "dataNascimento", label: "Data de nascimento", readable: false },
  { name: "phone", label: "Telefone do relatório", readable: false },
  { name: "email", label: "E-mail pessoal do relatório", readable: false },
];

/** Colunas de texto que aceitam casamento exato. `raw` e datas ficam fora. */
const MATCHABLE = new Set([
  "cpf",
  "rgm",
  "nome",
  "curso",
  "serie",
  "polo",
  "ciclo",
  "instituicao",
  "situacao",
  "tipoMatricula",
  "email",
  "emailAcademico",
  "phone",
]);

type Row = Awaited<
  ReturnType<typeof prisma.studentAcademicRecord.findFirst>
>;

function toRecord(row: NonNullable<Row>): RawRecord {
  return {
    id: row.id,
    // Sem número nem nome: `ref` passa por fora da allowlist de leitura, e o
    // modelo repete essa string ao aluno. Qualquer valor de campo aqui
    // seria um vazamento silencioso.
    ref: "registro acadêmico",
    builtin: row as unknown as Record<string, unknown>,
    custom: [],
  };
}

/**
 * Variações do valor informado que valem tentar na coluna.
 *
 * O relatório guarda o texto cru da planilha, então o mesmo RGM aparece com
 * e sem máscara e o CPF com e sem zero à esquerda. O casamento final ainda
 * passa pelo núcleo (`identityValueMatches`), que é exato.
 */
function candidatesFor(column: string, informed: string[]): string[] {
  const out = new Set(informed.filter(Boolean));
  for (const v of informed) {
    if (column === "cpf") {
      const cpf = normalizeCpf(v);
      if (cpf) out.add(cpf);
    } else if (column === "rgm") {
      const rgm = canonicalRgm(v);
      if (rgm) out.add(rgm);
    } else if (column === "phone") {
      const phone = canonicalPhone(v);
      if (phone) out.add(phone);
    }
  }
  return [...out];
}

export const academicRecordSource: RecordSource = {
  entity: ACADEMIC_RECORD_ENTITY,
  label: "Matrículas (relatório acadêmico)",
  fields: FIELDS,
  // O relatório é importado inteiro de uma planilha: não há campo
  // personalizado do CRM pendurado nele.
  supportsCustomValues: false,
  identifiesPerson: true,
  // Um aluno tem uma linha por curso/ciclo, e o mesmo telefone pode trazer
  // duas pessoas (o número da mãe cadastrado para dois filhos). É por isso
  // que o desempate por campo-chave existe.
  multiplePerContact: true,
  sharedCatalog: false,

  forContact: async (q) => {
    if (!q.contact) return [];
    const rows = await lookupStudent(q.organizationId, {
      phone: q.contact.phone,
      email: q.contact.email,
    });
    return rows.slice(0, Math.max(q.take, 1)).map(toRecord);
  },

  findByFieldValue: async (q) => {
    if (q.field.source !== "builtin") return [];
    if (!MATCHABLE.has(q.field.name)) return [];
    const candidates = candidatesFor(q.field.name, q.candidates);
    if (candidates.length === 0) return [];
    const rows = await prisma.studentAcademicRecord.findMany({
      where: {
        organizationId: q.organizationId,
        [q.field.name]: { in: candidates, mode: "insensitive" },
      },
      take: Math.max(q.take, 1),
    });
    return rows.map(toRecord);
  },

  searchByTerm: async (q) => {
    const contains = { contains: q.term, mode: "insensitive" as const };
    const rows = await prisma.studentAcademicRecord.findMany({
      where: {
        organizationId: q.organizationId,
        OR: [
          { nome: contains },
          { curso: contains },
          { polo: contains },
          { situacao: contains },
          { instituicao: contains },
          { rgm: contains },
        ],
      },
      take: Math.max(q.take, 1),
    });
    return rows.map(toRecord);
  },
};
