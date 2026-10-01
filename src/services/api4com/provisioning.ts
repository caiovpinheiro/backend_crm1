/**
 * ProvisioningService — máquina de estados que provisiona automaticamente
 * usuário + ramal + webhook na Api4com ao ligar o toggle "telephonyEnabled".
 *
 * Invariantes:
 *   - Cada passo concluído persiste provisioningStep ANTES de avançar.
 *   - 409 em POST /users = "já existe" → pula para CREATE_EXTENSION.
 *   - Toggle OFF: apaga ramal + tenta apagar usuário remoto, depois limpa
 *     credenciais locais. Histórico de chamadas permanece.
 *   - Retomada: ao chamar enableTelephony com step != IDLE, resume do ponto.
 *
 * Ver docs/PLAN-api4com.md §4 para diagrama de estados.
 */
import type { SipExtension, TelephonyProvisioningStep } from "@prisma/client";

import { encryptSecret } from "@/lib/crypto/secrets";
import { getLogger } from "@/lib/logger";
import { maskEmail, maskPhone } from "@/lib/pii-mask";
import { prisma } from "@/lib/prisma";
import {
  getOrCreateApi4ComProviderConfig,
  resolveApi4ComServiceToken,
  resolveOrgApi4ComGateway,
} from "@/services/call-provider-configs";

import { Api4ComClient } from "./client";
import { Api4ComConflictError, Api4ComValidationError } from "./errors";
import type { Api4ComExtensionResponse } from "./types";

const log = getLogger("api4com-provisioning");

export type ProvisionResult = {
  success: boolean;
  step: TelephonyProvisioningStep;
  error?: string;
  sipExtensionId?: string;
};

export type ProvisionStatus = {
  telephonyEnabled: boolean;
  provisioningStep: TelephonyProvisioningStep;
  provisioningError: string | null;
  provisionedAt: Date | null;
};

type ProvisionContext = {
  userId: string;
  organizationId: string;
  client: Api4ComClient;
  ext: SipExtension;
};

/**
 * Ativa telefonia para o usuário: provisiona usuário, ramal e webhook na Api4com.
 * Idempotente — pode ser chamado múltiplas vezes com segurança.
 */
export async function enableTelephony(
  userId: string,
  organizationId: string,
): Promise<ProvisionResult> {
  const token = await resolveApi4ComServiceToken(organizationId);
  if (!token) {
    return {
      success: false,
      step: "FAILED",
      error:
        "Token Api4Com ausente. Configure o token ADMIN em Widgets → Telefonia IP → Integração.",
    };
  }
  const client = new Api4ComClient({ token });
  const gateway = await resolveOrgApi4ComGateway(organizationId);
  const webhookVersion = process.env.API4COM_WEBHOOK_VERSION ?? "1.8";

  let ext = await findOrCreateExtensionRecord(userId, organizationId);

  if (ext.provisioningStep === "ACTIVE") {
    log.info(`[prov] Usuário ${userId} já provisionado (ACTIVE). Noop.`);
    return { success: true, step: "ACTIVE", sipExtensionId: ext.id };
  }

  ext = await updateStep(ext.id, "CHECK_REMOTE");
  const ctx: ProvisionContext = { userId, organizationId, client, ext };

  try {
    const step = ext.provisioningStep as TelephonyProvisioningStep;
    await runFromStep(step, ctx, gateway, webhookVersion);

    ext = await prisma.sipExtension.update({
      where: { id: ext.id },
      data: {
        provisioningStep: "ACTIVE",
        provisioningError: null,
        provisionedAt: new Date(),
        telephonyEnabled: true,
        status: "ACTIVE",
      },
    });

    log.info(`[prov] Usuário ${userId} provisionado com sucesso.`);
    return { success: true, step: "ACTIVE", sipExtensionId: ext.id };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`[prov] Falha no provisionamento de ${userId}: ${msg}`);
    await prisma.sipExtension.update({
      where: { id: ext.id },
      data: {
        provisioningStep: "FAILED",
        provisioningError: msg.slice(0, 2000),
      },
    });
    return { success: false, step: "FAILED", error: msg, sipExtensionId: ext.id };
  }
}

