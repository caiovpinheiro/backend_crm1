/**
 * Integração Postgres do isolamento tenant (Fase 1).
 *
 * Só corre contra Postgres **local** (localhost / 127.0.0.1).
 * DATABASE_URL apontando para DigitalOcean, host remoto ou ausente → skip.
 * Skip ≠ fase validada: a homologação real permanece pendente.
 *
 * Imports do Prisma são dinâmicos para o arquivo carregar mesmo sem
 * `prisma generate` / client gerado (CI sem DB).
 */
import { randomBytes } from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";

import {
  hostnameFromConnectionUrl,
  isDigitalOceanManagedHost,
} from "@/lib/warn-public-do-managed-hosts";

function isSafeLocalPostgres(url: string | undefined): boolean {
  if (!url?.trim()) return false;
  const host = hostnameFromConnectionUrl(url);
  if (!host) return false;
  if (isDigitalOceanManagedHost(host)) return false;
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

const LOCAL = isSafeLocalPostgres(process.env.DATABASE_URL);
const SKIP_REASON =
  "Homologação real pendente: sem PostgreSQL local seguro (DATABASE_URL localhost). Não validar isolamento só com mocks.";

const suffix = randomBytes(4).toString("hex");

describe.skipIf(!LOCAL)("tenant isolation integration (Postgres local)", () => {
  let orgAId = "";
  let orgBId = "";
  let catAId = "";
  let catBId = "";
  let tokenB = "";
  let userAId = "";
  let userBId = "";
  let extBId = "";

  it("prepara duas orgs fictícias", async () => {
    const { prismaBase } = await import("@/lib/prisma-base");
    const orgA = await prismaBase.organization.create({
      data: { name: `Sec Test A ${suffix}`, slug: `sec-test-a-${suffix}` },
      select: { id: true },
    });
    const orgB = await prismaBase.organization.create({
      data: { name: `Sec Test B ${suffix}`, slug: `sec-test-b-${suffix}` },
      select: { id: true },
    });
    orgAId = orgA.id;
    orgBId = orgB.id;

    const catB = await prismaBase.discountCategory.create({
      data: {
        organizationId: orgBId,
        name: `Cat B ${suffix}`,
        discountValue: 10,
      },
      select: { id: true },
    });
    catBId = catB.id;

    tokenB = `tok-b-${suffix}`;
    await prismaBase.callProviderConfig.create({
      data: {
        organizationId: orgBId,
        providerKey: "generic-sip",
        authMode: "TOKEN",
        webhookToken: tokenB,
        webhookSecretEncrypted: "test-enc",
        fieldMappings: { __api4comServiceTokenEncrypted: "secret-blob" },
        recordingDelivery: "URL",
      },
    });

    const userA = await prismaBase.user.create({
      data: {
        name: `Member A ${suffix}`,
        email: `member-a-${suffix}@sec.test`,
        organizationId: orgAId,
        role: "MEMBER",
      },
      select: { id: true },
    });
    const userB = await prismaBase.user.create({
      data: {
        name: `Admin B ${suffix}`,
        email: `admin-b-${suffix}@sec.test`,
        organizationId: orgBId,
        role: "ADMIN",
      },
      select: { id: true },
    });
    userAId = userA.id;
    userBId = userB.id;

    await prismaBase.agentPermission.create({
      data: {
        organizationId: orgBId,
        userId: userBId,
        canConfigureFieldVisibility: true,
      },
    });

    const extB = await prismaBase.sipExtension.create({
      data: {
        organizationId: orgBId,
        userId: userBId,
        label: "ext-b",
        sipUri: `sip:b-${suffix}@sec.test`,
        authUser: "b",
        authPasswordEncrypted: "enc",
        wsServer: "wss://sec.test/ws",
        stunServers: [],
      },
      select: { id: true },
    });
    extBId = extB.id;
  });

  it("1. usuário de A consulta registro de A", async () => {
    const { prisma } = await import("@/lib/prisma");
    const { runWithContext } = await import("@/lib/request-context");
    const created = await runWithContext(
      { organizationId: orgAId, userId: userAId, isSuperAdmin: false },
      async () =>
        prisma.discountCategory.create({
          data: { name: `Cat A ${suffix}`, discountValue: 15 },
          select: { id: true, name: true, organizationId: true },
        }),
    );
    catAId = created.id;
    expect(created.organizationId).toBe(orgAId);

    const found = await runWithContext(
      { organizationId: orgAId, userId: userAId, isSuperAdmin: false },
      async () =>
        prisma.discountCategory.findUnique({
          where: { id: catAId },
          select: { id: true, name: true },
        }),
    );
    expect(found?.id).toBe(catAId);
  });

  it("2. usuário de A consulta id de B: vazio, sem payload", async () => {
    const { prisma } = await import("@/lib/prisma");
    const { runWithContext } = await import("@/lib/request-context");
    const found = await runWithContext(
      { organizationId: orgAId, userId: userAId, isSuperAdmin: false },
      async () =>
        prisma.discountCategory.findUnique({
          where: { id: catBId },
          select: { id: true, name: true, discountValue: true },
        }),
    );
    expect(found).toBeNull();
  });

  it("3. usuário de A não altera nem exclui registro de B", async () => {
    const { prisma } = await import("@/lib/prisma");
    const { prismaBase } = await import("@/lib/prisma-base");
    const { runWithContext } = await import("@/lib/request-context");
    await runWithContext(
      { organizationId: orgAId, userId: userAId, isSuperAdmin: false },
      async () => {
        await expect(
          prisma.discountCategory.update({
            where: { id: catBId },
            data: { name: "hijacked" },
          }),
        ).rejects.toThrow();
      },
    );

    const stillB = await prismaBase.discountCategory.findUnique({
      where: { id: catBId },
      select: { name: true, organizationId: true },
    });
    expect(stillB?.organizationId).toBe(orgBId);
    expect(stillB?.name).toBe(`Cat B ${suffix}`);
  });

  it("4. A não associa productId de B (product scoped → não encontrado)", async () => {
    const { prisma } = await import("@/lib/prisma");
    const { prismaBase } = await import("@/lib/prisma-base");
    const { runWithContext } = await import("@/lib/request-context");
    const productB = await prismaBase.product.create({
      data: {
        organizationId: orgBId,
        name: `Prod B ${suffix}`,
      },
      select: { id: true },
    });
    const seen = await runWithContext(
      { organizationId: orgAId, userId: userAId, isSuperAdmin: false },
      async () =>
        prisma.product.findUnique({
          where: { id: productB.id },
          select: { id: true },
        }),
    );
    expect(seen).toBeNull();
    await prismaBase.product.delete({ where: { id: productB.id } }).catch(() => undefined);
  });

  it("5. where com organizationId divergente continua vazio", async () => {
    const { prisma } = await import("@/lib/prisma");
    const { runWithContext } = await import("@/lib/request-context");
    const leaked = await runWithContext(
      { organizationId: orgAId, userId: userAId, isSuperAdmin: false },
      async () =>
        prisma.discountCategory.findMany({
          where: { organizationId: orgBId },
          select: { id: true },
        }),
    );
    expect(leaked.map((r) => r.id)).not.toContain(catBId);
  });

  it("6. create sem organizationId explícito usa o contexto A", async () => {
    const { prisma } = await import("@/lib/prisma");
    const { prismaBase } = await import("@/lib/prisma-base");
    const { runWithContext } = await import("@/lib/request-context");
    const created = await runWithContext(
      { organizationId: orgAId, userId: userAId, isSuperAdmin: false },
      async () =>
        prisma.discountCategory.create({
          data: { name: `Cat A2 ${suffix}`, discountValue: 5 },
          select: { id: true, organizationId: true },
        }),
    );
    expect(created.organizationId).toBe(orgAId);
    await prismaBase.discountCategory.delete({ where: { id: created.id } });
  });

  it("5b. create com organizationId de B lança (não transfere)", async () => {
    const { prisma } = await import("@/lib/prisma");
    const { TenantIsolationError } = await import("@/lib/prisma-tenant-helpers");
    const { runWithContext } = await import("@/lib/request-context");
    await runWithContext(
      { organizationId: orgAId, userId: userAId, isSuperAdmin: false },
      async () => {
        await expect(
          prisma.discountCategory.create({
            data: {
              name: "evil",
              discountValue: 1,
              organizationId: orgBId,
            },
          }),
        ).rejects.toBeInstanceOf(TenantIsolationError);
      },
    );
  });

  it("7. prismaBase + webhookToken sistêmico funciona; sem contexto o scoped lança", async () => {
    const { prisma } = await import("@/lib/prisma");
    const { findConfigByWebhookToken } = await import(
      "@/services/call-provider-configs"
    );
    const cfg = await findConfigByWebhookToken(tokenB);
    expect(cfg?.organizationId).toBe(orgBId);
    expect(cfg?.webhookToken).toBe(tokenB);

    await expect(prisma.discountCategory.findMany()).rejects.toThrow(
      /RequestContext/,
    );
  });

  it("8. listagem da própria org não inclui B; detalhe A segue ok", async () => {
    const { prisma } = await import("@/lib/prisma");
    const { runWithContext } = await import("@/lib/request-context");
    const listed = await runWithContext(
      { organizationId: orgAId, userId: userAId, isSuperAdmin: false },
      async () =>
        prisma.discountCategory.findMany({
          select: { id: true, organizationId: true },
        }),
    );
    expect(listed.every((r) => r.organizationId === orgAId)).toBe(true);
    expect(listed.map((r) => r.id)).toContain(catAId);
    expect(listed.map((r) => r.id)).not.toContain(catBId);

    const configs = await runWithContext(
      { organizationId: orgAId, userId: userAId, isSuperAdmin: false },
      async () => prisma.callProviderConfig.findMany({ select: { webhookToken: true } }),
    );
    expect(configs.map((c) => c.webhookToken)).not.toContain(tokenB);
  });

  it("9. findFirst/OR/AND divergente não vaza; updateMany/deleteMany de A não tocam B", async () => {
    const { prisma } = await import("@/lib/prisma");
    const { prismaBase } = await import("@/lib/prisma-base");
    const { runWithContext } = await import("@/lib/request-context");
    const ctxA = {
      organizationId: orgAId,
      userId: userAId,
      isSuperAdmin: false,
    };

    const first = await runWithContext(ctxA, async () =>
      prisma.discountCategory.findFirst({
        where: { id: catBId },
        select: { id: true },
      }),
    );
    expect(first).toBeNull();

    const orLeak = await runWithContext(ctxA, async () =>
      prisma.discountCategory.findMany({
        where: {
          OR: [{ organizationId: orgBId }, { id: catBId }],
        },
        select: { id: true },
      }),
    );
    expect(orLeak.map((r) => r.id)).not.toContain(catBId);

    const andLeak = await runWithContext(ctxA, async () =>
      prisma.discountCategory.findMany({
        where: {
          AND: [{ organizationId: orgBId }, { name: { contains: "Cat B" } }],
        },
        select: { id: true },
      }),
    );
    expect(andLeak.map((r) => r.id)).not.toContain(catBId);

    const many = await runWithContext(ctxA, async () =>
      prisma.discountCategory.updateMany({
        where: { id: catBId },
        data: { name: "hijack-many" },
      }),
    );
    expect(many.count).toBe(0);

    const delMany = await runWithContext(ctxA, async () =>
      prisma.discountCategory.deleteMany({ where: { id: catBId } }),
    );
    expect(delMany.count).toBe(0);

    const stillB = await prismaBase.discountCategory.findUnique({
      where: { id: catBId },
      select: { name: true },
    });
    expect(stillB?.name).toBe(`Cat B ${suffix}`);
  });

  it("10. upsert/delete/update divergente; transação; composto sip; agent_permissions", async () => {
    const { prisma } = await import("@/lib/prisma");
    const { prismaBase } = await import("@/lib/prisma-base");
    const { TenantIsolationError } = await import("@/lib/prisma-tenant-helpers");
    const { agentPermissionWhere } = await import("@/lib/agent-permission-where");
    const { runWithContext } = await import("@/lib/request-context");
    const ctxA = {
      organizationId: orgAId,
      userId: userAId,
      isSuperAdmin: false,
    };

    await runWithContext(ctxA, async () => {
      await expect(
        prisma.discountCategory.delete({ where: { id: catBId } }),
      ).rejects.toThrow();
      await expect(
        prisma.discountCategory.update({
          where: { id: catBId },
          data: { organizationId: orgBId, name: "x" },
        }),
      ).rejects.toBeInstanceOf(TenantIsolationError);
    });

    await runWithContext(ctxA, async () => {
      await expect(
        prisma.$transaction(async (tx) => {
          await tx.discountCategory.update({
            where: { id: catBId },
            data: { name: "tx-hijack" },
          });
        }),
      ).rejects.toThrow();
    });
    const afterTx = await prismaBase.discountCategory.findUnique({
      where: { id: catBId },
      select: { name: true },
    });
    expect(afterTx?.name).toBe(`Cat B ${suffix}`);

    const sip = await runWithContext(ctxA, async () =>
      prisma.sipExtension.findFirst({
        where: { userId: userBId },
        select: { id: true },
      }),
    );
    expect(sip).toBeNull();

    const sipUpsert = runWithContext(ctxA, async () =>
      prisma.sipExtension.upsert({
        where: {
          organizationId_userId: { organizationId: orgBId, userId: userBId },
        },
        create: {
          userId: userBId,
          label: "hijack",
          sipUri: "sip:x@x",
          authUser: "x",
          authPasswordEncrypted: "x",
          wsServer: "wss://x",
          stunServers: [],
        },
        update: { label: "hijack" },
      }),
    );
    await expect(sipUpsert).rejects.toBeInstanceOf(TenantIsolationError);
    const stillExtB = await prismaBase.sipExtension.findUnique({
      where: { id: extBId },
      select: { label: true, organizationId: true },
    });
    expect(stillExtB?.organizationId).toBe(orgBId);
    expect(stillExtB?.label).toBe("ext-b");

    const sipById = await runWithContext(ctxA, async () =>
      prisma.sipExtension.findUnique({
        where: { id: extBId },
        select: { id: true },
      }),
    );
    expect(sipById).toBeNull();

    const permB = await runWithContext(ctxA, async () =>
      prisma.agentPermission.findFirst({
        where: agentPermissionWhere(userBId, orgAId),
        select: { canConfigureFieldVisibility: true, userId: true },
      }),
    );
    expect(permB).toBeNull();

    const permByUserOnly = await runWithContext(ctxA, async () =>
      prisma.agentPermission.findFirst({
        where: { userId: userBId },
        select: { userId: true, organizationId: true },
      }),
    );
    expect(permByUserOnly).toBeNull();

    const webhookByToken = await runWithContext(ctxA, async () =>
      prisma.callProviderConfig.findUnique({
        where: { webhookToken: tokenB },
        select: { id: true },
      }),
    );
    expect(webhookByToken).toBeNull();

    const { findConfigByWebhookToken } = await import(
      "@/services/call-provider-configs"
    );
    const systemic = await findConfigByWebhookToken(tokenB);
    expect(systemic?.organizationId).toBe(orgBId);
  });

  afterAll(async () => {
    if (!orgAId && !orgBId) return;
    const { prismaBase } = await import("@/lib/prisma-base");
    const orgIds = [orgAId, orgBId].filter(Boolean);
    await prismaBase.sipExtension
      .deleteMany({ where: { organizationId: { in: orgIds } } })
      .catch(() => undefined);
    await prismaBase.agentPermission
      .deleteMany({ where: { organizationId: { in: orgIds } } })
      .catch(() => undefined);
    await prismaBase.callProviderConfig
      .deleteMany({ where: { organizationId: { in: orgIds } } })
      .catch(() => undefined);
    await prismaBase.discountCategory
      .deleteMany({ where: { organizationId: { in: orgIds } } })
      .catch(() => undefined);
    await prismaBase.user
      .deleteMany({ where: { organizationId: { in: orgIds } } })
      .catch(() => undefined);
    if (orgAId) {
      await prismaBase.organization.delete({ where: { id: orgAId } }).catch(() => undefined);
    }
    if (orgBId) {
      await prismaBase.organization.delete({ where: { id: orgBId } }).catch(() => undefined);
    }
  });
});

describe("tenant isolation integration — gate de ambiente", () => {
  it("registra quando o Postgres local seguro não está disponível", () => {
    if (LOCAL) {
      expect(LOCAL).toBe(true);
      return;
    }
    expect(LOCAL).toBe(false);
    // eslint-disable-next-line no-console
    console.warn(SKIP_REASON);
  });
});
