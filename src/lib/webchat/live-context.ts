/**
 * Webchat v2 — contexto vivo (docs/decisoes/webchat-widget.md §9.3).
 *
 * Estado chave → valor simples que o site manda por `setContext` (widget)
 * ou `fields` (servidor a servidor). Merge raso: cada envio substitui só as
 * chaves enviadas; `null` remove a chave. Limites do canal
 * (`config.v2.context.maxKeys` / `maxValueChars`). Uma linha por
 * (canal, contato) ou por visitante anônimo (`sessionId`).
 *
 * Funções puras (sanitizar/aplicar) + `writeLiveContext` (banco, com
 * concorrência otimista). Quem publica no SSE é o chamador.
 */
import { Prisma } from "@prisma/client";

import { prisma, type ScopedTx } from "@/lib/prisma";
import { withOrgFromCtx } from "@/lib/prisma-helpers";
import { WEBCHAT_CONTEXT_KEY_RE } from "@/lib/webchat/v2-config";

export type WebchatContextValue = string | number | boolean;
export type WebchatContextState = Record<string, WebchatContextValue>;

/** Teto de entradas lidas de um único envio (o resto é ignorado). */
const MAX_PATCH_ENTRIES = 200;

export type WebchatContextPatch = {
  set: WebchatContextState;
  remove: string[];
  /** Chaves recusadas (nome inválido, valor não simples, excesso). */
  ignored: string[];
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Texto sem caracteres de controle (quebras viram espaço), cortado em `max`. */
export function cleanContextString(v: string, max: number): string {
  return v.replace(/[\u0000-\u001F\u007F]+/g, " ").trim().slice(0, max);
}

/**
 * Valida um envio do site. `null` = corpo não é objeto. Valores aceitos:
 * string (limpa e cortada em `maxValueChars`), número finito, booleano;
 * `null` remove a chave. Chave fora de `WEBCHAT_CONTEXT_KEY_RE` → ignorada.
 */
export function sanitizeContextPatch(
  raw: unknown,
  limits: { maxValueChars: number },
): WebchatContextPatch | null {
  if (!isPlainObject(raw)) return null;
  const out: WebchatContextPatch = { set: {}, remove: [], ignored: [] };
  let seen = 0;
  for (const [key, value] of Object.entries(raw)) {
    seen++;
    if (seen > MAX_PATCH_ENTRIES || !WEBCHAT_CONTEXT_KEY_RE.test(key)) {
      out.ignored.push(key.slice(0, 64));
      continue;
    }
    if (value === null) out.remove.push(key);
    else if (typeof value === "string") out.set[key] = cleanContextString(value, limits.maxValueChars);
    else if (typeof value === "number" && Number.isFinite(value)) out.set[key] = value;
    else if (typeof value === "boolean") out.set[key] = value;
    else out.ignored.push(key);
  }
  return out;
}

/** Lê o `state` gravado: só valores simples com chave válida. */
export function readContextState(raw: unknown): WebchatContextState {
  const out: WebchatContextState = {};
  if (!isPlainObject(raw)) return out;
  for (const [k, v] of Object.entries(raw)) {
    if (!WEBCHAT_CONTEXT_KEY_RE.test(k)) continue;
    if (typeof v === "string" || typeof v === "boolean" || (typeof v === "number" && Number.isFinite(v))) {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Aplica o patch: remove, atualiza as chaves que já existem e só cria chave
 * nova enquanto couber em `maxKeys` (as que não cabem vão para `ignored`).
 */
export function applyContextPatch(
  current: WebchatContextState,
  patch: WebchatContextPatch,
  maxKeys: number,
): { state: WebchatContextState; changed: boolean; ignored: string[] } {
  const state: WebchatContextState = { ...current };
  const ignored = [...patch.ignored];
  let changed = false;
  for (const k of patch.remove) {
    if (k in state) {
      delete state[k];
      changed = true;
    }
  }
  for (const [k, v] of Object.entries(patch.set)) {
    if (!(k in state) && Object.keys(state).length >= maxKeys) {
      ignored.push(k);
      continue;
    }
    if (state[k] !== v) {
      state[k] = v;
      changed = true;
    }
  }
  return { state, changed, ignored };
}

/**
 * Funde dois estados (merge de contatos / visitante anônimo → contato): em
 * chave repetida vence o estado mais recente. Não aplica `maxKeys` (o
 * próximo envio do site já respeita o limite).
 */
export function mergeContextStates(
  a: { state: WebchatContextState; updatedAt: Date },
  b: { state: WebchatContextState; updatedAt: Date },
): { state: WebchatContextState; updatedAt: Date } {
  const [older, newer] = a.updatedAt <= b.updatedAt ? [a, b] : [b, a];
  return { state: { ...older.state, ...newer.state }, updatedAt: newer.updatedAt };
}

export type LiveContextOwner = { contactId: string } | { sessionId: string };

export type WriteLiveContextResult = {
  state: WebchatContextState;
  /** `updatedAt` gravado (não muda se nada mudou). */
  updatedAt: Date;
  changed: boolean;
  ignored: string[];
};

function ownerWhere(channelId: string, owner: LiveContextOwner) {
  return "contactId" in owner
    ? { channelId, contactId: owner.contactId }
    : { sessionId: owner.sessionId };
}

/**
 * Grava um patch já sanitizado no contexto vivo do dono. Concorrência
 * otimista: relê e repete se outra escrita mudou a linha no meio (até 3x).
 * Roda no contexto de org do chamador (`inWebchatOrg` / `withSystemContext`).
 */
export async function writeLiveContext(input: {
  channelId: string;
  owner: LiveContextOwner;
  patch: WebchatContextPatch;
  maxKeys: number;
  now?: Date;
  db?: ScopedTx;
}): Promise<WriteLiveContextResult> {
  const db = input.db ?? prisma;
  const where = ownerWhere(input.channelId, input.owner);
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await db.webchatLiveContext.findFirst({
      where,
      select: { id: true, state: true, updatedAt: true },
    });
    const now = input.now ?? new Date();
    if (!row) {
      const applied = applyContextPatch({}, input.patch, input.maxKeys);
      try {
        await db.webchatLiveContext.create({
          data: withOrgFromCtx({
            channelId: input.channelId,
            contactId: "contactId" in input.owner ? input.owner.contactId : null,
            sessionId: "sessionId" in input.owner ? input.owner.sessionId : null,
            state: applied.state as Prisma.InputJsonValue,
            updatedAt: now,
          }),
        });
        return { ...applied, updatedAt: now, changed: true };
      } catch (err) {
        // Outra escrita criou a linha agora: relê e aplica por cima.
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") continue;
        throw err;
      }
    }
    const applied = applyContextPatch(readContextState(row.state), input.patch, input.maxKeys);
    if (!applied.changed) return { ...applied, updatedAt: row.updatedAt };
    const res = await db.webchatLiveContext.updateMany({
      where: { id: row.id, updatedAt: row.updatedAt },
      data: { state: applied.state as Prisma.InputJsonValue, updatedAt: now },
    });
    if (res.count === 1) return { ...applied, updatedAt: now };
  }
  throw new Error("webchat live context: escrita concorrente não convergiu");
}
