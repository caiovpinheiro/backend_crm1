import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import {
  aggregateMetaPricing,
  getLastPricingSyncAt,
} from "@/services/meta-pricing-sync";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/reports/messaging");

const TEMPLATE_CONTENT_RE =
  /📋 Modelo de mensagem|📞 Pedido de permissão|\[Template:\s*.+\]/i;

const SERVICE_SESSION_MS = 24 * 60 * 60 * 1000;

// Hard cap pra evitar carregar todas as mensagens do tenant em memória
// quando o período de relatório for muito amplo (ex.: pediram 1 ano).
// Em escala isso pode ser milhões de linhas → OOM no Node + lentidão no
// PG. 200k é folgado pra qualquer relatório real (≈6k msg/dia x 30d).
// Acima disso, a UI deve estreitar o filtro ou pedir agregação.
const MAX_MESSAGES = 200_000;

function extractTemplateName(content: string): string | null {
  const m =
    content.match(/(?:Nome|Modelo):\s*(.+)/i) ??
    content.match(/\[Template:\s*(.+?)\]/i);
  return m ? m[1].trim() : null;
}

function extractCategory(content: string): string | null {
  const m = content.match(/Categoria:\s*(.+)/i);
  return m ? m[1].trim().toLowerCase() : null;
}

function classifyCategory(cat: string): "marketing" | "utility" | "auth" | null {
  if (cat === "marketing") return "marketing";
  if (cat === "utility") return "utility";
  if (cat.includes("autentica") || cat === "authentication") return "auth";
  return null;
}

