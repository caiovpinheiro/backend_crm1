/**
 * repair-stale-open-conversations-for-closed-deals
 *
 * NÃO USE para “limpar” tickets DNA/Eduardo só porque o deal está
 * GANHO/PERDIDO. A regra de produto é: fila = status da conversa.
 * Estágio do funil NÃO encerra ticket. OPEN + PERDIDO na Aguardando é
 * válido até alguém encerrar de verdade (`keepAgentOnEnd` decide se
 * desvincula o atendente).
 *
 * Este script mistura (a) `closedAt` stale (encerramento real com status
 * errado — ok revisar) com (b) “só deal terminal” (produto errado — mass
 * close indevido). Não expandir. Não rodar --apply em produção.
 *
 * Uso (só se um humano filtrar o dry-run e quiser corrigir closedAt stale):
 *   pnpm tsx src/scripts/repair-stale-open-conversations-for-closed-deals.ts --org <orgId>
 *   pnpm tsx src/scripts/repair-stale-open-conversations-for-closed-deals.ts --org <orgId> --apply
 */

import { config as loadEnv } from "dotenv";
import { resolve } from "node:path";

loadEnv({ path: resolve(process.cwd(), ".env.local") });
loadEnv({ path: resolve(process.cwd(), ".env") });

function getArg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const orgId = getArg("--org");
  const apply = process.argv.includes("--apply");

  if (!orgId) {
    console.error("Erro: informe --org <organizationId>.");
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) {
    console.error("Erro: DATABASE_URL não definida.");
    process.exit(1);
  }

  const { prismaBase } = await import("@/lib/prisma-base");

  const stale = await prismaBase.conversation.findMany({
    where: {
      organizationId: orgId,
      status: { not: "RESOLVED" },
      OR: [
        { closedAt: { not: null } },
        {
          AND: [
            {
              contact: {
                deals: {
                  some: {
                    organizationId: orgId,
                    status: { in: ["WON", "LOST"] },
                  },
                },
              },
            },
            {
              contact: {
                deals: { none: { organizationId: orgId, status: "OPEN" } },
              },
            },
          ],
        },
      ],
    },
    select: {
      id: true,
      number: true,
      status: true,
      closedAt: true,
      assignedToId: true,
      contactId: true,
      contact: { select: { name: true } },
    },
    orderBy: { updatedAt: "desc" },
    take: 10_000,
  });

  console.log(
    `[repair] ${stale.length} conversa(s) OPEN/PENDING/SNOOZED com closedAt ou só deal terminal` +
      (apply ? "" : " (dry-run — use --apply para marcar RESOLVED)"),
  );
  for (const c of stale.slice(0, 30)) {
    console.log(
      `  #${c.number ?? "?"} ${c.contact?.name ?? c.contactId} status=${c.status} closedAt=${c.closedAt?.toISOString() ?? "null"} assignee=${c.assignedToId ?? "null"}`,
    );
  }
  if (stale.length > 30) {
    console.log(`  … +${stale.length - 30} restantes`);
  }

  if (!apply || stale.length === 0) {
    await prismaBase.$disconnect();
    return;
  }

  const ids = stale.map((c) => c.id);
  const now = new Date();
  const withClosedAt = await prismaBase.conversation.updateMany({
    where: {
      organizationId: orgId,
      id: { in: ids },
      closedAt: null,
    },
    data: { closedAt: now },
  });
  const resolved = await prismaBase.conversation.updateMany({
    where: { organizationId: orgId, id: { in: ids } },
    data: { status: "RESOLVED", hasError: false },
  });
  const pending = await prismaBase.distributionPending.updateMany({
    where: {
      organizationId: orgId,
      conversationId: { in: ids },
      status: "PENDING",
    },
    data: { status: "RESOLVED", resolvedAt: now },
  });

  console.log(
    `[repair] aplicado — closedAt preenchido: ${withClosedAt.count}, status RESOLVED: ${resolved.count}, pending cancelado: ${pending.count}`,
  );
  await prismaBase.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
