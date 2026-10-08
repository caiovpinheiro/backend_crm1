/**
 * Nomes do que a configuração do agente cita por id (departamentos, pessoas,
 * agentes, materiais, mensagens prontas, campos, tabulações, etapas,
 * etiquetas, números). Usado na exportação das regras e na revisão com IA.
 * Nenhum domínio de cliente.
 */

import { prisma } from "@/lib/prisma";
import { prismaBase } from "@/lib/prisma-base";
import type { V2AgentConfig } from "@/lib/ai-v2/types";
import type { V2ExportNames } from "./rules-export";

type Row = { id: string; name?: string | null };

const byId = (rows: Row[] | undefined) => Object.fromEntries((rows ?? []).map((r) => [r.id, r.name ?? ""]));

/** Nomes do que a configuração cita por id (departamento, agente, material…). */
export async function loadExportNames(organizationId: string, agentId: string, config: V2AgentConfig): Promise<V2ExportNames> {
  const p = prisma as any;
  const docIds = [...new Set([
    ...(config.allowedKnowledgeDocIds ?? []),
    ...config.themes.flatMap((t) => [...(t.allowedKnowledgeDocIds ?? []), ...(t.knowledgeDocIds ?? [])]),
  ])];
  const safe = <T,>(promise: Promise<T>, fallback: T) => promise.catch(() => fallback);
  const [departments, users, distributionRules, agents, models, flows, docs, customFields, pipelines, tags, tabulations, attachments, channels] = await Promise.all([
    safe(p.department.findMany({ where: { organizationId }, select: { id: true, name: true } }), []),
    safe(p.user.findMany({ where: { organizationId }, select: { id: true, name: true } }), []),
    safe(p.distributionRule.findMany({ where: { organizationId }, select: { id: true, name: true } }), []),
    safe(p.aIAgentConfig.findMany({ where: { organizationId }, select: { id: true, engine: true, active: true, user: { select: { name: true } } } }), []),
    safe(p.messageTemplate.findMany({ where: { organizationId }, select: { id: true, name: true } }), []),
    safe(p.whatsappFlowDefinition.findMany({ where: { organizationId, status: "PUBLISHED" }, select: { id: true, name: true } }), []),
    safe(p.aIAgentKnowledgeDoc.findMany({ where: { organizationId, agentId, id: { in: docIds } }, select: { id: true, title: true, status: true, validUntil: true } }), []),
    safe(p.customField.findMany({ where: { organizationId }, select: { id: true, name: true, label: true } }), []),
    safe(p.pipeline.findMany({ where: { organizationId }, select: { name: true, stages: { select: { id: true, name: true } } } }), []),
    safe(Promise.resolve(p.tag?.findMany?.({ where: { organizationId }, select: { id: true, name: true } }) ?? []), []),
    safe(import("@/services/tabulations").then(({ listActiveTabulationLeaves }) => listActiveTabulationLeaves({ organizationId })), []),
    docIds.length === 0
      ? Promise.resolve([] as Array<{ docId: string; n: number }>)
      : safe(
          (prismaBase as unknown as { $queryRawUnsafe: <T>(q: string, ...v: unknown[]) => Promise<T> }).$queryRawUnsafe<Array<{ docId: string; n: number }>>(
            `SELECT "docId", COUNT(*)::int AS n FROM "ai_v2_material_attachments" WHERE "organizationId" = $1 AND "docId" = ANY($2::text[]) GROUP BY "docId"`,
            organizationId, docIds,
          ),
          [] as Array<{ docId: string; n: number }>,
        ),
    safe(p.channel.findMany({ where: { organizationId }, select: { id: true, name: true } }), []),
  ]);
  const attachmentCount = new Map((attachments as Array<{ docId: string; n: number }>).map((a) => [a.docId, Number(a.n)]));
  return {
    departments: byId(departments),
    users: byId(users),
    distributionRules: byId(distributionRules),
    aiAgents: Object.fromEntries((agents as Array<{ id: string; engine: string; active: boolean; user?: { name?: string } }>).map((a) => [a.id, { name: a.user?.name ?? a.id, engine: a.engine, active: a.active }])),
    messageModels: byId(models),
    messageFlows: byId(flows),
    docs: Object.fromEntries((docs as Array<{ id: string; title: string; status: string; validUntil: Date | null }>).map((d) => [d.id, {
      title: d.title,
      status: d.status,
      validUntil: d.validUntil ? new Date(d.validUntil).toISOString() : null,
      attachments: attachmentCount.get(d.id) ?? 0,
    }])),
    customFields: Object.fromEntries((customFields as Array<{ id: string; name: string; label?: string | null }>).map((f) => [f.id, f.label || f.name])),
    tabulations: Object.fromEntries((tabulations as Array<{ id: string; path: string; departmentName: string }>).map((t) => [t.id, `${t.departmentName} › ${t.path}`])),
    stages: Object.fromEntries((pipelines as Array<{ name: string; stages: Row[] }>).flatMap((pl) => pl.stages.map((s) => [s.id, `${pl.name} › ${s.name}`]))),
    tags: byId(tags as Row[]),
    channels: byId(channels as Row[]),
  };
}
