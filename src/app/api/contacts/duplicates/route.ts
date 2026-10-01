import { NextResponse } from "next/server";

import { authenticateApiRequest, runWithApiUserContext } from "@/lib/api-auth";
import { prisma } from "@/lib/prisma";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/contacts/duplicates");

/**
 * GET /api/contacts/duplicates
 *
 * Retorna grupos de contatos potencialmente duplicados, agrupados por
 * telefone ou e-mail (campos não nulos/não vazios).
 *
 * Estratégia:
 *   1. Agrupa por `phone` onde há 2+ contatos — suspeitos de duplicata.
 *   2. Agrupa por `email` onde há 2+ contatos.
 *   3. Mescla os grupos (um contato pode aparecer em mais de um grupo).
 *
 * Resposta:
 *   { groups: DuplicateGroup[] }
 *
 * DuplicateGroup:
 *   { key: string; field: "phone" | "email"; contacts: ContactSnap[] }
 *
 * ContactSnap: { id, name, email, phone, createdAt, updatedAt,
 *               company: { name } | null, assignedTo: { name } | null }
 *
 * Acesso: qualquer usuário autenticado pode ver; o merge em si exige ADMIN.
 */

const MAX_GROUPS = 200;

export async function GET(request: Request) {
  try {
    const authResult = await authenticateApiRequest(request);
    if (!authResult.ok) return authResult.response;

    return await runWithApiUserContext(authResult.user, async () => {
      // 1) IDs agrupados por phone
      const byPhone = await prisma.contact.groupBy({
        by: ["phone"],
        where: { phone: { not: null, notIn: [""] } },
        having: { phone: { _count: { gte: 2 } } },
        _count: { phone: true },
        take: MAX_GROUPS,
        orderBy: { _count: { phone: "desc" } },
      });

      // 2) IDs agrupados por email
      const byEmail = await prisma.contact.groupBy({
        by: ["email"],
        where: { email: { not: null, notIn: [""] } },
        having: { email: { _count: { gte: 2 } } },
        _count: { email: true },
        take: MAX_GROUPS,
        orderBy: { _count: { email: "desc" } },
      });

      const phoneValues = byPhone.map((r) => r.phone as string);
      const emailValues = byEmail.map((r) => r.email as string);

      // 3) Buscar snapshots dos contatos envolvidos
      const contacts = await prisma.contact.findMany({
        where: {
          OR: [
            ...(phoneValues.length > 0 ? [{ phone: { in: phoneValues } }] : []),
            ...(emailValues.length > 0 ? [{ email: { in: emailValues } }] : []),
          ],
        },
        select: {
          id: true,
          name: true,
          email: true,
          phone: true,
          avatarUrl: true,
          createdAt: true,
          updatedAt: true,
          company: { select: { id: true, name: true } },
          assignedTo: { select: { id: true, name: true } },
        },
        orderBy: { createdAt: "asc" },
      });

      // 4) Montar grupos — deduplicar por (field, key)
      type ContactSnap = (typeof contacts)[number];
      type Group = { key: string; field: "phone" | "email"; contacts: ContactSnap[] };
      const groups: Group[] = [];
      const seen = new Set<string>(); // "field:key"

      for (const phone of phoneValues) {
        const sig = `phone:${phone}`;
        if (seen.has(sig)) continue;
        seen.add(sig);
        groups.push({
          key: phone,
          field: "phone",
          contacts: contacts.filter((c) => c.phone === phone),
        });
      }

      for (const email of emailValues) {
        const sig = `email:${email}`;
        if (seen.has(sig)) continue;
        seen.add(sig);
        const grpContacts = contacts.filter((c) => c.email === email);
        // Evitar duplicar grupo se todos os contatos já estão num grupo de phone
        groups.push({ key: email, field: "email", contacts: grpContacts });
      }

      return NextResponse.json({ groups });
    });
  } catch (e) {
    log.error({ err: e }, "GET falhou");
    return NextResponse.json(
      { message: "Erro ao localizar duplicatas." },
      { status: 500 },
    );
  }
}