/**
 * Desativa telefonia (toggle OFF): apaga ramal e tenta apagar o usuário
 * remoto. Histórico de chamadas no CRM permanece.
 */
export async function disableTelephony(
  userId: string,
  organizationId: string,
): Promise<ProvisionResult> {
  const ext = await prisma.sipExtension.findUnique({
    where: { organizationId_userId: { organizationId, userId } },
  });
  if (!ext) {
    return { success: true, step: "DISABLED" };
  }

  try {
    const extensionId = readProviderExtensionId(ext.providerMeta);
    if (extensionId || ext.api4comUserId) {
      const token = await resolveApi4ComServiceToken(organizationId);
      if (!token) {
        throw new Error(
          "Token Api4Com ausente. Configure o token ADMIN em Widgets → Telefonia IP → Integração.",
        );
      }
      const client = new Api4ComClient({ token });
      if (extensionId) {
        await client.deleteExtension(extensionId);
      }
      if (ext.api4comUserId) {
        await client.deleteUser(ext.api4comUserId);
      }
    }

    await prisma.sipExtension.update({
      where: { id: ext.id },
      data: {
        telephonyEnabled: false,
        status: "INACTIVE",
        provisioningStep: "DISABLED",
        provisioningError: null,
        provisionedAt: null,
        api4comUserId: null,
        api4comGateway: null,
        sipUri: "",
        authUser: "",
        authPasswordEncrypted: "",
        wsServer: "",
        providerMeta: {},
      },
    });
    log.info(`[prov] Telefonia desativada e recursos remotos removidos para ${userId}.`);
    return { success: true, step: "DISABLED", sipExtensionId: ext.id };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`[prov] Falha ao desprovisionar ${userId}: ${msg}`);
    await prisma.sipExtension.update({
      where: { id: ext.id },
      data: {
        provisioningStep: "FAILED",
        provisioningError: msg.slice(0, 2000),
      },
    });
    return { success: false, step: "FAILED", error: msg, sipExtensionId: ext.id };
  }
}

/**
 * Consulta status de provisionamento.
 */
export async function getProvisioningStatus(
  userId: string,
  organizationId: string,
): Promise<ProvisionStatus | null> {
  const ext = await prisma.sipExtension.findUnique({
    where: { organizationId_userId: { organizationId, userId } },
    select: {
      telephonyEnabled: true,
      provisioningStep: true,
      provisioningError: true,
      provisionedAt: true,
    },
  });
  if (!ext) return null;
  return ext;
}

// ── Máquina de estados interna ──────────────────────────────────────────────

