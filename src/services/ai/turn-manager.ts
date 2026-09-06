/**
 * Turn Manager — agrupamento persistente de inbound para o Agente IA.
 *
 * O cliente manda "Oi" / "preciso" / "de ajuda" / "com minha matrícula" em
 * quatro bolhas. Cada bolha continua sendo uma `Message` própria no banco
 * (nada é fundido, nada é sobrescrito); o `ConversationTurn` só REFERENCIA
 * os ids e materializa o texto concatenado quando o turno estabiliza. A IA
 * roda UMA vez, sobre o texto agregado.
 *
 * Diferença central em relação ao `inbound-debounce` antigo: a fonte de
 * verdade é o BANCO, não um `Map` de processo com `setTimeout`. Restart,
 * deploy, crash, worker diferente, múltiplas réplicas e retry convergem
 * para o mesmo estado porque todo mundo lê a mesma linha. O `setTimeout`
 * daqui é fast path de latência — se o processo morrer, o sweeper
 * (`turn-sweeper.ts`) encontra o turno pelo estado no banco.
 *
 * Estados: RECEIVING/STABILIZING (acumulando) → READY (janela venceu) →
 * PROCESSING (claim atômico) → COMPLETED | FAILED, ou INVALIDATED quando
 * um humano assume antes de a IA falar.
 */

import os from "node:os";

import { Prisma, type ConversationTurn } from "@prisma/client";

import { getOrgSetting } from "@/lib/org-settings";
import { prisma } from "@/lib/prisma";
import { prismaBase } from "@/lib/prisma-base";
import { withOrgFromCtx } from "@/lib/prisma-helpers";
import { getOrgIdOrNull } from "@/lib/request-context";
import { withSystemContext } from "@/lib/webhook-context";
import { isContactAllowedForAi } from "@/services/ai/phone-allowlist";
import {
  claimInboundMessageForAi,
  collectUnansweredInboundText,
} from "@/services/ai/inbound-debounce";

/** Piso da janela de debounce — o mesmo do debounce antigo. Debounce 0 */
/** gera uma resposta por bolha (triplica "vou te conectar"). */
export const TURN_DEBOUNCE_FLOOR_MS = 1500;

export const DEFAULT_TURN_DEBOUNCE_MS = 1500;
export const DEFAULT_TURN_MAX_WAIT_MS = 8000;

/** Status em que o turno ainda acumula mensagens (sentinela `openKey`). */
export const TURN_ACCUMULATING_STATUSES = [
  "RECEIVING",
  "STABILIZING",
  "READY",
] as const;

export type TurnChannel = "meta" | "baileys" | "messaging";

export type InboundTurnInput = {
  conversationId: string;
  contactId: string;
  /** ID da Message persistida. Sem ele não há o que referenciar. */
  messageId?: string | null;
  /** Texto da bolha atual (fallback quando a Message não tem content). */
  userMessage: string;
  channel: TurnChannel;
  /** Quando false, não agenda (ex.: mensagem de sistema). */
  eligible?: boolean;
};

