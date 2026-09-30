/**
 * RT-3: o `dispatch` serializa o frame SSE UMA vez por evento e entrega o
 * mesmo buffer a todos os listeners — antes cada conexão fazia o seu
 * `JSON.stringify` + `encode` do mesmo payload.
 */
process.env.CRM_SKIP_BACKGROUND_SERVERS = "1";
process.env.SSE_ENABLE_REDIS_PUBSUB = "0";

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { SseEventEnvelope } from "@/lib/sse-bus";

const ORG = "org_wire";

async function flush() {
  await Promise.resolve();
  await new Promise<void>((r) => setImmediate(r));
  await new Promise<void>((r) => setImmediate(r));
}

describe("sseBus — frame pré-serializado por evento", () => {
  let sseBus: typeof import("@/lib/sse-bus").sseBus;
  let encodeSseFrame: typeof import("@/lib/sse-bus").encodeSseFrame;
  const unsubs: Array<() => void> = [];

  beforeAll(async () => {
    ({ sseBus, encodeSseFrame } = await import("@/lib/sse-bus"));
  });

  afterEach(() => {
    while (unsubs.length) unsubs.pop()?.();
    vi.restoreAllMocks();
  });

  function listen(userId: string) {
    const received: SseEventEnvelope[] = [];
    unsubs.push(
      sseBus.subscribe(
        { organizationId: ORG, userId, isSuperAdmin: false },
        (_event, envelope) => received.push(envelope),
      ),
    );
    return received;
  }

  it("N listeners recebem o MESMO buffer e o payload é serializado uma vez", async () => {
    const boxes = Array.from({ length: 5 }, (_, i) => listen(`user_${i}`));
    const data = { organizationId: ORG, conversationId: "c1", preview: "oi" };
    const stringify = vi.spyOn(JSON, "stringify");

    sseBus.publish("conversation_updated", data);
    await flush();

    const first = boxes[0][0];
    expect(first?.wire).toBeInstanceOf(Uint8Array);
    for (const box of boxes) {
      expect(box).toHaveLength(1);
      expect(box[0].wire).toBe(first.wire);
    }
    // Só a serialização do dispatch conta o payload entregue.
    const dataSerializations = stringify.mock.calls.filter(
      (call) => call[0] === first.data,
    );
    expect(dataSerializations).toHaveLength(1);

    const text = new TextDecoder().decode(first.wire);
    expect(text).toBe(
      `event: conversation_updated\ndata: ${JSON.stringify(first.data)}\n\n`,
    );
  });

  it("encodeSseFrame gera `event:` + `data:` terminados por linha em branco", () => {
    const frame = new TextDecoder().decode(encodeSseFrame("ping", { a: 1 }));
    expect(frame).toBe('event: ping\ndata: {"a":1}\n\n');
  });

  it("sem destinatário na org não serializa nada", async () => {
    listen("user_x");
    const stringify = vi.spyOn(JSON, "stringify");
    const data = { organizationId: "outra_org", conversationId: "c9" };
    sseBus.publish("conversation_updated", data);
    await flush();
    expect(stringify.mock.calls.some((call) => call[0] === data)).toBe(false);
  });
});
