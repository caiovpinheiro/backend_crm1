/**
 * Ciclo de vida de campanha como serviço: validar o corpo de criação,
 * lançar, pausar, retomar e cancelar.
 *
 * As regras são as mesmas dos handlers de sessão em `/api/campaigns/*`
 * (que hoje as têm inline) — mesmos status HTTP e mensagens. Quem chama
 * escolhe se a trava de público (`campaign-audience-guard`) vale; as rotas
 * de sessão não passam por aqui.
 */
import type { CampaignStatus } from "@prisma/client";

import { isCampaignSendRoundRobinEnabled } from "@/lib/campaign-send-rate";
import { prisma } from "@/lib/prisma";
import { enqueueCampaignDispatch, enqueueCampaignSend } from "@/lib/queue";
import {
  checkAudienceFilters,
  type AudienceGuardCode,
} from "@/services/campaign-audience-guard";
import { updateCampaignStatus, type CreateCampaignInput } from "@/services/campaigns";

export type LifecycleFailure = {
  ok: false;
  httpStatus: number;
  message: string;
  code?: AudienceGuardCode;
};

export type LifecycleResult =
  | { ok: true; status: CampaignStatus; message: string }
  | LifecycleFailure;

export type AudienceGuardOptions = {
  /** Recusa público que resolve para todos os contatos com telefone. */
  requireRestrictiveAudience?: boolean;
};

const CAMPAIGN_TYPES = new Set(["TEMPLATE", "TEXT", "AUTOMATION"]);

function fail(
  httpStatus: number,
  message: string,
  code?: AudienceGuardCode,
): LifecycleFailure {
  return { ok: false, httpStatus, message, ...(code ? { code } : {}) };
}

/**
 * Corpo do `POST` de criação → `CreateCampaignInput` (mesmo contrato do
 * `POST /api/campaigns`). `scheduledAt` ilegível é recusado em vez de virar
 * data inválida no banco.
 */
export function parseCampaignDraftBody(
  body: unknown,
  createdById: string,
  opts: AudienceGuardOptions = {},
): { ok: true; input: CreateCampaignInput } | LifecycleFailure {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return fail(400, "Corpo inválido.");
  }
  const b = body as Record<string, unknown>;

  const name = typeof b.name === "string" ? b.name.trim() : "";
  if (!name) return fail(400, "Nome é obrigatório.");

  const type = typeof b.type === "string" ? b.type : "";
  if (!CAMPAIGN_TYPES.has(type)) return fail(400, "Tipo de campanha inválido.");

  const useLastConversationChannel = b.useLastConversationChannel === true;
  const channelId = typeof b.channelId === "string" ? b.channelId.trim() : "";
  if (!useLastConversationChannel && !channelId) {
    return fail(400, "Canal é obrigatório.");
  }

  let scheduledAt: Date | undefined;
  if (typeof b.scheduledAt === "string" && b.scheduledAt.trim()) {
    scheduledAt = new Date(b.scheduledAt);
    if (Number.isNaN(scheduledAt.getTime())) {
      return fail(400, "scheduledAt inválido. Use ISO-8601.");
    }
  }

  const segmentId =
    typeof b.segmentId === "string" && b.segmentId.trim() ? b.segmentId.trim() : undefined;

  let filters = b.filters as CreateCampaignInput["filters"];
  if (opts.requireRestrictiveAudience && !segmentId) {
    const audience = checkAudienceFilters(b.filters, { rejectUnknownKeys: true });
    if (!audience.ok) return fail(400, audience.message, audience.code);
    filters = audience.filters;
  }

  return {
    ok: true,
    input: {
      name,
      type: type as CreateCampaignInput["type"],
      channelId: useLastConversationChannel ? null : channelId,
      useLastConversationChannel,
      createdById,
      segmentId,
      filters,
      templateName: typeof b.templateName === "string" ? b.templateName : undefined,
      templateLanguage: typeof b.templateLanguage === "string" ? b.templateLanguage : undefined,
      templateComponents: b.templateComponents ?? undefined,
      textContent: typeof b.textContent === "string" ? b.textContent : undefined,
      automationId: typeof b.automationId === "string" ? b.automationId : undefined,
      sendRate: typeof b.sendRate === "number" ? b.sendRate : undefined,
      scheduledAt,
    },
  };
}

/**
 * Canal, segmento e automação citados precisam existir na organização do
 * contexto (o `prisma` escopado não enxerga os de outra).
 */
export async function findMissingCampaignReference(
  input: Pick<CreateCampaignInput, "channelId" | "segmentId" | "automationId">,
): Promise<LifecycleFailure | null> {
  const [channel, segment, automation] = await Promise.all([
    input.channelId
      ? prisma.channel.findUnique({ where: { id: input.channelId }, select: { id: true } })
      : null,
    input.segmentId
      ? prisma.segment.findUnique({ where: { id: input.segmentId }, select: { id: true } })
      : null,
    input.automationId
      ? prisma.automation.findUnique({ where: { id: input.automationId }, select: { id: true } })
      : null,
  ]);
  if (input.channelId && !channel) return fail(400, "Canal não encontrado.");
  if (input.segmentId && !segment) return fail(400, "Segmento não encontrado.");
  if (input.automationId && !automation) return fail(400, "Automação não encontrada.");
  return null;
}