function logTurn(event: string, payload: Record<string, unknown>) {
  console.info(
    "[ai-turn]",
    JSON.stringify({ event, ts: new Date().toISOString(), ...payload }),
  );
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Flag de rollout. Default OFF: o comportamento antigo continua sendo o */
/** caminho de produção até o Turn Manager ser validado em DEV. */
export function isTurnManagerEnabled(): boolean {
  const raw = (process.env.AI_TURN_MANAGER ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on";
}

/** Teto de tempo em PROCESSING antes do turno ser considerado travado. */
export function turnStaleMs(): number {
  return envInt("AI_TURN_STALE_MS", 120_000);
}

/** Tentativas de processamento antes do turno virar FAILED. */
export function turnMaxAttempts(): number {
  return envInt("AI_TURN_MAX_ATTEMPTS", 3);
}

/** Identidade do processo que faz o claim (diagnóstico de turno travado). */
export function workerIdentity(): string {
  return `${os.hostname()}:${process.pid}`;
}

/**
 * Janelas efetivas do turno. Resolvidas no INGEST (onde há
 * RequestContext) e congeladas na linha — o sweeper roda cross-org e não
 * teria como ler org setting sem um lookup por turno.
 */
export async function resolveTurnWindows(): Promise<{
  debounceMs: number;
  maxWaitMs: number;
}> {
  const envDebounce = envInt("AI_TURN_DEBOUNCE_MS", DEFAULT_TURN_DEBOUNCE_MS);
  const envMaxWait = envInt("AI_TURN_MAX_WAIT_MS", DEFAULT_TURN_MAX_WAIT_MS);

  let debounceMs = envDebounce;
  try {
    // Reaproveita a semântica do setting que já existe (o debounce antigo
    // lia a mesma chave, com o mesmo piso de 1500ms).
    const raw = await getOrgSetting("ai.inboundDebounceMs");
    if (raw) {
      const n = Number.parseInt(raw, 10);
      if (Number.isFinite(n) && n >= 0 && n <= 30_000) {
        debounceMs = n;
      }
    }
  } catch {
    /* fora de RequestContext — fica no valor de env */
  }

  debounceMs = Math.max(TURN_DEBOUNCE_FLOOR_MS, debounceMs);
  // MAX_WAIT abaixo do debounce tornaria a janela inútil (o teto venceria
  // antes de qualquer agrupamento acontecer).
  const maxWaitMs = Math.max(envMaxWait, debounceMs * 2);
  return { debounceMs, maxWaitMs };
}

function readMessageIds(value: Prisma.JsonValue | null): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

/** Instante em que o turno pode ser promovido a READY. */
export function turnDueAt(turn: {
  firstMessageAt: Date;
  lastMessageAt: Date;
  debounceMs: number;
  maxWaitMs: number;
}): number {
  const byDebounce = turn.lastMessageAt.getTime() + turn.debounceMs;
  const byMaxWait = turn.firstMessageAt.getTime() + turn.maxWaitMs;
  return Math.min(byDebounce, byMaxWait);
}

export function isTurnDue(
  turn: {
    firstMessageAt: Date;
    lastMessageAt: Date;
    debounceMs: number;
    maxWaitMs: number;
  },
  now = Date.now(),
): boolean {
  return now >= turnDueAt(turn);
}

// ── Ingest ──────────────────────────────────────────────────

export type AppendResult = {
  turnId: string;
  /** true quando a mensagem abriu um turno novo. */
  created: boolean;
  dueAt: number;
};

/**
 * Anexa a mensagem ao turno que está acumulando na conversa, ou abre um
 * novo. Seguro sob concorrência: o append é um `updateMany` guardado por
 * status, e a criação depende do UNIQUE (organizationId, openKey) — dois
 * ingests simultâneos não conseguem abrir dois turnos, o perdedor toma
 * P2002 e volta pelo caminho de append.
 */
export async function appendToOpenTurn(
  input: InboundTurnInput,
): Promise<AppendResult | null> {
  const windows = await resolveTurnWindows();
  const now = new Date();

  // 3 voltas cobrem o pior caso realista: append perde a corrida com o
  // claim (turno saiu de READY), create perde para outro ingest, e o
  // append seguinte já encontra o turno do vencedor.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const open = await prisma.conversationTurn.findFirst({
      where: {
        conversationId: input.conversationId,
        status: { in: [...TURN_ACCUMULATING_STATUSES] },
      },
      orderBy: { createdAt: "desc" },
    });

    if (open) {
      const ids = readMessageIds(open.messageIds);
      if (input.messageId && ids.includes(input.messageId)) {
        // Reentrância (webhook repetido que passou o claim de Redis).
        return { turnId: open.id, created: false, dueAt: turnDueAt(open) };
      }
      const nextIds = input.messageId ? [...ids, input.messageId] : ids;

      // Guardado por status: se o sweeper claimou o turno no meio (READY →
      // PROCESSING), count = 0 e a próxima volta abre um turno novo. Volta
      // para RECEIVING porque a janela de debounce reinicia a cada bolha —
      // um turno já READY que recebe mensagem não pode rodar sem ela.
      const updated = await prisma.conversationTurn.updateMany({
        where: {
          id: open.id,
          status: { in: [...TURN_ACCUMULATING_STATUSES] },
        },
        data: {
          status: "RECEIVING",
          readyAt: null,
          messageIds: nextIds as unknown as Prisma.InputJsonValue,
          lastMessageAt: now,
        },
      });
      if (updated.count === 1) {
        logTurn("appended", {
          turnId: open.id,
          conversationId: input.conversationId,
          messageId: input.messageId ?? null,
          messageCount: nextIds.length,
        });
        return {
          turnId: open.id,
          created: false,
          dueAt: turnDueAt({
            firstMessageAt: open.firstMessageAt,
            lastMessageAt: now,
            debounceMs: open.debounceMs,
            maxWaitMs: open.maxWaitMs,
          }),
        };
      }
      continue;
    }

    try {
      const created = await prisma.conversationTurn.create({
        data: withOrgFromCtx({
          conversationId: input.conversationId,
          contactId: input.contactId,
          channel: input.channel,
          status: "RECEIVING" as const,
          // Sentinela do turno acumulando (ver comentário no schema).
          openKey: input.conversationId,
          messageIds: (input.messageId
            ? [input.messageId]
            : []) as unknown as Prisma.InputJsonValue,
          debounceMs: windows.debounceMs,
          maxWaitMs: windows.maxWaitMs,
          firstMessageAt: now,
          lastMessageAt: now,
        }),
      });
      logTurn("created", {
        turnId: created.id,
        conversationId: input.conversationId,
        contactId: input.contactId,
        channel: input.channel,
        messageId: input.messageId ?? null,
        debounceMs: windows.debounceMs,
        maxWaitMs: windows.maxWaitMs,
      });
      return {
        turnId: created.id,
        created: true,
        dueAt: turnDueAt({
          firstMessageAt: now,
          lastMessageAt: now,
          debounceMs: windows.debounceMs,
          maxWaitMs: windows.maxWaitMs,
        }),
      };
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      // Outro ingest abriu o turno primeiro — próxima volta faz append.
      logTurn("create_race", {
        conversationId: input.conversationId,
        attempt: attempt + 1,
      });
    }
  }

  logTurn("append_gave_up", { conversationId: input.conversationId });
  return null;
}

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: string }).code === "P2002"
  );
}

