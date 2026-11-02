/**
 * Critério do aviso "contato no chat agora", com Postgres de verdade
 * (docs/decisoes/webchat-widget.md §9.13). Só corre contra Postgres local
 * (DATABASE_URL em localhost). Sem isso, pula.
 */
import { randomBytes } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { hostnameFromConnectionUrl } from "@/lib/warn-public-do-managed-hosts";

const url = process.env.DATABASE_URL;
const host = url?.trim() ? hostnameFromConnectionUrl(url) : null;
const LOCAL = host === "localhost" || host === "127.0.0.1" || host === "::1";

const suffix = randomBytes(4).toString("hex");
let seq = 0;
const uid = (p: string) => `${p}${suffix}${++seq}`;
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

describe.skipIf(!LOCAL)("ticket webchat ativo do contato (Postgres local)", () => {
  let orgId = "";
  let otherOrgId = "";
  let channelId = "";
  let otherChannelId = "";
  type Base = typeof import("@/lib/prisma-base")["prismaBase"];
  let base: Base;

  async function inOrg<T>(fn: () => Promise<T>, org = orgId): Promise<T> {
    const { runWithContext } = await import("@/lib/request-context");
    return runWithContext({ organizationId: org, userId: "system", isSuperAdmin: false }, fn);
  }

  async function makeChannel(org: string) {
    const row = await base.channel.create({
      data: {
        organizationId: org,
        name: uid("Canal "),
        number: ++seq + 100,
        type: "WEBCHAT",
        provider: "WEBCHAT",
        status: "CONNECTED",
        publicKey: `wc_${uid("k")}`.padEnd(27, "x"),
      },
      select: { id: true },
    });
    return row.id;
  }

  async function makeContact(org = orgId) {
    return (
      await base.contact.create({
        data: { organizationId: org, name: uid("Pessoa "), number: ++seq * 7 + 1000 },
        select: { id: true },
      })
    ).id;
  }

  async function makeTicket(
    contactId: string,
    opts: { channelId?: string; channel?: string; org?: string; status?: "OPEN" | "RESOLVED"; lastInboundAt?: Date | null } = {},
  ) {
    return base.conversation.create({
      data: {
        organizationId: opts.org ?? orgId,
        contactId,
        channel: opts.channel ?? "webchat",
        channelId: opts.channelId ?? channelId,
        externalId: uid("ext"),
        number: ++seq * 11 + 34_000,
        status: opts.status ?? "OPEN",
        lastInboundAt: opts.lastInboundAt ?? null,
      },
      select: { id: true, number: true },
    });
  }

  async function makeSession(contactId: string, lastSeenAt: Date, opts: { channelId?: string; org?: string } = {}) {
    await base.webchatSession.create({
      data: {
        id: uid("wv_"),
        organizationId: opts.org ?? orgId,
        channelId: opts.channelId ?? channelId,
        contactId,
        tokenHash: uid("hash"),
        expiresAt: new Date(Date.now() + 3_600_000),
        lastSeenAt,
      },
    });
  }

  async function find(contactId: string, canOpen: (id: string) => Promise<boolean> = async () => true, org = orgId) {
    const { findActiveWebchatConversationForContact } = await import("@/lib/webchat/active-conversation");
    return inOrg(() => findActiveWebchatConversationForContact({ organizationId: org, contactId, canOpen }), org);
  }

  beforeAll(async () => {
    base = (await import("@/lib/prisma-base")).prismaBase;
    orgId = (await base.organization.create({ data: { name: uid("Org A "), slug: uid("org-a-") }, select: { id: true } })).id;
    otherOrgId = (await base.organization.create({ data: { name: uid("Org B "), slug: uid("org-b-") }, select: { id: true } })).id;
    channelId = await makeChannel(orgId);
    otherChannelId = await makeChannel(orgId);
  });

  afterAll(async () => {
    if (!base) return;
    for (const organizationId of [orgId, otherOrgId]) {
      await base.webchatSession.deleteMany({ where: { organizationId } });
      await base.conversation.deleteMany({ where: { organizationId } });
      await base.contact.deleteMany({ where: { organizationId } });
      await base.channel.deleteMany({ where: { organizationId } });
    }
    await base.organization.deleteMany({ where: { id: { in: [orgId, otherOrgId] } } }).catch(() => undefined);
  });

  it("contato sem ticket webchat: nada", async () => {
    const contactId = await makeContact();
    await makeTicket(contactId, { channel: "whatsapp", lastInboundAt: new Date() });
    expect(await find(contactId)).toBeNull();
  });

  it("ticket aberto com mensagem recente do visitante, sem sessão: ativo", async () => {
    const contactId = await makeContact();
    const t = await makeTicket(contactId, { lastInboundAt: minutesAgo(29) });
    expect(await find(contactId)).toEqual({ id: t.id, number: t.number, reason: "recent_message" });
  });

  it("ticket aberto, mensagem antiga, visitante online no canal: ativo", async () => {
    const contactId = await makeContact();
    const t = await makeTicket(contactId, { lastInboundAt: minutesAgo(600) });
    await makeSession(contactId, minutesAgo(2));
    expect(await find(contactId)).toEqual({ id: t.id, number: t.number, reason: "online" });
  });

  it("ticket aberto, mensagem antiga e visitante fora: não é ativo", async () => {
    const contactId = await makeContact();
    await makeTicket(contactId, { lastInboundAt: minutesAgo(31) });
    await makeSession(contactId, minutesAgo(4));
    expect(await find(contactId)).toBeNull();
  });

  it("sessão de outro canal webchat não conta como online neste ticket", async () => {
    const contactId = await makeContact();
    await makeTicket(contactId, { lastInboundAt: minutesAgo(600) });
    await makeSession(contactId, new Date(), { channelId: otherChannelId });
    expect(await find(contactId)).toBeNull();
  });

  it("ticket encerrado não é ativo, mesmo com o visitante online", async () => {
    const contactId = await makeContact();
    await makeTicket(contactId, { status: "RESOLVED", lastInboundAt: new Date() });
    await makeSession(contactId, new Date());
    expect(await find(contactId)).toBeNull();
  });

  it("online ganha de mensagem recente em outro canal", async () => {
    const contactId = await makeContact();
    await makeTicket(contactId, { channelId, lastInboundAt: new Date() });
    const online = await makeTicket(contactId, { channelId: otherChannelId, lastInboundAt: minutesAgo(90) });
    await makeSession(contactId, new Date(), { channelId: otherChannelId });
    expect((await find(contactId))?.id).toBe(online.id);
  });

  it("ticket que o usuário não abre fica de fora; passa para o próximo", async () => {
    const contactId = await makeContact();
    const hidden = await makeTicket(contactId, { channelId, lastInboundAt: new Date() });
    const visible = await makeTicket(contactId, { channelId: otherChannelId, lastInboundAt: minutesAgo(5) });
    expect((await find(contactId, async (id) => id !== hidden.id))?.id).toBe(visible.id);
    expect(await find(contactId, async () => false)).toBeNull();
  });

  it("não atravessa organização", async () => {
    const foreignChannel = await makeChannel(otherOrgId);
    const foreignContact = await makeContact(otherOrgId);
    await makeTicket(foreignContact, { org: otherOrgId, channelId: foreignChannel, lastInboundAt: new Date() });
    await makeSession(foreignContact, new Date(), { org: otherOrgId, channelId: foreignChannel });
    // Org A perguntando pelo contato da org B, com e sem o id certo no contexto.
    expect(await find(foreignContact)).toBeNull();
    const { findActiveWebchatConversationForContact } = await import("@/lib/webchat/active-conversation");
    expect(
      await inOrg(() =>
        findActiveWebchatConversationForContact({
          organizationId: otherOrgId,
          contactId: foreignContact,
          canOpen: async () => true,
        }),
      ),
    ).toBeNull();
    // A própria org B enxerga: o teste não passa por falta de dado.
    expect((await find(foreignContact, async () => true, otherOrgId))?.reason).toBe("online");
  });
});
