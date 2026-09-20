/**
 * Inventário read-only de agentes de IA de uma organização.
 *
 * Uso:
 *   npx tsx scripts/inventory-org-agents.ts "Nome da Org"|"organizationId"
 *
 * Exporta para docs/inventory/<slug>/agents.json e knowledge/<agent>/<doc>.txt.
 * Não altera nenhum dado. Dados sensíveis (chaves, e-mails, telefones) são omitidos.
 */

import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";

async function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    return await new Promise((resolve) => {
      rl.question(question, (answer) => resolve(answer.trim()));
    });
  } finally {
    rl.close();
  }
}

function slugify(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function sanitizeFileName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .slice(0, 80);
}

function stripSensitive(raw: unknown): unknown {
  if (raw == null) return raw;
  if (typeof raw !== "object") return raw;
  const obj = { ...(raw as Record<string, unknown>) };
  for (const key of Object.keys(obj)) {
    const lower = key.toLowerCase();
    if (
      lower.includes("email") ||
      lower.includes("phone") ||
      lower.includes("cpf") ||
      lower.includes("rgm") ||
      lower.includes("apikey") ||
      lower.includes("secret") ||
      lower.includes("password") ||
      lower.includes("token") ||
      lower.includes("address")
    ) {
      obj[key] = "<redacted>";
    }
  }
  return obj;
}

