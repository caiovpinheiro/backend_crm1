/**
 * Segunda consulta de curso ("Ver outros cursos").
 *
 * O snapshot de custom fields era lido no início da continuação e não
 * de novo depois do delay de 20s nem do webhook do n8n. A condição e a
 * mensagem saíam com preço/modalidade da primeira passagem, mesmo com
 * o deal já atualizado.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sent: string[] = [];
const fetches: string[] = [];
const logs: Array<{ stepId?: string | null; status: string }> = [];
const upserts: Array<{ value: string }> = [];

let fields: Record<string, string> = {};
let fieldReads = 0;
let flipAfterFirstRead: Record<string, string> | null = null;

const { metaClientFromConfig } = vi.hoisted(() => ({
  metaClientFromConfig: vi.fn(),
}));

vi.mock("@/lib/meta-whatsapp/client", () => ({
  metaWhatsApp: { configured: false },
  metaClientFromConfig,
  formatMetaSendError: (err: unknown) => (err instanceof Error ? err.message : String(err)),
  isMetaGraphError: () => false,
}));

vi.mock("@/lib/safe-outbound-url", () => ({
  assertSafeOutboundUrl: vi.fn(async () => {}),
}));

vi.mock("@/services/deals", () => ({
  assertStageEntryFields: vi.fn(),
  assignDealOwner: vi.fn(),
  createDealEvent: vi.fn(async () => {}),
  markDealLost: vi.fn(),
  markDealWon: vi.fn(),
  nextDealNumber: vi.fn(),
  propagateOwnerToContactAndChat: vi.fn(),
}));

function model(name: string) {
  const methods: Record<string, ReturnType<typeof vi.fn>> = {};
  return new Proxy(methods, {
    get(target, prop) {
      if (typeof prop !== "string") return undefined;
      if (!target[prop]) {
        target[prop] = vi.fn(async (args?: { data?: { value?: string }; where?: { id?: string } }) => {
          if (name === "dealCustomFieldValue" && prop === "findMany") {
            fieldReads += 1;
            const snapshot = { ...fields };
            if (flipAfterFirstRead && fieldReads === 1) fields = { ...flipAfterFirstRead };
            return Object.entries(snapshot).map(([fieldName, value]) => ({
              value,
              customField: { name: fieldName },
            }));
          }
          if (name === "dealCustomFieldValue" && prop === "upsert") {
            const data = args as { update?: { value?: string }; create?: { value?: string } } | undefined;
            const value = String(data?.update?.value ?? data?.create?.value ?? "");
            upserts.push({ value });
            fields = { ...fields, curso_de_inscricao: value };
            return { id: "val" };
          }
          if (name === "customField" && prop === "findFirst") {
            return { id: "cf-curso" };
          }
          if (name === "automationLog" && prop === "create") {
            const data = (args as { data?: { stepId?: string | null; status?: string } } | undefined)?.data;
            logs.push({ stepId: data?.stepId, status: String(data?.status ?? "") });
            return { id: "log" };
          }
          if (name === "channel" && prop === "findFirst") {
            return {
              id: "ch1",
              organizationId: "org1",
              provider: "META_CLOUD_API",
              config: { accessToken: "tok", phoneNumberId: "phone", businessAccountId: "waba" },
            };
          }
          if (name === "conversation" && (prop === "findFirst" || prop === "findUnique")) {
            const id = args?.where?.id;
            if (id && id !== "conv1") return null;
            return { id: "conv1", status: "OPEN", channel: "whatsapp", channelId: "ch1" };
          }
          if (name === "message" && prop === "create") {
            return { id: "msg1", createdAt: new Date() };
          }
          if (name === "automationContext" && prop === "create") {
            return {
              id: "ctx1",
              contactId: "c1",
              organizationId: "org1",
              status: "RUNNING",
              currentStepId: "delay-long",
              timeoutAt: new Date(),
            };
          }
          if (prop === "findMany") return [];
          if (prop === "count") return 0;
          if (prop === "create" || prop === "update" || prop === "upsert") return { id: "x" };
          return null;
        });
      }
      return target[prop];
    },
  });
}

vi.mock("@/lib/prisma", () => {
  const cache = new Map<string, ReturnType<typeof model>>();
  const prisma = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === "$executeRawUnsafe") return vi.fn(async () => 0);
        if (prop === "$transaction") return vi.fn(async (ops: unknown) => ops);
        if (typeof prop !== "string") return undefined;
        let m = cache.get(prop);
        if (!m) {
          m = model(prop);
          cache.set(prop, m);
        }
        return m;
      },
    },
  );
  return { prisma };
});

import { continueFromStep } from "@/services/automation-executor";
import { runWithContext } from "@/lib/request-context";

const CONTACT = "c1";
const DEAL = "d1";
const AUTO = "auto1";

function automation(steps: Array<{ id: string; type: string; config: Record<string, unknown> }>) {
  return {
    id: AUTO,
    name: "RB",
    active: true,
    triggerConfig: {},
    organizationId: "org1",
    steps: steps.map((s, position) => ({ ...s, position })),
  };
}

async function run(
  steps: Array<{ id: string; type: string; config: Record<string, unknown> }>,
  fromStepId: string,
  variables: Record<string, unknown> = {},
) {
  const { prisma } = await import("@/lib/prisma");
  vi.mocked(prisma.automation.findUnique).mockResolvedValue(automation(steps) as never);
  vi.mocked(prisma.contact.findUnique).mockResolvedValue({
    id: CONTACT,
    name: "Raphael",
    phone: "5511999999999",
    organizationId: "org1",
  } as never);
  vi.mocked(prisma.deal.findFirst).mockResolvedValue({
    id: DEAL,
    contactId: CONTACT,
    status: "OPEN",
    title: "Negócio",
    organizationId: "org1",
    stage: { name: "Lead", pipelineId: "p1", pipeline: { name: "Principal" } },
  } as never);
  vi.mocked(prisma.deal.findUnique).mockResolvedValue({ organizationId: "org1" } as never);

  await runWithContext(
    {
      organizationId: "org1",
      userId: "u1",
      isSuperAdmin: false,
      actor: { type: "AUTOMATION", label: "teste" },
    },
    () => continueFromStep(AUTO, CONTACT, fromStepId, variables),
  );
}

beforeEach(() => {
  sent.length = 0;
  fetches.length = 0;
  logs.length = 0;
  upserts.length = 0;
  fields = {};
  fieldReads = 0;
  flipAfterFirstRead = null;
  metaClientFromConfig.mockReturnValue({
    configured: true,
    sendText: vi.fn(async (_to: string, content: string) => {
      sent.push(content);
      return { messages: [{ id: "wamid" }] };
    }),
    markAsRead: vi.fn(),
    sendTypingIndicator: vi.fn(),
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: { body?: string }) => {
      fetches.push(String(init?.body ?? ""));
      return { ok: true, status: 200 };
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("reload dos campos do curso", () => {
  it("depois do atraso curto, a mensagem usa o preço novo e ignora o snapshot da pausa", async () => {
    fields = { valor_curso2: "340", curso_de_inscricao: "educação física", contador: "2" };
    flipAfterFirstRead = { valor_curso2: "140", curso_de_inscricao: "Administração", contador: "2" };

    await run(
      [
        {
          id: "wait",
          type: "delay",
          config: { ms: 0, nextStepId: "card", __hasExplicitEdges: true },
        },
        {
          id: "card",
          type: "send_whatsapp_message",
          config: {
            content: "Mensalidade: {{dealCustomFields.valor_curso2}}",
            channelId: "ch1",
            nextStepId: "__none__",
            __hasExplicitEdges: true,
          },
        },
      ],
      "wait",
      {
        conversationId: "conv1",
        dealCustomFields: { valor_curso2: "340", curso_de_inscricao: "educação física" },
      },
    );

    expect(sent).toEqual(["Mensalidade: 140"]);
  });

  it("condição logo após o webhook lê o contador que o n8n gravou na resposta", async () => {
    fields = { contador: "2", curso_de_inscricao: "educação física" };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        fields = { contador: "1", curso_de_inscricao: "Administração" };
        fetches.push("ok");
        return { ok: true, status: 200 };
      }),
    );

    await run(
      [
        {
          id: "hook",
          type: "webhook",
          config: {
            url: "https://example.com/robocsv",
            method: "POST",
            body: "{\"curso\":\"{{dealCustomFields.curso_de_inscricao}}\"}",
            nextStepId: "gate",
            __hasExplicitEdges: true,
          },
        },
        {
          id: "gate",
          type: "condition",
          config: {
            __hasExplicitEdges: true,
            branches: [
              {
                id: "one",
                rules: [{ op: "eq", field: "dealCustomFields.contador", value: "1" }],
                nextStepId: "branch-one",
              },
              {
                id: "two",
                rules: [{ op: "eq", field: "dealCustomFields.contador", value: "2" }],
                nextStepId: "branch-two",
              },
            ],
            elseStepId: "branch-else",
          },
        },
        { id: "branch-one", type: "finish", config: { action: "stop", __hasExplicitEdges: true } },
        { id: "branch-two", type: "finish", config: { action: "stop", __hasExplicitEdges: true } },
        { id: "branch-else", type: "finish", config: { action: "stop", __hasExplicitEdges: true } },
      ],
      "hook",
    );

    expect(logs.map((l) => l.stepId)).toContain("branch-one");
    expect(logs.map((l) => l.stepId)).not.toContain("branch-two");
  });

  it("atraso persistido não dispara o webhook na mesma virada", async () => {
    fields = { contador: "2" };
    await run(
      [
        {
          id: "delay-long",
          type: "delay",
          config: { ms: 60_000, nextStepId: "hook", __hasExplicitEdges: true },
        },
        {
          id: "hook",
          type: "webhook",
          config: {
            url: "https://example.com/robocsv",
            method: "POST",
            body: "{}",
            __hasExplicitEdges: true,
          },
        },
      ],
      "delay-long",
    );

    expect(fetches).toEqual([]);
    expect(logs.map((l) => l.stepId)).not.toContain("hook");
  });

  it("update_field grava o texto digitado, não o token {{lastResponse}}", async () => {
    fields = { curso_de_inscricao: "educação física" };
    await run(
      [
        {
          id: "save",
          type: "update_field",
          config: {
            entity: "deal",
            field: "curso_de_inscricao",
            value: "{{lastResponse}}",
            nextStepId: "hook",
            __hasExplicitEdges: true,
          },
        },
        {
          id: "hook",
          type: "webhook",
          config: {
            url: "https://example.com/robocsv",
            method: "POST",
            body: "{\"curso\":\"{{dealCustomFields.curso_de_inscricao}}\"}",
            nextStepId: "__none__",
            __hasExplicitEdges: true,
          },
        },
      ],
      "save",
      { lastResponse: "Administração" },
    );

    expect(upserts.some((u) => u.value === "Administração")).toBe(true);
    expect(fetches.some((body) => body.includes("Administração"))).toBe(true);
    expect(fetches.some((body) => body.includes("educação física"))).toBe(false);
    expect(fetches.some((body) => body.includes("lastResponse"))).toBe(false);
  });
});
