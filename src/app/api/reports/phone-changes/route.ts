import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/reports/phone-changes");

/**
 * Relatório de troca de número do cliente (WhatsApp).
 *
 * Origem dos dados: tabela `contact_phone_changes`, populada
 * principalmente pelo webhook Meta quando recebe `system.type =
 * user_changed_number`. Cobre também (no futuro) edições manuais e
 * importações em massa.
 *
 * Querystring:
 *   - `from` (ISO date, opcional): default = início do mês corrente.
 *   - `to`   (ISO date, opcional): default = agora.
 *   - `limit` (número, opcional): tamanho da lista de "recent". Default 25.
 *
 * Retorna:
 *   - `summary`: contagem total + breakdown por origem.
 *   - `daily`: série temporal {date, count} pra plotar gráfico.
 *   - `recent`: últimas N trocas com info do contato (id, nome,
 *     phone atual) e dos números antes/depois.
 */
export async function GET(request: Request) {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ message: "Não autorizado." }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const from = searchParams.get("from");
    const to = searchParams.get("to");
    const limitRaw = searchParams.get("limit");
    const limit = Math.max(1, Math.min(200, Number.parseInt(limitRaw ?? "25", 10) || 25));

    const now = new Date();
    const startDate = from ? new Date(from) : new Date(now.getFullYear(), now.getMonth(), 1);
    const endDate = to ? new Date(to) : now;
    endDate.setHours(23, 59, 59, 999);

    // Total via count separado — evita puxar TODOS os registros só pra
    // contar quando o período é grande (ex.: 1 ano com 50k mudanças).
    const total = await prisma.contactPhoneChange.count({
      where: { createdAt: { gte: startDate, lte: endDate } },
    });

    // Para a série temporal e bySource precisamos das linhas, mas
    // limitamos a um teto razoável (10k mudanças cobrem qualquer
    // relatório real — acima disso a UI deve estreitar o período).
    const MAX_ROWS = 10_000;
    const changes = await prisma.contactPhoneChange.findMany({
      where: { createdAt: { gte: startDate, lte: endDate } },
      orderBy: { createdAt: "desc" },
      take: MAX_ROWS,
      select: {
        id: true,
        contactId: true,
        oldPhone: true,
        newPhone: true,
        source: true,
        rawSystemBody: true,
        createdAt: true,
        contact: {
          select: { id: true, name: true, phone: true, avatarUrl: true },
        },
      },
    });

    const bySource: Record<string, number> = {
      WHATSAPP_SYSTEM: 0,
      MANUAL: 0,
      IMPORT: 0,
    };
    const contactIds = new Set<string>();
    const dailyMap = new Map<string, number>();

    for (const c of changes) {
      bySource[c.source] = (bySource[c.source] ?? 0) + 1;
      contactIds.add(c.contactId);
      const dayKey = c.createdAt.toISOString().slice(0, 10);
      dailyMap.set(dayKey, (dailyMap.get(dayKey) ?? 0) + 1);
    }

    const daily = Array.from(dailyMap.entries())
      .map(([date, count]) => ({ date, count }))
      .sort((a, b) => a.date.localeCompare(b.date));

    const recent = changes.slice(0, limit).map((c) => ({
      id: c.id,
      contactId: c.contactId,
      contactName: c.contact?.name ?? "—",
      contactCurrentPhone: c.contact?.phone ?? null,
      contactAvatarUrl: c.contact?.avatarUrl ?? null,
      oldPhone: c.oldPhone,
      newPhone: c.newPhone,
      source: c.source,
      rawSystemBody: c.rawSystemBody,
      createdAt: c.createdAt.toISOString(),
    }));

    return NextResponse.json({
      period: {
        from: startDate.toISOString(),
        to: endDate.toISOString(),
      },
      summary: {
        total,
        uniqueContacts: contactIds.size,
        bySource,
      },
      daily,
      recent,
    });
  } catch (e) {
    log.error({ err: e }, "[reports/phone-changes] falhou");
    return NextResponse.json(
      { message: e instanceof Error ? e.message : "Erro ao gerar relatório." },
      { status: 500 },
    );
  }
}
