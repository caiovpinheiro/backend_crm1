/**
 * Ops one-shot: Joseph (org teste-dev) as orchestrator.
 * prismaBase: script fora de RequestContext, org scoped na query.
 */
import { Prisma } from "@prisma/client";

import { emptyToolPolicy, normalizeToolPolicy } from "../lib/ai-agents/steering";

const JOSEPH_HINT_ID = "cmu75dymh0003zlgkgx2lg0i2";
const ALLOWLIST_SKIP = /tabula/i;

function asRecord(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  return { ...(v as Record<string, unknown>) };
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL ausente");
    process.exit(1);
  }

  const { prismaBase } = await import("@/lib/prisma-base");

  try {
    const org = await prismaBase.organization.findFirst({
      where: { slug: "teste-dev" },
      select: { id: true, slug: true, name: true },
    });
    if (!org) {
      console.error("org teste-dev não encontrada");
      process.exit(1);
    }
    console.log("org", { id: org.id, slug: org.slug, name: org.name });

    const enumRows = await prismaBase.$queryRaw<Array<{ enumlabel: string }>>`
      SELECT e.enumlabel
      FROM pg_enum e
      JOIN pg_type t ON e.enumtypid = t.oid
      WHERE t.typname = 'AIAgentArchetype'
      ORDER BY e.enumsortorder
    `;
    const hasCoordenador = enumRows.some((r) => r.enumlabel === "COORDENADOR");
    console.log("AIAgentArchetype", enumRows.map((r) => r.enumlabel).join(", "));
    console.log("COORDENADOR enum", hasCoordenador);

    const agents = await prismaBase.aIAgentConfig.findMany({
      where: { organizationId: org.id },
      select: {
        id: true,
        userId: true,
        archetype: true,
        enabledTools: true,
        toolConfig: true,
        inboxPolicy: true,
        steeringRules: true,
        user: { select: { id: true, name: true, email: true } },
      },
    });

    console.log(
      "agents",
      agents.map((a) => ({
        userId: a.user.id,
        name: a.user.name,
        email: a.user.email,
        archetype: a.archetype,
        steeringLen: a.steeringRules?.length ?? 0,
      })),
    );

    const joseph =
      agents.find((a) => a.user.id === JOSEPH_HINT_ID) ??
      agents.find(
        (a) =>
          /joseph/i.test(a.user.name ?? "") &&
          (a.steeringRules?.length ?? 0) > 20_000,
      ) ??
      agents.find((a) => /joseph/i.test(a.user.name ?? ""));

    if (!joseph) {
      console.error("Joseph não encontrado");
      process.exit(1);
    }

    const steeringLen = joseph.steeringRules?.length ?? 0;
    if (!/joseph/i.test(joseph.user.name ?? "") || steeringLen < 20_000) {
      console.error("confirmação falhou", {
        name: joseph.user.name,
        email: joseph.user.email,
        userId: joseph.user.id,
        steeringLen,
      });
      process.exit(1);
    }

    const specialists = agents
      .filter((a) => a.user.id !== joseph.user.id)
      .filter((a) => !ALLOWLIST_SKIP.test(a.user.name ?? ""))
      .filter((a) =>
        /acolhi|atendimento|reten/i.test(a.user.name ?? ""),
      );

    const allowedAgentNames = specialists.map((a) => a.user.name);
    console.log("allowlist (read-only names)", allowedAgentNames);
    if (allowedAgentNames.length !== 3) {
      console.error("esperava 3 especialistas (Acolhi/Atendimento/Retenção)");
      process.exit(1);
    }

    const enabledTools = [
      ...new Set([...joseph.enabledTools, "transfer_conversation"]),
    ];

    const inboxPolicy = asRecord(joseph.inboxPolicy);
    inboxPolicy.interceptFirstAccess = false;

    const toolConfig = asRecord(joseph.toolConfig);
    const existingTransfer = normalizeToolPolicy(
      toolConfig.transfer_conversation,
    );
    const transferPolicy = {
      ...emptyToolPolicy(),
      ...existingTransfer,
      allowedAgentNames,
      allowedDepartments: [],
      allowedUserNames: existingTransfer.allowedUserNames ?? [],
    };
    toolConfig.transfer_conversation = transferPolicy;

    const data: Prisma.AIAgentConfigUpdateInput = {
      enabledTools,
      inboxPolicy: inboxPolicy as Prisma.InputJsonValue,
      toolConfig: toolConfig as Prisma.InputJsonValue,
    };
    if (hasCoordenador) {
      data.archetype = "COORDENADOR";
    }

    await prismaBase.aIAgentConfig.update({
      where: { id: joseph.id },
      data,
    });

    const after = await prismaBase.aIAgentConfig.findUniqueOrThrow({
      where: { id: joseph.id },
      select: {
        archetype: true,
        enabledTools: true,
        inboxPolicy: true,
        toolConfig: true,
        steeringRules: true,
        user: { select: { id: true, name: true, email: true } },
      },
    });

    const afterPolicy = asRecord(after.inboxPolicy);
    const afterTools = asRecord(after.toolConfig);
    console.log("updated", {
      userId: after.user.id,
      name: after.user.name,
      email: after.user.email,
      archetype: after.archetype,
      enabledTools: after.enabledTools,
      interceptFirstAccess: afterPolicy.interceptFirstAccess,
      steeringRulesLen: after.steeringRules?.length ?? 0,
      transfer_conversation: afterTools.transfer_conversation,
    });
  } finally {
    const { prismaBase } = await import("@/lib/prisma-base");
    await prismaBase.$disconnect();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
