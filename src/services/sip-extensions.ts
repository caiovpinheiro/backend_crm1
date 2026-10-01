/**
 * Service: Ramais SIP (SipExtension).
 *
 * Regras de segurança:
 *  - authPasswordEncrypted NUNCA é retornada nas listagens/get.
 *  - getMyCredentials descriptografa e retorna a senha SOMENTE para o dono.
 *  - NUNCA logar credenciais.
 */
import { Prisma, type SipExtensionStatus } from "@prisma/client";

import { decryptSecret, encryptSecret } from "@/lib/crypto/secrets";
import { prisma } from "@/lib/prisma";
import { prismaBase } from "@/lib/prisma-base";
import { withOrg } from "@/lib/prisma-helpers";
import { getOrgIdOrThrow } from "@/lib/request-context";
import {
  getApi4ComAccountFromProviderMeta,
  getApi4ComTokenFromProviderMeta,
  resolveDialProvider,
  buildApi4ComProviderMeta,
} from "@/services/sip-extension-provider-meta";
import { resolveApi4ComServiceToken } from "@/services/call-provider-configs";
import { loginApi4Com } from "@/services/telephony-providers/api4com";

// ── Tipos públicos ────────────────────────────────────────────────────────

export type CreateOrUpdateExtensionInput = {
  userId: string;
  label: string;
  sipUri: string;
  authUser: string;
  /** Senha em texto plano — cifrada antes de persistir. */
  authPassword: string;
  wsServer: string;
  stunServers: string[];
  turnServer?: { urls: string | string[]; username?: string; credential?: string } | null;
  status?: SipExtensionStatus;
  /** Metadados do provedor (ex.: token Api4Com). Nunca exposto na API pública. */
  providerMeta?: Prisma.InputJsonValue | null;
};

export type SipExtensionPublic = {
  id: string;
  organizationId: string;
  userId: string;
  label: string;
  sipUri: string;
  authUser: string;
  wsServer: string;
  stunServers: unknown;
  turnServer: unknown;
  status: SipExtensionStatus;
  telephonyEnabled: boolean;
  provisioningStep: string;
  provisioningError: string | null;
  provisionedAt: Date | null;
  user: { id: string; name: string; email: string } | null;
  createdAt: Date;
  updatedAt: Date;
};

// Campos que nunca são expostos na resposta pública
const SELECT_PUBLIC = {
  id: true,
  organizationId: true,
  userId: true,
  label: true,
  sipUri: true,
  authUser: true,
  wsServer: true,
  stunServers: true,
  turnServer: true,
  status: true,
  telephonyEnabled: true,
  provisioningStep: true,
  provisioningError: true,
  provisionedAt: true,
  user: { select: { id: true, name: true, email: true } },
  createdAt: true,
  updatedAt: true,
} as const;

function redactTurnServer(turn: unknown): unknown {
  if (!turn || typeof turn !== "object" || Array.isArray(turn)) return turn;
  const copy = { ...(turn as Record<string, unknown>) };
  if ("credential" in copy) delete copy.credential;
  if ("password" in copy) delete copy.password;
  return copy;
}

function toPublicExtension(row: SipExtensionPublic): SipExtensionPublic {
  return { ...row, turnServer: redactTurnServer(row.turnServer) };
}

/** User não é SCOPED_MODELS (login). Filtro manual — não é bypass de Call. */
async function assertUserInCurrentOrg(userId: string): Promise<void> {
  const organizationId = getOrgIdOrThrow();
  const member = await prismaBase.user.findFirst({
    where: { id: userId, organizationId },
    select: { id: true },
  });
  if (!member) {
    throw Object.assign(new Error("Usuário não encontrado nesta organização."), {
      code: "USER_NOT_IN_ORG",
      status: 400,
    });
  }
}

// ── Funções ───────────────────────────────────────────────────────────────

/**
 * Cria ou atualiza o ramal do usuário na org corrente.
 * Upsert por (organizationId, userId) — um ramal por usuário por org.
 */
