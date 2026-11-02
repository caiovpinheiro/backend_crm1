/**
 * Evento de falha da distribuição no /logs, com Postgres de verdade: a mesma
 * falha no mesmo ticket em 45 s grava uma vez só. Com mock essa consulta
 * "funcionava" mesmo filtrando por coluna que não existe no model.
 *
 * Só corre contra Postgres local (DATABASE_URL em localhost). Sem isso, pula.
 */
import { randomBytes } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { hostnameFromConnectionUrl } from "@/lib/warn-public-do-managed-hosts";

vi.mock("@/services/organization-widgets", async (orig) => ({
  ...(await orig<typeof import("@/services/organization-widgets")>()),
  hasOrganizationWidget: async () => true,
}));

const url = process.env.DATABASE_URL;
const host = url?.trim() ? hostnameFromConnectionUrl(url) : null;
const LOCAL = host === "localhost" || host === "127.0.0.1" || host === "::1";

const suffix = randomBytes(4).toString("hex");
let seq = 0;
const uid = (p: string) => `${p}${suffix}${++seq}`;

describe.skipIf(!LOCAL)("coalescência do evento de falha da distribuição (Postgres local)", () => {
  let orgId = "";
  let closedDeptId = "";

  type Base = typeof import("@/lib/prisma-base")["prismaBase"];
  let base: Base;

  async function makeConversation() {
    const contact = await base.contact.create({
      data: { organizationId: orgId, name: uid("Contato "), number: ++seq * 7 + 1000 },
      select: { id: true },
    });
    return base.conversation.create({
      data: {
        organizationId: orgId,
        contactId: contact.id,
        number: ++seq * 13 + 3000,
        externalId: uid("ext"),
        channel: "whatsapp",
        lastInboundAt: new Date(),
      },
      select: { id: true, contactId: true },
    });
  }

  /** Motor real, sem ninguém elegível na org: sempre termina em falha. */
  async function distribute(conv: { id: string; contactId: string }) {
    const { executeDistribution } = await import("@/services/distribution/engine");
    const { runWithContext } = await import("@/lib/request-context");
    return runWithContext({ organizationId: orgId, userId: "system", isSuperAdmin: false }, () =>
      executeDistribution({
        dealId: null,
        contactId: conv.contactId,
        conversationId: conv.id,
        distributionType: null,
        triggerSource: "AUTOMATION",
      }),
    );
  }

  const failures = (conversationId: string) =>
    base.activityEvent.findMany({
      where: { organizationId: orgId, type: "LEAD_DISTRIBUTION_FAILED", conversationId },
      orderBy: { occurredAt: "asc" },
      select: { meta: true, occurredAt: true },
    });

  beforeAll(async () => {
    base = (await import("@/lib/prisma-base")).prismaBase;
    const org = await base.organization.create({
      data: { name: uid("Org "), slug: uid("org-") },
      select: { id: true },
    });
    orgId = org.id;
    const dept = await base.department.create({
      data: { organizationId: orgId, name: uid("Sem distribuição "), distributionEnabled: false },
      select: { id: true },
    });
    closedDeptId = dept.id;
  });

  afterAll(async () => {
    if (!base) return;
    await base.organization.deleteMany({ where: { id: orgId } });
  });

  it("a mesma falha repetida na janela grava um evento só, e o fluxo segue", async () => {
    const conv = await makeConversation();

    const first = await distribute(conv);
    const second = await distribute(conv);

    expect(first.reason).toBe("NO_ELIGIBLE_RESPONSIBLE");
    expect(second.reason).toBe("NO_ELIGIBLE_RESPONSIBLE");
    const events = await failures(conv.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.meta).toMatchObject({ reason: "NO_ELIGIBLE_RESPONSIBLE" });
    expect(
      await base.distributionPending.count({
        where: { organizationId: orgId, conversationId: conv.id, status: "PENDING" },
      }),
    ).toBe(1);
  });

  it("passada a janela, a falha volta a aparecer", async () => {
    const conv = await makeConversation();
    await distribute(conv);

    await base.activityEvent.updateMany({
      where: { organizationId: orgId, conversationId: conv.id },
      data: { occurredAt: new Date(Date.now() - 46_000) },
    });
    await distribute(conv);

    expect(await failures(conv.id)).toHaveLength(2);
  });

  it("motivo diferente na janela não é engolido", async () => {
    const conv = await makeConversation();
    await distribute(conv);

    await base.conversation.update({
      where: { id: conv.id },
      data: { departmentId: closedDeptId },
    });
    const second = await distribute(conv);

    expect(second.reason).toBe("NO_DEPARTMENT");
    const reasons = (await failures(conv.id)).map((e) => (e.meta as { reason?: string }).reason);
    expect(reasons).toEqual(["NO_ELIGIBLE_RESPONSIBLE", "NO_DEPARTMENT"]);
  });

  it("falha em outro ticket não é engolida", async () => {
    const a = await makeConversation();
    const b = await makeConversation();

    await distribute(a);
    await distribute(b);

    expect(await failures(a.id)).toHaveLength(1);
    expect(await failures(b.id)).toHaveLength(1);
  });
});
