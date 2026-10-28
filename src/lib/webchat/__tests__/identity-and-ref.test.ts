/**
 * Helpers compartilhados do webchat v2: identidade do site no contato (campo
 * de match) e `ref` da conversa (com cópia opcional para o negócio).
 */
import { Prisma } from "@prisma/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/prisma-helpers", () => ({
  withOrgFromCtx: <T,>(d: T) => ({ ...d, organizationId: "org-1" }),
}));

import {
  findContactByWebchatIdentity,
  normalizeWebchatExternalId,
  setContactWebchatIdentity,
} from "@/lib/webchat/contact-match";
import { normalizeWebchatRef, recordWebchatConversationRef } from "@/lib/webchat/conversation-ref";

const calls: { op: string; args: unknown }[] = [];
let responses: Record<string, unknown> = {};

const db = new Proxy(
  {},
  {
    get: (_t, model: string) =>
      new Proxy(
        {},
        {
          get: (_m, method: string) => async (args: unknown) => {
            const op = `${model}.${method}`;
            calls.push({ op, args });
            const r = responses[op];
            if (r instanceof Error) throw r;
            return typeof r === "function" ? (r as (a: unknown) => unknown)(args) : (r ?? null);
          },
        },
      ),
  },
) as never;

beforeEach(() => {
  calls.length = 0;
  responses = {};
});

describe("normalizadores", () => {
  it("externalId e ref: texto 1..128 sem controle", () => {
    expect(normalizeWebchatExternalId(" ext-1 ")).toBe("ext-1");
    expect(normalizeWebchatExternalId(42)).toBe("42");
    expect(normalizeWebchatExternalId("")).toBeNull();
    expect(normalizeWebchatExternalId("a\nb")).toBeNull();
    expect(normalizeWebchatExternalId("x".repeat(129))).toBeNull();
    expect(normalizeWebchatRef("REF-123")).toBe("REF-123");
    expect(normalizeWebchatRef({})).toBeNull();
  });
});

describe("identidade do site no contato", () => {
  it("match por externalId", async () => {
    responses["contact.findFirst"] = { id: "ct-1" };
    expect(await findContactByWebchatIdentity({ type: "externalId" }, "ext-1", db)).toEqual({ id: "ct-1" });
    expect(calls[0]).toEqual({ op: "contact.findFirst", args: { where: { externalId: "ext-1" }, select: { id: true } } });
  });

  it("match por campo personalizado", async () => {
    responses["contactCustomFieldValue.findFirst"] = { contactId: "ct-2" };
    const found = await findContactByWebchatIdentity({ type: "customField", customFieldId: "cf-1" }, "ext-1", db);
    expect(found).toEqual({ id: "ct-2" });
    expect((calls[0].args as { where: unknown }).where).toEqual({ customFieldId: "cf-1", value: "ext-1" });
  });

  it("gravar externalId: ok ou taken (unique)", async () => {
    expect(await setContactWebchatIdentity("ct-1", { type: "externalId" }, "ext-1", db)).toBe("ok");
    responses["contact.update"] = new Prisma.PrismaClientKnownRequestError("dup", {
      code: "P2002",
      clientVersion: "x",
    });
    expect(await setContactWebchatIdentity("ct-1", { type: "externalId" }, "ext-1", db)).toBe("taken");
  });

  it("gravar em campo personalizado: confere o campo e faz upsert", async () => {
    const match = { type: "customField", customFieldId: "cf-1" } as const;
    expect(await setContactWebchatIdentity("ct-1", match, "ext-1", db)).toBe("field_missing");
    responses["customField.findFirst"] = { id: "cf-1" };
    expect(await setContactWebchatIdentity("ct-1", match, "ext-1", db)).toBe("ok");
    const upsert = calls.find((c) => c.op === "contactCustomFieldValue.upsert")?.args as {
      create: unknown;
      update: unknown;
    };
    expect(upsert.create).toEqual({ contactId: "ct-1", customFieldId: "cf-1", value: "ext-1", organizationId: "org-1" });
    expect(upsert.update).toEqual({ value: "ext-1" });
  });
});

describe("recordWebchatConversationRef", () => {
  const base = { conversationId: "cv-1", contactId: "ct-1", ref: "REF-1", source: "s2s" as const };

  it("cria a linha e não toca no negócio sem campo configurado", async () => {
    responses["webchatConversationRef.upsert"] = { id: "r1" };
    const res = await recordWebchatConversationRef(
      { ...base, category: "suporte", priority: null, refDealCustomFieldId: null },
      db,
    );
    expect(res).toEqual({ id: "r1", created: true });
    const upsert = calls.find((c) => c.op === "webchatConversationRef.upsert")?.args as {
      create: Record<string, unknown>;
      update: Record<string, unknown>;
    };
    expect(upsert.create).toMatchObject({ conversationId: "cv-1", ref: "REF-1", source: "s2s", category: "suporte" });
    expect(upsert.update).toEqual({ category: "suporte" });
    expect(calls.some((c) => c.op.startsWith("deal"))).toBe(false);
  });

  it("copia o ref para o campo do negócio aberto mais recente", async () => {
    responses["webchatConversationRef.findUnique"] = { id: "r1" };
    responses["webchatConversationRef.upsert"] = { id: "r1" };
    responses["customField.findFirst"] = { id: "cf-deal" };
    responses["deal.findFirst"] = { id: "deal-1" };
    const res = await recordWebchatConversationRef({ ...base, refDealCustomFieldId: "cf-deal" }, db);
    expect(res.created).toBe(false);
    const dealFind = calls.find((c) => c.op === "deal.findFirst")?.args as { where: unknown };
    expect(dealFind.where).toEqual({ contactId: "ct-1", status: "OPEN" });
    const upsert = calls.find((c) => c.op === "dealCustomFieldValue.upsert")?.args as { update: unknown };
    expect(upsert.update).toEqual({ value: "REF-1" });
  });

  it("campo do negócio inexistente: ignora", async () => {
    responses["webchatConversationRef.upsert"] = { id: "r1" };
    await recordWebchatConversationRef({ ...base, refDealCustomFieldId: "cf-x" }, db);
    expect(calls.some((c) => c.op === "dealCustomFieldValue.upsert")).toBe(false);
  });
});
