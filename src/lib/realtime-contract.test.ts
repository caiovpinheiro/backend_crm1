/**
 * Contrato dos eventos de tempo real (P-12).
 *
 * - Cada publisher de `realtime-events.ts` emite o nome de evento e o
 *   payload documentados, sem acrescentar nem tirar campo.
 * - Todo nome de `REALTIME_EVENT_NAMES` tem publisher coberto aqui.
 * - Nenhum arquivo da aplicação chama `sseBus.publish` fora do contrato.
 *
 * Sem Redis e sem banco: o barramento é um mock.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const { publish } = vi.hoisted(() => ({ publish: vi.fn() }));
vi.mock("@/lib/sse-bus", () => ({ sseBus: { publish } }));

import {
  __resetTypingThrottleForTests,
  publishAutomationState,
  publishChannelUpdated,
  publishContactUpdated,
  publishConversationAssignment,
  publishConversationTimelineUpdated,
  publishConversationUpdated,
  publishDealMoved,
  publishEntityViewers,
  publishMessageDeleted,
  publishMessageStatus,
  publishMessageUpdated,
  publishNewMessage,
  publishOutboundNewMessage,
  publishPresenceUpdate,
  publishScheduledMessageUpdated,
  publishSupportMessage,
  publishSupportTicketNew,
  publishSupportTicketUpdated,
  publishSystemPresenceUpdate,
  publishTeamChat,
  publishTypingEvent,
  publishWhatsappCall,
  REALTIME_EVENT_NAMES,
  TYPING_TTL_MS,
  type RealtimeEventName,
} from "@/lib/realtime-events";

const ORG = "org_1";
const T0 = Date.parse("2026-10-01T12:00:00.000Z");

type Case = {
  name: string;
  event: RealtimeEventName;
  run: () => unknown;
  /** Payload exato que chega ao barramento. */
  payload: Record<string, unknown>;
  /** Terceiro argumento do barramento, quando existe. */
  opts?: Record<string, unknown>;
};

const viewers = [{ userId: "u1", name: "Ana", avatarUrl: null, lastSeen: T0 }];