/**
 * Entrypoint dos 3 ingests de inbound (meta-webhook, messaging, baileys).
 * Substitui `scheduleAiReply` nos call sites; com a flag desligada
 * delega para o debounce antigo, então NÃO existem dois debounces
 * concorrentes — só um caminho ativo por vez.
 */
export async function onInboundMessageForAi(
  input: InboundTurnInput,
): Promise<void> {
  if (!isTurnManagerEnabled()) {
    const { scheduleAiReply } = await import("@/services/ai/inbound-debounce");
    await scheduleAiReply(input);
    return;
  }

  if (input.eligible === false) return;
  if (!input.userMessage?.trim() && !input.messageId) return;

  // Allowlist (defesa em profundidade — o inbox-handler checa de novo).
  try {
    const allowed = await isContactAllowedForAi(input.contactId);
    if (!allowed) {
      logTurn("skip_allowlist", {
        conversationId: input.conversationId,
        contactId: input.contactId,
      });
      return;
    }
  } catch (e) {
    console.error("[ai-turn] phone allowlist check failed — blocking", e);
    return;
  }

  // Claim por messageId (webhook repetido / multi-pod). Continua sendo o
  // mesmo claim Redis do debounce antigo: barra o reprocessamento ANTES
  // de encostar no banco.
  const claimed = await claimInboundMessageForAi(input.messageId);
  if (!claimed) return;

  const appended = await appendToOpenTurn(input);
  if (!appended) return;

  armFastPath(appended.turnId, appended.dueAt);
  // Todo processo que ingere inbound também varre. O claim atômico torna a
  // concorrência inofensiva, e isso garante que o turno tenha quem o
  // promova mesmo em ambiente que não sobe worker dedicado (DEV com só
  // `APP_MODE=api`). Import dinâmico: o sweeper importa este módulo.
  void import("@/services/ai/turn-sweeper")
    .then(({ startAiTurnSweeper }) => startAiTurnSweeper())
    .catch(() => {
      /* fast path + cron cobrem */
    });
}

