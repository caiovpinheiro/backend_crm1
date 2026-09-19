/**
 * `consultar_matricula` — ferramenta do vertical acadêmico.
 *
 * Mora aqui, e não em `src/services/ai/tools.ts`, porque matrícula é
 * característica de UM produto. Enquanto ela estava no `FACTORY_MAP` do
 * núcleo, todo tenant novo — clínica, loja, escritório — herdava uma
 * ferramenta que fala de aluno, portal e polo. O núcleo sabe COMO chamar
 * uma ferramenta; QUAIS ferramentas existem é do pack do tenant.
 *
 * O núcleo resolve este factory por `extraTools` do pack (`buildToolSet`).
 * Tenant sem o pack acadêmico não vê a ferramenta nem no prompt nem na tela.
 */
import { tool } from "ai";
import { z } from "zod";

import { prisma } from "@/lib/prisma";
import type { ToolPolicy } from "@/lib/ai-agents/steering";
import { getOrgIdOrNull } from "@/lib/request-context";
import { lookupStudent } from "@/services/academic-records";
import {
  ACADEMIC_LOOKUP_GUIDANCE,
  describeAcademicExposure,
  describeAcademicIdentity,
  normalizeAcademicIdentityKeys,
  type AcademicIdentityKey,
} from "@/services/ai/academic-record-policy";
import { academicLookupForModel } from "@/services/ai/sensitive-fields";
import { fail, ok, type RunContext } from "@/services/ai/tools";

/** Texto da ferramenta na tela e no prompt — cópia do pack, não do núcleo. */
export const CONSULTAR_MATRICULA_TOOL_META = {
  id: "consultar_matricula",
  label: "Consultar registro acadêmico",
  description:
    "Consulta o registro da pessoa no relatório acadêmico da organização. Casa por telefone/e-mail do contato. Demais campos só chegam se o operador liberar na ferramenta.",
  category: "crm" as const,
  defaultForArchetypes: ["ATENDIMENTO", "SUPORTE"],
};

/**
 * Mensagem padrão de transferência quando o aluno pede dado pessoal específico.
 * Mantida no código para consistência (o agente deve reproduzi-la ao transferir).
 */
const MATRICULA_TRANSFER_MESSAGE =
  "Para garantir a segurança dos seus dados, vou te transferir para um de nossos consultores, que poderá confirmar essas informações com você. Só um instante, por favor. 🙂";

/**
 * Limite de alcance de `podeAcessarPortal`, anexado à description.
 *
 * O modelo respondeu "seu acesso ao Blackboard está liberado" a partir de
 * `podeAcessarPortal: true`, enquanto o campo do CRM registrava o contrário.
 * O bit é sobre UM acesso; generalizar para outros sistemas é invenção.
 */
const MATRICULA_SCOPE_NOTE =
  "ALCANCE: `podeAcessarPortal` responde UMA pergunta — o acesso ao portal está ativo. Não vale como resposta sobre nenhum outro sistema, ferramenta, produto ou campo do cadastro, mesmo que o nome pareça relacionado. Se a pergunta é sobre um item específico registrado no cadastro, esta ferramenta não responde: consulte os campos do CRM. Nunca converta este bit em afirmação sobre outra coisa.";

export function consultarMatriculaTool(ctx: RunContext, policy: ToolPolicy) {
  const transferMessage = policy.transferMessage ?? MATRICULA_TRANSFER_MESSAGE;
  // A allowlist do operador mora no mesmo campo que `search_crm_records`
  // usa (`toolConfig[tool].readableFields`); a normalização descarta o que
  // não é coluna do relatório.
  const readableFields = policy.readableFields;
  // Identificadores que ESTA organização declarou. Vazio = a ferramenta
  // mantém exatamente o schema de antes, sem o argumento.
  const identityKeys = normalizeAcademicIdentityKeys(policy.identityKeys);
  const identityShape =
    identityKeys.length > 0
      ? {
          identificador: z
            .object({
              campo: z.enum(
                identityKeys as [AcademicIdentityKey, ...AcademicIdentityKey[]],
              ),
              valor: z.string().min(3),
            })
            .optional()
            .describe(
              "Número que a pessoa informou no chat para ser localizada. Só preencha com o que ela escreveu; nunca com valor deduzido ou lembrado.",
            ),
        }
      : {};
  return tool({
    description: `${
      CONSULTAR_MATRICULA_TOOL_META.description
    }\n\n${ACADEMIC_LOOKUP_GUIDANCE}\n\n${describeAcademicExposure(
      readableFields,
    )}\n\n${describeAcademicIdentity(identityKeys)}\n\n${MATRICULA_SCOPE_NOTE}`,
    inputSchema: z.object({
      cpf: z
        .string()
        .optional()
        .describe(
          "CPF informado pelo aluno no chat (opcional). Só use se o telefone/e-mail não localizar a matrícula. PROIBIDO pedir o CPF ao aluno para desempatar identidade — para isso use `nomeCompleto`.",
        ),
      nomeCompleto: z
        .string()
        .optional()
        .describe(
          "Nome completo que o aluno confirmou no chat. Use quando a chamada anterior devolveu `identidade: \"confirmar_identidade\"`.",
        ),
      ...identityShape,
    }),
    execute: async (args) => {
      // `identificador` só existe no schema quando o operador configurou —
      // daí a leitura por cast em vez de desestruturação: o tipo do arg é
      // uma união entre a forma com e sem o campo.
      const { cpf, nomeCompleto } = args;
      const { identificador } = args as {
        identificador?: { campo: AcademicIdentityKey; valor: string };
      };
      try {
        const orgId = getOrgIdOrNull();
        if (!orgId) return fail("Sem organização no contexto.");
        if (!ctx.contactId) return fail("Sem contato associado à conversa.");

        const contact = await prisma.contact.findUnique({
          where: { id: ctx.contactId },
          select: { phone: true, email: true },
        });
        if (!contact) return fail("Contato não encontrado.");

        // O identificador informado no chat entra pela chave que o operador
        // declarou. Antes o número dito pela pessoa não tinha onde entrar: o
        // modelo repetia a chamada e verbalizava que havia consultado por
        // ele.
        const informed = identificador?.valor?.trim() || null;
        const informedRgm = identificador?.campo === "rgm" ? informed : null;
        const informedCpf = identificador?.campo === "cpf" ? informed : null;

        // Casamento amplo (telefone + e-mail + CPF informado) para maximizar
        // a chance de achar o registro. O que o modelo vê sai do filtro
        // abaixo — a busca ampla não vaza nada por si.
        const records = await lookupStudent(orgId, {
          phone: contact.phone,
          email: contact.email,
          cpf: cpf?.trim() || informedCpf,
          rgm: informedRgm,
        });

        // Filtro de saída: o status derivado sai sempre; os campos do
        // relatório só quando o operador liberou nominalmente. Antes o
        // payload trazia curso, polo, série e situação com um "NÃO
        // DIVULGUE" textual — e o agente respondeu "seu curso está
        // cancelado". Instrução dentro de payload não é mecanismo de
        // segurança; allowlist é.
        return ok(
          academicLookupForModel({
            records,
            readableFields,
            transferMessage,
            nomeCompleto: nomeCompleto ?? null,
          }),
        );
      } catch (err) {
        return fail(
          err instanceof Error ? err.message : "Falha ao consultar matrícula.",
        );
      }
    },
  });
}
