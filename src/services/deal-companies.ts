/**
 * Empresas vinculadas ao negócio (ex.: candidato indicado para a empresa).
 *
 * - Um negócio pode ter várias empresas; uma é a principal (o foco atual).
 *   A primeira vinculada vira principal; tirar a principal promove a mais
 *   antiga que sobrar.
 * - A principal alimenta as variáveis `{{empresa.*}}` das mensagens.
 * - Filtros/ativações "por empresa" contam TODOS os negócios vinculados,
 *   em qualquer posição (`dealIdsForCompany`).
 */
import { prisma } from "@/lib/prisma";
import { withOrgFromCtx } from "@/lib/prisma-helpers";

export type DealCompanyDto = {
  companyId: string;
  isPrimary: boolean;
  linkedAt: string;
  company: {
    id: string;
    number: number;
    name: string;
    /** CNPJ (a tela Empresas grava em `size`). */
    cnpj: string | null;
    phone: string | null;
    /** E-mail (a tela Empresas grava em `domain`). */
    email: string | null;
    cep: string | null;
    city: string | null;
    state: string | null;
    address: string | null;
  };
};

const COMPANY_SELECT = {
  id: true,
  number: true,
  name: true,
  size: true,
  phone: true,
  domain: true,
  cep: true,
  city: true,
  state: true,
  address: true,
} as const;

type CompanyRow = {
  id: string;
  number: number;
  name: string;
  size: string | null;
  phone: string | null;
  domain: string | null;
  cep: string | null;
  city: string | null;
  state: string | null;
  address: string | null;
};

function serializeCompany(c: CompanyRow): DealCompanyDto["company"] {
  return {
    id: c.id,
    number: c.number,
    name: c.name,
    cnpj: c.size,
    phone: c.phone,
    email: c.domain,
    cep: c.cep,
    city: c.city,
    state: c.state,
    address: c.address,
  };
}

/** Empresas do negócio: principal primeiro, depois por ordem de vínculo. */
export async function listDealCompanies(dealId: string): Promise<DealCompanyDto[]> {
  const rows = await prisma.dealCompany.findMany({
    where: { dealId },
    orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
    select: { companyId: true, isPrimary: true, createdAt: true, company: { select: COMPANY_SELECT } },
  });
  return rows.map((r) => ({
    companyId: r.companyId,
    isPrimary: r.isPrimary,
    linkedAt: r.createdAt.toISOString(),
    company: serializeCompany(r.company),
  }));
}

export class DealCompanyError extends Error {
  constructor(
    public readonly code: "EMPRESA_INEXISTENTE" | "EMPRESA_JA_VINCULADA" | "VINCULO_INEXISTENTE",
    message: string,
  ) {
    super(message);
  }
}

/** Vincula a empresa. A primeira do negócio (ou `primary: true`) vira principal. */
export async function linkDealCompany(
  dealId: string,
  companyId: string,
  opts: { primary?: boolean } = {},
): Promise<{ companyName: string; isPrimary: boolean }> {
  const company = await prisma.company.findFirst({ where: { id: companyId }, select: { id: true, name: true } });
  if (!company) throw new DealCompanyError("EMPRESA_INEXISTENTE", "Empresa não encontrada.");
  const exists = await prisma.dealCompany.findFirst({ where: { dealId, companyId }, select: { id: true } });
  if (exists) throw new DealCompanyError("EMPRESA_JA_VINCULADA", "Esta empresa já está vinculada ao negócio.");

  const hasPrimary = await prisma.dealCompany.findFirst({ where: { dealId, isPrimary: true }, select: { id: true } });
  const isPrimary = opts.primary === true || !hasPrimary;
  await prisma.$transaction(async (tx) => {
    if (isPrimary && hasPrimary) {
      await tx.dealCompany.updateMany({ where: { dealId, isPrimary: true }, data: { isPrimary: false } });
    }
    await tx.dealCompany.create({
      data: withOrgFromCtx({ dealId, companyId, isPrimary }),
      select: { id: true },
    });
  });
  return { companyName: company.name, isPrimary };
}

