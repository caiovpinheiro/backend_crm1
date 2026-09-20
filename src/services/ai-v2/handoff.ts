/**
 * Handoff único da v2.
 * Nenhum domínio de cliente.
 */

import { executeDistribution } from "@/services/distribution";
import type { V2Destination } from "@/lib/ai-v2/types";

export async function simpleHandoff(args: {
  conversationId: string;
  contactId?: string | null;
  dealId?: string | null;
  destination: V2Destination;
}): Promise<void> {
  let departmentId: string | undefined;

  if (args.destination.type === "department") departmentId = args.destination.id;

  await executeDistribution({
    conversationId: args.conversationId,
    contactId: args.contactId ?? null,
    dealId: args.dealId ?? null,
    triggerSource: "AI_AGENT",
    departmentId: departmentId ?? null,
    reassign: true,
    allowOrgWideFallback: false,
  });
}