async function main() {
  const input = process.argv[2]?.trim();
  if (!input) {
    console.error(
      "Uso: npx tsx scripts/inventory-org-agents.ts \"Nome da Org\"|\"organizationId\"",
    );
    process.exit(1);
  }

  const { prismaBase } = await import("../src/lib/prisma-base");
  const { renderSystemPrompt, composeRuntimeOverride } = await import(
    "../src/lib/ai-agents/system-prompt"
  );
  const { getVerticalPack } = await import("../src/verticals");
  const { normalizeInboxPolicy } = await import("../src/lib/ai-agents/steering");
  const { normalizeAutoClosePolicy, normalizeQualificationQuestions, normalizeOutputStyle } =
    await import("../src/lib/ai-agents/piloting");

  let orgs: Array<{ id: string; name: string; createdAt: Date }> = [];

  if (/^[a-zA-Z0-9_-]+$/.test(input)) {
    const byId = await prismaBase.organization.findUnique({
      where: { id: input },
      select: { id: true, name: true, createdAt: true },
    });
    if (byId) orgs.push(byId);
  }

  if (orgs.length === 0) {
    orgs = await prismaBase.organization.findMany({
      where: {
        name: { contains: input, mode: "insensitive" },
      },
      orderBy: { name: "asc" },
      take: 20,
      select: { id: true, name: true, createdAt: true },
    });
  }

  if (orgs.length === 0) {
    console.error(`Nenhuma organização encontrada para: ${input}`);
    process.exit(1);
  }

  let selected = orgs[0];
  if (orgs.length > 1) {
    console.log("\nMais de uma organização encontrada:");
    for (let i = 0; i < orgs.length; i++) {
      console.log(`${i + 1}. ${orgs[i].name} (${orgs[i].id})`);
    }
    const choice = await prompt("Escolha o número (ou ENTER para 1): ");
    const idx = choice ? Number(choice) - 1 : 0;
    if (Number.isNaN(idx) || idx < 0 || idx >= orgs.length) {
      console.error("Opção inválida.");
      process.exit(1);
    }
    selected = orgs[idx];
  }

  const confirmed = await prompt(
    `\nExportar inventário de ${selected.name} (${selected.id})? (s/N) `,
  );
  if (confirmed.toLowerCase() !== "s") {
    console.log("Cancelado.");
    process.exit(0);
  }

  const rootDir = path.resolve(process.cwd(), "docs", "inventory", slugify(selected.name));
  if (existsSync(rootDir)) {
    const clean = await prompt(
      `Pasta ${rootDir} já existe. Sobrescrever? (s/N) `,
    );
    if (clean.toLowerCase() !== "s") {
      console.log("Cancelado.");
      process.exit(0);
    }
    rmSync(rootDir, { recursive: true, force: true });
  }
  const knowledgeDir = path.join(rootDir, "knowledge");
  mkdirSync(knowledgeDir, { recursive: true });

  const orgId = selected.id;

  const [departments, pipelines, customFields, tabulationsRaw, messageTemplates, whatsAppTemplates] =
    await Promise.all([
      prismaBase.department.findMany({
        where: { organizationId: orgId },
        orderBy: { name: "asc" },
        select: {
          id: true,
          number: true,
          name: true,
          color: true,
          icon: true,
          distributionEnabled: true,
          requireTabulationOnClose: true,
          autoCloseTabulationId: true,
          createdAt: true,
          updatedAt: true,
          _count: { select: { members: true } },
        },
      }),
      prismaBase.pipeline.findMany({
        where: { organizationId: orgId },
        orderBy: { name: "asc" },
        select: {
          id: true,
          number: true,
          name: true,
          slug: true,
          isDefault: true,
          lossReasonRequired: true,
          stages: {
            orderBy: { position: "asc" },
            select: {
              id: true,
              number: true,
              name: true,
              position: true,
              color: true,
              isIncoming: true,
              isWon: true,
              isLost: true,
            },
          },
        },
      }),
      prismaBase.customField.findMany({
        where: { organizationId: orgId },
        orderBy: { entity: "asc" },
        select: {
          id: true,
          number: true,
          name: true,
          label: true,
          type: true,
          options: true,
          required: true,
          entity: true,
          showInInboxLeadPanel: true,
          showInDealPanel: true,
          inboxLeadPanelOrder: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      prismaBase.tabulation.findMany({
        where: { organizationId: orgId },
        orderBy: [{ departmentId: "asc" }, { parentId: "asc" }, { position: "asc" }],
        select: {
          id: true,
          number: true,
          name: true,
          color: true,
          position: true,
          active: true,
          parentId: true,
          departmentId: true,
        },
      }),
      prismaBase.messageTemplate.findMany({
        where: { organizationId: orgId },
        orderBy: { name: "asc" },
        select: {
          id: true,
          number: true,
          name: true,
          content: true,
          category: true,
          language: true,
          status: true,
          channelType: true,
          mediaUrl: true,
          mediaType: true,
          mediaName: true,
          attachments: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      prismaBase.whatsAppTemplateConfig.findMany({
        where: { organizationId: orgId },
        orderBy: { metaTemplateName: "asc" },
        select: {
          id: true,
          metaTemplateId: true,
          metaTemplateName: true,
          label: true,
          agentEnabled: true,
          language: true,
          category: true,
          bodyPreview: true,
          hasButtons: true,
          buttonTypes: true,
          hasVariables: true,
          flowAction: true,
          flowId: true,
          operatorVariables: true,
          hiddenAt: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
    ]);

  // Árvore de tabulações por departamento
  const tabulationsByDept = new Map<string, typeof tabulationsRaw>();
  for (const t of tabulationsRaw) {
    const list = tabulationsByDept.get(t.departmentId) ?? [];
    list.push(t);
    tabulationsByDept.set(t.departmentId, list);
  }
  function buildTree(deptId: string, parentId: string | null): unknown[] {
    const nodes = (tabulationsByDept.get(deptId) ?? []).filter(
      (t) => t.parentId === parentId,
    );
    return nodes.map((t) => ({
      id: t.id,
      number: t.number,
      name: t.name,
      color: t.color,
      position: t.position,
      active: t.active,
      children: buildTree(deptId, t.id),
    }));
  }

  const agentsRaw = await prismaBase.aIAgentConfig.findMany({
    where: { organizationId: orgId },
    include: {
      user: { select: { id: true, name: true, email: true, type: true, active: true } },
      knowledgeDocs: {
        select: {
          id: true,
          title: true,
          source: true,
          mimeType: true,
          sizeBytes: true,
          content: true,
          createdAt: true,
          updatedAt: true,
        },
        orderBy: { title: "asc" },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  const since30d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

  const agents = await Promise.all(
    agentsRaw.map(async (agent) => {
      const pack = getVerticalPack(agent.verticalPack);
      const inboxPolicy = normalizeInboxPolicy(agent.inboxPolicy, agent.verticalPack);
      const autoClose = normalizeAutoClosePolicy(agent.autoClosePolicy);
      const qualificationQuestions = normalizeQualificationQuestions(
        agent.qualificationQuestions as unknown as Record<string, unknown>[],
      );
      const outputStyle = normalizeOutputStyle(agent.outputStyle);

      // Blocos de prompt do vertical pack, se houver
      const blocks: string[] = [];
      try {
        const packBlocks =
          pack?.promptBlocks({
            archetype: agent.archetype,
            userMessage: "",
            recentContext: "",
          }) ?? [];
        blocks.push(...packBlocks);
      } catch {
        // ignore
      }

      const override = composeRuntimeOverride({
        savedOverride: agent.systemPromptOverride,
        steeringRules: agent.steeringRules,
        blocks,
      });

      const finalPrompt = renderSystemPrompt({
        template: agent.systemPromptTemplate,
        override,
        productPolicy: agent.productPolicy,
        archetype: agent.archetype,
        hasProductSearch: agent.enabledTools.includes("search_products"),
        hasCrmFieldSearch: agent.enabledTools.includes("search_crm_records"),
        tone: agent.tone,
        language: agent.language,
        autonomyMode: agent.autonomyMode,
        contact: null,
        deal: null,
        retrievalBlock: "",
        qualificationQuestions,
        outputStyle,
      });

      // Estatísticas dos últimos 30 dias
      const runs = await prismaBase.aIAgentRun.groupBy({
        by: ["status"],
        where: { organizationId: orgId, agentId: agent.id, createdAt: { gte: since30d } },
        _count: { status: true },
        _sum: { inputTokens: true, outputTokens: true, costUsd: true },
        _avg: { confidence: true },
      });
      const stats = {
        runs: runs.reduce((acc, r) => acc + r._count.status, 0),
        byStatus: Object.fromEntries(runs.map((r) => [r.status, r._count.status])),
        handoffs: runs
          .filter((r) => r.status === "HANDOFF")
          .reduce((acc, r) => acc + r._count.status, 0),
        inputTokens: runs.reduce((acc, r) => acc + (r._sum.inputTokens ?? 0), 0),
        outputTokens: runs.reduce((acc, r) => acc + (r._sum.outputTokens ?? 0), 0),
        costUsd: runs.reduce((acc, r) => acc + (r._sum.costUsd ?? 0), 0),
        avgConfidence: runs.length
          ? runs.reduce((acc, r) => acc + (r._avg.confidence ?? 0), 0) / runs.length
          : null,
      };

      // Documentos de conhecimento
      const knowledgeDocs = agent.knowledgeDocs.map((doc) => {
        const folder = sanitizeFileName(`${agent.user?.name ?? "agent"}-${agent.id.slice(0, 8)}`);
        const fileName = `${sanitizeFileName(doc.title || "doc")}-${doc.id.slice(0, 8)}.txt`;
        const docDir = path.join(knowledgeDir, folder);
        mkdirSync(docDir, { recursive: true });
        writeFileSync(
          path.join(docDir, fileName),
          doc.content ?? "<conteúdo indisponível — reconstruir a partir dos chunks>",
          "utf-8",
        );
        return {
          id: doc.id,
          title: doc.title,
          source: doc.source,
          mimeType: doc.mimeType,
          sizeBytes: doc.sizeBytes,
          filePath: path.relative(rootDir, path.join(docDir, fileName)),
          createdAt: doc.createdAt,
          updatedAt: doc.updatedAt,
        };
      });

      return {
        id: agent.id,
        userId: agent.userId,
        agentName: agent.user?.name ?? null,
        agentEmail: "<redacted>",
        active: agent.active,
        userActive: agent.user?.active ?? null,
        archetype: agent.archetype,
        templateId: agent.templateId,
        engine: agent.engine,
        verticalPack: agent.verticalPack,
        model: agent.model,
        temperature: agent.temperature,
        responseBehavior: agent.responseBehavior,
        maxTokens: agent.maxTokens,
        tone: agent.tone,
        language: agent.language,
        autonomyMode: agent.autonomyMode,
        outputStyle: agent.outputStyle,
        simulateTyping: agent.simulateTyping,
        typingPerCharMs: agent.typingPerCharMs,
        markMessagesRead: agent.markMessagesRead,
        enabledTools: agent.enabledTools,
        toolConfig: agent.toolConfig,
        maxSteps: agent.maxSteps,
        maxToolCallsPerRun: agent.maxToolCallsPerRun,
        maxRepeatsPerTool: agent.maxRepeatsPerTool,
        dailyTokenCap: agent.dailyTokenCap,
        openingMessage: agent.openingMessage,
        openingDelayMs: agent.openingDelayMs,
        inactivityTimerMs: agent.inactivityTimerMs,
        inactivityHandoffMode: agent.inactivityHandoffMode,
        inactivityHandoffUserId: agent.inactivityHandoffUserId,
        inactivityFarewellMessage: agent.inactivityFarewellMessage,
        keywordHandoffs: agent.keywordHandoffs,
        qualificationQuestions: agent.qualificationQuestions,
        businessHours: agent.businessHours,
        autoClosePolicy: agent.autoClosePolicy,
        identityConfirmationEnabled: agent.identityConfirmationEnabled,
        identityConfirmationTemplate: agent.identityConfirmationTemplate,
        identityConfirmationFields: agent.identityConfirmationFields,
        pipelineId: agent.pipelineId,
        steeringRules: agent.steeringRules,
        systemPromptOverride: agent.systemPromptOverride,
        systemPromptTemplate: agent.systemPromptTemplate,
        productPolicy: agent.productPolicy,
        inboxPolicyRaw: stripSensitive(agent.inboxPolicy),
        inboxPolicyResolved: inboxPolicy,
        finalPrompt,
        simpleConfig: agent.simpleConfig,
        createdAt: agent.createdAt,
        updatedAt: agent.updatedAt,
        knowledgeDocs,
        stats30d: stats,
      };
    }),
  );

  const output = {
    exportedAt: new Date().toISOString(),
    organization: {
      id: selected.id,
      name: selected.name,
      slug: slugify(selected.name),
      createdAt: selected.createdAt,
    },
    departments: departments.map((d) => ({
      id: d.id,
      number: d.number,
      name: d.name,
      color: d.color,
      icon: d.icon,
      distributionEnabled: d.distributionEnabled,
      requireTabulationOnClose: d.requireTabulationOnClose,
      autoCloseTabulationId: d.autoCloseTabulationId,
      membersCount: d._count.members,
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
      tabulations: buildTree(d.id, null),
    })),
    pipelines: pipelines.map((p) => ({
      id: p.id,
      number: p.number,
      name: p.name,
      slug: p.slug,
      isDefault: p.isDefault,
      lossReasonRequired: p.lossReasonRequired,
      stages: p.stages,
    })),
    customFields: customFields.map((f) => ({
      id: f.id,
      number: f.number,
      name: f.name,
      label: f.label,
      type: f.type,
      options: f.options,
      required: f.required,
      entity: f.entity,
      showInInboxLeadPanel: f.showInInboxLeadPanel,
      showInDealPanel: f.showInDealPanel,
      inboxLeadPanelOrder: f.inboxLeadPanelOrder,
      createdAt: f.createdAt,
      updatedAt: f.updatedAt,
    })),
    messageTemplates: messageTemplates.map((t) => ({
      id: t.id,
      number: t.number,
      name: t.name,
      content: t.content,
      category: t.category,
      language: t.language,
      status: t.status,
      channelType: t.channelType,
      mediaUrl: t.mediaUrl,
      mediaType: t.mediaType,
      mediaName: t.mediaName,
      attachments: t.attachments,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    })),
    whatsAppTemplateConfigs: whatsAppTemplates.map((t) => ({
      id: t.id,
      metaTemplateId: t.metaTemplateId,
      metaTemplateName: t.metaTemplateName,
      label: t.label,
      agentEnabled: t.agentEnabled,
      language: t.language,
      category: t.category,
      bodyPreview: t.bodyPreview,
      hasButtons: t.hasButtons,
      buttonTypes: t.buttonTypes,
      hasVariables: t.hasVariables,
      flowAction: t.flowAction,
      flowId: t.flowId,
      operatorVariables: t.operatorVariables,
      hiddenAt: t.hiddenAt,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    })),
    agents,
  };

  const jsonPath = path.join(rootDir, "agents.json");
  writeFileSync(jsonPath, JSON.stringify(output, null, 2), "utf-8");

  console.log(`\nInventário exportado:`);
  console.log(`- ${jsonPath}`);
  console.log(`- ${knowledgeDir} (${agents.reduce((acc, a) => acc + a.knowledgeDocs.length, 0)} docs)`);

  await prismaBase.$disconnect();
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
