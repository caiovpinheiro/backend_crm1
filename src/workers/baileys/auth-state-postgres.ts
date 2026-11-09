import type {
  AuthenticationCreds,
  AuthenticationState,
  SignalDataTypeMap,
  SignalDataSet,
  SignalKeyStore,
} from "@whiskeysockets/baileys";
import { initAuthCreds, BufferJSON } from "@whiskeysockets/baileys";
import type { Prisma } from "@prisma/client";
import { prismaBase } from "@/lib/prisma-base";
import { getLogger } from "@/lib/logger";

const log = getLogger("worker.baileys.auth-state");

/** Tentativas de gravação (credencial e chaves) antes de desistir e logar. */
export const AUTH_WRITE_ATTEMPTS = 3;
const AUTH_WRITE_BACKOFF_MS = 500;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function withRetry<T>(
  what: string,
  channelId: string,
  fn: () => Promise<T>,
  backoffMs = AUTH_WRITE_BACKOFF_MS,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= AUTH_WRITE_ATTEMPTS; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      log.warn(
        { channelId, what, attempt, err: err instanceof Error ? err.message : String(err) },
        "[baileys-auth] gravação falhou",
      );
      if (attempt < AUTH_WRITE_ATTEMPTS) await sleep(backoffMs * attempt);
    }
  }
  log.error(
    { channelId, what, err: lastErr instanceof Error ? lastErr.message : String(lastErr) },
    "[baileys-auth] gravação desistiu depois das tentativas",
  );
  throw lastErr;
}

/**
 * Implements Baileys AuthenticationState backed by the `baileys_auth_keys`
 * Postgres table via Prisma. Each channel has its own isolated key set.
 */
export async function usePostgresAuthState(
  channelId: string,
): Promise<{ state: AuthenticationState; saveCreds: () => Promise<void> }> {
  const writeData = (value: unknown) => JSON.stringify(value, BufferJSON.replacer);
  const readData = (raw: unknown) => JSON.parse(JSON.stringify(raw), BufferJSON.reviver);

  const channelRow = await prismaBase.channel.findUnique({
    where: { id: channelId },
    select: { organizationId: true },
  });
  const organizationId = channelRow?.organizationId ?? "";

  const readCreds = async (): Promise<AuthenticationCreds> => {
    const row = await prismaBase.baileysAuthKey.findUnique({
      where: { channelId_keyType_keyId: { channelId, keyType: "creds", keyId: "creds" } },
    });
    return row ? readData(row.value) : initAuthCreds();
  };

  const creds = await readCreds();

  // Uma gravação por vez, sempre do estado mais novo: `creds.update`
  // dispara em rajada e upserts em paralelo podiam colidir (create
  // duplicado) ou falhar sem log.
  let queue: Promise<void> = Promise.resolve();
  const writeCreds = async () => {
    const value = JSON.parse(writeData(creds));
    await prismaBase.baileysAuthKey.upsert({
      where: { channelId_keyType_keyId: { channelId, keyType: "creds", keyId: "creds" } },
      update: { value },
      create: { organizationId, channelId, keyType: "creds", keyId: "creds", value },
    });
  };
  const saveCreds = (): Promise<void> => {
    const run = queue.then(() => withRetry("creds", channelId, writeCreds));
    // A fila segue mesmo se esta gravação desistir.
    queue = run.catch(() => {});
    return run;
  };

  const keys: SignalKeyStore = {
    async get<T extends keyof SignalDataTypeMap>(type: T, ids: string[]) {
      const rows = await prismaBase.baileysAuthKey.findMany({
        where: { channelId, keyType: type, keyId: { in: ids } },
      });
      const result: { [id: string]: SignalDataTypeMap[T] } = {};
      for (const row of rows) {
        try {
          result[row.keyId] = readData(row.value);
        } catch {
          /* corrupted key — skip */
        }
      }
      return result;
    },

    async set(data: SignalDataSet) {
      // Tudo ou nada: chave de sessão gravada pela metade dá erro de
      // descriptografia e derruba a conexão depois. As operações são
      // recriadas a cada tentativa (PrismaPromise não é reaproveitável).
      const writes: Array<{ type: string; keyId: string; value: unknown | null }> = [];
      for (const _type in data) {
        const type = _type as keyof SignalDataTypeMap;
        const entries = data[type]!;
        for (const [keyId, value] of Object.entries(entries)) {
          writes.push({
            type,
            keyId,
            value: value === null || value === undefined ? null : JSON.parse(writeData(value)),
          });
        }
      }
      if (writes.length === 0) return;
      const buildOps = (): Prisma.PrismaPromise<unknown>[] =>
        writes.map((w) =>
          w.value === null
            ? prismaBase.baileysAuthKey.deleteMany({
                where: { channelId, keyType: w.type, keyId: w.keyId },
              })
            : prismaBase.baileysAuthKey.upsert({
                where: { channelId_keyType_keyId: { channelId, keyType: w.type, keyId: w.keyId } },
                update: { value: w.value as Prisma.InputJsonValue },
                create: {
                  organizationId,
                  channelId,
                  keyType: w.type,
                  keyId: w.keyId,
                  value: w.value as Prisma.InputJsonValue,
                },
              }),
        );
      await withRetry("keys", channelId, () => prismaBase.$transaction(buildOps()));
    },

    async clear() {
      await prismaBase.baileysAuthKey.deleteMany({ where: { channelId } });
    },
  };

  return {
    state: { creds, keys },
    saveCreds,
  };
}

/**
 * Credencial já pareada com um aparelho (QR lido). Esse canal reconecta
 * sozinho no boot — sem ela, reconectar só geraria QR novo.
 */
export function credsAreRegistered(raw: unknown): boolean {
  if (!raw || typeof raw !== "object") return false;
  const me = (raw as { me?: { id?: unknown } }).me;
  return typeof me?.id === "string" && me.id.length > 0;
}
