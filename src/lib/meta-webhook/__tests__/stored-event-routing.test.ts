/**
 * `processStoredMetaWebhookEvent` (chamado pelo worker-meta-webhook) roteia
 * por `objectType`: page/instagram → loop do messaging-handler; WhatsApp →
 * loop próprio. Todos os módulos pesados do handler são mockados.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const noop = () => {};
  const logger = { info: noop, warn: noop, error: noop, debug: noop, child: () => logger };
  return {
    logger,
    empty: () => ({}),
    processMessaging: vi.fn(async () => {}),
    withSystemContext: vi.fn(async (_org: string, fn: () => unknown) => fn()),
    prismaBase: {
      metaWebhookEvent: { findUnique: vi.fn(), update: vi.fn(async () => ({})) },
    },
  };
});

vi.mock("next/server", () => ({ NextResponse: { json: (b: unknown) => b } }));
vi.mock("@prisma/client", () => ({ Prisma: {} }));
vi.mock("@/lib/logger", () => ({ getLogger: () => mocks.logger }));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/prisma-base", () => ({ prismaBase: mocks.prismaBase }));
vi.mock("@/lib/webhook-context", () => ({ withSystemContext: mocks.withSystemContext }));
vi.mock("@/lib/meta-webhook/messaging-handler", () => ({
  handleMessagingWebhookPost: vi.fn(),
  processMessagingWebhookPayload: mocks.processMessaging,
}));
vi.mock("@/lib/meta-webhook/messaging-payload", () => ({
  asMetaId: (v: unknown) => (typeof v === "string" ? v : ""),
  configMetaIds: () => new Set(),
}));
vi.mock("@/lib/phone", mocks.empty);
vi.mock("@/lib/meta-constants", () => ({ CRM_META_APP_SECRET: "" }));
vi.mock("@/services/contacts", mocks.empty);
vi.mock("@/services/conversations", mocks.empty);
vi.mock("@/services/distribution", mocks.empty);
vi.mock("@/services/ai/attendance-gate", mocks.empty);
vi.mock("@/lib/meta-webhook-signature", mocks.empty);
vi.mock("@/lib/crypto/secrets", mocks.empty);
vi.mock("@/lib/storage/local", mocks.empty);
vi.mock("@/lib/queue", mocks.empty);
vi.mock("@/lib/cache", () => ({ cache: {} }));
vi.mock("@/lib/conversation-inbound", mocks.empty);
vi.mock("@/lib/whatsapp-catalog-order", mocks.empty);
vi.mock("@/lib/sse-bus", () => ({ sseBus: {} }));
vi.mock("@/lib/request-context", mocks.empty);
vi.mock("@/lib/prisma-helpers", mocks.empty);
vi.mock("@/lib/message-dedup", mocks.empty);
vi.mock("@/services/whatsapp-call-consent-webhook", mocks.empty);
vi.mock("@/services/automation-triggers", mocks.empty);
vi.mock("@/services/meta-ad-resolver", mocks.empty);
vi.mock("@/services/ai/turn-manager", mocks.empty);
vi.mock("@/services/ai-v2/first-attendance", mocks.empty);
vi.mock("@/services/auto-deals", mocks.empty);
vi.mock("@/lib/display-name", mocks.empty);
vi.mock("@/lib/channels/retired-whatsapp", mocks.empty);
vi.mock("@/services/meta-whatsapp-calls-webhook", mocks.empty);
vi.mock("@/services/automation-context", mocks.empty);
vi.mock("@/services/activity-log", mocks.empty);
vi.mock("@/lib/meta-whatsapp/error-catalog", mocks.empty);
vi.mock("@/lib/web-push", mocks.empty);
vi.mock("@/services/scheduled-messages", mocks.empty);
vi.mock("@/services/campaigns", mocks.empty);
vi.mock("@/lib/campaign-counters", mocks.empty);
vi.mock("@/lib/status-write-buffer", mocks.empty);
vi.mock("@/lib/meta-whatsapp/parse-flow-response", mocks.empty);
vi.mock("@/services/whatsapp-flow-response", mocks.empty);

import { processStoredMetaWebhookEvent } from "@/lib/meta-webhook/handler";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("processStoredMetaWebhookEvent — roteamento por objectType", () => {
  it.each(["page", "instagram"])(
    "objectType=%s → processMessagingWebhookPayload dentro do contexto da org",
    async (objectType) => {
      const rawBody = { object: objectType, entry: [{ id: "page-1" }] };
      mocks.prismaBase.metaWebhookEvent.findUnique.mockResolvedValueOnce({
        id: "evt-1",
        organizationId: "org-1",
        objectType,
        rawBody,
        processed: false,
      });

      await processStoredMetaWebhookEvent("evt-1");

      expect(mocks.withSystemContext).toHaveBeenCalledWith("org-1", expect.any(Function));
      expect(mocks.processMessaging).toHaveBeenCalledWith(rawBody, {
        metaWebhookEventId: "evt-1",
      });
    },
  );

  it("evento já processado → não roteia (reenvio não duplica)", async () => {
    mocks.prismaBase.metaWebhookEvent.findUnique.mockResolvedValueOnce({
      id: "evt-1",
      organizationId: "org-1",
      objectType: "instagram",
      rawBody: { object: "instagram", entry: [] },
      processed: true,
    });
    await processStoredMetaWebhookEvent("evt-1");
    expect(mocks.processMessaging).not.toHaveBeenCalled();
  });

  it("whatsapp_business_account sem entries → não passa pelo messaging e marca processado", async () => {
    mocks.prismaBase.metaWebhookEvent.findUnique.mockResolvedValueOnce({
      id: "evt-wa",
      organizationId: "org-1",
      objectType: "whatsapp_business_account",
      rawBody: { object: "whatsapp_business_account", entry: [] },
      processed: false,
    });
    await processStoredMetaWebhookEvent("evt-wa");
    expect(mocks.processMessaging).not.toHaveBeenCalled();
    expect(mocks.prismaBase.metaWebhookEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "evt-wa" } }),
    );
  });
});
