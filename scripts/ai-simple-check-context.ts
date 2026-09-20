/**
 * Diagnóstico: dado um telefone, mostra o contato e o deal aberto mais recente
 * que o motor v2 simples carregaria para montar o prompt.
 *
 * Uso:
 *   npx tsx scripts/ai-simple-check-context.ts +5511999999999 [organizationId]
 */

async function main() {
  const phone = process.argv[2];
  const organizationId = process.argv[3];

  if (!phone) {
    console.error("Uso: npx tsx scripts/ai-simple-check-context.ts <telefone> [organizationId]");
    process.exit(1);
  }

  const { prismaBase } = await import("@/lib/prisma-base");
  const { loadContactAndDeal } = await import("@/services/ai-simple/engine");
  const { normalizeSimpleConfig } = await import("@/lib/ai-simple/config");
  const { runWithContext } = await import("@/lib/request-context");

  // Config exploratória: traz os campos mais comuns do contato e do deal.
  const config = normalizeSimpleConfig({
    tone: "",
    rules: "",
    context_fields: {
      contact: ["id", "name", "phone", "email", "lifecycleStage"],
      deal: ["id", "title", "value", "status", "stage.name", "stage.pipeline.name"],
    },
    confirmation_message: "",
    on_deal_not_found: "ask_identification",
    identification_message: "",
    knowledge: "",
    modes: [],
    allowed_actions: [],
    allowed_fields: [],
    handoff_message: "",
    handoff_queue: "",
    history_limit: 10,
  });

  const where = organizationId
    ? { organizationId, phone: { contains: phone.replace(/\D/g, "") } }
    : { phone: { contains: phone.replace(/\D/g, "") } };

  const contacts = await prismaBase.contact.findMany({
    where,
    take: 5,
    select: { id: true, organizationId: true, name: true, phone: true, email: true },
  });

  if (contacts.length === 0) {
    console.log("Nenhum contato encontrado.");
    process.exit(0);
  }

  if (contacts.length > 1 && !organizationId) {
    console.log("Mais de um contato encontrado; especifique organizationId:");
    for (const c of contacts) {
      console.log(`- ${c.id} | org=${c.organizationId} | ${c.name} | ${c.phone}`);
    }
    process.exit(0);
  }

  for (const contact of contacts) {
    const ctx = {
      organizationId: contact.organizationId,
      userId: "system",
      isSuperAdmin: false,
    };
    const { contact: snapshot, deal, dealId } = await runWithContext(
      ctx,
      () => loadContactAndDeal(contact.organizationId, contact.id, config),
    );
    console.log("\n--- contato ---");
    console.log({
      id: contact.id,
      organizationId: contact.organizationId,
      name: contact.name,
      phone: contact.phone,
      email: contact.email,
      snapshot,
    });
    console.log("--- deal ---");
    console.log({ dealId, deal });
  }

  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
