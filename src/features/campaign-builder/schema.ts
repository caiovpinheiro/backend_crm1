import { z } from "zod";

import {
  clampCampaignSendRate,
  getCampaignSendRateDefault,
} from "@/lib/campaign-send-rate";

export const campaignTypeSchema = z.enum(["TEMPLATE", "TEXT", "AUTOMATION"]);
export const builderStepSchema = z.enum([
  "impulse_type",
  "automation",
  "leads",
  "configuration",
]);

const segmentFiltersSchema = z.object({
  search: z.string().optional(),
  lifecycleStage: z.string().optional(),
  tagIds: z.array(z.string()).optional(),
  companyId: z.string().optional(),
  assignedToId: z.string().optional(),
  dealOwnerId: z.string().optional(),
  pipelineId: z.string().optional(),
  stageIds: z.array(z.string()).optional(),
  dealStatus: z.enum(["OPEN", "WON", "LOST"]).optional(),
  createdAfter: z.string().optional(),
  hasPhone: z.boolean().optional(),
});

export const campaignBuilderDraftSchema = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(1, "Nome obrigatório"),
  type: campaignTypeSchema,
  channelId: z.string().trim().optional(),
  useLastConversationChannel: z.boolean().optional().default(false),
  segmentId: z.string().trim().optional(),
  filters: segmentFiltersSchema.optional(),
  templateName: z.string().trim().optional(),
  templateLanguage: z.string().trim().optional().default("pt_BR"),
  textContent: z.string().trim().optional(),
  automationId: z.string().trim().optional(),
  // Clamp (não reject) para UI legada que ainda permite até 80 msgs/s.
  sendRate: z
    .number()
    .int()
    .min(1)
    .default(getCampaignSendRateDefault())
    .transform((n) => clampCampaignSendRate(n)),
  scheduledAt: z.string().datetime().optional(),
  step: builderStepSchema.default("impulse_type"),
});

export const draftPreviewSchema = z.object({
  count: z.number().int().nonnegative(),
  sample: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      phone: z.string().nullable().optional(),
      email: z.string().nullable().optional(),
    }),
  ),
});

export const saveDraftRequestSchema = z.object({
  id: z.string().optional(),
  patch: campaignBuilderDraftSchema.partial(),
});

export type CampaignBuilderStep = z.infer<typeof builderStepSchema>;
export type CampaignBuilderDraft = z.infer<typeof campaignBuilderDraftSchema>;
export type SegmentFiltersInput = z.infer<typeof segmentFiltersSchema>;
