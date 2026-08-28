import { createHmac, randomBytes } from "crypto";

import { prisma } from "@/lib/prisma";
import { getOrgIdOrNull } from "@/lib/request-context";

export const INTEGRATION_WEBHOOK_EVENTS = [
  "agent_changed",
  "contact_owner_changed",
  "lead_distributed",
  "stage_changed",
  "deal_created",
  "deal_won",
  "deal_lost",
  "contact_created",
  "tag_added",
  "conversation_created",
  "lifecycle_changed",
  "message_received",
  "message_sent",
] as const;

export type IntegrationWebhookEvent = (typeof INTEGRATION_WEBHOOK_EVENTS)[number];

const KNOWN_EVENTS = new Set<string>(INTEGRATION_WEBHOOK_EVENTS);

const DISPATCH_TIMEOUT_MS = 8_000;

export type IntegrationWebhookRecord = {
  id: string;
  url: string;
  events: string[];
  isActive: boolean;
  name: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function publicShape(row: {
  id: string;
  url: string;
  events: string[];
  isActive: boolean;
  name: string | null;
  createdAt: Date;
  updatedAt: Date;
}): IntegrationWebhookRecord {
  return {
    id: row.id,
    url: row.url,
    events: row.events,
    isActive: row.isActive,
    name: row.name,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function isHttpsUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

export function normalizeWebhookEvents(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string") return null;
    const event = item.trim();
    if (!event) return null;
    if (event !== "*" && !KNOWN_EVENTS.has(event)) return null;
    if (seen.has(event)) continue;
    seen.add(event);
    out.push(event);
  }
  return out.length > 0 ? out : null;
}

export async function listIntegrationWebhooks(): Promise<IntegrationWebhookRecord[]> {
  const rows = await prisma.integrationWebhook.findMany({
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      url: true,
      events: true,
      isActive: true,
      name: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  return rows.map(publicShape);
}

export async function getIntegrationWebhook(
  id: string,
): Promise<IntegrationWebhookRecord | null> {
  const row = await prisma.integrationWebhook.findUnique({
    where: { id },
    select: {
      id: true,
      url: true,
      events: true,
      isActive: true,
      name: true,
      createdAt: true,
      updatedAt: true,
    },
  });
  return row ? publicShape(row) : null;
}

export async function createIntegrationWebhook(input: {
  url: string;
  events: string[];
  name?: string | null;
  organizationId: string;
}): Promise<IntegrationWebhookRecord & { secret: string }> {
  const secret = randomBytes(32).toString("hex");
  const row = await prisma.integrationWebhook.create({
    data: {
      organizationId: input.organizationId,
      url: input.url,
      events: input.events,
      name: input.name ?? null,
      secret,
      isActive: true,
    },
  });
  return { ...publicShape(row), secret };
}

export async function deleteIntegrationWebhook(id: string): Promise<boolean> {
  try {
    await prisma.integrationWebhook.delete({ where: { id } });
    return true;
  } catch {
    return false;
  }
}

export function assertWebhookUrl(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return "url é obrigatória.";
  if (!isHttpsUrl(trimmed)) return "url deve ser http(s).";
  if (trimmed.length > 2000) return "url é longa demais.";
  return null;
}

type TriggerContext = {
  contactId?: string;
  dealId?: string;
  data?: unknown;
};

function buildPayload(
  event: string,
  context: TriggerContext,
  organizationId: string | null,
): Record<string, unknown> {
  return {
    event,
    occurredAt: new Date().toISOString(),
    organizationId,
    contactId: context.contactId ?? null,
    dealId: context.dealId ?? null,
    data:
      context.data !== undefined && context.data !== null && typeof context.data === "object"
        ? context.data
        : {},
  };
}

function signBody(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

/**
 * Dispara os webhooks da org que escutam `event` (ou `*`).
 * Fire-and-forget: nunca lança para o caller.
 */
export async function dispatchIntegrationWebhooks(
  event: string,
  context: TriggerContext,
): Promise<void> {
  const organizationId = getOrgIdOrNull();
  if (!organizationId) return;

  let hooks: Array<{ id: string; url: string; secret: string | null }>;
  try {
    hooks = await prisma.integrationWebhook.findMany({
      where: {
        isActive: true,
        OR: [{ events: { has: event } }, { events: { has: "*" } }],
      },
      select: { id: true, url: true, secret: true },
    });
  } catch (err) {
    console.warn(
      "[integration-webhooks] list failed:",
      err instanceof Error ? err.message : err,
    );
    return;
  }

  if (hooks.length === 0) return;

  const payload = buildPayload(event, context, organizationId);
  const body = JSON.stringify(payload);

  await Promise.allSettled(
    hooks.map(async (hook) => {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "X-Eduit-Event": event,
      };
      if (hook.secret) {
        headers["X-Eduit-Signature"] = signBody(hook.secret, body);
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), DISPATCH_TIMEOUT_MS);
      try {
        const res = await fetch(hook.url, {
          method: "POST",
          headers,
          body,
          signal: controller.signal,
        });
        if (!res.ok) {
          console.warn(
            `[integration-webhooks] ${hook.id} ${event} → HTTP ${res.status}`,
          );
        }
      } catch (err) {
        console.warn(
          `[integration-webhooks] ${hook.id} ${event} failed:`,
          err instanceof Error ? err.message : err,
        );
      } finally {
        clearTimeout(timer);
      }
    }),
  );
}
