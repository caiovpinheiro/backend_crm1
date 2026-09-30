/**
 * RT-3: o `dispatch` serializa o frame SSE UMA vez por evento e entrega o
 * mesmo buffer a todos os listeners — antes cada conexão fazia o seu
 * `JSON.stringify` + `encode` do mesmo payload.
 *
 * Os payloads NÃO levam `conversationId`: com ele o bus tenta o snapshot
 * do `card` (Prisma) antes do fan-out, e o tempo disso depende do
 * ambiente (no CI o engine sobe e tenta TCP; aqui nem carrega). A espera
 * pelo fan-out é por condição, não por número fixo de ticks.
 */
process.env.CRM_SKIP_BACKGROUND_SERVERS = "1";
process.env.SSE_ENABLE_REDIS_PUBSUB = "0";

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { SseEventEnvelope } from "@/lib/sse-bus";

const ORG = "org_wire";

async function waitFor(cond: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error("fan-out não chegou a tempo");
    await new Promise<void>((r) => setImmediate(r));
  }
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

  function listen(organizationId: string, userId: string) {
    const received: SseEventEnvelope[] = [];
    unsubs.push(
      sseBus.subscribe(
        { organizationId, userId, isSuperAdmin: false },
        (_event, envelope) => received.push(envelope),
      ),
    );
    return received;
  }

  it("N listeners recebem o MESMO buffer e o payload é serializado uma vez", async () => {
    const boxes = Array.from({ length: 5 }, (_, i) => listen(ORG, `user_${i}`));
    const data = { organizationId: ORG, dealId: "d1", preview: "oi" };
    const stringify = vi.spyOn(JSON, "stringify");

    sseBus.publish("conversation_updated", data);
    await waitFor(() => boxes.every((box) => box.length >= 1));

    const first = boxes[0][0];
    expect(first.data).toBe(data);
    expect(ArrayBuffer.isView(first.wire)).toBe(true);
    expect(first.wire!.byteLength).toBeGreaterThan(0);
    for (const box of boxes) {
      expect(box).toHaveLength(1);
      expect(box[0].wire).toBe(first.wire);
    }
    // Uma única serialização do payload entregue, para 5 destinatários.
    const dataSerializations = stringify.mock.calls.filter((call) => call[0] === data);
    expect(dataSerializations).toHaveLength(1);

    const text = new TextDecoder().decode(first.wire);
    expect(text).toBe(`event: conversation_updated\ndata: ${JSON.stringify(data)}\n\n`);
  });

  it("encodeSseFrame gera `event:` + `data:` terminados por linha em branco", () => {
    const frame = new TextDecoder().decode(encodeSseFrame("ping", { a: 1 }));
    expect(frame).toBe('event: ping\ndata: {"a":1}\n\n');
  });

  it("sem destinatário na org não serializa nada", async () => {
    const box = listen(ORG, "user_x");
    const stringify = vi.spyOn(JSON, "stringify");
    const orphan = { organizationId: "outra_org", dealId: "d9" };
    sseBus.publish("conversation_updated", orphan);

    // Sentinela: os fan-outs sem card resolvem em ordem — quando este
    // chega, o dispatch do órfão já passou (e não serializou nada).
    const sentinel = { organizationId: ORG, dealId: "d10" };
    sseBus.publish("conversation_updated", sentinel);
    await waitFor(() => box.some((env) => env.data === sentinel));

    expect(stringify.mock.calls.some((call) => call[0] === orphan)).toBe(false);
    expect(stringify.mock.calls.filter((call) => call[0] === sentinel)).toHaveLength(1);
  });
});
