/**
 * Números do CRM para a aba "Ao vivo" do portal do aluno. Só leitura e só agregado:
 * nenhuma resposta leva nome, telefone, id de contato ou de conversa de aluno.
 *
 * Cada bloco falha sozinho: o portal mostra o que veio e marca o que ficou indisponível.
 */

import { createHmac } from "node:crypto";
import { Prisma } from "@prisma/client";

import { getLogger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { getPainelAgora } from "@/services/painel-agora";
import { computePainelRange } from "@/services/painel-period";
import { getPainelServiceExceptions } from "@/services/painel-service";
import { getPainelTeamRanking } from "@/services/painel-team";

const log = getLogger("services/painel-portal-aluno");

export const PORTAL_MAX_AUTOMACOES = 5;
export const PORTAL_MAX_PASSOS_ALCANCE = 10;
export const PORTAL_MAX_PASSOS_COORTE = 12;
const MAX_DIAS_ATENDENTE = 90;
const UM_DIA_MS = 86_400_000;

export type PortalBloco<T> = { ok: true; data: T } | { ok: false; error: string };

export type PortalAutomacao = {
  id: string;
  nome: string;
  ativa: boolean;
  atualizadaEm: string;
  passos: { id: string; tipo: string }[];
  porDia: { dia: string; passo: string | null; status: string; n: number }[];
  ultimoRegistroEm: string | null;
};

export type PortalCoorteItem = { k: string; em: string; ok: boolean };

export type PortalAtendente = { id: string; nome: string; atendidas: number; encerradas: number };

export type PainelPortalAluno = {
  geradoEm: string;
  desde: string;
  automacoes: PortalBloco<PortalAutomacao[]>;
  /** Por passo, chaves embaralhadas dos telefones que passaram por ele. Vazio sem chave. */
  alcance: PortalBloco<Record<string, string[]>>;
  /** Testes A/B/C: por passo, quando cada telefone embaralhado passou e se o envio deu certo. */
  coorte: PortalBloco<Record<string, PortalCoorteItem[]>>;
  atendimento: PortalBloco<{
    aguardandoResposta: number;
    emAtendimento: number;
    maiorEsperaComercialMs: number;
    maiorEsperaCorridaMs: number;
    acimaDoSla: boolean;
    slaMinutos: number;
    atendentesOnline: number;
    atendentesTotal: number;
    semResposta: number;
    abertasMais24h: number;
    semResponsavel: number;
    comFalhaDeEnvio: number;
  }>;
  atendentes: PortalBloco<{
    hoje: PortalAtendente[];
    periodo: PortalAtendente[];
    periodoDesde: string;
    cortado: boolean;
  }>;
};

/** DDD + 8 últimos dígitos: o mesmo número com e sem o nono dígito vira a mesma chave. */
export function chaveTelefone(phone: string | null | undefined): string | null {
  let d = String(phone ?? "").replace(/\D/g, "");
  if (d.length >= 12 && d.startsWith("55")) d = d.slice(2);
  if (d.length < 10) return null;
  return d.slice(0, 2) + d.slice(-8);
}

export function embaralharTelefone(chave: string, phone: string | null | undefined): string | null {
  const k = chaveTelefone(phone);
  return k ? createHmac("sha256", chave).update(k).digest("hex").slice(0, 32) : null;
}

export function desdeValido(raw: string | null): string | null {
  const s = String(raw ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const d = new Date(`${s}T12:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s ? s : null;
}

async function bloco<T>(nome: string, fn: () => Promise<T>): Promise<PortalBloco<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (err) {
    log.error({ err, bloco: nome }, "[painel-portal-aluno] bloco falhou");
    return { ok: false, error: "Falha ao carregar este bloco." };
  }
}

// Início do dia em Brasília (-03:00, sem horário de verão).
const inicioDoDia = (dia: string) => new Date(`${dia}T00:00:00-03:00`);

async function lerAutomacoes(
  orgId: string,
  ids: string[],
  desde: string,
): Promise<PortalAutomacao[]> {
  const automacoes = await prisma.automation.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      name: true,
      active: true,
      updatedAt: true,
      steps: { select: { id: true, type: true }, orderBy: { position: "asc" } },
    },
  });
  const linhas = await prisma.$queryRaw<
    { automationId: string; stepId: string | null; status: string; dia: string; n: number; ultimo: Date }[]
  >(Prisma.sql`
    SELECT "automationId", "stepId", status,
           to_char("executedAt" AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD') AS dia,
           COUNT(*)::int AS n, MAX("executedAt") AS ultimo
    FROM automation_logs
    WHERE "organizationId" = ${orgId}
      AND "automationId" IN (${Prisma.join(ids)})
      AND "executedAt" >= ${inicioDoDia(desde)}
    GROUP BY 1, 2, 3, 4
    ORDER BY dia
  `);
  return automacoes.map((a) => {
    const minhas = linhas.filter((l) => l.automationId === a.id);
    const ultimo = minhas.reduce<Date | null>(
      (m, l) => (!m || new Date(l.ultimo) > m ? new Date(l.ultimo) : m),
      null,
    );
    return {
      id: a.id,
      nome: a.name,
      ativa: a.active,
      atualizadaEm: a.updatedAt.toISOString(),
      passos: a.steps.map((s) => ({ id: s.id, tipo: s.type })),
      porDia: minhas.map((l) => ({ dia: l.dia, passo: l.stepId, status: l.status, n: Number(l.n) })),
      ultimoRegistroEm: ultimo ? ultimo.toISOString() : null,
    };
  });
}

async function lerAlcance(
  orgId: string,
  ids: string[],
  passos: string[],
  desde: string,
  chave: string | null,
): Promise<Record<string, string[]>> {
  const out: Record<string, Set<string>> = {};
  passos.forEach((p) => {
    out[p] = new Set();
  });
  if (chave && passos.length) {
    const linhas = await prisma.$queryRaw<{ stepId: string; phone: string | null }[]>(Prisma.sql`
      SELECT DISTINCT l."stepId", c.phone
      FROM automation_logs l
      INNER JOIN contacts c ON c.id = l."contactId"
      WHERE l."organizationId" = ${orgId}
        AND c."organizationId" = ${orgId}
        AND l."automationId" IN (${Prisma.join(ids)})
        AND l."stepId" IN (${Prisma.join(passos)})
        AND l.status = 'SUCCESS'
        AND l."executedAt" >= ${inicioDoDia(desde)}
    `);
    linhas.forEach((l) => {
      const k = embaralharTelefone(chave, l.phone);
      if (k) out[l.stepId]?.add(k);
    });
  }
  return Object.fromEntries(Object.entries(out).map(([p, s]) => [p, [...s]]));
}

async function lerCoorte(
  orgId: string,
  ids: string[],
  passos: string[],
  desde: string,
  chave: string | null,
): Promise<Record<string, PortalCoorteItem[]>> {
  const out: Record<string, Map<string, PortalCoorteItem>> = {};
  passos.forEach((p) => {
    out[p] = new Map();
  });
  if (chave && passos.length) {
    const linhas = await prisma.$queryRaw<
      { stepId: string; phone: string | null; em: Date; ok: boolean }[]
    >(Prisma.sql`
      SELECT l."stepId", c.phone, MIN(l."executedAt") AS em, BOOL_OR(l.status = 'SUCCESS') AS ok
      FROM automation_logs l
      INNER JOIN contacts c ON c.id = l."contactId"
      WHERE l."organizationId" = ${orgId}
        AND c."organizationId" = ${orgId}
        AND l."automationId" IN (${Prisma.join(ids)})
        AND l."stepId" IN (${Prisma.join(passos)})
        AND l.status IN ('SUCCESS', 'FAILED', 'FAILED_HANDLED')
        AND l."executedAt" >= ${inicioDoDia(desde)}
      GROUP BY 1, 2
    `);
    linhas.forEach((l) => {
      const k = embaralharTelefone(chave, l.phone);
      const passo = out[l.stepId];
      if (!k || !passo) return;
      const em = new Date(l.em).toISOString();
      // Formatos diferentes do mesmo número viram uma entrada só: vale a primeira passagem.
      const antes = passo.get(k);
      if (!antes) passo.set(k, { k, em, ok: Boolean(l.ok) });
      else passo.set(k, { k, em: em < antes.em ? em : antes.em, ok: antes.ok || Boolean(l.ok) });
    });
  }
  return Object.fromEntries(Object.entries(out).map(([p, m]) => [p, [...m.values()]]));
}

async function lerAtendimento() {
  const [comercial, corrida, excecoes] = await Promise.all([
    getPainelAgora("business"),
    getPainelAgora("elapsed"),
    getPainelServiceExceptions("business"),
  ]);
  const n = (key: string) => excecoes.find((e) => e.key === key)?.count ?? 0;
  // Nome do contato e id da conversa com a maior espera ficam fora de propósito.
  return {
    aguardandoResposta: comercial.awaitingReply,
    emAtendimento: comercial.inService,
    maiorEsperaComercialMs: comercial.longestWait.ms,
    maiorEsperaCorridaMs: corrida.longestWait.ms,
    acimaDoSla: comercial.longestWait.overSla,
    slaMinutos: comercial.longestWait.slaMinutes,
    atendentesOnline: comercial.agents.online,
    atendentesTotal: comercial.agents.total,
    semResposta: n("no_reply"),
    abertasMais24h: n("open_24h"),
    semResponsavel: n("unassigned"),
    comFalhaDeEnvio: n("send_failure"),
  };
}

function diaBrasilia(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Sao_Paulo" }).format(d);
}

async function lerAtendentes(desde: string, agora: Date) {
  const escopo = { departmentIds: [], userIds: [] };
  const hoje = diaBrasilia(agora);
  const limite = diaBrasilia(new Date(agora.getTime() - MAX_DIAS_ATENDENTE * UM_DIA_MS));
  const periodoDesde = desde < limite ? limite : desde;
  const [doDia, doPeriodo] = await Promise.all([
    getPainelTeamRanking(computePainelRange("custom", hoje, hoje, agora), "business", escopo),
    getPainelTeamRanking(computePainelRange("custom", periodoDesde, hoje, agora), "business", escopo),
  ]);
  // Só contagens de atendentes humanos. Tempo médio fica fora: abertura até encerramento
  // inclui a espera pelo aluno e o robô, e não mede a resposta do atendente.
  const linhas = (rows: typeof doDia.rows): PortalAtendente[] =>
    rows.map((r) => ({ id: r.id, nome: r.name, atendidas: r.attended, encerradas: r.finished }));
  return {
    hoje: linhas(doDia.rows),
    periodo: linhas(doPeriodo.rows),
    periodoDesde,
    cortado: doDia.capped || doPeriodo.capped,
  };
}

export async function getPainelPortalAluno(input: {
  organizationId: string;
  automacoes: string[];
  passosAlcance: string[];
  passosCoorte: string[];
  desde: string;
  /** Sem chave (sessão de navegador), o alcance volta vazio. */
  chaveAlcance: string | null;
  agora?: Date;
}): Promise<PainelPortalAluno> {
  const agora = input.agora ?? new Date();
  const { organizationId: org, automacoes: ids, passosAlcance, passosCoorte, desde, chaveAlcance } = input;
  const [automacoes, alcance, coorte, atendimento, atendentes] = await Promise.all([
    bloco("automacoes", () => lerAutomacoes(org, ids, desde)),
    bloco("alcance", () => lerAlcance(org, ids, passosAlcance, desde, chaveAlcance)),
    bloco("coorte", () => lerCoorte(org, ids, passosCoorte, desde, chaveAlcance)),
    bloco("atendimento", lerAtendimento),
    bloco("atendentes", () => lerAtendentes(desde, agora)),
  ]);
  return { geradoEm: agora.toISOString(), desde, automacoes, alcance, coorte, atendimento, atendentes };
}
