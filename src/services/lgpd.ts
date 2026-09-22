/**
 * Serviço LGPD/GDPR (PR 4.3).
 *
 * Implementa os direitos do titular previstos em:
 *   - LGPD Art. 18, II (acesso) + IV (portabilidade) → `requestExport`
 *   - LGPD Art. 18, VI (eliminacao) → `requestErase`
 *   - GDPR Art. 15 (right of access) + Art. 20 (data portability)
 *   - GDPR Art. 17 (right to erasure / "right to be forgotten")
 *
 * ## Decisoes
 *
 * 1. **Export inline.** O job de gerar o JSON e barato (<1s pra um
 *    user tipico) — processamos no request handler, sem worker. Se um
 *    user com volume excepcional precisar export, o caller pode mover
 *    pra BullMQ depois. Marcamos `status` em PROCESSING → READY/FAILED
 *    pra a UI conseguir refresh sem timeout.
 *
 * 2. **Erase = anonimizacao.** NAO deletamos a row de User pra preservar
 *    integridade referencial em audit_logs, messages, deals, conversations.
 *    Rodar DELETE CASCADE faria a auditoria perder atribuicao (e.g.,
 *    "alguem fez X mas nao sabemos quem"), o que e exatamente o
 *    contrario do que a LGPD pede pra dados de auditoria. Substituimos:
 *    - name = "Usuario removido"
 *    - email = "erased+<userId>@anon.local"
 *    - hashedPassword = NULL (login impossivel)
 *    - phone, avatarUrl, signature, closingMessage = NULL
 *    - mfaSecret, mfaEnabledAt = NULL + delete backup codes
 *    - apiTokens deletados
 *    - webPushSubscriptions deletadas
 *    - aiAgentConfig.systemPrompt redactado
 *    Apos isso o user nao consegue logar e nao aparece em busca.
 *
 * 3. **Audit trail preservado.** Eventos `data_export_request`,
 *    `data_export_download`, `data_erase_request`, `data_erase_complete`
 *    sao loggados explicitamente. Compliance pede prova de que a
 *    erase foi cumprida (e quando).
 *
 * 4. **Storage do ZIP.** Reusamos o tenant-scoped storage (PR 1.3) no
 *    bucket `data-exports`. URL e gateada pelo middleware de auth do
 *    `/api/storage/[...path]/route.ts` — so o owner ou super-admin
 *    consegue baixar.
 *
 * 5. **Retention.** Arquivos expiram em 7 dias (`expiresAt`). Um cron
 *    futuro vai deletar fisicamente; o registro fica COMPLETED com
 *    `downloadKey = null`.
 *
 * @see docs/lgpd.md
 */
import { DataRequestStatus, DataRequestType } from "@prisma/client";
import crypto from "node:crypto";

import { prismaBase } from "@/lib/prisma-base";
import { sseBus } from "@/lib/sse-bus";
import { logAudit } from "@/lib/audit/log";
import { getLogger } from "@/lib/logger";

const logger = getLogger("lgpd");
import { saveFile, generateFileName } from "@/lib/storage/local";
import { redactValue } from "@/lib/audit/redact";

export const EXPORT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_MESSAGES = 5000;
const MAX_NOTES = 5000;
const MAX_ACTIVITIES = 5000;

export type RequestExportInput = {
  userId: string;
  organizationId: string;
  requestedById?: string;
};

/**
 * Cria + processa inline um export do user. Retorna o registro
 * `DataRequest` pronto pra UI mostrar a URL. Lanca em caso de IO.
 */
export async function requestExport(
  input: RequestExportInput,
): Promise<{ id: string; downloadUrl: string | null; status: DataRequestStatus }> {
  const created = await prismaBase.dataRequest.create({
    data: {
      organizationId: input.organizationId,
      userId: input.userId,
      requestedById: input.requestedById ?? input.userId,
      type: DataRequestType.EXPORT,
      status: DataRequestStatus.PROCESSING,
      startedAt: new Date(),
    },
    select: { id: true },
  });

  await logAudit({
    entity: "data_export",
    action: "data_export_request",
    entityId: created.id,
    organizationId: input.organizationId,
    actorId: input.requestedById ?? input.userId,
    metadata: { targetUserId: input.userId },
  });

  try {
    const result = await processExport(
      created.id,
      input.userId,
      input.organizationId,
    );
    return {
      id: created.id,
      downloadUrl: result.url,
      status: DataRequestStatus.READY,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, dataRequestId: created.id }, "[lgpd] export failed");
    await prismaBase.dataRequest.update({
      where: { id: created.id },
      data: {
        status: DataRequestStatus.FAILED,
        completedAt: new Date(),
        error: msg.slice(0, 1000),
      },
    });
    throw err;
  }
}