// ── Fast path (só latência) ─────────────────────────────────

const fastPathTimers = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Agenda um tick local para o instante em que o turno vence. É OTIMIZAÇÃO:
 * sem isso o turno ainda é promovido pelo sweeper (que varre o banco), só
 * com a latência do intervalo do tick. Se o processo morrer, o timer morre
 * com ele e nada se perde.
 */
export function armFastPath(turnId: string, dueAt: number): void {
  const existing = fastPathTimers.get(turnId);
  if (existing) clearTimeout(existing);

  const delay = Math.max(0, dueAt - Date.now());
  const timer = setTimeout(() => {
    fastPathTimers.delete(turnId);
    void promoteAndDispatchTurn(turnId).catch((err) => {
      console.error("[ai-turn] fast path falhou", {
        turnId,
        err: err instanceof Error ? err.message : String(err),
      });
    });
  }, delay);
  timer.unref?.();
  fastPathTimers.set(turnId, timer);

  // STABILIZING = "tem dispatch armado". Puro diagnóstico: o sweeper trata
  // RECEIVING e STABILIZING igual.
  void prisma.conversationTurn
    .updateMany({
      where: { id: turnId, status: "RECEIVING" },
      data: { status: "STABILIZING" },
    })
    .catch(() => {
      /* diagnóstico — não vale derrubar o ingest */
    });
}

/** Limpa timers locais (usado em teardown de teste / shutdown). */
export function clearFastPathTimers(): void {
  for (const timer of fastPathTimers.values()) clearTimeout(timer);
  fastPathTimers.clear();
}

// ── Promoção / claim / processamento ────────────────────────

/**
 * Promove o turno a READY (materializando `aggregatedText`) e tenta
 * processá-lo. Idempotente: o `updateMany` é guardado por status, então
 * fast path e sweeper podem chamar ao mesmo tempo sem rodar duas vezes.
 */
export async function promoteAndDispatchTurn(turnId: string): Promise<boolean> {
  const turn = await prismaBase.conversationTurn.findUnique({
    where: { id: turnId },
  });
  if (!turn) return false;

  if (turn.status === "READY") {
    return dispatchReadyTurn(turn.id, turn.organizationId);
  }
  if (turn.status !== "RECEIVING" && turn.status !== "STABILIZING") {
    return false;
  }
  if (!isTurnDue(turn)) {
    // Chegou mensagem depois do timer ser armado: o due mudou. Rearma.
    armFastPath(turn.id, turnDueAt(turn));
    return false;
  }

  const promoted = await promoteTurnToReady(turn.id, turn.organizationId);
  if (!promoted) return false;
  return dispatchReadyTurn(turn.id, turn.organizationId);
}

/**
 * RECEIVING/STABILIZING → READY, com o texto agregado materializado.
 * Só um promotor vence (guarda por status), o resto vê count = 0.
 */
export async function promoteTurnToReady(
  turnId: string,
  organizationId: string,
): Promise<boolean> {
  const turn = await prismaBase.conversationTurn.findUnique({
    where: { id: turnId },
  });
  if (!turn) return false;

  const aggregatedText = await buildAggregatedText(
    organizationId,
    readMessageIds(turn.messageIds),
  );

  const res = await prismaBase.conversationTurn.updateMany({
    where: {
      id: turnId,
      organizationId,
      status: { in: ["RECEIVING", "STABILIZING"] },
    },
    data: {
      status: "READY",
      readyAt: new Date(),
      aggregatedText,
    },
  });
  if (res.count !== 1) return false;

  logTurn("ready", {
    turnId,
    conversationId: turn.conversationId,
    messageCount: readMessageIds(turn.messageIds).length,
    waitedMs: Date.now() - turn.firstMessageAt.getTime(),
    textLength: aggregatedText.length,
  });
  return true;
}

