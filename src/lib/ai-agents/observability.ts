/**
 * Observabilidade neutra do agente de IA (Onda 0).
 * Não altera o texto gerado — só hash/diff/snapshots para auditoria.
 */

import { createHash } from "node:crypto";

import type { Prisma } from "@prisma/client";

/** Campos de config que afetam comportamento do agente (hash estável). */
export type AgentBehaviorConfigSlice = {
  archetype: string;
  model: string;
  temperature: number;
  maxTokens: number;
  systemPromptTemplate: string;
  systemPromptOverride: string | null;
  productPolicy: string | null;
  steeringRules: string | null;
  tone: string;
  language: string;
  autonomyMode: string;
  enabledTools: string[];
  outputStyle: string;
  qualificationQuestions: unknown;
  toolConfig: unknown;
  inboxPolicy: unknown;
  autoClosePolicy: unknown;
  keywordHandoffs: string[];
  openingMessage: string | null;
};

export type AuditSource =
  | "wizard"
  | "simple"
  | "advanced"
  | "api"
  | "script";

const AUDIT_SOURCES = new Set<AuditSource>([
  "wizard",
  "simple",
  "advanced",
  "api",
  "script",
]);

export function parseAuditSource(raw: unknown): AuditSource {
  if (typeof raw === "string" && AUDIT_SOURCES.has(raw as AuditSource)) {
    return raw as AuditSource;
  }
  return "api";
}

function stableJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableJson(v)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`).join(",")}}`;
}

/** SHA-256 hex dos campos que mudam o comportamento do agente. */
export function hashAgentBehaviorConfig(
  slice: AgentBehaviorConfigSlice,
): string {
  const payload = [
    slice.archetype,
    slice.model,
    String(slice.temperature),
    String(slice.maxTokens),
    slice.systemPromptTemplate,
    slice.systemPromptOverride ?? "",
    slice.productPolicy ?? "",
    slice.steeringRules ?? "",
    slice.tone,
    slice.language,
    slice.autonomyMode,
    [...slice.enabledTools].sort().join(","),
    slice.outputStyle,
    stableJson(slice.qualificationQuestions),
    stableJson(slice.toolConfig),
    stableJson(slice.inboxPolicy),
    stableJson(slice.autoClosePolicy),
    [...slice.keywordHandoffs].sort().join(","),
    slice.openingMessage ?? "",
  ].join("\n---\n");
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

export function behaviorSliceFromAgent(agent: {
  archetype: string;
  model: string;
  temperature: number;
  maxTokens: number;
  systemPromptTemplate: string;
  systemPromptOverride: string | null;
  productPolicy: string | null;
  steeringRules: string | null;
  tone: string;
  language: string;
  autonomyMode: string;
  enabledTools: string[];
  outputStyle: string;
  qualificationQuestions: unknown;
  toolConfig: unknown;
  inboxPolicy: unknown;
  autoClosePolicy: unknown;
  keywordHandoffs: string[];
  openingMessage: string | null;
}): AgentBehaviorConfigSlice {
  return {
    archetype: agent.archetype,
    model: agent.model,
    temperature: agent.temperature,
    maxTokens: agent.maxTokens,
    systemPromptTemplate: agent.systemPromptTemplate,
    systemPromptOverride: agent.systemPromptOverride,
    productPolicy: agent.productPolicy,
    steeringRules: agent.steeringRules,
    tone: agent.tone,
    language: agent.language,
    autonomyMode: agent.autonomyMode,
    enabledTools: agent.enabledTools ?? [],
    outputStyle: agent.outputStyle,
    qualificationQuestions: agent.qualificationQuestions,
    toolConfig: agent.toolConfig,
    inboxPolicy: agent.inboxPolicy,
    autoClosePolicy: agent.autoClosePolicy,
    keywordHandoffs: agent.keywordHandoffs ?? [],
    openingMessage: agent.openingMessage,
  };
}

const AUDIT_FIELD_KEYS = [
  "name",
  "avatarUrl",
  "archetype",
  "model",
  "temperature",
  "maxTokens",
  "systemPromptTemplate",
  "systemPromptOverride",
  "productPolicy",
  "steeringRules",
  "toolConfig",
  "inboxPolicy",
  "tone",
  "language",
  "autonomyMode",
  "enabledTools",
  "dailyTokenCap",
  "pipelineId",
  "channelId",
  "active",
  "openingMessage",
  "openingDelayMs",
  "inactivityTimerMs",
  "inactivityHandoffMode",
  "inactivityHandoffUserId",
  "inactivityFarewellMessage",
  "keywordHandoffs",
  "qualificationQuestions",
  "businessHours",
  "outputStyle",
  "simulateTyping",
  "typingPerCharMs",
  "markMessagesRead",
  "autoClosePolicy",
] as const;

export type AuditDiffEntry = {
  field: string;
  before: unknown;
  after: unknown;
};

function normalizeForDiff(value: unknown): unknown {
  if (value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return value;
}

function valuesEqual(a: unknown, b: unknown): boolean {
  return stableJson(normalizeForDiff(a)) === stableJson(normalizeForDiff(b));
}

/** Diff before/after só dos campos que mudaram. */
export function buildAgentConfigDiff(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  changedKeys?: Iterable<string>,
): AuditDiffEntry[] {
  const keys = changedKeys
    ? Array.from(changedKeys)
    : AUDIT_FIELD_KEYS.filter(
        (k) => k in before || k in after,
      );
  const out: AuditDiffEntry[] = [];
  for (const field of keys) {
    const b = normalizeForDiff(before[field]);
    const a = normalizeForDiff(after[field]);
    if (valuesEqual(b, a)) continue;
    out.push({ field, before: b, after: a });
  }
  return out;
}

export function auditDiffAsJson(
  diff: AuditDiffEntry[],
): Prisma.InputJsonValue {
  return diff as unknown as Prisma.InputJsonValue;
}
