import type {
  AuthenticationCreds,
  AuthenticationState,
  SignalDataTypeMap,
  SignalDataSet,
  SignalKeyStore,
} from "@whiskeysockets/baileys";
import { initAuthCreds, BufferJSON } from "@whiskeysockets/baileys";
import { prismaBase } from "@/lib/prisma-base";

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

  const saveCreds = async () => {
    await prismaBase.baileysAuthKey.upsert({
      where: { channelId_keyType_keyId: { channelId, keyType: "creds", keyId: "creds" } },
      update: { value: JSON.parse(writeData(creds)) },
      create: { organizationId, channelId, keyType: "creds", keyId: "creds", value: JSON.parse(writeData(creds)) },
    });
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
      const ops: Promise<unknown>[] = [];
      for (const _type in data) {
        const type = _type as keyof SignalDataTypeMap;
        const entries = data[type]!;
        for (const [keyId, value] of Object.entries(entries)) {
          if (value === null || value === undefined) {
            ops.push(
              prismaBase.baileysAuthKey.deleteMany({
                where: { channelId, keyType: type, keyId },
              }),
            );
          } else {
            const serialized = JSON.parse(writeData(value));
            ops.push(
              prismaBase.baileysAuthKey.upsert({
                where: { channelId_keyType_keyId: { channelId, keyType: type, keyId } },
                update: { value: serialized },
                create: { organizationId, channelId, keyType: type, keyId, value: serialized },
              }),
            );
          }
        }
      }
      await Promise.all(ops);
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
