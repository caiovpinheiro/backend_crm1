/**
 * Dump de auditoria (somente leitura) dos agentes da org Cruzeiro EAD.
 * Uso: npx tsx scripts/audit-cruzeiro-agents.ts
 */
import { config as loadEnv } from "dotenv";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { PrismaClient } from "@prisma/client";

loadEnv({ path: resolve(process.cwd(), ".env.local") });
loadEnv({ path: resolve(process.cwd(), ".env") });

const OUT = join(process.cwd(), "baseline", "cruzeiro-audit.json");

function clip(s: string | null | undefined, n = 400) {
  if (!s) return s ?? null;
  return s.length <= n ? s : s.slice(0, n) + `…[+${s.length - n}c]`;
}

async function main() {
  const prisma = new PrismaClient();
  try {
    const orgs = await prisma.organization.findMany({
      where: {
        OR: [
          { slug: { contains: "cruzeiro", mode: "insensitive" } },
          { name: { contains: "cruzeiro", mode: "insensitive" } },
        ],
      },
      select: { id: true, name: true, slug: true, status: true },
    });

    const result: Record<string, unknown> = { orgs };

    for (const org of orgs) {
      const orgId = org.id;
      const agents = await prisma.aIAgentConfig.findMany({
        where: { organizationId: orgId },
        include: {
          user: { select: { id: true, name: true, email: true, type: true } },
        },
        orderBy: { createdAt: "asc" },
      });

      const knowledge = await prisma.aIAgentKnowledgeDoc.findMany({
        where: { organizationId: orgId },
        select: {
          id: true,
          agentId: true,
          title: true,
          status: true,
          chunkCount: true,
          sizeBytes: true,
          validFrom: true,
          validUntil: true,
          expiredBehavior: true,
          source: true,
          updatedAt: true,
        },
        orderBy: { title: "asc" },
      });

      const depts = await prisma.department.findMany({
        where: { organizationId: orgId },
        select: {
          id: true,
          name: true,
          distributionEnabled: true,
          _count: { select: { members: true } },
        },
        orderBy: { name: "asc" },
      });

      const autos = await prisma.automation.findMany({
        where: { organizationId: orgId },
        select: {
          id: true,
          number: true,
          name: true,
          active: true,
          triggerType: true,
          triggerConfig: true,
          steps: {
            select: { id: true, type: true, config: true, position: true },
            orderBy: { position: "asc" },
          },
        },
        orderBy: { number: "asc" },
      });

      const aiAutos = autos.filter((a) =>
        a.steps.some(
          (s) =>
            s.type === "transfer_to_ai_agent" ||
            s.type === "ask_ai_agent" ||
            JSON.stringify(s.config).includes("ai") ||
            JSON.stringify(a.triggerConfig).toLowerCase().includes("ai"),
        ),
      );

      const since = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);
      const runAgg = await prisma.aIAgentRun.groupBy({
        by: ["agentId", "source"],
        where: { organizationId: orgId, createdAt: { gte: since } },
        _count: { _all: true },
        _sum: { inputTokens: true, outputTokens: true },
      });

      const assignedNow = await prisma.conversation.groupBy({
        by: ["assignedToId"],
        where: {
          organizationId: orgId,
          status: "OPEN",
          assignedToId: { in: agents.map((a) => a.userId) },
        },
        _count: { _all: true },
      });

      const settings = await prisma.organizationSetting.findMany({
        where: {
          organizationId: orgId,
          key: { contains: "ai", mode: "insensitive" },
        },
        select: { key: true, value: true },
      });

      result[org.slug || org.id] = {
        org,
        settings,
        departments: depts,
        openConversationsByAiUser: assignedNow,
        runsLast14d: runAgg,
        agents: agents.map((a) => ({
          id: a.id,
          userId: a.userId,
          name: a.user.name,
          email: a.user.email,
          active: a.active,
          archetype: a.archetype,
          verticalPack: a.verticalPack,
          model: a.model,
          temperature: a.temperature,
          maxTokens: a.maxTokens,
          autonomyMode: a.autonomyMode,
          enabledTools: a.enabledTools,
          dailyTokenCap: a.dailyTokenCap,
          maxSteps: a.maxSteps,
          maxToolCallsPerRun: a.maxToolCallsPerRun,
          maxRepeatsPerTool: a.maxRepeatsPerTool,
          pipelineId: a.pipelineId,
          channelId: a.channelId,
          openingMessage: clip(a.openingMessage, 200),
          openingDelayMs: a.openingDelayMs,
          inactivityTimerMs: a.inactivityTimerMs,
          inactivityHandoffMode: a.inactivityHandoffMode,
          keywordHandoffs: a.keywordHandoffs,
          qualificationQuestions: a.qualificationQuestions,
          businessHours: a.businessHours,
          outputStyle: a.outputStyle,
          autoClosePolicy: a.autoClosePolicy,
          toolConfig: a.toolConfig,
          inboxPolicy: a.inboxPolicy,
          hasOverride: Boolean(a.systemPromptOverride?.trim()),
          overrideLen: a.systemPromptOverride?.length ?? 0,
          templateLen: a.systemPromptTemplate?.length ?? 0,
          steeringLen: a.steeringRules?.length ?? 0,
          productPolicyLen: a.productPolicy?.length ?? 0,
          overridePreview: clip(a.systemPromptOverride, 600),
          steeringPreview: clip(a.steeringRules, 600),
          templatePreview: clip(a.systemPromptTemplate, 400),
          knowledge: knowledge.filter((k) => k.agentId === a.id),
        })),
        automationsTouchingAi: aiAutos.map((a) => ({
          number: a.number,
          name: a.name,
          active: a.active,
          triggerType: a.triggerType,
          triggerConfig: a.triggerConfig,
          steps: a.steps.map((s) => ({
            position: s.position,
            type: s.type,
            config: s.config,
          })),
        })),
        automationCount: autos.length,
        activeAutomationCount: autos.filter((a) => a.active).length,
      };
    }

    mkdirSync(join(process.cwd(), "baseline"), { recursive: true });
    writeFileSync(OUT, JSON.stringify(result, null, 2), "utf8");
    console.log(`wrote ${OUT} orgs=${orgs.length}`);
    for (const o of orgs) {
      console.log(`- ${o.slug} ${o.name} ${o.id}`);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
