/**
 * Mede o contrato de atendimento por conversa — SOMENTE LEITURA.
 *
 * Os cinco critérios do contrato (ver AGENTS.md, "Atendimento IA"), medidos
 * no rastro que já existe: mensagens, `AIAgentRun` e o trace de tools em
 * `AIAgentMessage`. Sem isso, "funcionou?" depende de alguém abrir o print e
 * ler a conversa.
 *
 * O recorte é o atendimento em curso (`RETRIEVAL_SESSION_GAP_MS`), o mesmo
 * que o motor usa para decidir que o assunto acabou.
 *
 * EasyPanel (/app, depois do deploy):
 *   node dist/workers/audit-attendance.js --org teste-dev
 *   node dist/workers/audit-attendance.js --org teste-dev --dias 3 --out /tmp/atendimento.json
 *
 * Local:
 *   npx tsx src/scripts/audit-attendance.ts --org teste-dev
 *
 * prismaBase: script fora de RequestContext (resolve a org pelo slug).
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { prismaBase } from "@/lib/prisma-base";
import { RETRIEVAL_SESSION_GAP_MS } from "@/services/ai/retrieval-query";

/** Tool genérica de consulta: é por ela que a identificação acontece. */
const LOOKUP_TOOL = "search_crm_records";

function arg(flag: string, fallback = ""): string {
  const i = process.argv.indexOf(flag);
  if (i < 0) return fallback;
  return process.argv[i + 1] ?? fallback;
}

type Criterio = {
  ok: boolean;
  /** Número que sustenta o veredito — sem ele o relatório não é acionável. */
  detalhe: string;
};

type Relatorio = {
  conversationId: string;
  contato: string;
  inicioDoAtendimento: string;
  criterios: {
    todaMensagemRespondida: Criterio;
    umaTransferenciaPorAssunto: Criterio;
    identificacaoUmaVez: Criterio;
    semAgenteRepetido: Criterio;
    desfechoExplicito: Criterio;
  };
  /** true só quando os cinco passam. */
  aprovado: boolean;
};

/** Início do atendimento em curso: anda para trás até o primeiro silêncio. */
function sessionStart(times: Date[]): Date | null {
  if (times.length === 0) return null;
  const desc = [...times].sort((a, b) => b.getTime() - a.getTime());
  let start = desc[0];
  for (let i = 1; i < desc.length; i += 1) {
    if (start.getTime() - desc[i].getTime() > RETRIEVAL_SESSION_GAP_MS) break;
    start = desc[i];
  }
  return start;
}

