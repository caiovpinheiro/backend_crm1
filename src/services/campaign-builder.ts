import { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { enqueueCampaignDispatch } from "@/lib/queue";
import { resolveCampaignSendRate } from "@/lib/campaign-send-rate";
import { previewSegment } from "@/services/segments";

import type { CampaignBuilderDraft } from "@/features/campaign-builder/schema";

type DraftPatch = Partial<CampaignBuilderDraft>;
type Actor = { id: string; role: string };

function canManageAnyDraft(role: string): boolean {
  return role === "ADMIN" || role === "MANAGER";
}

function toDate(value?: string): Date | undefined {
  if (!value) return undefined;
  const dt = new Date(value);
  if (Number.isNaN(dt.getTime())) return undefined;
  return dt;
}

export async function getDraftById(id: string, actor: Actor) {
  return prisma.campaign.findFirst({
    where: { id },
    select: {
      id: true,
      name: true,
      type: true,
      channelId: true,
      useLastConversationChannel: true,
      segmentId: true,
      filters: true,
      templateName: true,
      templateLanguage: true,
      textContent: true,
      automationId: true,
      sendRate: true,
      scheduledAt: true,
      status: true,
      createdById: true,
    },
  }).then((draft) => {
    if (!draft) return null;
    if (canManageAnyDraft(actor.role) || draft.createdById === actor.id) return draft;
    throw new Error("FORBIDDEN_DRAFT_ACCESS");
  });
}

export async function createDraft(organizationId: string, createdById: string, patch: DraftPatch) {
  return prisma.campaign.create({
    data: {
      organizationId,
      name: patch.name ?? "Nova campanha",
      type: patch.type ?? "TEMPLATE",
      useLastConversationChannel: patch.useLastConversationChannel ?? false,
      ...(patch.useLastConversationChannel || !patch.channelId
        ? {}
        : { channelId: patch.channelId }),
      createdById,
      segmentId: patch.segmentId || null,
      filters: (patch.filters as Prisma.InputJsonValue | undefined) ?? undefined,
      templateName: patch.templateName ?? null,
      templateLanguage: patch.templateLanguage ?? "pt_BR",
      textContent: patch.textContent ?? null,
      automationId: patch.automationId ?? null,
      sendRate: resolveCampaignSendRate(patch.sendRate),
      scheduledAt: toDate(patch.scheduledAt) ?? null,
      status: "DRAFT",
    },
  });
}

export async function updateDraft(id: string, patch: DraftPatch, actor: Actor) {
  const current = await prisma.campaign.findFirst({
    where: { id },
    select: { id: true, createdById: true },
  });
  if (!current) throw new Error("DRAFT_NOT_FOUND");
  if (!canManageAnyDraft(actor.role) && current.createdById !== actor.id) {
    throw new Error("FORBIDDEN_DRAFT_ACCESS");
  }

  const data: Prisma.CampaignUpdateInput = {};
  if (patch.name !== undefined) data.name = patch.name;
  if (patch.type !== undefined) data.type = patch.type;
  if (patch.useLastConversationChannel === true) {
    data.useLastConversationChannel = true;
    data.channel = { disconnect: true };
  } else if (patch.channelId) {
    data.useLastConversationChannel = false;
    data.channel = { connect: { id: patch.channelId } };
  } else if (patch.useLastConversationChannel === false) {
    data.useLastConversationChannel = false;
  }
  if (patch.segmentId !== undefined) data.segment = patch.segmentId ? { connect: { id: patch.segmentId } } : { disconnect: true };
  if (patch.filters !== undefined) data.filters = patch.filters as Prisma.InputJsonValue;
  if (patch.templateName !== undefined) data.templateName = patch.templateName || null;
  if (patch.templateLanguage !== undefined) data.templateLanguage = patch.templateLanguage;
  if (patch.textContent !== undefined) data.textContent = patch.textContent || null;
  if (patch.automationId !== undefined) data.automation = patch.automationId ? { connect: { id: patch.automationId } } : { disconnect: true };
  if (patch.sendRate !== undefined) data.sendRate = resolveCampaignSendRate(patch.sendRate);
  if (patch.scheduledAt !== undefined) data.scheduledAt = toDate(patch.scheduledAt) ?? null;

  return prisma.campaign.update({
    where: { id },
    data,
  });
}

export async function previewDraft(id: string, actor: Actor) {
  const draft = await prisma.campaign.findUnique({
    where: { id },
    select: {
      segment: { select: { filters: true } },
      filters: true,
      createdById: true,
    },
  });
  if (!draft) throw new Error("Rascunho não encontrado.");
  if (!canManageAnyDraft(actor.role) && draft.createdById !== actor.id) {
    throw new Error("FORBIDDEN_DRAFT_ACCESS");
  }

  const filters = (draft.segment?.filters ?? draft.filters ?? {}) as Parameters<
    typeof previewSegment
  >[0];
  return previewSegment(filters);
}

export async function launchDraft(id: string, actor: Actor) {
  const campaign = await prisma.campaign.findUnique({
    where: { id },
    include: { channel: { select: { status: true } } },
  });
  if (!campaign) throw new Error("Rascunho não encontrado.");
  if (!canManageAnyDraft(actor.role) && campaign.createdById !== actor.id) {
    throw new Error("FORBIDDEN_DRAFT_ACCESS");
  }
  if (campaign.status !== "DRAFT") throw new Error("Apenas rascunhos podem ser lançados.");
  if (!campaign.useLastConversationChannel) {
    if (!campaign.channelId || !campaign.channel) {
      throw new Error("Canal é obrigatório para campanha com canal fixo.");
    }
    if (campaign.channel.status !== "CONNECTED") {
      throw new Error("Canal selecionado não está conectado.");
    }
  }
  if (!campaign.segmentId && !campaign.filters) {
    throw new Error("Selecione um segmento ou configure filtros.");
  }
  if (campaign.type === "TEMPLATE" && !campaign.templateName) {
    throw new Error("Template obrigatório para campanhas TEMPLATE.");
  }
  if (campaign.type === "TEXT" && !campaign.textContent) {
    throw new Error("Conteúdo obrigatório para campanhas TEXT.");
  }
  if (campaign.type === "AUTOMATION" && !campaign.automationId) {
    throw new Error("Automação obrigatória para campanhas AUTOMATION.");
  }

  const isScheduled = campaign.scheduledAt && campaign.scheduledAt > new Date();
  const status = isScheduled ? "SCHEDULED" : "PROCESSING";
  const delay = isScheduled ? campaign.scheduledAt!.getTime() - Date.now() : undefined;

  await prisma.campaign.update({
    where: { id },
    data: { status },
  });
  // Enfileira o cuid real (não o `number` público): o worker resolve via
  // prismaBase, que não faz number→id como o prisma escopado desta leitura.
  const job = await enqueueCampaignDispatch({ campaignId: campaign.id }, delay);
  if (!job) {
    // Redis indisponível: reverter para DRAFT (não deixar preso sem consumidor).
    await prisma.campaign.update({
      where: { id },
      data: { status: "DRAFT" },
    });
    throw new Error("QUEUE_UNAVAILABLE");
  }

  return { campaignId: id, status };
}