/**
 * Concatena o conteúdo das Messages do turno na ordem em que foram
 * ingeridas. Lê as linhas originais — o turno nunca reescreve `Message`.
 */
export async function buildAggregatedText(
  organizationId: string,
  messageIds: string[],
): Promise<string> {
  if (messageIds.length === 0) return "";

  const rows = await prismaBase.message.findMany({
    where: { organizationId, id: { in: messageIds } },
    select: { id: true, content: true, authorType: true, messageType: true },
  });
  const byId = new Map(rows.map((r) => [r.id, r]));

  const parts: string[] = [];
  for (const id of messageIds) {
    const row = byId.get(id);
    if (!row) continue;
    if (row.authorType === "bot" || row.authorType === "system") continue;
    if (row.messageType === "note") continue;
    const text = (row.content ?? "").trim();
    if (text) parts.push(text);
  }
  return parts.join("\n");
}

/**
 * Claim atômico READY → PROCESSING. `updateMany` + checagem de count é o
 * equivalente Prisma do `UPDATE ... WHERE status='READY' RETURNING *`:
 * o Postgres serializa os dois UPDATEs na mesma linha e o perdedor vê
 * count = 0. Só um worker processa o turno.
 *
 * O claim também LIMPA `openKey` — a partir daqui a conversa volta a
 * aceitar um turno novo, que é o que faz mensagem durante PROCESSING não
 * se perder nem contaminar o turno em voo.
 */
export async function claimTurn(
  turnId: string,
  organizationId: string,
  claimedBy = workerIdentity(),
): Promise<ConversationTurn | null> {
  const res = await prismaBase.conversationTurn.updateMany({
    where: { id: turnId, organizationId, status: "READY" },
    data: {
      status: "PROCESSING",
      claimedBy,
      claimedAt: new Date(),
      openKey: null,
    },
  });
  if (res.count !== 1) {
    logTurn("claim_lost", { turnId, claimedBy });
    return null;
  }
  const turn = await prismaBase.conversationTurn.findUnique({
    where: { id: turnId },
  });
  if (turn) logTurn("claimed", { turnId, claimedBy });
  return turn;
}

/** Claim + execução do agente sobre o texto agregado. */
export async function dispatchReadyTurn(
  turnId: string,
  organizationId: string,
): Promise<boolean> {
  const turn = await claimTurn(turnId, organizationId);
  if (!turn) return false;
  await runTurn(turn);
  return true;
}

/**
 * Executa `maybeReplyAsAIAgent` com o texto agregado. NÃO reescreve o
 * inbox-handler: só passa `userMessage` já concatenado + `turnId` para
 * rastreabilidade no `AIAgentRun`.
 */
