#!/usr/bin/env tsx
/**
 * Script de smoke test: dado um telefone, mostra contato e negócios abertos
 * que a v2 carregaria.
 * Uso: npx tsx scripts/ai-v2-check-context.ts +5511999999999 [organizationId]
 */

import { prismaBase } from "@/lib/prisma-base";
import { withSystemContext } from "@/lib/webhook-context";

async function main() {
  const phone = process.argv[2]?.trim();
  const orgId = process.argv[3]?.trim();

  if (!phone) {
    console.error("Uso: npx tsx scripts/ai-v2-check-context.ts <telefone> [organizationId]");
    process.exit(1);
  }

  if (orgId) {
    await run(orgId, phone);
    return;
  }

  // Lista organizações e pergunta se não passou orgId
  const orgs = await prismaBase.organization.findMany({
    take: 20,
    select: { id: true, name: true, slug: true },
    orderBy: { name: "asc" },
  });

  if (orgs.length === 0) {
    console.error("Nenhuma organização encontrada.");
    process.exit(1);
  }

  if (orgs.length === 1) {
    await run(orgs[0].id, phone);
    return;
  }

  console.log("Mais de uma organização. Escolha passando o id como segundo argumento:");
  for (const o of orgs) {
    console.log(`  ${o.id}  ${o.name} (${o.slug ?? ""})`);
  }
  process.exit(0);
}

async function run(organizationId: string, phone: string) {
  await withSystemContext(
    organizationId,
    async () => {
      const contact = await prismaBase.contact.findFirst({
        where: { organizationId, phone: { contains: phone } },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          name: true,
          phone: true,
          email: true,
          customValues: true,
          createdAt: true,
        },
      });

      if (!contact) {
        console.log(`Nenhum contato encontrado com telefone contendo: ${phone}`);
        return;
      }

      console.log("=== CONTATO ===");
      console.log(JSON.stringify(contact, null, 2));

      const deals = await prismaBase.deal.findMany({
        where: {
          organizationId,
          contactId: contact.id,
          status: { not: "LOST" },
        },
        orderBy: { updatedAt: "desc" },
        take: 5,
        select: {
          id: true,
          title: true,
          status: true,
          value: true,
          stage: { select: { id: true, name: true } },
          customValues: true,
          updatedAt: true,
        },
      });

      console.log("=== NEGÓCIOS ABERTOS ===");
      console.log(JSON.stringify(deals, null, 2));

      // Campos padrão que a v2 usaria
      console.log("=== CAMPOS PADRÃO V2 ===");
      console.log(
        JSON.stringify(
          {
            contact: ["id", "name", "phone", "email"],
            deal: ["id", "title", "status", "value", "stage.id", "stage.name"],
          },
          null,
          2,
        ),
      );
    },
    { actor: { type: "SYSTEM", label: "ai-v2-check-context" } },
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
