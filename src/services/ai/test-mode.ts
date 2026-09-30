/**
 * Operador autorizado a testar o agente pelo WhatsApp (`#reset`).
 *
 * O comando só existe para telefone de usuário DA MESMA organização com
 * permissão `ai_agent:edit`. Para qualquer outro telefone o texto é uma
 * mensagem comum e segue para o agente — nunca respondemos "comando não
 * autorizado", porque isso revelaria que o comando existe.
 *
 * Não há lista solta em env: a autorização é derivada dos usuários da org
 * (`User.phone`) mais a permission.
 */

import { checkPermission } from "@/lib/authz";
import { phoneMatchVariants } from "@/lib/phone";
import { prisma } from "@/lib/prisma";
import { getOrgIdOrNull } from "@/lib/request-context";
import { normalizePhoneDigits } from "@/services/ai/phone-allowlist";

/** Permission que autoriza testar o agente. Quem edita o agente pode testá-lo. */
export const TEST_MODE_PERMISSION = "ai_agent:edit" as const;

export type TestModeOperator = { userId: string; name: string };

/**
 * Usuário da organização corrente cujo telefone cadastrado é o telefone deste
 * contato E que tem permissão de editar agente.
 *
 * `null` = ninguém. O chamador trata a mensagem como texto comum; NÃO
 * responde nada sobre comando.
 *
 * A busca é sempre dentro da org do contexto (`prisma` scoped + filtro
 * explícito), então o telefone de um operador da org A nunca vale numa
 * conversa da org B mesmo que o mesmo número exista nas duas.
 */
export async function resolveTestModeOperator(
  contactId: string,
): Promise<TestModeOperator | null> {
  const orgId = getOrgIdOrNull();
  if (!orgId) return null;

  const contact = await prisma.contact.findUnique({
    where: { id: contactId },
    select: { phone: true, whatsappJid: true, whatsappUsername: true },
  });
  if (!contact) return null;

  const candidates = new Set(
    [
      contact.phone,
      contact.whatsappJid?.split("@")[0] ?? null,
      contact.whatsappUsername,
    ]
      .map((c) => normalizePhoneDigits(c))
      .filter((d) => d.length >= 10),
  );
  if (candidates.size === 0) return null;

  // Operadores da org com telefone cadastrado. A lista é pequena (equipe), e
  // comparar em memória evita depender do formato exato gravado no perfil —
  // "(35) 99982-1871" e "5535999821871" precisam casar.
  const users = await prisma.user.findMany({
    where: {
      organizationId: orgId,
      type: "HUMAN",
      phone: { not: null },
    },
    select: { id: true, name: true, phone: true },
  });

  for (const user of users) {
    const variants = new Set(
      [
        normalizePhoneDigits(user.phone),
        ...phoneMatchVariants(user.phone).map((v) => normalizePhoneDigits(v)),
      ].filter(Boolean),
    );
    const matched = [...candidates].some((c) => variants.has(c));
    if (!matched) continue;

    const allowed = await checkPermission(
      { userId: user.id, organizationId: orgId, isSuperAdmin: false },
      TEST_MODE_PERMISSION,
    );
    if (!allowed) continue;
    return { userId: user.id, name: user.name };
  }

  return null;
}