export async function runTurn(turn: {
  id: string;
  organizationId: string;
  conversationId: string;
  contactId: string | null;
  channel: string;
  aggregatedText: string | null;
  messageIds: Prisma.JsonValue;
  attempts: number;
}): Promise<void> {
  const startedAt = Date.now();
  const messageIds = readMessageIds(turn.messageIds);

  try {
    await withSystemContext(
      turn.organizationId,
      async () => {
        let text = (turn.aggregatedText ?? "").trim();
        if (!text) {
          // Turno sem texto materializado (mídia-only, ou promoção que
          // correu antes do content ser persistido). Cai no coletor
          // clássico em vez de desistir da mensagem do cliente.
          text = (
            await collectUnansweredInboundText(turn.conversationId)
          ).trim();
        }
        if (!text) {
          logTurn("empty_turn", {
            turnId: turn.id,
            conversationId: turn.conversationId,
          });
          await completeTurn(turn.id, turn.organizationId);
          return;
        }

        const { maybeReplyAsAIAgent } = await import(
          "@/services/ai/inbox-handler"
        );
        await maybeReplyAsAIAgent({
          conversationId: turn.conversationId,
          contactId: turn.contactId ?? "",
          userMessage: text,
          channel: turn.channel === "baileys" ? "baileys" : "meta",
          inboundMessageIds: messageIds,
          turnId: turn.id,
        });

        await completeTurn(turn.id, turn.organizationId);
        logTurn("completed", {
          turnId: turn.id,
          conversationId: turn.conversationId,
          messageCount: messageIds.length,
          durationMs: Date.now() - startedAt,
        });
      },
      { actor: { type: "AI", label: "Agente IA", sublabel: "turn-manager" } },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[ai-turn] runTurn falhou", { turnId: turn.id, err: message });
    await failOrRetryTurn(turn.id, turn.organizationId, message);
  }
}

/** PROCESSING → COMPLETED. */
export async function completeTurn(
  turnId: string,
  organizationId: string,
): Promise<void> {
  await prismaBase.conversationTurn.updateMany({
    where: { id: turnId, organizationId, status: "PROCESSING" },
    data: { status: "COMPLETED", completedAt: new Date(), openKey: null },
  });
}

/**
 * Erro no processamento: devolve para READY (nova tentativa) ou desiste
 * com FAILED depois de `AI_TURN_MAX_ATTEMPTS`. Sem o teto, um turno que
 * falha sempre ficaria em loop eterno no sweeper.
 */
export async function failOrRetryTurn(
  turnId: string,
  organizationId: string,
  error: string,
): Promise<"READY" | "FAILED" | "SKIPPED"> {
  const turn = await prismaBase.conversationTurn.findUnique({
    where: { id: turnId },
  });
  if (!turn || turn.status !== "PROCESSING") return "SKIPPED";

  const attempts = turn.attempts + 1;
  if (attempts >= turnMaxAttempts()) {
    await prismaBase.conversationTurn.updateMany({
      where: { id: turnId, organizationId, status: "PROCESSING" },
      data: {
        status: "FAILED",
        attempts,
        lastError: error.slice(0, 2000),
        completedAt: new Date(),
        openKey: null,
      },
    });
    logTurn("failed", { turnId, attempts, error });
    return "FAILED";
  }

  await prismaBase.conversationTurn.updateMany({
    where: { id: turnId, organizationId, status: "PROCESSING" },
    data: {
      status: "READY",
      attempts,
      lastError: error.slice(0, 2000),
      claimedBy: null,
      claimedAt: null,
      // Volta a ser um turno acumulando: se o cliente escrever de novo
      // antes do retry, a mensagem entra neste turno em vez de abrir outro.
      openKey: turn.conversationId,
    },
  });
  logTurn("requeued", { turnId, attempts, error });
  return "READY";
}

// ── Cancelamento ────────────────────────────────────────────

/**
 * Equivalente de `cancelAiReplyDebounce` no mundo persistente: humano
 * respondeu, assignee mudou ou o burst halt disparou → o turno acumulando
 * não deve mais virar resposta da IA.
 *
 * Turno já em PROCESSING NÃO é abortado aqui (o LLM pode estar no ar); a
 * barreira desse caso continua sendo `assertAiStillAuthorized`, que checa
 * generation + assignee imediatamente antes do envio.
 */
export async function invalidateOpenTurns(
  conversationId: string,
  reason: string,
): Promise<number> {
  try {
    const res = await prismaBase.conversationTurn.updateMany({
      where: {
        conversationId,
        status: { in: [...TURN_ACCUMULATING_STATUSES] },
      },
      data: {
        status: "INVALIDATED",
        completedAt: new Date(),
        openKey: null,
        lastError: `invalidated: ${reason}`,
      },
    });
    if (res.count > 0) {
      logTurn("invalidated", { conversationId, reason, count: res.count });
    }
    return res.count;
  } catch (err) {
    console.error("[ai-turn] invalidateOpenTurns falhou", {
      conversationId,
      reason,
      err: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
}

/** Diagnóstico: turno acumulando da conversa (usado em teste e debug). */
export async function findOpenTurn(conversationId: string) {
  const orgId = getOrgIdOrNull();
  return prismaBase.conversationTurn.findFirst({
    where: {
      conversationId,
      ...(orgId ? { organizationId: orgId } : {}),
      status: { in: [...TURN_ACCUMULATING_STATUSES] },
    },
    orderBy: { createdAt: "desc" },
  });
}
