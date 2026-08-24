import { Prisma } from "@prisma/client";
import { prismaBase } from "@/lib/prisma-base";
import { getLogger } from "@/lib/logger";
import { metrics } from "@/lib/metrics";

/**
 * Buffer de escrita para `Message.sendStatus` e `CampaignRecipient.status`
 * vindos do webhook Meta.
 *
 * Por que existe: em blast, 1 UPDATE por status por mensagem/recipient gerava
 * N statements e N row locks sequenciais, competindo com o sender de campanha.
 * Aqui acumulamos e flushamos em lote (threshold 50 ou 2s) com UM
 * `UPDATE ... FROM (VALUES ...)` por tabela.
 *
 * Correção sob concorrência (o ponto não negociável): a guarda de prioridade
 * NÃO está só na memória. O colapso por id no Map protege apenas dentro do
 * mesmo flush; entre flushes e entre processos (concurrency 4, vários
 * processos) ela não vê nada. Por isso a guarda vive no WHERE do UPDATE:
 *
 *   UPDATE ... FROM (VALUES ...) v
 *   WHERE t.id = v.id AND prio(t.status_atual) < prio(v.status_novo)
 *
 * Um READ já gravado não é sobrescrito por um SENT atrasado, mesmo que chegue
 * num flush posterior ou noutro processo.
 *
 * Perda em crash: NÃO é reconciliável pela Meta — ela só retenta quando não
 * recebe 200, e o handler já respondeu "accepted" (handler.ts:2389-2394). Por
 * isso o flush é registrado no shutdown (SIGTERM/SIGINT) — ver
 * `registerStatusBufferShutdown`. Nota: `campaign-counters.ts` NÃO registra
 * shutdown; este módulo registra o seu próprio.
 */

const FLUSH_THRESHOLD = 50;
const FLUSH_INTERVAL_MS = 2_000;

const log = getLogger("status-buffer");

/**
 * Kill switch. `STATUS_WRITE_BUFFER_ENABLED=0` faz os call sites voltarem ao
 * update individual (caminho histórico). Default ligado. Lido a cada chamada
 * para permitir toggle sem rebuild.
 */
export function isStatusWriteBufferEnabled(): boolean {
  return process.env.STATUS_WRITE_BUFFER_ENABLED !== "0";
}

// ── Prioridades — FONTE ÚNICA ─────────────────────────────
// O CASE do SQL é derivado destas constantes (ver `prioCase`), para não
// duplicar a tabela em dois lugares.
//
// Semântica de FAILED (replica handler.ts:1849-1852): a guarda original é
//   if (prio[novo] <= prio[atual] && novo !== 'FAILED') return; // não atualiza
// Com FAILED: 0 na tabela, isso significa:
//   - FAILED como NOVO: sempre atualiza (o `&& novo !== 'FAILED'` anula o
//     early-return, mesmo sobre READ) — uma falha terminal vence uma leitura.
//   - FAILED como ATUAL: sempre é sobrescrito (prio[FAILED]=0, e
//     prio[qualquer] <= 0 é false para os demais) — um FAILED não é terminal,
//     um READ/DELIVERED posterior o corrige.
// No SQL abaixo: `(v.novo = 'FAILED') OR (prio(t.atual) < prio(v.novo))`.
//
// ATENÇÃO — não remova o `OR v.novo = 'FAILED'` do WHERE achando que a
// tabela sozinha basta: FAILED tem prioridade 0 DE PROPÓSITO (para que nenhum
// outro status sobrescreva um FAILED), e é a cláusula OR — não a tabela — que
// dá ao FAILED a precedência de sempre vencer como NOVO. Sem o OR, um FAILED
// atrasado perderia para um READ já gravado (prio 0 < 4), o oposto do
// comportamento original de handler.ts:1849-1852.
const RECIPIENT_PRIORITY: Record<string, number> = {
  PENDING: 0,
  SENDING: 1,
  SENT: 2,
  DELIVERED: 3,
  READ: 4,
  FAILED: 0,
};

const MESSAGE_PRIORITY: Record<string, number> = {
  pending: 0,
  sending: 1,
  sent: 2,
  delivered: 3,
  read: 4,
  failed: 0,
};

/** Gera `CASE <col> WHEN '<k>' THEN <n> ... ELSE 0 END` a partir da tabela. */
function prioCase(column: string, table: Record<string, number>): string {
  const whens = Object.entries(table)
    .map(([k, n]) => `WHEN '${k}' THEN ${n}`)
    .join(" ");
  return `CASE ${column} ${whens} ELSE 0 END`;
}

// ── Tipos de escrita ──────────────────────────────────────

