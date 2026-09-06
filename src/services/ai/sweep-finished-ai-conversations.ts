/**
 * Varredura da fila do Agente IA: encerra tickets cujo atendimento já
 * terminou mas ficaram OPEN (aluno agradeceu / pediu para encerrar, ou
 * a última mensagem é a despedida do agente).
 *
 * Usado pelo cron `/api/cron/sweep-finished-ai` e pelo script
 * `src/scripts/ops-sweep-finished-ai.ts`. Dry-run por padrão.
 */


import { prismaBase } from "@/lib/prisma-base";
import { withSystemContext } from "@/lib/webhook-context";
import { isIdleNudgeContent } from "@/services/ai/idle-followup";
import { getVerticalPack } from "@/verticals";

function academicOps() {
  return getVerticalPack("academic")?.ops ?? {};
}

export type SweepFinishedAiOpts = {
  apply: boolean;
  /** Janela de atividade recente (horas). */
  hours?: number;
  limit?: number;
  organizationId?: string | null;
  numbers?: number[];
  /** Silêncio mínimo desde a última mensagem (minutos) — evita fechar conversa viva. */
  quietMinutes?: number;
};

export type SweepFinishedAiItem = {
  number: number;
  contact: string;
  lastDirection: "in" | "out" | null;
  lastStudent: string;
  lastAgent: string;
  match: "student_wrapup" | "agent_farewell" | "farewell_after_nudge";
  status: "listed" | "closed" | "skipped" | "failed";
  detail?: string;
};

const MAX_PREVIEW = 90;

function preview(text?: string | null): string {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  return t.length > MAX_PREVIEW ? `${t.slice(0, MAX_PREVIEW)}…` : t;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function sweepFinishedAiConversations(
  opts: SweepFinishedAiOpts,
): Promise<{
  apply: boolean;
  hours: number;
  scanned: number;
  items: SweepFinishedAiItem[];
  closed: number;
  skipped: number;
  failed: number;
}> {
  const hours = Math.max(1, opts.hours ?? 72);
  const limit = Math.max(1, opts.limit ?? 200);
  const quietMs = Math.max(0, opts.quietMinutes ?? 10) * 60 * 1000;
  const numbers = opts.numbers ?? [];
  const since = new Date(Date.now() - hours * 60 * 60 * 1000);

  const rows = await prismaBase.conversation.findMany({
    where: {
      status: { not: "RESOLVED" },
      ...(opts.organizationId ? { organizationId: opts.organizationId } : {}),
      ...(numbers.length
        ? { number: { in: numbers } }
        : {
            updatedAt: { gte: since },
            assignedTo: { is: { type: "AI" } },
          }),
    },
    select: {
      id: true,
      number: true,
      organizationId: true,
      contactId: true,
      updatedAt: true,
      contact: { select: { name: true } },
    },
    orderBy: { updatedAt: "desc" },
    take: limit,
  });

  const items: SweepFinishedAiItem[] = [];
  let closed = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of rows) {
    if (!row.contactId) continue;

    const recent = await prismaBase.message.findMany({
      where: {
        conversationId: row.id,
        isPrivate: false,
        messageType: { not: "note" },
      },
      orderBy: { createdAt: "desc" },
      take: 6,
      select: {
        content: true,
        direction: true,
        authorType: true,
        createdAt: true,
      },
    });
    const last = recent[0];
    if (!last?.content) continue;
    // Conversa ainda quente: deixa o fluxo normal responder.
    if (Date.now() - last.createdAt.getTime() < quietMs) continue;

    const lastStudent = recent.find((m) => m.direction === "in");
    // O check-in de inatividade não é despedida: quando ele é a última
    // mensagem, a despedida real é o texto do agente logo antes dele.
    const lastIsNudge =
      last.direction === "out" && isIdleNudgeContent(last.content);
    const farewellCandidate = recent.find(
      (m) =>
        m.direction === "out" &&
        m.authorType === "bot" &&
        !isIdleNudgeContent(m.content),
    );

    // Última é do aluno encerrando (inclui resposta de despedida ao check-in).
    const studentClosing =
      last.direction === "in" && academicOps().studentWrappedUp?.(last.content);

    // Última é do agente: exige despedida dele + aluno já tendo fechado
    // o assunto, senão fecharíamos conversa em que o aluno só sumiu.
    const agentClosing =
      last.direction === "out" &&
      last.authorType === "bot" &&
      academicOps().attendanceEndedInFarewell?.({
        lastAgentText: lastIsNudge ? farewellCandidate?.content : last.content,
        lastStudentText: lastStudent?.content ?? null,
      });

    if (!studentClosing && !agentClosing) continue;

    const base: SweepFinishedAiItem = {
      number: row.number,
      contact: row.contact?.name ?? "?",
      lastDirection: last.direction === "in" ? "in" : "out",
      lastStudent: preview(lastStudent?.content),
      lastAgent: preview(farewellCandidate?.content ?? last.content),
      match: studentClosing
        ? "student_wrapup"
        : lastIsNudge
          ? "farewell_after_nudge"
          : "agent_farewell",
      status: "listed",
    };

    if (!opts.apply) {
      items.push(base);
      continue;
    }

    try {
      const result = await withSystemContext(
        row.organizationId,
        () =>
          academicOps().closeAiOnlyConversation?.({
            conversationId: row.id,
            contactId: row.contactId,
            allowAfterHumanReply: true,
            reason: "Varredura: atendimento da IA já concluído",
          }),
        { actor: { type: "AI", label: "Agente IA", sublabel: "ops-sweep" } },
      );
      if (result.closed) {
        closed++;
        items.push({ ...base, status: "closed" });
      } else {
        skipped++;
        items.push({ ...base, status: "skipped", detail: result.reason });
      }
    } catch (err) {
      failed++;
      items.push({
        ...base,
        status: "failed",
        detail: err instanceof Error ? err.message : String(err),
      });
    }
    await sleep(200);
  }

  return {
    apply: opts.apply,
    hours,
    scanned: rows.length,
    items,
    closed,
    skipped,
    failed,
  };
}