const CASES: Case[] = [
  {
    name: "publishNewMessage — saída manual",
    event: "new_message",
    run: () =>
      publishNewMessage({
        organizationId: ORG,
        conversationId: "conv_1",
        contactId: "contact_1",
        direction: "out",
        content: "oi",
        senderName: "Ana",
        timestamp: new Date(T0),
      }),
    payload: {
      organizationId: ORG,
      conversationId: "conv_1",
      contactId: "contact_1",
      direction: "out",
      content: "oi",
      senderName: "Ana",
      timestamp: new Date(T0),
    },
  },
  {
    name: "publishNewMessage — entrada com escopo do board informado pelo chamador",
    event: "new_message",
    run: () =>
      publishNewMessage({
        organizationId: ORG,
        conversationId: "conv_1",
        contactId: "contact_1",
        direction: "in",
        assignedToId: null,
        content: "bom dia",
        messageType: "text",
        timestamp: "2026-10-01T12:00:00.000Z",
        pipelineIds: ["pipe_1"],
        dealIds: ["deal_1", "deal_2"],
      }),
    payload: {
      organizationId: ORG,
      conversationId: "conv_1",
      contactId: "contact_1",
      direction: "in",
      assignedToId: null,
      content: "bom dia",
      messageType: "text",
      timestamp: "2026-10-01T12:00:00.000Z",
      pipelineIds: ["pipe_1"],
      dealIds: ["deal_1", "deal_2"],
    },
  },
  {
    name: "publishOutboundNewMessage — atalho do envio pelo CRM",
    event: "new_message",
    run: () =>
      publishOutboundNewMessage(
        { id: "conv_1", organizationId: ORG, contactId: "contact_1" },
        "segue o boleto",
        new Date(T0),
      ),
    payload: {
      organizationId: ORG,
      conversationId: "conv_1",
      contactId: "contact_1",
      direction: "out",
      content: "segue o boleto",
      timestamp: new Date(T0),
    },
  },
  {
    name: "publishMessageStatus",
    event: "message_status",
    run: () =>
      publishMessageStatus({
        organizationId: ORG,
        conversationId: "conv_1",
        messageId: "wamid.1",
        internalId: "msg_1",
        status: "failed",
        error: "131026",
      }),
    payload: {
      organizationId: ORG,
      conversationId: "conv_1",
      messageId: "wamid.1",
      internalId: "msg_1",
      status: "failed",
      error: "131026",
    },
  },
  {
    name: "publishMessageUpdated",
    event: "message_updated",
    run: () =>
      publishMessageUpdated({
        organizationId: ORG,
        conversationId: "conv_1",
        messageId: "msg_1",
        status: "approved",
      }),
    payload: {
      organizationId: ORG,
      conversationId: "conv_1",
      messageId: "msg_1",
      status: "approved",
    },
  },
  {
    name: "publishMessageDeleted",
    event: "message_deleted",
    run: () =>
      publishMessageDeleted({
        organizationId: ORG,
        conversationId: "conv_1",
        messageId: "msg_1",
      }),
    payload: { organizationId: ORG, conversationId: "conv_1", messageId: "msg_1" },
  },
  {
    name: "publishConversationUpdated — status",
    event: "conversation_updated",
    run: () =>
      publishConversationUpdated({
        organizationId: ORG,
        conversationId: "conv_1",
        status: "RESOLVED",
        closedAt: "2026-10-01T12:00:00.000Z",
        followUpAt: null,
      }),
    payload: {
      organizationId: ORG,
      conversationId: "conv_1",
      status: "RESOLVED",
      closedAt: "2026-10-01T12:00:00.000Z",
      followUpAt: null,
    },
  },
  {
    name: "publishConversationUpdated — responsável",
    event: "conversation_updated",
    run: () =>
      publishConversationUpdated({
        organizationId: ORG,
        conversationId: "conv_1",
        assignedToId: "user_1",
        assignedTo: { type: "HUMAN" },
      }),
    payload: {
      organizationId: ORG,
      conversationId: "conv_1",
      assignedToId: "user_1",
      assignedTo: { type: "HUMAN" },
    },
  },
  {
    name: "publishDealMoved",
    event: "deal_moved",
    run: () =>
      publishDealMoved({
        organizationId: ORG,
        dealId: "deal_1",
        fromPipelineId: "pipe_1",
        toPipelineId: "pipe_2",
        fromStageId: "stage_a",
        toStageId: "stage_b",
        position: 1.5,
        updatedAt: "2026-10-01T12:00:00.000Z",
        card: {
          id: "deal_1",
          title: "Lead",
          status: "OPEN",
          position: 1.5,
        },
      }),
    payload: {
      organizationId: ORG,
      dealId: "deal_1",
      fromPipelineId: "pipe_1",
      toPipelineId: "pipe_2",
      fromStageId: "stage_a",
      toStageId: "stage_b",
      position: 1.5,
      updatedAt: "2026-10-01T12:00:00.000Z",
      card: {
        id: "deal_1",
        title: "Lead",
        status: "OPEN",
        position: 1.5,
      },
    },
  },
  {
    name: "publishDealMoved — com dono e unidade (gate de posse do SSE)",
    event: "deal_moved",
    run: () =>
      publishDealMoved({
        organizationId: ORG,
        dealId: "deal_1",
        fromPipelineId: "pipe_1",
        toPipelineId: "pipe_1",
        fromStageId: "stage_a",
        toStageId: "stage_a",
        position: 2,
        updatedAt: "2026-10-07T12:00:00.000Z",
        ownerId: "user_2",
        orgUnitId: null,
      }),
    payload: {
      organizationId: ORG,
      dealId: "deal_1",
      fromPipelineId: "pipe_1",
      toPipelineId: "pipe_1",
      fromStageId: "stage_a",
      toStageId: "stage_a",
      position: 2,
      updatedAt: "2026-10-07T12:00:00.000Z",
      ownerId: "user_2",
      orgUnitId: null,
    },
  },
  {
    name: "publishConversationUpdated — atribuição/transferência",
    event: "conversation_updated",
    run: () =>
      publishConversationUpdated({
        organizationId: ORG,
        conversationId: "conv_1",
        contactId: "contact_1",
        assignedToId: "user_2",
        assignedTo: { type: "HUMAN", id: "user_2", name: "Beto" },
        departmentId: "dept_1",
        previousAssignedToId: "user_1",
        unreadCount: 0,
        lastMessageAt: "2026-10-07T12:00:00.000Z",
      }),
    payload: {
      organizationId: ORG,
      conversationId: "conv_1",
      contactId: "contact_1",
      assignedToId: "user_2",
      assignedTo: { type: "HUMAN", id: "user_2", name: "Beto" },
      departmentId: "dept_1",
      previousAssignedToId: "user_1",
      unreadCount: 0,
      lastMessageAt: "2026-10-07T12:00:00.000Z",
    },
  },
  {
    name: "publishConversationTimelineUpdated",
    event: "conversation_timeline_updated",
    run: () =>
      publishConversationTimelineUpdated({
        organizationId: ORG,
        conversationId: "conv_1",
        type: "ASSIGNEE_CHANGED",
      }),
    payload: {
      organizationId: ORG,
      conversationId: "conv_1",
      type: "ASSIGNEE_CHANGED",
    },
  },
  {
    name: "publishConversationAssignment — com responsável",
    event: "conversation_assigned",
    run: () =>
      publishConversationAssignment({
        organizationId: ORG,
        conversationId: "conv_1",
        contactId: "contact_1",
        assignedToId: "user_1",
        reason: "pediu humano",
      }),
    payload: {
      organizationId: ORG,
      conversationId: "conv_1",
      contactId: "contact_1",
      assignedToId: "user_1",
      reason: "pediu humano",
    },
  },
  {
    name: "publishConversationAssignment — de volta para a fila",
    event: "conversation_unassigned",
    run: () =>
      publishConversationAssignment({
        organizationId: ORG,
        conversationId: "conv_1",
        contactId: "contact_1",
        assignedToId: null,
        reason: "sem agente",
      }),
    payload: {
      organizationId: ORG,
      conversationId: "conv_1",
      contactId: "contact_1",
      assignedToId: null,
      reason: "sem agente",
    },
  },
  {
    name: "publishTypingEvent",
    event: "typing",
    run: () =>
      publishTypingEvent({
        organizationId: ORG,
        conversationId: "conv_1",
        contactId: "contact_1",
        userId: "user_1",
        userName: " Ana ",
        now: T0,
      }),
    payload: {
      organizationId: ORG,
      conversationId: "conv_1",
      contactId: "contact_1",
      userId: "user_1",
      userName: "Ana",
      source: "agent",
      until: new Date(T0 + TYPING_TTL_MS).toISOString(),
    },
  },
  {
    name: "publishScheduledMessageUpdated",
    event: "scheduled_message_updated",
    run: () =>
      publishScheduledMessageUpdated({
        organizationId: ORG,
        conversationId: "conv_1",
        status: "CANCELLED",
      }),
    payload: {
      organizationId: ORG,
      conversationId: "conv_1",
      scheduledMessageId: null,
      status: "CANCELLED",
    },
  },
  {
    name: "publishContactUpdated",
    event: "contact_updated",
    run: () =>
      publishContactUpdated({
        organizationId: ORG,
        contactId: "contact_1",
        reason: "phone_changed",
        oldPhone: "5511999990000",
        newPhone: "5511999991111",
      }),
    payload: {
      organizationId: ORG,
      contactId: "contact_1",
      reason: "phone_changed",
      oldPhone: "5511999990000",
      newPhone: "5511999991111",
    },
  },
  {
    name: "publishWhatsappCall",
    event: "whatsapp_call",
    run: () =>
      publishWhatsappCall({
        organizationId: ORG,
        conversationId: "conv_1",
        contactId: "contact_1",
        callId: "call_1",
        event: "connect",
        direction: "USER_INITIATED",
        assignedToId: "user_1",
      }),
    payload: {
      organizationId: ORG,
      conversationId: "conv_1",
      contactId: "contact_1",
      callId: "call_1",
      event: "connect",
      direction: "USER_INITIATED",
      assignedToId: "user_1",
    },
  },
  {
    name: "publishAutomationState",
    event: "automation_state",
    run: () =>
      publishAutomationState({
        organizationId: ORG,
        contactId: "contact_1",
        automationId: "auto_1",
        status: "RUNNING",
        active: true,
        createdAt: "2026-10-01T12:00:00.000Z",
      }),
    payload: {
      organizationId: ORG,
      contactId: "contact_1",
      automationId: "auto_1",
      status: "RUNNING",
      active: true,
      createdAt: "2026-10-01T12:00:00.000Z",
    },
  },
  {
    name: "publishChannelUpdated",
    event: "channel_updated",
    run: () =>
      publishChannelUpdated({
        organizationId: ORG,
        channelId: "chan_1",
        status: "CONNECTED",
      }),
    payload: { organizationId: ORG, channelId: "chan_1", status: "CONNECTED" },
  },
  {
    name: "publishPresenceUpdate",
    event: "presence_update",
    run: () =>
      publishPresenceUpdate({ organizationId: ORG, userId: "user_1", status: "AWAY" }),
    payload: { organizationId: ORG, userId: "user_1", status: "AWAY" },
  },
  {
    name: "publishSystemPresenceUpdate",
    event: "system_presence_update",
    run: () =>
      publishSystemPresenceUpdate({
        organizationId: ORG,
        userId: "user_1",
        systemOnline: false,
        lastSeenAt: "2026-10-01T12:00:00.000Z",
      }),
    payload: {
      organizationId: ORG,
      userId: "user_1",
      systemOnline: false,
      lastSeenAt: "2026-10-01T12:00:00.000Z",
    },
  },
  {
    name: "publishEntityViewers",
    event: "entity_viewers",
    run: () =>
      publishEntityViewers({
        organizationId: ORG,
        entityType: "deal",
        entityId: "deal_1",
        viewers,
      }),
    payload: {
      organizationId: ORG,
      entityType: "deal",
      entityId: "deal_1",
      viewers,
    },
  },
  {
    name: "publishSupportTicketNew",
    event: "support_ticket_new",
    run: () =>
      publishSupportTicketNew({
        organizationId: ORG,
        ticketId: "tk_1",
        requesterId: "user_1",
        assignedToId: null,
        status: "OPEN",
        number: 7,
      }),
    payload: {
      organizationId: ORG,
      ticketId: "tk_1",
      requesterId: "user_1",
      assignedToId: null,
      status: "OPEN",
      number: 7,
    },
  },
  {
    name: "publishSupportTicketUpdated",
    event: "support_ticket_updated",
    run: () =>
      publishSupportTicketUpdated({
        organizationId: ORG,
        ticketId: "tk_1",
        status: "OPEN",
      }),
    payload: { organizationId: ORG, ticketId: "tk_1", status: "OPEN" },
  },
  {
    name: "publishSupportMessage",
    event: "support_message",
    run: () =>
      publishSupportMessage({
        organizationId: ORG,
        ticketId: "tk_1",
        requesterId: "user_1",
        assignedToId: "user_2",
        message: { id: "sm_1", content: "ajuda" },
      }),
    payload: {
      organizationId: ORG,
      ticketId: "tk_1",
      requesterId: "user_1",
      assignedToId: "user_2",
      message: { id: "sm_1", content: "ajuda" },
    },
  },
  ...(
    [
      "team_chat_message",
      "team_chat_room_updated",
      "team_chat_typing",
      "team_chat_work_item_updated",
      "team_chat_forward_updated",
    ] as const
  ).map(
    (event): Case => ({
      name: `publishTeamChat — ${event}`,
      event,
      run: () =>
        publishTeamChat(
          event,
          { organizationId: ORG, roomId: "room_1", memberIds: ["u1", "u2"] },
          ["u1", "u2"],
        ),
      payload: { organizationId: ORG, roomId: "room_1", memberIds: ["u1", "u2"] },
      opts: { audienceUserIds: ["u1", "u2"] },
    }),
  ),
];