type RecipientWrite = {
  id: string;
  status: string;
  // Campos extras já resolvidos pelo caller (deliveredAt/readAt/errorMessage).
  data: { deliveredAt?: Date; readAt?: Date; errorMessage?: string | null };
};

type MessageWrite = {
  id: string;
  sendStatus: string;
  // undefined = não tocar no campo; null = limpar; string = gravar.
  sendError?: string | null;
};

type Pending = {
  recipients: Map<string, RecipientWrite>; // chave = recipient.id (colapsa)
  messages: Map<string, MessageWrite>; // chave = message.id (colapsa)
  timer: NodeJS.Timeout | null;
  isFlushing: boolean;
};

const globalForStatus = globalThis as unknown as {
  statusWriteBuffer?: Pending;
};

function buffer(): Pending {
  return (globalForStatus.statusWriteBuffer ??= {
    recipients: new Map(),
    messages: new Map(),
    timer: null,
    isFlushing: false,
  });
}

// Guarda em memória = OTIMIZAÇÃO dentro do mesmo flush (evita carregar um
// write que já perdeu). A guarda de verdade está no WHERE do UPDATE.
// Guarda em memória = OTIMIZAÇÃO dentro do mesmo flush. A guarda de verdade
// está no WHERE do UPDATE. Replica a mesma regra do SQL:
//   atualiza se (novo === FAILED) OU (prio[atual] < prio[novo]).
// (FAILED como atual é sobrescrito — prio[FAILED]=0 perde para todos.)
function shouldRecipientReplace(next: string, current: string): boolean {
  if (next === "FAILED") return true;
  return (RECIPIENT_PRIORITY[next] ?? 0) > (RECIPIENT_PRIORITY[current] ?? 0);
}

function shouldMessageReplace(next: string, current: string): boolean {
  if (next === "failed") return true;
  return (MESSAGE_PRIORITY[next] ?? 0) > (MESSAGE_PRIORITY[current] ?? 0);
}

export function bufferRecipientStatus(write: RecipientWrite): void {
  const buf = buffer();
  const existing = buf.recipients.get(write.id);
  if (!existing || shouldRecipientReplace(write.status, existing.status)) {
    buf.recipients.set(write.id, write);
  }
  scheduleFlush();
}

export function bufferMessageStatus(write: MessageWrite): void {
  const buf = buffer();
  const existing = buf.messages.get(write.id);
  if (!existing || shouldMessageReplace(write.sendStatus, existing.sendStatus)) {
    buf.messages.set(write.id, write);
  }
  scheduleFlush();
}

function scheduleFlush(): void {
  const buf = buffer();
  const total = buf.recipients.size + buf.messages.size;
  if (total >= FLUSH_THRESHOLD) {
    void flush();
    return;
  }
  if (!buf.timer) {
    buf.timer = setTimeout(() => void flush(), FLUSH_INTERVAL_MS);
    buf.timer.unref?.();
  }
}

async function flush(): Promise<void> {
  const buf = buffer();
  // Dois callers cruzando o threshold ao mesmo tempo não disparam dois flushes.
  if (buf.isFlushing) return;
  buf.isFlushing = true;

  if (buf.timer) {
    clearTimeout(buf.timer);
    buf.timer = null;
  }

  const recipients = [...buf.recipients.values()];
  const messages = [...buf.messages.values()];
  try {
    if (recipients.length === 0 && messages.length === 0) return;
    await Promise.all([flushRecipients(recipients), flushMessages(messages)]);
    // Só limpa DEPOIS do sucesso — ver catch.
    buf.recipients.clear();
    buf.messages.clear();
  } catch (err) {
    // Re-insere os writes falhados SEM rebaixar um write novo que chegou
    // durante o flush com prioridade maior (mesma regra de colapso).
    for (const w of recipients) {
      const cur = buf.recipients.get(w.id);
      if (!cur || shouldRecipientReplace(w.status, cur.status)) {
        buf.recipients.set(w.id, w);
      }
    }
    for (const w of messages) {
      const cur = buf.messages.get(w.id);
      if (!cur || shouldMessageReplace(w.sendStatus, cur.sendStatus)) {
        buf.messages.set(w.id, w);
      }
    }
    metrics.errors.inc({ scope: "status-buffer", kind: "flush_failed" });
    log.error(
      { err: err instanceof Error ? err.message : String(err), recipients: recipients.length, messages: messages.length },
      "flush do status-buffer falhou — writes re-enfileirados",
    );
    // Reagenda para não ficar preso até o próximo threshold.
    scheduleFlush();
  } finally {
    buf.isFlushing = false;
  }
}

/**
 * UM statement por tabela. A guarda de prioridade vive no WHERE, então é
 * atômica por linha e vale entre flushes e processos. Locks de linha são
 * curtos (um statement), não segurados por uma transação longa.
 */