export async function createOrUpdateExtension(
  input: CreateOrUpdateExtensionInput,
): Promise<SipExtensionPublic> {
  const organizationId = getOrgIdOrThrow();
  await assertUserInCurrentOrg(input.userId);
  const encryptedPassword = encryptSecret(input.authPassword);

  return toPublicExtension(
    await prisma.sipExtension.upsert({
    where: {
      organizationId_userId: { organizationId, userId: input.userId },
    },
    create: withOrg(
      {
        userId: input.userId,
        label: input.label,
        sipUri: input.sipUri,
        authUser: input.authUser,
        authPasswordEncrypted: encryptedPassword,
        wsServer: input.wsServer,
        stunServers: input.stunServers as Prisma.InputJsonValue,
        ...(input.turnServer !== undefined && input.turnServer !== null
          ? { turnServer: input.turnServer as Prisma.InputJsonValue }
          : {}),
        ...(input.providerMeta !== undefined && input.providerMeta !== null
          ? { providerMeta: input.providerMeta as Prisma.InputJsonValue }
          : {}),
        status: input.status ?? "ACTIVE",
      },
      organizationId,
    ),
    update: {
      label: input.label,
      sipUri: input.sipUri,
      authUser: input.authUser,
      authPasswordEncrypted: encryptedPassword,
      wsServer: input.wsServer,
      stunServers: input.stunServers as Prisma.InputJsonValue,
      ...(input.turnServer !== undefined
        ? {
            turnServer:
              input.turnServer === null
                ? Prisma.DbNull
                : (input.turnServer as Prisma.InputJsonValue),
          }
        : {}),
      ...(input.providerMeta !== undefined
        ? {
            providerMeta:
              input.providerMeta === null
                ? Prisma.DbNull
                : (input.providerMeta as Prisma.InputJsonValue),
          }
        : {}),
      status: input.status ?? "ACTIVE",
    },
    select: SELECT_PUBLIC,
    }),
  );
}

/** Lista todos os ramais da org corrente (sem senha). */
export async function listExtensions(): Promise<SipExtensionPublic[]> {
  const rows = await prisma.sipExtension.findMany({
    select: SELECT_PUBLIC,
    orderBy: { createdAt: "asc" },
  });
  return rows.map(toPublicExtension);
}

/** Busca um ramal por id, filtrando pela org corrente. */
export async function getExtension(id: string): Promise<SipExtensionPublic | null> {
  const row = await prisma.sipExtension.findUnique({
    where: { id },
    select: SELECT_PUBLIC,
  });
  return row ? toPublicExtension(row) : null;
}

/** Remove um ramal da org corrente. */
export async function deleteExtension(id: string): Promise<void> {
  await prisma.sipExtension.delete({ where: { id } });
}

export type SipCredentials = {
  sipUri: string;
  authUser: string;
  /** Senha descriptografada — retornar SOMENTE ao dono autenticado. NUNCA logar. */
  authPassword: string;
  wsServer: string;
  stunServers: unknown;
  turnServer: unknown;
  /** Como discar: Api4Com usa REST /dialer + auto-atendimento SIP; demais PBX usam INVITE direto. */
  dialProvider: "api4com" | "sip";
};

/**
 * Retorna as credenciais descriptografadas do ramal do usuário.
 * DEVE ser chamado SOMENTE pelo próprio dono (verificação no route handler).
 * NUNCA logar o retorno desta função.
 */
function normalizeSipUri(raw: string): string {
  const uri = raw.trim();
  if (!uri) return "";
  if (/^sip:/i.test(uri)) return uri;
  if (uri.includes("@")) return `sip:${uri}`;
  return uri;
}

/** Ramal só é usável no JsSIP com WSS + URI + usuário. Linha vazia (toggle off / provision incompleto) não conta. */
function isSipReady(ext: {
  telephonyEnabled?: boolean;
  sipUri: string;
  authUser: string;
  wsServer: string;
}): boolean {
  if (ext.telephonyEnabled === false) return false;
  return Boolean(ext.wsServer.trim() && ext.authUser.trim() && ext.sipUri.trim());
}

export async function getMyCredentials(userId: string): Promise<SipCredentials | null> {
  const organizationId = getOrgIdOrThrow();

  const ext = await prisma.sipExtension.findUnique({
    where: {
      organizationId_userId: { organizationId, userId },
    },
    select: {
      sipUri: true,
      authUser: true,
      authPasswordEncrypted: true,
      wsServer: true,
      stunServers: true,
      turnServer: true,
      providerMeta: true,
      telephonyEnabled: true,
    },
  });

  if (!ext || !isSipReady(ext)) return null;

  return {
    sipUri: normalizeSipUri(ext.sipUri),
    authUser: ext.authUser,
    authPassword: decryptSecret(ext.authPasswordEncrypted),
    wsServer: ext.wsServer,
    stunServers: ext.stunServers,
    turnServer: ext.turnServer,
    dialProvider: resolveDialProvider(ext.wsServer, ext.providerMeta),
  };
}

export type Api4ComStatus = {
  connected: boolean;
  /** E-mail Api4com salvo (decifrado do providerMeta). NÃO inclui senha. */
  email: string | null;
  /** Ramal SIP (= authUser). */
  ramal: string | null;
  /** Domínio do PBX (parseado do wsServer). */
  domain: string | null;
};

