/**
 * Nonce de uso único do connect Meta.
 *
 * Produção exige Redis. Memória só em development/test — um processo
 * não segura replay entre réplicas.
 *
 * Depois do sucesso o registro fica `completed` até o TTL, com
 * channelId e returnUrl, para um retry de rede devolver o mesmo
 * resultado sem provisionar de novo.
 */
import { getCacheClient } from "@/lib/cache/redis-client";
import { MetaConnectError } from "@/lib/meta-connect-state";
import { getLogger } from "@/lib/logger";

const log = getLogger("meta-connect-store");

export type MetaConnectRecord = {
  status: "pending" | "processing" | "completed";
  organizationId: string;
  userId: string;
  returnUrl: string;
  exp: number;
  channelId?: string;
  name?: string;
  resultChannelId?: string;
};

type ClaimResult =
  | { kind: "missing" }
  | { kind: "completed"; record: MetaConnectRecord }
  | { kind: "claimed"; record: MetaConnectRecord }
  | { kind: "busy" };

const memory = new Map<string, { record: MetaConnectRecord; expiresAt: number }>();

function allowMemory(): boolean {
  const env = process.env.NODE_ENV;
  return env === "development" || env === "test";
}

function keyOf(nonce: string): string {
  return `meta-connect:v1:${nonce}`;
}

function lockOf(nonce: string): string {
  return `meta-connect:lock:${nonce}`;
}

function memoryGet(nonce: string): MetaConnectRecord | null {
  const row = memory.get(nonce);
  if (!row) return null;
  if (row.expiresAt <= Date.now()) {
    memory.delete(nonce);
    return null;
  }
  return row.record;
}

function memorySet(nonce: string, record: MetaConnectRecord, ttlSec: number): void {
  memory.set(nonce, { record, expiresAt: Date.now() + ttlSec * 1000 });
}

export async function savePendingMetaConnect(
  nonce: string,
  record: MetaConnectRecord,
  ttlSec: number,
): Promise<void> {
  const client = getCacheClient();
  if (!client) {
    if (!allowMemory()) {
      throw new MetaConnectError(
        "Redis é obrigatório para conectar com a Meta.",
        503,
        "REDIS_REQUIRED",
      );
    }
    if (memoryGet(nonce)) {
      throw new MetaConnectError("Não foi possível iniciar a conexão.", 409, "STATE_USED");
    }
    memorySet(nonce, record, ttlSec);
    return;
  }
  const ok = await client.set(keyOf(nonce), JSON.stringify(record), "EX", ttlSec, "NX");
  if (ok !== "OK") {
    throw new MetaConnectError("Não foi possível iniciar a conexão.", 409, "STATE_USED");
  }
}

export async function readMetaConnectRecord(
  nonce: string,
): Promise<MetaConnectRecord | null> {
  const client = getCacheClient();
  if (!client) {
    if (!allowMemory()) {
      throw new MetaConnectError(
        "Redis é obrigatório para conectar com a Meta.",
        503,
        "REDIS_REQUIRED",
      );
    }
    return memoryGet(nonce);
  }
  const raw = await client.get(keyOf(nonce));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as MetaConnectRecord;
  } catch {
    return null;
  }
}

async function writeRecord(
  nonce: string,
  record: MetaConnectRecord,
  ttlSec: number,
): Promise<void> {
  const client = getCacheClient();
  if (!client) {
    if (!allowMemory()) {
      throw new MetaConnectError(
        "Redis é obrigatório para conectar com a Meta.",
        503,
        "REDIS_REQUIRED",
      );
    }
    memorySet(nonce, record, ttlSec);
    return;
  }
  await client.set(keyOf(nonce), JSON.stringify(record), "EX", ttlSec);
}

/**
 * pending → processing, com lock. `completed` devolve o resultado
 * guardado. `busy` quando outro request está no meio.
 */
export async function claimMetaConnect(
  nonce: string,
): Promise<ClaimResult> {
  const client = getCacheClient();
  if (!client) {
    if (!allowMemory()) {
      throw new MetaConnectError(
        "Redis é obrigatório para conectar com a Meta.",
        503,
        "REDIS_REQUIRED",
      );
    }
    const record = memoryGet(nonce);
    if (!record) return { kind: "missing" };
    if (record.status === "completed") return { kind: "completed", record };
    if (record.status === "processing") return { kind: "busy" };
    const next = { ...record, status: "processing" as const };
    const row = memory.get(nonce);
    memorySet(nonce, next, row ? Math.max(1, Math.ceil((row.expiresAt - Date.now()) / 1000)) : 60);
    return { kind: "claimed", record: next };
  }

  const raw = await client.get(keyOf(nonce));
  if (!raw) return { kind: "missing" };
  const record = JSON.parse(raw) as MetaConnectRecord;
  if (record.status === "completed") return { kind: "completed", record };

  const locked = await client.set(lockOf(nonce), "1", "EX", 90, "NX");
  if (locked !== "OK") return { kind: "busy" };

  const again = await client.get(keyOf(nonce));
  if (!again) {
    await client.del(lockOf(nonce));
    return { kind: "missing" };
  }
  const current = JSON.parse(again) as MetaConnectRecord;
  if (current.status === "completed") {
    await client.del(lockOf(nonce));
    return { kind: "completed", record: current };
  }
  const ttl = await client.ttl(keyOf(nonce));
  const next: MetaConnectRecord = { ...current, status: "processing" };
  await client.set(
    keyOf(nonce),
    JSON.stringify(next),
    "EX",
    ttl > 0 ? ttl : 90,
  );
  return { kind: "claimed", record: next };
}

export async function completeMetaConnectRecord(
  nonce: string,
  resultChannelId: string,
  returnUrl: string,
  ttlSec: number,
): Promise<void> {
  const current = await readMetaConnectRecord(nonce);
  if (!current) return;
  await writeRecord(
    nonce,
    {
      ...current,
      status: "completed",
      resultChannelId,
      returnUrl,
    },
    ttlSec,
  );
  const client = getCacheClient();
  if (client) await client.del(lockOf(nonce));
}

/** Falha antes de gravar o canal: devolve o nonce para um novo code. */
export async function releaseMetaConnectRecord(nonce: string): Promise<void> {
  const current = await readMetaConnectRecord(nonce);
  if (!current || current.status === "completed") return;
  const client = getCacheClient();
  let ttl = metaTtlFallback();
  if (client) {
    const left = await client.ttl(keyOf(nonce));
    if (left > 0) ttl = left;
  } else {
    const row = memory.get(nonce);
    if (row) ttl = Math.max(1, Math.ceil((row.expiresAt - Date.now()) / 1000));
  }
  await writeRecord(nonce, { ...current, status: "pending" }, ttl);
  if (client) await client.del(lockOf(nonce));
  log.info({ noncePrefix: nonce.slice(0, 8) }, "meta connect nonce released");
}

function metaTtlFallback(): number {
  return 60;
}