export async function GET(request: Request) {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ message: "Não autorizado." }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const from = searchParams.get("from");
    const to = searchParams.get("to");
    const now = new Date();
    const startDate = from ? new Date(from) : new Date(now.getFullYear(), now.getMonth(), 1);
    const endDate = to ? new Date(to) : now;
    endDate.setHours(23, 59, 59, 999);

    // Filtro "alinhado com Meta Insights" — o relatório tem que reconciliar
    // com o que a Meta cobra e mostra no Business Manager:
    //
    //  1. `isPrivate: false`          → notas internas da inbox nunca
    //                                   passaram pelo WhatsApp.
    //  2. `authorType != "system"`   → eventos sintéticos (protocolo
    //                                   aberto, conversa iniciada, etc.)
    //                                   não existem pra Meta.
    //  3. `sendStatus != "failed"`   → mensagens que falharam no envio
    //                                   nunca chegaram na infra Meta.
    //  4. Conversa em canal Meta Cloud API OU sem canal vinculado:
    //     - channelRef.provider = META_CLOUD_API → cobradas/rastreadas
    //     - channelId = null (conversas legadas antes da feature
    //       Channel) → contadas como fallback conservador pra não
    //       perder histórico em tenants antigos.
    //     - BAILEYS_MD (WhatsApp QR) fica de fora: Meta não vê essas
    //       mensagens porque trafegam pelo protocolo MD (não pela
    //       Cloud API) → explicavam a divergência "CRM conta 7, Meta
    //       Insights mostra 6".
    const messageWhere = {
      createdAt: { gte: startDate, lte: endDate },
      isPrivate: false,
      authorType: { not: "system" as const },
      sendStatus: { not: "failed" },
      conversation: {
        OR: [
          { channelRef: { provider: "META_CLOUD_API" as const } },
          { channelId: null },
        ],
      },
    };

    // Conta primeiro pra detectar excesso e responder com hint pra UI
    // estreitar o período antes de tentar carregar tudo em RAM.
    const totalCount = await prisma.message.count({ where: messageWhere });

    if (totalCount > MAX_MESSAGES) {
      return NextResponse.json(
        {
          message:
            `Período retornaria ${totalCount} mensagens (limite ${MAX_MESSAGES}). ` +
            "Reduza o intervalo de datas para gerar o relatório.",
          totalCount,
          limit: MAX_MESSAGES,
        },
        { status: 413 },
      );
    }

    const messages = await prisma.message.findMany({
      where: messageWhere,
      select: {
        id: true,
        conversationId: true,
        direction: true,
        messageType: true,
        content: true,
        createdAt: true,
      },
      orderBy: { createdAt: "asc" },
      take: MAX_MESSAGES,
    });

    const templateNames = new Set<string>();
    for (const msg of messages) {
      const mt = (msg.messageType ?? "").toLowerCase();
      const content = msg.content ?? "";
      if (mt === "template" || TEMPLATE_CONTENT_RE.test(content)) {
        const name = extractTemplateName(content);
        if (name) templateNames.add(name);
      }
    }

    const categoryLookup = new Map<string, string>();
    if (templateNames.size > 0) {
      try {
        const configs = await prisma.whatsAppTemplateConfig.findMany({
          where: { metaTemplateName: { in: [...templateNames] } },
          select: { metaTemplateName: true, category: true },
        });
        for (const c of configs) {
          if (c.category) categoryLookup.set(c.metaTemplateName, c.category.toLowerCase());
        }
      } catch {}
    }

    // Build a map of the last inbound message time per conversation
    // to determine if a service session was open when a template was sent.
    // WhatsApp: service session = 24h window from customer's last message.
    const lastInboundByConv = new Map<string, number>();
    for (const msg of messages) {
      if (msg.direction === "in" && msg.conversationId) {
        lastInboundByConv.set(msg.conversationId, msg.createdAt.getTime());
      }
    }

    // Also check inbound messages from the 24h before the report period
    // (a session opened just before the period could still be active)
    const prePeriodStart = new Date(startDate.getTime() - SERVICE_SESSION_MS);
    const prePeriodInbound = await prisma.message.findMany({
      where: {
        ...messageWhere,
        createdAt: { gte: prePeriodStart, lt: startDate },
        direction: "in",
      },
      select: { conversationId: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    });
    const preInboundByConv = new Map<string, number>();
    for (const msg of prePeriodInbound) {
      if (msg.conversationId) {
        preInboundByConv.set(msg.conversationId, msg.createdAt.getTime());
      }
    }

    let serviceInbound = 0;
    let serviceOutbound = 0;
    let templateMarketing = 0;
    let templateUtility = 0;
    let templateUtilityFree = 0;
    let templateAuth = 0;
    let templateOther = 0;
    let flowMessages = 0;
    const totalMessages = messages.length;

    const dailyMap = new Map<string, {
      date: string;
      inbound: number;
      outbound: number;
      marketing: number;
      utility: number;
      utilityFree: number;
      auth: number;
      flow: number;
    }>();

    // Track running last-inbound times as we iterate chronologically
    const runningInbound = new Map<string, number>();
    // Seed with pre-period inbound
    for (const [convId, ts] of preInboundByConv) {
      runningInbound.set(convId, ts);
    }

    for (const msg of messages) {
      const dayKey = msg.createdAt.toISOString().slice(0, 10);
      if (!dailyMap.has(dayKey)) {
        dailyMap.set(dayKey, { date: dayKey, inbound: 0, outbound: 0, marketing: 0, utility: 0, utilityFree: 0, auth: 0, flow: 0 });
      }
      const day = dailyMap.get(dayKey)!;

      // Update running inbound tracker
      if (msg.direction === "in" && msg.conversationId) {
        runningInbound.set(msg.conversationId, msg.createdAt.getTime());
      }

      const mt = (msg.messageType ?? "text").toLowerCase();
      const content = msg.content ?? "";
      const isTemplate = mt === "template" || TEMPLATE_CONTENT_RE.test(content);

      if (isTemplate) {
        let cat = extractCategory(content);
        if (!cat) {
          const name = extractTemplateName(content);
          if (name) cat = categoryLookup.get(name) ?? null;
        }

        const bucket = cat ? classifyCategory(cat) : null;

        // Check if service session is open for this conversation
        const convId = msg.conversationId;
        const lastIn = convId ? runningInbound.get(convId) : undefined;
        const serviceSessionOpen = lastIn !== undefined &&
          (msg.createdAt.getTime() - lastIn) < SERVICE_SESSION_MS;

        if (bucket === "marketing") {
          // Marketing always opens a new conversation (charged)
          templateMarketing++;
          day.marketing++;
        } else if (bucket === "utility" || bucket === null) {
          if (serviceSessionOpen) {
            // Utility within open service session = free
            templateUtilityFree++;
            day.utilityFree++;
          } else {
            // Utility without service session = new conversation (charged)
            if (bucket === "utility") {
              templateUtility++;
              day.utility++;
            } else {
              templateOther++;
              day.utility++;
            }
          }
        } else if (bucket === "auth") {
          templateAuth++;
          day.auth++;
        }
      } else if (mt === "interactive" && /fluxo|flow/i.test(content)) {
        flowMessages++;
        day.flow++;
      } else if (msg.direction === "in") {
        serviceInbound++;
        day.inbound++;
      } else if (msg.direction === "out") {
        serviceOutbound++;
        day.outbound++;
      }
    }

    const daily = Array.from(dailyMap.values()).sort((a, b) => a.date.localeCompare(b.date));

    // ── Custo OFICIAL da Meta (cache MetaPricingDailyMetric) ──────
    // Roda em paralelo pra nao penalizar o tempo de resposta. Se o
    // tenant ainda nao sincronizou, a tabela vem vazia e o frontend
    // mostra estado "sincronizar agora".
    const [metaAgg, lastSyncAt] = await Promise.all([
      aggregateMetaPricing({ from: startDate, to: endDate }),
      getLastPricingSyncAt(),
    ]);

    return NextResponse.json({
      period: {
        from: startDate.toISOString(),
        to: endDate.toISOString(),
      },
      summary: {
        totalMessages,
        serviceInbound,
        serviceOutbound,
        templateMarketing,
        templateUtility,
        templateUtilityFree,
        templateAuth,
        templateOther,
        flowMessages,
      },
      daily,
      meta: {
        lastSyncAt: lastSyncAt ? lastSyncAt.toISOString() : null,
        totalCostUsd: metaAgg.totalCostUsd,
        totalVolume: metaAgg.totalVolume,
        byCategory: metaAgg.byCategory,
        byPricingType: metaAgg.byPricingType,
      },
    });
  } catch (e) {
    log.error({ err: e }, "[reports/messaging] falhou");
    return NextResponse.json(
      { message: e instanceof Error ? e.message : "Erro ao gerar relatório." },
      { status: 500 },
    );
  }
}