async function flushRecipients(writes: RecipientWrite[]): Promise<void> {
  if (writes.length === 0) return;
  const prio = prioCase("v.novo", RECIPIENT_PRIORITY);
  // t.status é enum RecipientStatus — cast para text antes do CASE.
  const prioCur = prioCase("t.status::text", RECIPIENT_PRIORITY);

  // UPDATE ... FROM (VALUES ...) — um statement só. Os valores são interpolados
  // como parâmetros individuais via Prisma.join (seguro contra SQL injection).
  // `status` é o enum RecipientStatus — o VALUES passa text, então o SET faz
  // cast (::"RecipientStatus"). Campos de timestamp/erro: COALESCE preserva o
  // existente quando o novo é NULL.
  //
  // Os casts ::timestamp no COALESCE são OBRIGATÓRIOS: o Postgres infere o
  // tipo de cada coluna do VALUES pelo primeiro valor, e um NULL na primeira
  // linha tipa a coluna como text — sem o cast, COALESCE(text, timestamp)
  // falha com 42804. O cast é no-op quando o parâmetro já vem tipado.
  //
  // LIMITAÇÃO CONHECIDA: COALESCE(v.campo, t.campo) não distingue "não tocar"
  // de "limpar" — um NULL vindo do VALUES sempre significa "preservar o valor
  // atual". Hoje é correto porque errorMessage/deliveredAt/readAt só são
  // setados, nunca limpos. Se um dia for preciso gravar NULL de propósito em
  // errorMessage (limpar um erro), migre para o padrão `touchError` usado em
  // flushMessages (flag booleana + CASE WHEN), que distingue as duas coisas.
  const values = writes.map(
    (w) =>
      Prisma.sql`(${w.id}, ${w.status}, ${w.data.deliveredAt ?? null}, ${w.data.readAt ?? null}, ${w.data.errorMessage ?? null})`,
  );

  await prismaBase.$executeRaw`
    UPDATE "campaign_recipients" t
    SET
      "status" = v.novo::"RecipientStatus",
      "deliveredAt" = COALESCE(v."deliveredAt"::timestamp, t."deliveredAt"),
      "readAt" = COALESCE(v."readAt"::timestamp, t."readAt"),
      "errorMessage" = COALESCE(v."errorMessage", t."errorMessage")
    FROM (VALUES ${Prisma.join(values)})
      AS v(id, novo, "deliveredAt", "readAt", "errorMessage")
    WHERE t.id = v.id
      AND (v.novo = 'FAILED' OR ${Prisma.raw(prioCur)} < ${Prisma.raw(prio)})
  `;
}

async function flushMessages(writes: MessageWrite[]): Promise<void> {
  if (writes.length === 0) return;
  const prio = prioCase("v.novo", MESSAGE_PRIORITY);
  const prioCur = prioCase('t."sendStatus"', MESSAGE_PRIORITY);

  // sendError undefined = não tocar (touchError=false); null = limpar; string = gravar.
  // O ::boolean em touchError é obrigatório pelo mesmo motivo dos casts de
  // timestamp em flushRecipients: inferência de tipo do VALUES via 1ª linha.
  const values = writes.map(
    (w) =>
      Prisma.sql`(${w.id}, ${w.sendStatus}, ${w.sendError === undefined ? null : w.sendError}, ${w.sendError !== undefined})`,
  );

  await prismaBase.$executeRaw`
    UPDATE "messages" t
    SET
      "sendStatus" = v.novo,
      "sendError" = CASE WHEN v."touchError"::boolean THEN v."sendError" ELSE t."sendError" END
    FROM (VALUES ${Prisma.join(values)})
      AS v(id, novo, "sendError", "touchError")
    WHERE t.id = v.id
      AND (v.novo = 'failed' OR ${Prisma.raw(prioCur)} < ${Prisma.raw(prio)})
  `;
}

/** Força o flush — usar antes de ler estado ou no shutdown. */
export async function flushStatusWrites(): Promise<void> {
  await flush();
}

/**
 * Registra flush no shutdown. `campaign-counters.ts` NÃO registra o seu —
 * este módulo registra o próprio para não perder status já "accepted".
 * Idempotente: chamar duas vezes não duplica listeners.
 */
let shutdownRegistered = false;
export function registerStatusBufferShutdown(): void {
  if (shutdownRegistered) return;
  shutdownRegistered = true;
  const onSignal = (signal: string) => {
    void (async () => {
      try {
        await flush();
      } finally {
        log.info({ signal }, "status-buffer flushed no shutdown");
      }
    })();
  };
  process.once("SIGINT", () => onSignal("SIGINT"));
  process.once("SIGTERM", () => onSignal("SIGTERM"));
}
