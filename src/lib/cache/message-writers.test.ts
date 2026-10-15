/**
 * Todo escritor de `Message` sobe a versão das mensagens da conversa
 * (`noteMessageChange` / `noteMessageRowChange`, `lib/cache/message-versions.ts`)
 * — sem isso o `GET /messages` responderia 304 com a lista velha.
 *
 * 1. Varredura do código: cada `prisma.message.create/update/delete…` (e
 *    as escritas de fixada/favorito/nota fixada, que mudam a resposta) tem
 *    o bump logo depois. Exceções explícitas abaixo, com o motivo.
 * 2. Buffer de status do webhook: o bump sai DEPOIS do UPDATE em lote (o
 *    `message_status` do SSE sai antes; a versão só pode subir com o dado
 *    já no banco).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const SRC = join(process.cwd(), "src");
/** Linhas depois da chamada em que o bump tem de aparecer. */
const WINDOW = 45;

/** Escritas sem bump, de propósito. */
const ALLOWED: Record<string, string> = {
  // A conversa é apagada na mesma transação: o GET devolve 404.
  "src/services/contacts.ts:deleteMany": "conversa apagada junto",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "__tests__" || name === "test-setup" || name === "scripts") continue;
      walk(p, out);
    } else if (p.endsWith(".ts") && !p.endsWith(".test.ts") && !p.endsWith(".d.ts")) {
      out.push(p);
    }
  }
  return out;
}

type Site = { file: string; line: number; op: string; text: string };

function sites(pattern: RegExp): Site[] {
  const found: Site[] = [];
  for (const abs of walk(SRC)) {
    const file = relative(process.cwd(), abs).split(sep).join("/");
    const text = readFileSync(abs, "utf8");
    for (const m of text.matchAll(pattern)) {
      const line = text.slice(0, m.index).split("\n").length;
      const lineText = text.split("\n")[line - 1] ?? "";
      if (/^\s*(\/\/|\*|\/\*)/.test(lineText)) continue; // comentário
      found.push({ file, line, op: m[1] ?? "", text });
    }
  }
  return found;
}

function bumpNear(site: Site): boolean {
  const lines = site.text.split("\n").slice(site.line - 1, site.line - 1 + WINDOW).join("\n");
  return /\bnoteMessage(Row)?Changes?\(/.test(lines);
}

describe("escritores de Message sobem a versão", () => {
  it("toda escrita em messages tem o bump logo depois", () => {
    const writes = sites(/\.message\s*\.\s*(create|createMany|update|updateMany|upsert|delete|deleteMany)\b/g);
    expect(writes.length).toBeGreaterThan(60);
    const missing = writes
      .filter((s) => !ALLOWED[`${s.file}:${s.op}`])
      .filter((s) => !bumpNear(s))
      .map((s) => `${s.file}:${s.line} (${s.op})`);
    expect(missing).toEqual([]);
  });

  it("fixada, favorito e nota fixada (mudam a resposta) também", () => {
    const writes = [
      ...sites(/\.pinnedMessage\s*\.\s*(create|update|delete|deleteMany)\b/g),
      ...sites(/\.favoriteMessage\s*\.\s*(create|delete)\b/g),
    ].filter((s) => s.file.startsWith("src/app/api/"));
    expect(writes.length).toBeGreaterThanOrEqual(5);
    // O GET apaga fixadas vencidas em segundo plano: o prazo já está no ETag.
    const missing = writes
      .filter((s) => !s.file.endsWith("conversations/[id]/messages/route.ts"))
      .filter((s) => !bumpNear(s))
      .map((s) => `${s.file}:${s.line} (${s.op})`);
    expect(missing).toEqual([]);
    const pinNote = readFileSync(join(SRC, "app/api/conversations/[id]/pin-note/route.ts"), "utf8");
    expect(pinNote).toMatch(/noteMessageChange\(.*"meta"\)/);
  });
});

// ── Buffer de status ───────────────────────────────────────────────

const calls: string[] = [];
vi.mock("@/lib/prisma-base", () => ({
  prismaBase: {
    $executeRaw: vi.fn(async () => {
      calls.push("UPDATE");
      return 1;
    }),
  },
}));
vi.mock("@/lib/cache/message-versions", () => ({
  noteMessageChanges: vi.fn(async (changes: unknown[]) => {
    calls.push(`BUMP ${JSON.stringify(changes)}`);
  }),
}));

describe("buffer de status do webhook", () => {
  afterEach(() => {
    calls.length = 0;
  });

  it("sobe a versão depois do UPDATE em lote, com org/conversa/ids", async () => {
    const { bufferMessageStatus, flushStatusWrites } = await import("@/lib/status-write-buffer");
    bufferMessageStatus({
      id: "msg_1",
      sendStatus: "read",
      sendError: null,
      change: { organizationId: "org_1", conversationId: "conv_1", ids: ["msg_1", "wamid.1"] },
    });
    expect(calls).toEqual([]);
    await flushStatusWrites();
    expect(calls[0]).toBe("UPDATE");
    expect(calls[1]).toBe(
      `BUMP ${JSON.stringify([
        { organizationId: "org_1", conversationId: "conv_1", ids: ["msg_1", "wamid.1"], kind: "upd" },
      ])}`,
    );
  });
});