async function runFromStep(
  step: TelephonyProvisioningStep,
  ctx: ProvisionContext,
  gateway: string,
  webhookVersion: string,
): Promise<void> {
  const STEP_ORDER: TelephonyProvisioningStep[] = [
    "CHECK_REMOTE",
    "CREATE_USER",
    "CREATE_EXTENSION",
    "CONFIG_WEBHOOK",
  ];

  const startIdx = STEP_ORDER.indexOf(step);
  if (startIdx === -1) {
    throw new Error(`Step inválido para retomada: ${step}`);
  }

  let api4comUserId = ctx.ext.api4comUserId;

  for (let i = startIdx; i < STEP_ORDER.length; i++) {
    const current = STEP_ORDER[i];

    switch (current) {
      case "CHECK_REMOTE": {
        const user = await findUserOnCrm(ctx);
        if (user) {
          api4comUserId = user.id;
          await persistApi4comUserId(ctx.ext.id, api4comUserId);
        }
        await updateStep(ctx.ext.id, "CREATE_USER");
        break;
      }
      case "CREATE_USER": {
        const hasRamal = Boolean(
          readProviderExtensionId(ctx.ext.providerMeta) &&
            ctx.ext.authUser &&
            ctx.ext.authPasswordEncrypted,
        );
        if (!api4comUserId && !hasRamal) {
          try {
            api4comUserId = await createRemoteUser(ctx);
            await persistApi4comUserId(ctx.ext.id, api4comUserId);
          } catch (err) {
            log.warn(
              `[prov] CREATE_USER falhou — seguindo para o ramal: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
        }
        await updateStep(ctx.ext.id, "CREATE_EXTENSION");
        break;
      }
      case "CREATE_EXTENSION": {
        const existingId = readProviderExtensionId(ctx.ext.providerMeta);
        if (existingId && ctx.ext.authUser && ctx.ext.authPasswordEncrypted) {
          log.info(`[prov] Ramal ${ctx.ext.authUser} já persistido — pulando CREATE_EXTENSION.`);
        } else {
          const extResp = await createRemoteExtension(ctx);
          await persistExtensionData(ctx.ext.id, extResp, gateway);
        }
        await updateStep(ctx.ext.id, "CONFIG_WEBHOOK");
        break;
      }
      case "CONFIG_WEBHOOK": {
        await configureWebhook(ctx, gateway, webhookVersion);
        break;
      }
    }
  }
}

async function findUserOnCrm(ctx: ProvisionContext): Promise<{ id: string } | null> {
  const crmUser = await prisma.user.findUnique({
    where: { id: ctx.userId },
    select: { email: true },
  });
  if (!crmUser?.email) return null;

  const remoteUsers = await ctx.client.findUsers({ email: crmUser.email });
  return remoteUsers.length > 0 ? { id: remoteUsers[0].id } : null;
}

async function createRemoteUser(ctx: ProvisionContext): Promise<string> {
  const crmUser = await prisma.user.findUniqueOrThrow({
    where: { id: ctx.userId },
    select: { email: true, name: true, phone: true },
  });

  const password = generatePassword();
  const phone = resolveApi4ComPhone(crmUser.phone);
  const payload = {
    name: crmUser.name ?? crmUser.email,
    email: crmUser.email,
    password,
    phone,
    role: "USER" as const,
  };

  try {
    return (await ctx.client.createUser(payload)).id;
  } catch (err) {
    if (
      err instanceof Api4ComValidationError &&
      /phone/i.test(`${err.message} ${err.responseBody ?? ""}`) &&
      phone !== API4COM_FALLBACK_PHONE
    ) {
      log.warn(`[prov] Telefone ${maskPhone(phone)} recusado. Tentando o fallback.`);
      try {
        return (await ctx.client.createUser({ ...payload, phone: API4COM_FALLBACK_PHONE })).id;
      } catch (retryErr) {
        return recoverExistingUser(ctx, crmUser.email, retryErr);
      }
    }
    return recoverExistingUser(ctx, crmUser.email, err);
  }
}

async function recoverExistingUser(
  ctx: ProvisionContext,
  email: string,
  err: unknown,
): Promise<string> {
  if (err instanceof Api4ComConflictError) {
    log.warn(`[prov] Usuário ${maskEmail(email)} já existe na Api4com (409). Recuperando...`);
    const existing = await ctx.client.findUsers({ email });
    if (existing.length > 0) return existing[0].id;
    throw new Error(
      `Conflito ao criar usuário (409), mas GET não retornou match para ${maskEmail(email)}.`,
    );
  }
  throw err;
}

async function createRemoteExtension(
  ctx: ProvisionContext,
): Promise<Api4ComExtensionResponse> {
  const crmUser = await prisma.user.findUnique({
    where: { id: ctx.userId },
    select: { name: true, email: true },
  });
  const name = crmUser?.name?.trim() || "CRM";
  const parts = name.split(/\s+/);
  return ctx.client.createNextExtension({
    firstName: parts[0],
    lastName: parts.slice(1).join(" ") || parts[0],
    email: crmUser?.email ?? undefined,
  });
}

async function configureWebhook(
  ctx: ProvisionContext,
  gateway: string,
  webhookVersion: string,
): Promise<void> {
  const config = await getOrCreateApi4ComProviderConfig(ctx.organizationId);
  const baseUrl = (process.env.NEXT_PUBLIC_APP_URL ?? process.env.APP_URL ?? "").replace(
    /\/$/,
    "",
  );
  const webhookUrl = config.webhookUrl.startsWith("http")
    ? config.webhookUrl
    : `${baseUrl}${config.webhookUrl.startsWith("/") ? "" : "/"}${config.webhookUrl}`;

  const versions = Array.from(new Set([webhookVersion, "1.8", "v1.4"]));
  let lastErr: unknown;
  for (const version of versions) {
    try {
      await ctx.client.upsertIntegration({
        gateway,
        webhook: true,
        webhookConstraint: { metadata: { gateway } },
        metadata: {
          webhookUrl,
          webhookVersion: version,
          webhookTypes: ["channel-answer", "channel-hangup"],
        },
      });
      return;
    } catch (err) {
      lastErr = err;
      log.warn(
        `[prov] PATCH /integrations falhou com webhookVersion=${version}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  log.warn(
    `[prov] Webhook da org não registrado — ramal segue válido. ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`,
  );
}

// ── Helpers de persistência ─────────────────────────────────────────────────

async function findOrCreateExtensionRecord(
  userId: string,
  organizationId: string,
): Promise<SipExtension> {
  const existing = await prisma.sipExtension.findUnique({
    where: { organizationId_userId: { organizationId, userId } },
  });
  if (existing) return existing;

  return prisma.sipExtension.create({
    data: {
      organizationId,
      userId,
      label: "Api4com (auto)",
      sipUri: "",
      authUser: "",
      authPasswordEncrypted: "",
      wsServer: "",
      stunServers: ["stun:stun.l.google.com:19302"],
      telephonyEnabled: true,
      provisioningStep: "IDLE",
    },
  });
}

async function updateStep(
  extId: string,
  step: TelephonyProvisioningStep,
): Promise<SipExtension> {
  return prisma.sipExtension.update({
    where: { id: extId },
    data: { provisioningStep: step },
  });
}

async function persistApi4comUserId(
  extId: string,
  api4comUserId: string,
): Promise<void> {
  await prisma.sipExtension.update({
    where: { id: extId },
    data: { api4comUserId },
  });
}

async function persistExtensionData(
  extId: string,
  resp: Api4ComExtensionResponse,
  gateway: string,
): Promise<void> {
  const domain = resp.domain;
  await prisma.sipExtension.update({
    where: { id: extId },
    data: {
      sipUri: `sip:${resp.ramal}@${domain}`,
      authUser: resp.ramal,
      authPasswordEncrypted: encryptSecret(resp.senha),
      wsServer: `wss://${domain}:6443`,
      api4comGateway: gateway,
      providerMeta: {
        extensionId: resp.id,
        ramal: resp.ramal,
        domain,
        bina: resp.bina ?? null,
      },
    },
  });
}

function generatePassword(): string {
  const chars = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@#$%";
  let pw = "";
  for (let i = 0; i < 16; i++) {
    pw += chars[Math.floor(Math.random() * chars.length)];
  }
  return pw;
}

/** Exemplo oficial da Api4Com — passa a validação DDD + 8/9 dígitos. */
const API4COM_FALLBACK_PHONE = "4833328530";

/**
 * Api4Com exige DDD (2) + número (8 ou 9). Rejeita placeholder tipo 11999999999.
 * Usa o telefone do CRM se for BR válido; senão o exemplo da documentação.
 */
function resolveApi4ComPhone(phone: string | null | undefined): string {
  return normalizeBrPhone(phone) ?? API4COM_FALLBACK_PHONE;
}

function normalizeBrPhone(phone: string | null | undefined): string | null {
  let digits = (phone ?? "").replace(/\D/g, "");
  if (digits.startsWith("55") && (digits.length === 12 || digits.length === 13)) {
    digits = digits.slice(2);
  }
  if (digits.length !== 10 && digits.length !== 11) return null;
  const ddd = Number(digits.slice(0, 2));
  if (ddd < 11 || ddd > 99) return null;
  const local = digits.slice(2);
  if (/^(\d)\1+$/.test(local)) return null;
  if (digits.length === 11 && local[0] !== "9") return null;
  return digits;
}

function readProviderExtensionId(meta: unknown): string | null {
  if (!meta || typeof meta !== "object") return null;
  const id = (meta as { extensionId?: unknown }).extensionId;
  if (typeof id === "string" && id.length > 0) return id;
  if (typeof id === "number" && Number.isFinite(id)) return String(id);
  return null;
}