export async function launchCampaign(
  id: string,
  opts: AudienceGuardOptions = {},
): Promise<LifecycleResult> {
  const campaign = await prisma.campaign.findUnique({
    where: { id },
    include: { channel: { select: { status: true } } },
  });
  if (!campaign) return fail(404, "Campanha não encontrada.");

  if (campaign.status !== "DRAFT") {
    return fail(409, "Apenas campanhas em rascunho podem ser lançadas.");
  }

  if (!campaign.useLastConversationChannel) {
    if (!campaign.channelId || !campaign.channel) {
      return fail(400, "Canal é obrigatório para campanha com canal fixo.");
    }
    if (campaign.channel.status !== "CONNECTED") {
      return fail(409, "O canal selecionado não está conectado.");
    }
  }

  if (!campaign.segmentId && !campaign.filters) {
    return fail(400, "Selecione um segmento ou configure filtros de destinatários.");
  }
  if (opts.requireRestrictiveAudience && !campaign.segmentId) {
    const audience = checkAudienceFilters(campaign.filters);
    if (!audience.ok) return fail(400, audience.message, audience.code);
  }

  if (campaign.type === "TEMPLATE" && !campaign.templateName) {
    return fail(400, "Selecione um template para campanha do tipo Template.");
  }
  if (campaign.type === "TEXT" && !campaign.textContent) {
    return fail(400, "Insira o conteúdo da mensagem para campanha do tipo Texto.");
  }
  if (campaign.type === "AUTOMATION" && !campaign.automationId) {
    return fail(400, "Selecione uma automação para campanha do tipo Automação.");
  }

  const isScheduled = Boolean(campaign.scheduledAt && campaign.scheduledAt > new Date());
  const newStatus: CampaignStatus = isScheduled ? "SCHEDULED" : "PROCESSING";
  const delay = isScheduled ? campaign.scheduledAt!.getTime() - Date.now() : undefined;

  await prisma.campaign.update({ where: { id }, data: { status: newStatus } });

  const job = await enqueueCampaignDispatch({ campaignId: campaign.id }, delay);
  if (!job) {
    await prisma.campaign.update({ where: { id }, data: { status: "DRAFT" } });
    return fail(
      503,
      "Fila de disparo indisponível (Redis). A campanha continua como rascunho — tente lançar novamente em instantes.",
    );
  }

  return {
    ok: true,
    status: newStatus,
    message: isScheduled
      ? `Campanha agendada para ${campaign.scheduledAt!.toLocaleString("pt-BR")}.`
      : "Campanha iniciada.",
  };
}

export async function pauseCampaign(id: string): Promise<LifecycleResult> {
  const campaign = await prisma.campaign.findUnique({
    where: { id },
    select: { status: true },
  });
  if (!campaign) return fail(404, "Campanha não encontrada.");

  if (campaign.status !== "SENDING" && campaign.status !== "PROCESSING") {
    return fail(409, "Apenas campanhas em envio podem ser pausadas.");
  }

  await updateCampaignStatus(id, "PAUSED");
  return { ok: true, status: "PAUSED", message: "Campanha pausada." };
}

export async function resumeCampaign(id: string): Promise<LifecycleResult> {
  const campaign = await prisma.campaign.findUnique({
    where: { id },
    select: { status: true },
  });
  if (!campaign) return fail(404, "Campanha não encontrada.");

  if (campaign.status !== "PAUSED") {
    return fail(409, "Apenas campanhas pausadas podem ser retomadas.");
  }

  await prisma.campaign.update({ where: { id }, data: { status: "SENDING" } });

  if (isCampaignSendRoundRobinEnabled()) {
    const pending = await prisma.campaignRecipient.count({
      where: { campaignId: id, status: "PENDING" },
    });
    return {
      ok: true,
      status: "SENDING",
      message: `Campanha retomada. ${pending} envios pendentes serão retomados automaticamente.`,
    };
  }

  const pendingRecipients = await prisma.campaignRecipient.findMany({
    where: { campaignId: id, status: "PENDING" },
    include: {
      contact: { select: { id: true, phone: true, whatsappBsuid: true } },
    },
  });

  for (const r of pendingRecipients) {
    if (!r.contact.phone) continue;
    await enqueueCampaignSend({
      campaignId: id,
      recipientId: r.id,
      contactId: r.contactId,
      contactPhone: r.contact.phone,
      contactBsuid: r.contact.whatsappBsuid ?? undefined,
    });
  }

  return {
    ok: true,
    status: "SENDING",
    message: `Campanha retomada. ${pendingRecipients.length} envios na fila.`,
  };
}

const CANCELLABLE: readonly CampaignStatus[] = [
  "DRAFT",
  "SCHEDULED",
  "PROCESSING",
  "SENDING",
  "PAUSED",
];

export async function cancelCampaign(id: string): Promise<LifecycleResult> {
  const campaign = await prisma.campaign.findUnique({
    where: { id },
    select: { status: true },
  });
  if (!campaign) return fail(404, "Campanha não encontrada.");

  if (!CANCELLABLE.includes(campaign.status)) {
    return fail(409, "Esta campanha não pode ser cancelada.");
  }

  await updateCampaignStatus(id, "CANCELLED");
  await prisma.campaignRecipient.updateMany({
    where: { campaignId: id, status: "PENDING" },
    data: { status: "FAILED", errorMessage: "Campanha cancelada." },
  });

  return { ok: true, status: "CANCELLED", message: "Campanha cancelada." };
}
