/**
 * Configuração do agente v2 (simple) validada com Zod.
 */

import { z } from "zod";
import type { SimpleConfig, SimpleStage } from "@/lib/ai-simple/types";

export const simpleActionTypeSchema = z.enum([
  "create_deal",
  "add_tag",
  "create_activity",
  "search_products",
  "move_stage",
  "send_whatsapp_template",
]);

const simpleModeSchema = z.object({
  id: z.string().min(1),
  when: z.string().min(1),
  instructions: z.string().min(1),
});

export const simpleConfigSchema = z.object({
  tone: z.string().min(1),
  rules: z.string().default(""),
  context_fields: z.object({
    contact: z.array(z.string()).default([]),
    deal: z.array(z.string()).default([]),
  }).default({ contact: [], deal: [] }),
  confirmation_message: z.string().min(1),
  on_deal_not_found: z.enum(["ask_identification", "handoff"]).default("handoff"),
  identification_message: z.string().default(""),
  knowledge: z.string().default(""),
  modes: z.array(simpleModeSchema).default([]),
  allowed_actions: z.array(simpleActionTypeSchema).default([]),
  allowed_fields: z.array(z.string()).default([]),
  handoff_message: z.string().default(""),
  handoff_queue: z.string().default(""),
  history_limit: z.number().int().min(1).max(50).default(10),
});

export type RawSimpleConfig = z.infer<typeof simpleConfigSchema>;

export function normalizeSimpleConfig(raw: unknown): SimpleConfig {
  const parsed = simpleConfigSchema.parse(raw);
  return {
    tone: parsed.tone,
    rules: parsed.rules,
    contextFields: {
      contact: parsed.context_fields.contact,
      deal: parsed.context_fields.deal,
    },
    confirmationMessage: parsed.confirmation_message,
    onDealNotFound: parsed.on_deal_not_found,
    identificationMessage: parsed.identification_message,
    knowledge: parsed.knowledge,
    modes: parsed.modes,
    allowedActions: parsed.allowed_actions,
    allowedFields: parsed.allowed_fields,
    handoffMessage: parsed.handoff_message,
    handoffQueue: parsed.handoff_queue,
    historyLimit: parsed.history_limit,
  };
}

export function validateSimpleConfig(raw: unknown): { ok: true; config: SimpleConfig } | { ok: false; errors: z.ZodError } {
  const result = simpleConfigSchema.safeParse(raw);
  if (!result.success) {
    return { ok: false, errors: result.error };
  }
  return { ok: true, config: normalizeSimpleConfig(result.data) };
}

export const SIMPLE_STAGE_VALUES: SimpleStage[] = [
  "new",
  "awaiting_identification",
  "awaiting_confirmation",
  "active",
];

export function isSimpleStage(value: string): value is SimpleStage {
  return SIMPLE_STAGE_VALUES.includes(value as SimpleStage);
}