async function processExport(
  requestId: string,
  userId: string,
  organizationId: string,
): Promise<{ url: string }> {
  const payload = await collectUserData(userId, organizationId);

  const json = JSON.stringify(payload, null, 2);
  const buffer = Buffer.from(json, "utf-8");
  const fileName = generateFileName({
    prefix: "export",
    ext: "json",
    suffix: requestId.slice(0, 8),
  });

  const saved = await saveFile({
    orgId: organizationId,
    bucket: "data-exports",
    fileName,
    buffer,
  });

  const contentHash = crypto
    .createHash("sha256")
    .update(buffer)
    .digest("hex");

  await prismaBase.dataRequest.update({
    where: { id: requestId },
    data: {
      status: DataRequestStatus.READY,
      downloadKey: saved.url,
      downloadSize: buffer.byteLength,
      contentHash,
      expiresAt: new Date(Date.now() + EXPORT_TTL_MS),
      completedAt: new Date(),
    },
  });

  return { url: saved.url };
}

/**
 * Lista dados pessoais e de operacao do user. Limites embutidos pra
 * evitar export gigantesco — quando o user tem >5k mensagens, indica
 * NO JSON que houve truncamento e oferece um endpoint paginado
 * (futuro PR 4.3.1).
 */
async function collectUserData(userId: string, organizationId: string) {
  const user = await prismaBase.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      type: true,
      role: true,
      avatarUrl: true,
      signature: true,
      closingMessage: true,
      organizationId: true,
      isSuperAdmin: true,
      mfaEnabledAt: true,
      createdAt: true,
      updatedAt: true,
      organization: { select: { id: true, name: true, slug: true } },
    },
  });
  if (!user) throw new Error("user nao encontrado");

  const [
    messagesCount,
    messages,
    notesCount,
    notes,
    activitiesCount,
    activities,
    dealsAssigned,
    contactsAssigned,
    apiTokens,
    loginAttempts,
    auditLogs,
    presenceLogs,
    schedule,
    aiAgentConfig,
    dashboardLayouts,
  ] = await Promise.all([
    prismaBase.message.count({ where: { aiAgentUserId: userId } }),
    prismaBase.message.findMany({
      where: { aiAgentUserId: userId },
      select: {
        id: true,
        conversationId: true,
        content: true,
        messageType: true,
        direction: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
      take: MAX_MESSAGES,
    }),
    prismaBase.note.count({ where: { userId } }),
    prismaBase.note.findMany({
      where: { userId },
      select: { id: true, content: true, contactId: true, dealId: true, createdAt: true },
      orderBy: { createdAt: "desc" },
      take: MAX_NOTES,
    }),
    prismaBase.activity.count({ where: { userId } }),
    prismaBase.activity.findMany({
      where: { userId },
      select: {
        id: true,
        type: true,
        title: true,
        description: true,
        scheduledAt: true,
        completed: true,
        completedAt: true,
        contactId: true,
        dealId: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
      take: MAX_ACTIVITIES,
    }),
    prismaBase.deal.findMany({
      where: { ownerId: userId },
      select: {
        id: true,
        title: true,
        stageId: true,
        value: true,
        status: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
      take: 1000,
    }),
    prismaBase.contact.findMany({
      where: { assignedToId: userId },
      select: { id: true, name: true, email: true, phone: true, createdAt: true },
      orderBy: { createdAt: "desc" },
      take: 1000,
    }),
    prismaBase.apiToken.findMany({
      where: { userId },
      select: {
        id: true,
        name: true,
        tokenPrefix: true,
        lastUsedAt: true,
        expiresAt: true,
        createdAt: true,
      },
    }),
    prismaBase.loginAttempt.findMany({
      where: { userId },
      select: { id: true, ip: true, userAgent: true, outcome: true, createdAt: true },
      orderBy: { createdAt: "desc" },
      take: 200,
    }),
    prismaBase.auditLog.findMany({
      where: { actorId: userId },
      select: {
        id: true,
        entity: true,
        action: true,
        entityId: true,
        ip: true,
        userAgent: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
      take: 500,
    }),
    prismaBase.agentPresenceLog.findMany({
      where: { userId },
      select: { id: true, status: true, createdAt: true },
      orderBy: { createdAt: "desc" },
      take: 500,
    }),
    prismaBase.agentSchedule.findUnique({ where: { userId } }),
    prismaBase.aIAgentConfig.findUnique({ where: { userId } }),
    prismaBase.userDashboardLayout.findMany({
      where: { userId },
      select: { id: true, name: true, isDefault: true, createdAt: true },
    }),
  ]);

  // Redacao defensiva — caso colunas tenham conteudo sensivel, o
  // helper substitui antes de chegar ao JSON exportado.
  return redactValue({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    organizationId,
    user,
    counts: {
      messages: messagesCount,
      notes: notesCount,
      activities: activitiesCount,
      dealsAssigned: dealsAssigned.length,
      contactsAssigned: contactsAssigned.length,
      apiTokens: apiTokens.length,
      loginAttempts: loginAttempts.length,
      auditLogs: auditLogs.length,
    },
    truncation: {
      messagesTruncated: messagesCount > MAX_MESSAGES,
      notesTruncated: notesCount > MAX_NOTES,
      activitiesTruncated: activitiesCount > MAX_ACTIVITIES,
    },
    data: {
      messages,
      notes,
      activities,
      dealsAssigned,
      contactsAssigned,
      apiTokens,
      loginAttempts,
      auditLogs,
      presenceLogs,
      schedule,
      aiAgentConfig,
      dashboardLayouts,
    },
  });
}

export type RequestEraseInput = {
  userId: string;
  organizationId: string;
  requestedById?: string;
  /** Motivo livre (compliance trail). */
  reason?: string;
};

export async function requestErase(
  input: RequestEraseInput,
): Promise<{ id: string; status: DataRequestStatus }> {
  const created = await prismaBase.dataRequest.create({
    data: {
      organizationId: input.organizationId,
      userId: input.userId,
      requestedById: input.requestedById ?? input.userId,
      type: DataRequestType.ERASE,
      status: DataRequestStatus.PROCESSING,
      startedAt: new Date(),
    },
    select: { id: true },
  });

  await logAudit({
    entity: "data_erase",
    action: "data_erase_request",
    entityId: created.id,
    organizationId: input.organizationId,
    actorId: input.requestedById ?? input.userId,
    metadata: { targetUserId: input.userId, reason: input.reason ?? null },
  });

  try {
    await processErase(input.userId, input.organizationId);
    await prismaBase.dataRequest.update({
      where: { id: created.id },
      data: {
        status: DataRequestStatus.COMPLETED,
        completedAt: new Date(),
      },
    });
    await logAudit({
      entity: "data_erase",
      action: "data_erase_complete",
      entityId: created.id,
      organizationId: input.organizationId,
      actorId: input.requestedById ?? input.userId,
      metadata: { targetUserId: input.userId },
    });
    return { id: created.id, status: DataRequestStatus.COMPLETED };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, dataRequestId: created.id }, "[lgpd] erase failed");
    await prismaBase.dataRequest.update({
      where: { id: created.id },
      data: {
        status: DataRequestStatus.FAILED,
        completedAt: new Date(),
        error: msg.slice(0, 1000),
      },
    });
    throw err;
  }
}

async function processErase(userId: string, _organizationId: string): Promise<void> {
  // Anonimiza fields PII e desabilita login. Mantem o registro pra
  // preservar FKs em audit_logs / messages / deals / etc.
  const placeholderEmail = `erased+${userId}@anon.local`;
  await prismaBase.$transaction([
    prismaBase.user.update({
      where: { id: userId },
      data: {
        name: "Usuario removido",
        email: placeholderEmail,
        hashedPassword: null,
        phone: null,
        avatarUrl: null,
        signature: null,
        closingMessage: null,
        mfaSecret: null,
        mfaEnabledAt: null,
        isErased: true,
        erasedAt: new Date(),
      },
    }),
    prismaBase.userMfaBackupCode.deleteMany({ where: { userId } }),
    prismaBase.apiToken.deleteMany({ where: { userId } }),
    prismaBase.webPushSubscription.deleteMany({ where: { userId } }),
  ]);

  // AIAgentConfig pode conter prompts personalizados (PII potencial).
  const aiConfig = await prismaBase.aIAgentConfig.findUnique({
    where: { userId },
    select: { id: true },
  });
  if (aiConfig) {
    await prismaBase.aIAgentConfig.update({
      where: { id: aiConfig.id },
      data: { systemPromptOverride: null },
    });
  }

  sseBus.revokeUser({ userId, organizationId: _organizationId });
}

export async function getDataRequest(id: string, userId: string) {
  return prismaBase.dataRequest.findFirst({
    where: { id, userId },
    select: {
      id: true,
      type: true,
      status: true,
      downloadKey: true,
      downloadSize: true,
      contentHash: true,
      expiresAt: true,
      completedAt: true,
      error: true,
      createdAt: true,
    },
  });
}

export async function listMyDataRequests(userId: string) {
  return prismaBase.dataRequest.findMany({
    where: { userId },
    select: {
      id: true,
      type: true,
      status: true,
      downloadSize: true,
      expiresAt: true,
      completedAt: true,
      createdAt: true,
    },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
}