/**
 * Status compacto da conexão Api4com do usuário corrente.
 *
 * Retorna o suficiente pra UI dizer "Conectado como X • Ramal Y" sem
 * expor segredos. O e-mail vem decriptado pra reapresentar pro próprio
 * dono — a UI pode pré-preencher num formulário de reconexão.
 *
 * SEGURANÇA: só pode ser chamado pelo dono autenticado (autorização
 * no route handler). NUNCA retorna senha nem token de API.
 */
export async function getMyApi4ComStatus(userId: string): Promise<Api4ComStatus> {
  const organizationId = getOrgIdOrThrow();

  const ext = await prisma.sipExtension.findUnique({
    where: { organizationId_userId: { organizationId, userId } },
    select: {
      authUser: true,
      wsServer: true,
      providerMeta: true,
    },
  });

  if (!ext) {
    return { connected: false, email: null, ramal: null, domain: null };
  }

  const account = getApi4ComAccountFromProviderMeta(ext.providerMeta);
  const domain = ext.wsServer
    .replace(/^wss?:\/\//, "")
    .replace(/:.*$/, "")
    .trim() || null;

  return {
    connected: Boolean(ext.authUser),
    email: account?.email ?? null,
    ramal: ext.authUser || null,
    domain,
  };
}

/** Token + ramal para discagem Api4Com REST (dono autenticado apenas). */
export async function getMyApi4ComDialAuth(
  userId: string,
): Promise<{ extension: string; apiToken: string } | null> {
  const organizationId = getOrgIdOrThrow();

  const ext = await prisma.sipExtension.findUnique({
    where: {
      organizationId_userId: { organizationId, userId },
    },
    select: {
      authUser: true,
      providerMeta: true,
    },
  });

  if (!ext) return null;

  const apiToken = getApi4ComTokenFromProviderMeta(ext.providerMeta);
  if (!apiToken) return null;

  return { extension: ext.authUser, apiToken };
}

/**
 * Resolve token fresco para discagem (re-login quando credenciais da conta estão salvas).
 */
export async function resolveApi4ComDialToken(
  userId: string,
): Promise<{ extension: string; apiToken: string; organizationId: string } | null> {
  const organizationId = getOrgIdOrThrow();

  const ext = await prisma.sipExtension.findUnique({
    where: {
      organizationId_userId: { organizationId, userId },
    },
    select: {
      id: true,
      authUser: true,
      providerMeta: true,
    },
  });

  if (!ext?.authUser) return null;

  const account = getApi4ComAccountFromProviderMeta(ext.providerMeta);
  if (account) {
    const login = await loginApi4Com(account.email, account.password);
    if (!login.ok) return null;

    await prisma.sipExtension.update({
      where: { id: ext.id },
      data: {
        providerMeta: buildApi4ComProviderMeta(
          login.token,
          account.email,
          account.password,
        ) as Prisma.InputJsonValue,
      },
    });

    return { extension: ext.authUser, apiToken: login.token, organizationId };
  }

  const storedToken = getApi4ComTokenFromProviderMeta(ext.providerMeta);
  if (storedToken) {
    return { extension: ext.authUser, apiToken: storedToken, organizationId };
  }

  const orgToken = await resolveApi4ComServiceToken(organizationId);
  if (!orgToken) return null;
  return { extension: ext.authUser, apiToken: orgToken, organizationId };
}

/**
 * Busca o ramal de um usuário na org corrente (sem descriptografar senha).
 * Usado internamente para verificar existência antes de operar.
 */
export async function getExtensionByUser(userId: string): Promise<SipExtensionPublic | null> {
  const organizationId = getOrgIdOrThrow();
  return prisma.sipExtension.findUnique({
    where: {
      organizationId_userId: { organizationId, userId },
    },
    select: SELECT_PUBLIC,
  });
}

export type UpdateExtensionInput = Partial<Omit<CreateOrUpdateExtensionInput, "userId">> & {
  userId: string;
};

/**
 * Atualiza um ramal existente por id.
 * Re-cifra a senha se authPassword for fornecida.
 */
export async function updateExtension(
  id: string,
  input: UpdateExtensionInput,
): Promise<SipExtensionPublic> {
  const updateData: Record<string, unknown> = {};

  if (input.label !== undefined) updateData.label = input.label;
  if (input.sipUri !== undefined) updateData.sipUri = input.sipUri;
  if (input.authUser !== undefined) updateData.authUser = input.authUser;
  if (input.authPassword) updateData.authPasswordEncrypted = encryptSecret(input.authPassword);
  if (input.wsServer !== undefined) updateData.wsServer = input.wsServer;
  if (input.stunServers !== undefined) updateData.stunServers = input.stunServers;
  if (input.turnServer !== undefined) updateData.turnServer = input.turnServer;
  if (input.status !== undefined) updateData.status = input.status;

  return prisma.sipExtension.update({
    where: { id },
    data: updateData,
    select: SELECT_PUBLIC,
  });
}
