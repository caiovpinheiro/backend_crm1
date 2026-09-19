/**
 * FASE 1: Extração de Estrutura de Mensagens
 * Org: cmpptxqd00002od01pxxs0g12
 * Foco: Entender a estrutura, tipos, padrões básicos
 */

import { PrismaClient } from "@prisma/client";

async function main() {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    console.error("❌ DATABASE_URL não definida");
    process.exit(1);
  }

  console.log(`\n${"=".repeat(80)}`);
  console.log(`🔍 FASE 1: ESTRUTURA DE MENSAGENS`);
  console.log(`${"=".repeat(80)}`);
  console.log(`📍 Conectando ao banco...`);
  console.log(`${"=".repeat(80)}\n`);

  const prisma = new PrismaClient({
    datasources: {
      db: {
        url: databaseUrl,
      },
    },
  });

  const orgId = "cmpptxqd00002od01pxxs0g12";

  try {
    // 1. Verificar se org existe
    const org = await prisma.$queryRaw`
      SELECT id, name FROM organizations WHERE id = ${orgId}
    `;

    if (!org || (Array.isArray(org) && org.length === 0)) {
      console.log(`❌ Organização ${orgId} não encontrada`);
      process.exit(1);
    }

    const orgName = Array.isArray(org) ? org[0]?.name : org?.name;
    console.log(`✅ Organização encontrada: ${orgName} (${orgId})\n`);

    // 2. Contar conversas
    const convCount = await prisma.$queryRaw<[{ count: bigint }]>`
      SELECT COUNT(*) as count FROM conversations WHERE "organizationId" = ${orgId}
    `;
    const totalConversas = Number(convCount[0].count);
    console.log(`📨 Total de conversas: ${totalConversas}\n`);

    // 3. Estrutura de Mensagens - Estatísticas Básicas
    console.log(`${"─".repeat(80)}`);
    console.log(`📊 ESTRUTURA DE MENSAGENS`);
    console.log(`${"─".repeat(80)}\n`);

    const msgStats = await prisma.$queryRaw<
      Array<{
        total_mensagens: bigint;
        total_por_tipo_autor: number;
        total_por_direcao: number;
        autores_unicos: number;
        conversas_com_mensagens: number;
      }>
    >`
      SELECT
        COUNT(m.id) as total_mensagens,
        COUNT(DISTINCT m."authorType") as total_por_tipo_autor,
        COUNT(DISTINCT m.direction) as total_por_direcao,
        COUNT(DISTINCT CASE WHEN m."authorType" = 'bot' THEN m."aiAgentUserId" END) as autores_unicos,
        COUNT(DISTINCT m."conversationId") as conversas_com_mensagens
      FROM messages m
      WHERE m."organizationId" = ${orgId}
    `;

    console.log(`Total de mensagens: ${Number(msgStats[0].total_mensagens)}`);
    console.log(`Tipos de autor únicos: ${msgStats[0].total_por_tipo_autor}`);
    console.log(`Direções únicas: ${msgStats[0].total_por_direcao}`);
    console.log(`Conversas com mensagens: ${msgStats[0].conversas_com_mensagens}/${totalConversas}\n`);

    // 4. Distribuição por AuthorType
    console.log(`${"─".repeat(80)}`);
    console.log(`👤 DISTRIBUIÇÃO POR TIPO DE AUTOR`);
    console.log(`${"─".repeat(80)}\n`);

    const authorTypes = await prisma.$queryRaw<
      Array<{
        author_type: string | null;
        count: bigint;
      }>
    >`
      SELECT "authorType" as author_type, COUNT(*) as count
      FROM messages
      WHERE "organizationId" = ${orgId}
      GROUP BY "authorType"
      ORDER BY count DESC
    `;

    for (const row of authorTypes) {
      const type = row.author_type || "(NULL)";
      const count = Number(row.count);
      console.log(`  ${type}: ${count}`);
    }
    console.log();

    // 5. Distribuição por Direction
    console.log(`${"─".repeat(80)}`);
    console.log(`🔄 DISTRIBUIÇÃO POR DIREÇÃO`);
    console.log(`${"─".repeat(80)}\n`);

    const directions = await prisma.$queryRaw<
      Array<{
        direction: string | null;
        count: bigint;
      }>
    >`
      SELECT direction, COUNT(*) as count
      FROM messages
      WHERE "organizationId" = ${orgId}
      GROUP BY direction
      ORDER BY count DESC
    `;

    for (const row of directions) {
      const dir = row.direction || "(NULL)";
      const count = Number(row.count);
      console.log(`  ${dir}: ${count}`);
    }
    console.log();

    // 6. Distribuição por Canais
    console.log(`${"─".repeat(80)}`);
    console.log(`📱 DISTRIBUIÇÃO POR CANAL`);
    console.log(`${"─".repeat(80)}\n`);

    const channels = await prisma.$queryRaw<
      Array<{
        channel: string | null;
        count: bigint;
      }>
    >`
      SELECT c.channel, COUNT(m.id) as count
      FROM messages m
      JOIN conversations c ON m."conversationId" = c.id
      WHERE m."organizationId" = ${orgId}
      GROUP BY c.channel
      ORDER BY count DESC
    `;

    for (const row of channels) {
      const ch = row.channel || "(NULL)";
      const count = Number(row.count);
      console.log(`  ${ch}: ${count}`);
    }
    console.log();

    // 7. Tipos de Mensagem (messageType)
    console.log(`${"─".repeat(80)}`);
    console.log(`💬 DISTRIBUIÇÃO POR TIPO DE MENSAGEM`);
    console.log(`${"─".repeat(80)}\n`);

    const msgTypes = await prisma.$queryRaw<
      Array<{
        message_type: string | null;
        count: bigint;
      }>
    >`
      SELECT "messageType" as message_type, COUNT(*) as count
      FROM messages
      WHERE "organizationId" = ${orgId}
      GROUP BY "messageType"
      ORDER BY count DESC
    `;

    for (const row of msgTypes) {
      const type = row.message_type || "(NULL)";
      const count = Number(row.count);
      console.log(`  ${type}: ${count}`);
    }
    console.log();

    // 8. Agentes IA (se houver)
    console.log(`${"─".repeat(80)}`);
    console.log(`🤖 AGENTES IA (Mensagens com aiAgentUserId)`);
    console.log(`${"─".repeat(80)}\n`);

    const aiAgents = await prisma.$queryRaw<
      Array<{
        ai_agent_id: string | null;
        ai_agent_name: string | null;
        count: bigint;
      }>
    >`
      SELECT m."aiAgentUserId" as ai_agent_id, u.name as ai_agent_name, COUNT(*) as count
      FROM messages m
      LEFT JOIN users u ON m."aiAgentUserId" = u.id
      WHERE m."organizationId" = ${orgId} AND m."aiAgentUserId" IS NOT NULL
      GROUP BY m."aiAgentUserId", u.name
      ORDER BY count DESC
    `;

    if (aiAgents.length === 0) {
      console.log("  (Nenhuma mensagem atribuída a agentes IA)");
    } else {
      for (const row of aiAgents) {
        const name = row.ai_agent_name || "sem nome";
        const count = Number(row.count);
        console.log(`  ${name} (${row.ai_agent_id}): ${count} mensagens`);
      }
    }
    console.log();

    // 9. Status de Envio (sendStatus)
    console.log(`${"─".repeat(80)}`);
    console.log(`✉️ DISTRIBUIÇÃO POR STATUS DE ENVIO`);
    console.log(`${"─".repeat(80)}\n`);

    const sendStatus = await prisma.$queryRaw<
      Array<{
        send_status: string | null;
        count: bigint;
      }>
    >`
      SELECT "sendStatus" as send_status, COUNT(*) as count
      FROM messages
      WHERE "organizationId" = ${orgId}
      GROUP BY "sendStatus"
      ORDER BY count DESC
    `;

    for (const row of sendStatus) {
      const status = row.send_status || "(NULL)";
      const count = Number(row.count);
      console.log(`  ${status}: ${count}`);
    }
    console.log();

    // 10. Intervalo de Tempo
    console.log(`${"─".repeat(80)}`);
    console.log(`📅 INTERVALO TEMPORAL`);
    console.log(`${"─".repeat(80)}\n`);

    const timeRange = await prisma.$queryRaw<
      Array<{
        min_date: Date | null;
        max_date: Date | null;
      }>
    >`
      SELECT MIN("createdAt") as min_date, MAX("createdAt") as max_date
      FROM messages
      WHERE "organizationId" = ${orgId}
    `;

    if (timeRange[0].min_date && timeRange[0].max_date) {
      console.log(`  Primeira mensagem: ${new Date(timeRange[0].min_date).toISOString()}`);
      console.log(`  Última mensagem: ${new Date(timeRange[0].max_date).toISOString()}`);
      const daysDiff = Math.floor(
        (new Date(timeRange[0].max_date).getTime() - new Date(timeRange[0].min_date).getTime()) /
          (1000 * 60 * 60 * 24)
      );
      console.log(`  Span: ${daysDiff} dias`);
    } else {
      console.log("  (Sem dados de data)");
    }
    console.log();

    // 11. Mensagens Privadas
    console.log(`${"─".repeat(80)}`);
    console.log(`🔒 MENSAGENS PRIVADAS`);
    console.log(`${"─".repeat(80)}\n`);

    const privMsgs = await prisma.$queryRaw<
      Array<{
        is_private: boolean;
        count: bigint;
      }>
    >`
      SELECT "isPrivate" as is_private, COUNT(*) as count
      FROM messages
      WHERE "organizationId" = ${orgId}
      GROUP BY "isPrivate"
    `;

    for (const row of privMsgs) {
      const isPriv = row.is_private ? "Privada" : "Pública";
      const count = Number(row.count);
      console.log(`  ${isPriv}: ${count}`);
    }
    console.log();

    // 12. Resumo Geral
    console.log(`${"=".repeat(80)}`);
    console.log(`📋 RESUMO ESTRUTURAL`);
    console.log(`${"=".repeat(80)}\n`);

    console.log(`✅ Estrutura mapeada com sucesso!`);
    console.log(`\n📊 Próxima fase: Análise de conteúdo e padrões de conversa`);

    console.log(`\n${"=".repeat(80)}\n`);

  } catch (error) {
    console.error("❌ Erro:", error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