async function main() {
  const orgSlug = arg("--org").trim();
  const dias = Number(arg("--dias", "1")) || 1;
  const out = arg("--out", "/tmp/atendimento.json");

  if (!orgSlug) {
    console.error("Informe a organização: --org <slug>");
    process.exit(1);
  }
  const org = await prismaBase.organization.findUnique({
    where: { slug: orgSlug },
    select: { id: true },
  });
  if (!org) {
    console.error(`Organização "${orgSlug}" não encontrada.`);
    process.exit(1);
  }

  const desde = new Date(Date.now() - dias * 24 * 60 * 60 * 1000);
  const conversas = await prismaBase.conversation.findMany({
    where: {
      organizationId: org.id,
      messages: { some: { createdAt: { gte: desde }, direction: "in" } },
    },
    select: {
      id: true,
      status: true,
      aiIdentifiedAt: true,
      assignedTo: { select: { type: true } },
      contact: { select: { name: true } },
      messages: {
        where: { isPrivate: false, messageType: { not: "note" } },
        orderBy: { createdAt: "asc" },
        select: { direction: true, authorType: true, createdAt: true },
      },
    },
    take: 200,
  });

  const relatorios: Relatorio[] = [];

  for (const conv of conversas) {
    const inicio = sessionStart(conv.messages.map((m) => m.createdAt));
    if (!inicio) continue;
    const msgs = conv.messages.filter((m) => m.createdAt >= inicio);

    // 1. Toda mensagem do cliente recebe resposta. Inbound seguido de outro
    // inbound sem nada do bot no meio é o buraco — menos a última, que pode
    // estar sendo processada agora.
    const semResposta = msgs.filter((m, i) => {
      if (m.direction !== "in") return false;
      const depois = msgs.slice(i + 1);
      if (depois.length === 0) return false;
      const proximoIn = depois.findIndex((n) => n.direction === "in");
      const janela = proximoIn < 0 ? depois : depois.slice(0, proximoIn);
      return !janela.some((n) => n.direction === "out");
    }).length;

    const runs = await prismaBase.aIAgentRun.findMany({
      where: { conversationId: conv.id, createdAt: { gte: inicio } },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        agentId: true,
        outcome: true,
        createdAt: true,
        agent: { select: { user: { select: { name: true } } } },
      },
    });

    // 2 e 4. Transferências e reincidência de agente no mesmo atendimento.
    const transferencias = runs.filter(
      (r) => r.outcome === "HANDOFF_COMPLETED",
    ).length;
    const porAgente = new Map<string, number>();
    for (const r of runs) {
      porAgente.set(r.agentId, (porAgente.get(r.agentId) ?? 0) + 1);
    }
    const agentesQueVoltaram = [...runs]
      .filter((r, i, all) => {
        const anterior = all.slice(0, i);
        const outroNoMeio = anterior.some((p) => p.agentId !== r.agentId);
        const jaTinhaRodado = anterior.some((p) => p.agentId === r.agentId);
        return outroNoMeio && jaTinhaRodado;
      })
      .map((r) => r.agent?.user?.name ?? r.agentId);

    // 3. Identificação uma vez só: consulta de identificação depois de a
    // conversa já estar identificada é o agente perguntando de novo.
    const lookupsDepois = conv.aiIdentifiedAt
      ? await prismaBase.aIAgentMessage.count({
          where: {
            runId: { in: runs.map((r) => r.id) },
            toolName: LOOKUP_TOOL,
            createdAt: { gt: conv.aiIdentifiedAt },
          },
        })
      : 0;

    // 5. Desfecho: resolvido (encerrada), com humano, ou na fila.
    const comHumano = conv.assignedTo?.type === "HUMAN";
    const naFila = await prismaBase.distributionPending.count({
      where: { conversationId: conv.id, status: "PENDING" },
    });
    const encerrada = conv.status !== "OPEN";
    const ultima = msgs.at(-1);
    const paradaNoCliente =
      ultima?.direction === "in" &&
      Date.now() - ultima.createdAt.getTime() > RETRIEVAL_SESSION_GAP_MS;

    const criterios: Relatorio["criterios"] = {
      todaMensagemRespondida: {
        ok: semResposta === 0,
        detalhe: `${semResposta} mensagem(ns) do cliente sem resposta`,
      },
      umaTransferenciaPorAssunto: {
        ok: transferencias <= 1,
        detalhe: `${transferencias} transferência(s) no atendimento`,
      },
      identificacaoUmaVez: {
        ok: lookupsDepois === 0,
        detalhe: conv.aiIdentifiedAt
          ? `${lookupsDepois} consulta(s) de identificação depois de já identificado`
          : "conversa não identificada",
      },
      semAgenteRepetido: {
        ok: agentesQueVoltaram.length === 0,
        detalhe:
          agentesQueVoltaram.length === 0
            ? "nenhum agente recebeu a conversa duas vezes"
            : `voltou para: ${[...new Set(agentesQueVoltaram)].join(", ")}`,
      },
      desfechoExplicito: {
        ok: encerrada || comHumano || naFila > 0 || !paradaNoCliente,
        detalhe: encerrada
          ? "encerrada"
          : comHumano
            ? "com atendente humano"
            : naFila > 0
              ? "na fila humana"
              : paradaNoCliente
                ? "parada depois de uma mensagem do cliente"
                : "em andamento",
      },
    };

    relatorios.push({
      conversationId: conv.id,
      contato: conv.contact?.name ?? "(sem nome)",
      inicioDoAtendimento: inicio.toISOString(),
      criterios,
      aprovado: Object.values(criterios).every((c) => c.ok),
    });
  }

  const reprovadas = relatorios.filter((r) => !r.aprovado);
  const resumo = {
    organizacao: orgSlug,
    janelaDias: dias,
    atendimentos: relatorios.length,
    aprovados: relatorios.length - reprovadas.length,
    reprovados: reprovadas.length,
    porCriterio: {
      semResposta: relatorios.filter(
        (r) => !r.criterios.todaMensagemRespondida.ok,
      ).length,
      transferenciaDemais: relatorios.filter(
        (r) => !r.criterios.umaTransferenciaPorAssunto.ok,
      ).length,
      identificacaoRepetida: relatorios.filter(
        (r) => !r.criterios.identificacaoUmaVez.ok,
      ).length,
      agenteRepetido: relatorios.filter((r) => !r.criterios.semAgenteRepetido.ok)
        .length,
      semDesfecho: relatorios.filter((r) => !r.criterios.desfechoExplicito.ok)
        .length,
    },
  };

  const destino = resolve(out);
  writeFileSync(destino, JSON.stringify({ resumo, relatorios }, null, 2));

  console.log(JSON.stringify(resumo, null, 2));
  console.log(`\nDetalhe por conversa em ${destino}`);
  for (const r of reprovadas.slice(0, 10)) {
    const falhas = Object.entries(r.criterios)
      .filter(([, c]) => !c.ok)
      .map(([nome, c]) => `${nome} (${c.detalhe})`);
    console.log(`  - ${r.contato} [${r.conversationId}]: ${falhas.join("; ")}`);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prismaBase.$disconnect());
