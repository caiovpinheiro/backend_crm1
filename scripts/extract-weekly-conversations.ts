/**
 * Extrai conversas da semana (sábado 13/09 até hoje 18/09)
 * para análise de padrões de clientes, agentes e IA.
 */

async function main() {
  const { prismaBase } = await import("@/lib/prisma-base");

  // Data de início: sábado 13/09/2026 00:00 UTC
  const startDate = new Date(Date.UTC(2026, 8, 13, 0, 0, 0)); // mês é 0-indexed
  // Data de fim: hoje 18/09/2026 23:59:59 UTC
  const endDate = new Date(Date.UTC(2026, 8, 18, 23, 59, 59));

  console.log(`📊 Extraindo conversas de ${startDate.toISOString()} até ${endDate.toISOString()}\n`);

  // Buscar todas as organizações
  const organizations = await prismaBase.$queryRaw<Array<{ id: string; name: string }>>`
    SELECT id, name FROM organizations
    ORDER BY name
  `;

  console.log(`🏢 Encontradas ${organizations.length} organizações\n`);

  const allOrgData: any[] = [];

  for (const org of organizations) {
    console.log(`\n${"=".repeat(80)}`);
    console.log(`📍 Organização: ${org.name} (${org.id})`);
    console.log(`${"=".repeat(80)}\n`);

    try {
      // Buscar conversas desta semana
      const conversations = await prismaBase.conversation.findMany({
        where: {
          organizationId: org.id,
          updatedAt: {
            gte: startDate,
            lte: endDate,
          },
        },
        select: {
          id: true,
          number: true,
          status: true,
          channel: true,
          updatedAt: true,
          createdAt: true,
          hasHumanReply: true,
          hasAgentReply: true,
          contact: {
            select: {
              id: true,
              name: true,
              email: true,
              phone: true,
            },
          },
          assignedTo: {
            select: {
              id: true,
              name: true,
              type: true,
            },
          },
          messages: {
            select: {
              id: true,
              content: true,
              direction: true,
              authorType: true,
              createdAt: true,
              aiAgentUser: {
                select: {
                  id: true,
                  name: true,
                },
              },
            },
            orderBy: { createdAt: "asc" },
          },
          department: {
            select: {
              id: true,
              name: true,
            },
          },
        },
        orderBy: { updatedAt: "desc" },
      });

      console.log(`📨 Total de conversas: ${conversations.length}\n`);

      if (conversations.length === 0) {
        console.log("Nenhuma conversa nesta semana.\n");
        continue;
      }

      // Análise agregada
      let totalMessages = 0;
      let humanMessages = 0;
      let botMessages = 0;
      let systemMessages = 0;
      let inboundMessages = 0;
      let outboundMessages = 0;
      const agentInteractions: Record<string, number> = {};
      const aiAgentInteractions: Record<string, number> = {};
      const departmentStats: Record<string, { count: number; conversations: string[] }> = {};
      const channelStats: Record<string, number> = {};

      const conversationDetails: any[] = [];

      for (const conv of conversations) {
        const deptName = conv.department?.name || "Sem departamento";
        if (!departmentStats[deptName]) {
          departmentStats[deptName] = { count: 0, conversations: [] };
        }
        departmentStats[deptName].count++;
        departmentStats[deptName].conversations.push(`#${conv.number}`);

        if (conv.channel) {
          channelStats[conv.channel] = (channelStats[conv.channel] || 0) + 1;
        }

        const agentName = conv.assignedTo?.name || "Não atribuído";
        if (conv.assignedTo?.type === "AI") {
          aiAgentInteractions[agentName] = (aiAgentInteractions[agentName] || 0) + 1;
        } else if (conv.assignedTo?.name) {
          agentInteractions[agentName] = (agentInteractions[agentName] || 0) + 1;
        }

        let convHumanMessages = 0;
        let convBotMessages = 0;
        let convSystemMessages = 0;
        let convInbound = 0;
        let convOutbound = 0;

        const messageDetails: any[] = [];

        for (const msg of conv.messages) {
          totalMessages++;

          if (msg.direction === "inbound") {
            convInbound++;
            inboundMessages++;
          } else {
            convOutbound++;
            outboundMessages++;
          }

          if (msg.authorType === "human") {
            humanMessages++;
            convHumanMessages++;
          } else if (msg.authorType === "bot") {
            botMessages++;
            convBotMessages++;
          } else if (msg.authorType === "system") {
            systemMessages++;
            convSystemMessages++;
          }

          messageDetails.push({
            timestamp: msg.createdAt.toISOString(),
            direction: msg.direction,
            authorType: msg.authorType,
            aiAgent: msg.aiAgentUser?.name || null,
            preview: msg.content.substring(0, 100) + (msg.content.length > 100 ? "..." : ""),
          });
        }

        conversationDetails.push({
          number: conv.number,
          contact: `${conv.contact.name} (${conv.contact.phone || conv.contact.email || "sem contato"})`,
          status: conv.status,
          channel: conv.channel,
          assignedTo: agentName,
          assignedToType: conv.assignedTo?.type || "HUMAN",
          department: deptName,
          createdAt: conv.createdAt.toISOString(),
          updatedAt: conv.updatedAt.toISOString(),
          totalMessages: conv.messages.length,
          humanMessages: convHumanMessages,
          botMessages: convBotMessages,
          systemMessages: convSystemMessages,
          inbound: convInbound,
          outbound: convOutbound,
          hasHumanReply: conv.hasHumanReply,
          hasAgentReply: conv.hasAgentReply,
          messages: messageDetails,
        });
      }

      // Exibir análise
      console.log(`📊 ESTATÍSTICAS GERAIS:`);
      console.log(`   Total de mensagens: ${totalMessages}`);
      if (totalMessages > 0) {
        console.log(`   ├─ Humanas: ${humanMessages} (${((humanMessages / totalMessages) * 100).toFixed(1)}%)`);
        console.log(`   ├─ Bot/IA: ${botMessages} (${((botMessages / totalMessages) * 100).toFixed(1)}%)`);
        console.log(`   └─ Sistema: ${systemMessages} (${((systemMessages / totalMessages) * 100).toFixed(1)}%)`);
      }
      console.log(`   ├─ Inbound: ${inboundMessages}`);
      console.log(`   └─ Outbound: ${outboundMessages}`);

      console.log(`\n📱 DISTRIBUIÇÃO POR CANAL:`);
      const sortedChannels = Object.entries(channelStats).sort((a, b) => b[1] - a[1]);
      for (const [channel, count] of sortedChannels) {
        console.log(`   ${channel}: ${count} conversas`);
      }

      console.log(`\n👥 DISTRIBUIÇÃO POR AGENTE HUMANO:`);
      const sortedAgents = Object.entries(agentInteractions).sort((a, b) => b[1] - a[1]);
      if (sortedAgents.length === 0) {
        console.log("   (Nenhuma conversa com agente humano atribuído)");
      } else {
        for (const [agent, count] of sortedAgents) {
          console.log(`   ${agent}: ${count} conversas`);
        }
      }

      console.log(`\n🤖 DISTRIBUIÇÃO POR AGENTE IA:`);
      const sortedAIAgents = Object.entries(aiAgentInteractions).sort((a, b) => b[1] - a[1]);
      if (sortedAIAgents.length === 0) {
        console.log("   (Nenhuma conversa com agente IA)");
      } else {
        for (const [agent, count] of sortedAIAgents) {
          console.log(`   ${agent}: ${count} conversas`);
        }
      }

      console.log(`\n🏷️  DISTRIBUIÇÃO POR DEPARTAMENTO:`);
      for (const [dept, stats] of Object.entries(departmentStats)) {
        const convList = stats.conversations.slice(0, 5).join(", ") + (stats.conversations.length > 5 ? ", ..." : "");
        console.log(`   ${dept}: ${stats.count} conversas (${convList})`);
      }

      // Armazenar dados para dashboard
      allOrgData.push({
        organization: org.name,
        organizationId: org.id,
        period: { start: startDate.toISOString(), end: endDate.toISOString() },
        summary: {
          totalConversations: conversations.length,
          totalMessages,
          humanMessages,
          botMessages,
          systemMessages,
          inboundMessages,
          outboundMessages,
          agentInteractions,
          aiAgentInteractions,
          departmentStats,
          channelStats,
        },
        conversations: conversationDetails,
      });

      // Salvar detalhes em arquivo JSON
      const safeName = org.name.replace(/[^a-z0-9]/gi, "-").toLowerCase();
      const outputPath = `./scripts/output-weekly-conversations-${safeName}.json`;

      const output = JSON.stringify(allOrgData[allOrgData.length - 1], null, 2);

      // Use standard fs instead of Bun
      const fs = await import("fs/promises");
      await fs.writeFile(outputPath, output, "utf-8");

      console.log(`\n✅ Detalhes salvos em: ${outputPath}`);
    } catch (err) {
      console.error(`❌ Erro ao processar org ${org.name}:`, (err as Error).message);
    }
  }

  // Salvar consolidado de todas as orgs
  const consolidatedPath = `./scripts/output-all-organizations-weekly.json`;
  const fs = await import("fs/promises");
  await fs.writeFile(consolidatedPath, JSON.stringify(allOrgData, null, 2), "utf-8");

  console.log(`\n${"=".repeat(80)}`);
  console.log("✨ Extração concluída!");
  console.log(`📁 Arquivo consolidado: ${consolidatedPath}`);
  console.log(`${"=".repeat(80)}\n`);

  process.exit(0);
}

main().catch((err) => {
  console.error("❌ Erro fatal:", (err as Error).message);
  process.exit(1);
});