/** Marca a empresa como principal (a anterior deixa de ser). */
export async function setPrimaryDealCompany(dealId: string, companyId: string): Promise<{ companyName: string }> {
  const link = await prisma.dealCompany.findFirst({
    where: { dealId, companyId },
    select: { id: true, company: { select: { name: true } } },
  });
  if (!link) throw new DealCompanyError("VINCULO_INEXISTENTE", "Esta empresa não está vinculada ao negócio.");
  await prisma.$transaction([
    prisma.dealCompany.updateMany({ where: { dealId, isPrimary: true, NOT: { companyId } }, data: { isPrimary: false } }),
    prisma.dealCompany.update({ where: { id: link.id }, data: { isPrimary: true }, select: { id: true } }),
  ]);
  return { companyName: link.company.name };
}

/** Desvincula. Se era a principal, a mais antiga que sobrar assume. */
export async function unlinkDealCompany(dealId: string, companyId: string): Promise<{ companyName: string }> {
  const link = await prisma.dealCompany.findFirst({
    where: { dealId, companyId },
    select: { id: true, isPrimary: true, company: { select: { name: true } } },
  });
  if (!link) throw new DealCompanyError("VINCULO_INEXISTENTE", "Esta empresa não está vinculada ao negócio.");
  await prisma.dealCompany.delete({ where: { id: link.id }, select: { id: true } });
  if (link.isPrimary) {
    const next = await prisma.dealCompany.findFirst({
      where: { dealId },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    if (next) await prisma.dealCompany.update({ where: { id: next.id }, data: { isPrimary: true }, select: { id: true } });
  }
  return { companyName: link.company.name };
}

/** Empresa principal do negócio (variáveis `{{empresa.*}}`). */
export async function primaryCompanyForDeal(dealId: string): Promise<DealCompanyDto["company"] | null> {
  const row = await prisma.dealCompany.findFirst({
    where: { dealId },
    orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
    select: { company: { select: COMPANY_SELECT } },
  });
  return row ? serializeCompany(row.company) : null;
}

/** Empresa pelo id, no formato das variáveis `{{empresa.*}}`. */
export async function companyForMessages(companyId: string): Promise<DealCompanyDto["company"] | null> {
  const row = await prisma.company.findFirst({ where: { id: companyId }, select: COMPANY_SELECT });
  return row ? serializeCompany(row) : null;
}

/**
 * Negócios vinculados à empresa em QUALQUER posição (principal ou não) —
 * base dos filtros/ativações "por empresa".
 */
export async function dealIdsForCompany(companyId: string): Promise<string[]> {
  const rows = await prisma.dealCompany.findMany({ where: { companyId }, select: { dealId: true } });
  return rows.map((r) => r.dealId);
}

/**
 * Variáveis de mensagem da empresa principal: `{{empresa.nome}}`,
 * `{{empresa.cnpj}}`, `{{empresa.telefone}}`, `{{empresa.email}}`,
 * `{{empresa.cep}}`, `{{empresa.cidade}}`, `{{empresa.estado}}`,
 * `{{empresa.endereco}}` (e os mesmos em inglês sob `company.*`).
 * Sem empresa: tudo vazio (o token some, como os demais).
 */
export function companyMessageVars(c: DealCompanyDto["company"] | null): {
  empresa: Record<string, string>;
  company: Record<string, string>;
} {
  const v = (x: string | null | undefined) => (x ?? "").trim();
  const empresa = {
    nome: v(c?.name),
    cnpj: v(c?.cnpj),
    telefone: v(c?.phone),
    email: v(c?.email),
    cep: v(c?.cep),
    cidade: v(c?.city),
    estado: v(c?.state),
    endereco: v(c?.address),
  };
  const company = {
    name: empresa.nome,
    cnpj: empresa.cnpj,
    phone: empresa.telefone,
    email: empresa.email,
    cep: empresa.cep,
    city: empresa.cidade,
    state: empresa.estado,
    address: empresa.endereco,
  };
  return { empresa, company };
}