describe("contrato: cada publisher emite exatamente o formato documentado", () => {
  beforeEach(() => {
    publish.mockReset();
    __resetTypingThrottleForTests();
  });

  it.each(CASES)("$name → $event", ({ event, run, payload, opts }) => {
    run();

    expect(publish).toHaveBeenCalledTimes(1);
    const call = publish.mock.calls[0] as unknown[];
    expect(call[0]).toBe(event);
    // toStrictEqual: campo a mais, a menos ou `undefined` sobrando falha.
    expect(call[1]).toStrictEqual(payload);
    if (opts) {
      expect(call).toHaveLength(3);
      expect(call[2]).toStrictEqual(opts);
    } else {
      expect(call).toHaveLength(2);
    }
  });

  it("todo evento do contrato tem publisher coberto", () => {
    const covered = new Set(CASES.map((c) => c.event));
    expect([...REALTIME_EVENT_NAMES].filter((name) => !covered.has(name))).toEqual([]);
    expect(new Set(REALTIME_EVENT_NAMES).size).toBe(REALTIME_EVENT_NAMES.length);
  });

  it("todo payload leva organizationId (o barramento descarta sem org)", () => {
    for (const c of CASES) {
      expect(c.payload.organizationId, c.name).toBe(ORG);
    }
  });

  it("publishScheduledMessageUpdated sem org não publica", () => {
    publishScheduledMessageUpdated({
      organizationId: null,
      conversationId: "conv_1",
      status: "SENT",
    });
    expect(publish).not.toHaveBeenCalled();
  });

  it("publishOutboundNewMessage engole falha do barramento (envio não cai)", () => {
    publish.mockImplementationOnce(() => {
      throw new Error("redis fora");
    });
    expect(() =>
      publishOutboundNewMessage(
        { id: "conv_1", organizationId: ORG, contactId: null },
        "oi",
        new Date(T0),
      ),
    ).not.toThrow();
  });
});

