import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { resolveAutomationExecution } from "@/lib/background-mode";
import { prisma } from "@/lib/prisma";
import { metaWhatsApp } from "@/lib/meta-whatsapp/client";

export async function GET() {
  return withOrgContext(async (session) => {
    try {
      const role = (session.user as { role?: string }).role;
      if (role !== "ADMIN") {
        return NextResponse.json({ message: "Apenas admin." }, { status: 403 });
      }

      const [allAutomations, recentLogs, logCountByStatus, totalContacts] = await Promise.all([
        prisma.automation.findMany({
          include: {
            steps: { orderBy: { position: "asc" }, select: { id: true, type: true, config: true, position: true } },
          },
          orderBy: { updatedAt: "desc" },
        }),
        prisma.automationLog.findMany({
          orderBy: { executedAt: "desc" },
          take: 50,
          select: { id: true, automationId: true, contactId: true, status: true, message: true, executedAt: true },
        }),
        prisma.automationLog.groupBy({
          by: ["status"],
          _count: true,
          where: { executedAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) } },
        }),
        prisma.contact.count(),
      ]);

      const summary = {
        totalAutomations: allAutomations.length,
        activeAutomations: allAutomations.filter((a) => a.active).length,
        inactiveAutomations: allAutomations.filter((a) => !a.active).length,
        byTriggerType: Object.fromEntries(
          Array.from(
            allAutomations.reduce((m, a) => {
              const key = a.triggerType;
              if (!m.has(key)) m.set(key, { total: 0, active: 0 });
              const e = m.get(key)!;
              e.total++;
              if (a.active) e.active++;
              return m;
            }, new Map<string, { total: number; active: number }>())
          )
        ),
        logsLast7Days: Object.fromEntries(logCountByStatus.map((r) => [r.status, r._count])),
        totalContacts,
      };

      const env = {
        META_WHATSAPP_ACCESS_TOKEN: process.env.META_WHATSAPP_ACCESS_TOKEN ? `set (${process.env.META_WHATSAPP_ACCESS_TOKEN.length} chars)` : "NOT SET ⚠️",
        META_WHATSAPP_PHONE_NUMBER_ID: process.env.META_WHATSAPP_PHONE_NUMBER_ID || "NOT SET ⚠️",
        META_WHATSAPP_BUSINESS_ACCOUNT_ID: process.env.META_WHATSAPP_BUSINESS_ACCOUNT_ID || "NOT SET ⚠️",
        META_APP_SECRET: process.env.META_APP_SECRET ? "set" : "NOT SET",
        META_WEBHOOK_VERIFY_TOKEN: process.env.META_WEBHOOK_VERIFY_TOKEN ? "set" : "NOT SET",
        AUTOMATION_WORKER_MODE: process.env.AUTOMATION_WORKER_MODE || `(not set → ${resolveAutomationExecution().mode})`,
        REDIS_URL: process.env.REDIS_URL ? "set" : "NOT SET (inline execution will be used)",
        NODE_ENV: process.env.NODE_ENV ?? "unknown",
        metaWhatsAppConfigured: metaWhatsApp.configured,
      };

      const issues: string[] = [];
      if (!metaWhatsApp.configured) {
        issues.push("Meta WhatsApp API NÃO está configurada. Passos send_whatsapp_message/template/question não conseguem enviar mensagens.");
      }
      if (!process.env.META_WHATSAPP_ACCESS_TOKEN) {
        issues.push("META_WHATSAPP_ACCESS_TOKEN não definido.");
      }
      if (!process.env.META_WHATSAPP_PHONE_NUMBER_ID) {
        issues.push("META_WHATSAPP_PHONE_NUMBER_ID não definido.");
      }
      const activeMessageReceived = allAutomations.filter((a) => a.active && a.triggerType === "message_received");
      if (activeMessageReceived.length === 0) {
        issues.push("Nenhuma automação ativa com trigger 'message_received'. Mensagens recebidas não dispararão automações.");
      }
      for (const a of allAutomations.filter((a) => a.active)) {
        const whatsappSteps = a.steps.filter((s) => ["send_whatsapp_message", "send_whatsapp_template", "question"].includes(s.type));
        for (const s of whatsappSteps) {
          const cfg = s.config as Record<string, unknown> | null;
          if (s.type === "send_whatsapp_message" && (!cfg?.content || String(cfg.content).trim() === "")) {
            issues.push(`Automação "${a.name}" (${a.id}): passo send_whatsapp_message na posição ${s.position} tem content vazio.`);
          }
        }
      }

      return NextResponse.json({
        timestamp: new Date().toISOString(),
        summary,
        issues: issues.length > 0 ? issues : ["Nenhum problema detectado."],
        automations: allAutomations.map((a) => ({
          id: a.id,
          name: a.name,
          triggerType: a.triggerType,
          triggerConfig: a.triggerConfig,
          active: a.active,
          stepsCount: a.steps.length,
          steps: a.steps.map((s) => ({
            id: s.id,
            type: s.type,
            position: s.position,
            configPreview: JSON.stringify(s.config).slice(0, 200),
          })),
          updatedAt: a.updatedAt,
        })),
        recentLogs,
        env,
      });
    } catch (e) {
      return NextResponse.json({ message: e instanceof Error ? e.message : "Erro.", stack: e instanceof Error ? e.stack : undefined }, { status: 500 });
    }
  });
}

export async function POST(request: Request) {
  return withOrgContext(async (session) => {
    try {
      const role = (session.user as { role?: string }).role;
      if (role !== "ADMIN") {
        return NextResponse.json({ message: "Apenas admin." }, { status: 403 });
      }

      const body = (await request.json()) as { automationId?: string; contactId?: string };
      if (!body.automationId || !body.contactId) {
        return NextResponse.json({ message: "automationId e contactId obrigatórios." }, { status: 400 });
      }

      const automation = await prisma.automation.findUnique({
        where: { id: body.automationId },
        include: { steps: { orderBy: { position: "asc" } } },
      });
      if (!automation) {
        return NextResponse.json({ message: "Automação não encontrada.", automationId: body.automationId }, { status: 404 });
      }

      const contact = await prisma.contact.findUnique({
        where: { id: body.contactId },
        select: { id: true, name: true, phone: true, whatsappBsuid: true },
      });
      if (!contact) {
        return NextResponse.json({ message: "Contato não encontrado.", contactId: body.contactId }, { status: 404 });
      }

      const results: { step: string; status: string; detail: string }[] = [];

      try {
        const { runAutomationInline } = await import("@/services/automation-executor");
        await runAutomationInline({
          automationId: automation.id,
          context: { contactId: contact.id, event: "message_received", data: { channel: "WhatsApp", content: "[diagnóstico manual]" } },
        });
        results.push({ step: "runAutomationInline", status: "OK", detail: "Executado com sucesso" });
      } catch (err) {
        results.push({ step: "runAutomationInline", status: "ERROR", detail: err instanceof Error ? err.message : String(err) });
      }

      const logs = await prisma.automationLog.findMany({
        where: { automationId: automation.id },
        orderBy: { executedAt: "desc" },
        take: 10,
      });

      return NextResponse.json({
        automation: { id: automation.id, name: automation.name, active: automation.active, stepsCount: automation.steps.length },
        contact: { id: contact.id, name: contact.name, phone: contact.phone, whatsappBsuid: contact.whatsappBsuid },
        metaWhatsAppConfigured: metaWhatsApp.configured,
        results,
        recentLogs: logs,
      });
    } catch (e) {
      return NextResponse.json({ message: e instanceof Error ? e.message : "Erro." }, { status: 500 });
    }
  });
}