describe("contrato: sseBus.publish só dentro de realtime-events.ts", () => {
  /** Quem pode chamar o barramento: o contrato e o próprio transporte. */
  const ALLOWED = new Set(["lib/realtime-events.ts", "lib/sse-bus.ts"]);

  function sourceFiles(): Array<{ rel: string; text: string }> {
    const root = join(process.cwd(), "src");
    const out: Array<{ rel: string; text: string }> = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "__tests__" || entry.name === "test-setup") continue;
          walk(full);
          continue;
        }
        if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) continue;
        const rel = full.slice(root.length + 1).split("\\").join("/");
        out.push({ rel, text: readFileSync(full, "utf8") });
      }
    };
    walk(root);
    return out;
  }

  /** Linha de código (comentário citando o nome não conta). */
  function codeLines(text: string): string[] {
    return text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => !line.startsWith("*") && !line.startsWith("//") && !line.startsWith("/*"));
  }

  it("nenhum arquivo da aplicação chama sseBus.publish cru", () => {
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(500);

    const offenders: string[] = [];
    for (const { rel, text } of files) {
      if (ALLOWED.has(rel)) continue;
      if (!text.includes("publish")) continue;
      const code = codeLines(text).join("\n");
      // `sseBus.publish(`, `sseBus\n  .publish(` e o import dinâmico
      // desestruturado (`const { sseBus } = await import(...)`).
      if (/\bsseBus\s*\.\s*publish\s*\(/.test(code)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it("o contrato publica por um único ponto", () => {
    const text = readFileSync(
      join(process.cwd(), "src", "lib", "realtime-events.ts"),
      "utf8",
    );
    const code = codeLines(text).join("\n");
    // As duas chamadas são os dois ramos (com/sem opções) de `publish`.
    expect(code.match(/\bsseBus\s*\.\s*publish\s*\(/g)).toHaveLength(2);
  });
});
