/**
 * Replay em lote: falas do aluno → runAgent, troca de agente pela tool.
 *
 * Não cria conversa WhatsApp. `source: inbox_test` simula transfer_* (não
 * muta CRM) e o guardrail não descarta o texto. O harness lê os ARGS da
 * tool e passa o próximo turno para o destino.
 *
 * Local:
 *   npx tsx src/scripts/replay-agent-runs.ts --org teste-dev --start Joseph
 *
 * EasyPanel (/app, depois do deploy):
 *   node dist/workers/replay-agent-runs.js --org teste-dev --start Joseph
 *   node dist/workers/replay-agent-runs.js --lote 2 --out /tmp/replay-lote2.json
 *   node dist/workers/replay-agent-runs.js --lote 2 --limit 35 --out /tmp/replay-lote2.json
 *   # --real-handoff: conversa sandbox com id real, tools de efeito rodam de
 *   #   verdade (executeOrchestratedHandoff + assign) e os eventos gravados
 *   #   entram no TurnRecord. A conversa é apagada no fim (--keep-sandbox mantém).
 *   # exit 1 se o QA achar ASK em pedido real, inbound fora de ordem, SKIP de regra, etc.
 *   # --qa-continue grava o relatório e não falha o processo
 *
 * O harness cria contato + linha de matriculado (se a org não tiver relatório
 * casando o telefone). Sem isso consultar_matricula sempre falha.
 * prismaBase: script fora de RequestContext até achar a org; o loop usa
 * runWithContext + runAgent (prisma scoped).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import bundledLote1 from "./fixtures/joseph-replay-cases.json";
import bundledLote2 from "./fixtures/joseph-replay-lote2.json";
import { evaluateMessageRules } from "@/lib/ai-agents/message-rules";
import { normalizeInboxPolicy } from "@/lib/ai-agents/steering";
import { prismaBase } from "@/lib/prisma-base";
import { runWithContext } from "@/lib/request-context";
import {
  canonicalPhone,
  lookupStudent,
} from "@/services/academic-records";
import { runAgent, MAX_HISTORY, type RunResult } from "@/services/ai/runner";
import {
  blockedEffects,
  disableReplaySandbox,
  enableReplaySandbox,
  REPLAY_SANDBOX_SETTING_KEY,
} from "@/services/ai/replay-sandbox";
import { formatQaReport, scoreReplay, fixtureTurnInbound } from "@/scripts/replay-qa";

type FixtureCase = {
  id: string;
  label: string;
  turns: Array<string | { inbound: string; expect?: { guard?: boolean; human?: boolean } }>;
  contact?: { name?: string; phone?: string | null };
};
type FixtureFile = { cases: FixtureCase[] };

type AgentRow = {
  id: string;
  userId: string;
  archetype: string | null;
  inboxPolicy: unknown;
  verticalPack: string | null;
  name: string;
};

type HistoryTurn = { role: "user" | "assistant"; content: string };

type TurnRecord = {
  caseId: string;
  turnIndex: number;
  inbound: string;
  agentId: string;
  agentName: string;
  llmInvoked: boolean;
  runId: string | null;
  status: string | null;
  text: string;
  tools: Array<{ name: string; args: unknown; result: unknown }>;
  rule: { action: string; label: string; department: string | null } | null;
  switchedTo: string | null;
  skipped: string | null;
  at?: string;
  handoff?: {
    fromAgentId: string;
    toAgentId: string;
    by?: string;
  } | null;
  /**
   * O que o handoff gravou no banco neste turno (`--real-handoff`): eventos
   * de conversa e o dono resultante. É a diferença entre "a tool devolveu
   * assigned:true" e "a atribuição aconteceu".
   */
  dbHandoff?: {
    conversationId: string;
    assignedToId: string | null;
    assignedToName: string | null;
    events: Array<{ content: string; createdAt: string }>;
  } | null;
};

function arg(flag: string, fallback = ""): string {
  const i = process.argv.indexOf(flag);
  if (i < 0) return fallback;
  return process.argv[i + 1] ?? fallback;
}

function fold(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .trim();
}

function asRecord(v: unknown): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  return v as Record<string, unknown>;
}

function logTurn(r: TurnRecord): void {
  const tools = r.tools.map((t) => t.name).join(",") || "-";
  const status = r.skipped ? `SKIP ${r.skipped}` : r.status ?? "-";
  const dest = r.switchedTo ? ` → ${r.switchedTo}` : "";
  console.log("");
  console.log(
    `--- ${r.caseId} t${r.turnIndex} | ${r.agentName}${dest} | ${status} | tools=${tools} ---`,
  );
  console.log(`ALUNO:\n${r.inbound}`);
  console.log(`AGENTE:\n${r.text?.trim() ? r.text : "(sem texto)"}`);
}

function transcriptPathFor(outPath: string): string {
  return outPath.replace(/\.json$/i, "") + ".txt";
}

function formatTranscript(cases: FixtureCase[], records: TurnRecord[]): string {
  const byCase = new Map<string, TurnRecord[]>();
  for (const r of records) {
    const list = byCase.get(r.caseId) ?? [];
    list.push(r);
    byCase.set(r.caseId, list);
  }
  const lines: string[] = [
    "Replay — transcrição completa (inbound do fixture + resposta do agente).",
    "O lote 2 é inbound-only, sem mídia, máx. 10 turnos do aluno. Ordem = ordem do dump.",
    "",
  ];
  for (const c of cases) {
    const turns = byCase.get(c.id) ?? [];
    const truncated = c.turns.length >= 10 ? " (bateu no teto de 10)" : "";
    lines.push(
      `===== ${c.id} ${c.label ?? ""} | ${c.turns.length} inbound${truncated} =====`,
    );
    lines.push("Script do aluno (ordem):");
    c.turns.forEach((t, i) => lines.push(`  t${i} ${fixtureTurnInbound(t)}`));
    lines.push("");
    for (const r of turns) {
      const tools = r.tools.map((t) => t.name).join(",") || "-";
      const status = r.skipped ? `SKIP ${r.skipped}` : r.status ?? "-";
      const dest = r.switchedTo ? ` → ${r.switchedTo}` : "";
      lines.push(`--- t${r.turnIndex} ${r.agentName}${dest} ${status} tools=${tools}`);
      lines.push(`ALUNO: ${r.inbound}`);
      lines.push(`AGENTE: ${r.text?.trim() ? r.text : "(sem texto)"}`);
      lines.push("");
    }
  }
  return lines.join("\n");
}

function loadFixtures(path: string | null, lote: string): FixtureCase[] {
  const bundled =
    lote === "2" || lote === "lote2"
      ? (bundledLote2 as FixtureFile)
      : lote === "all"
        ? {
            cases: [
              ...(bundledLote1 as FixtureFile).cases,
              ...(bundledLote2 as FixtureFile).cases,
            ],
          }
        : (bundledLote1 as FixtureFile);
  const raw = path
    ? (JSON.parse(readFileSync(path, "utf8")) as FixtureFile)
    : bundled;
  if (!Array.isArray(raw.cases)) throw new Error("fixture sem cases[]");
  return raw.cases.filter((c) => c.id && Array.isArray(c.turns) && c.turns.length);
}

function findAgent(agents: AgentRow[], needle: string): AgentRow | null {
  const n = fold(needle);
  if (!n) return null;
  return (
    agents.find((a) => a.id === needle || a.userId === needle) ??
    agents.find((a) => fold(a.name) === n) ??
    agents.find((a) => fold(a.name).includes(n) || n.includes(fold(a.name))) ??
    null
  );
}

function toolSucceeded(result: unknown): boolean {
  const r = asRecord(result);
  if (r.ok === false) return false;
  if (typeof r.error === "string" && r.ok !== true) return false;
  return true;
}

function inspectHandoff(calls: RunResult["toolCalls"]): {
  kind: "ai_agent" | "department" | "human" | null;
  name: string;
} {
  for (const c of calls) {
    if (!toolSucceeded(c.result)) continue;
    const args = asRecord(c.args);
    if (c.name === "transfer_conversation") {
      const target = String(args.target ?? "");
      const name = String(args.name ?? "").trim();
      if (target === "ai_agent") return { kind: "ai_agent", name };
      if (target === "department") return { kind: "department", name };
      if (target === "user") return { kind: "human", name };
    }
    if (c.name === "transfer_to_ai_agent") {
      return {
        kind: "ai_agent",
        name: String(args.name ?? args.agentName ?? args.agentUserId ?? "").trim(),
      };
    }
    if (c.name === "transfer_to_department") {
      return {
        kind: "department",
        name: String(args.departmentName ?? args.name ?? "").trim(),
      };
    }
    if (c.name === "transfer_to_human" || c.name === "execute_distribution") {
      return {
        kind: "human",
        name: String(args.departmentName ?? args.name ?? c.name).trim(),
      };
    }
  }
  return { kind: null, name: "" };
}

function mapDepartmentToAgent(
  agents: AgentRow[],
  department: string,
): AgentRow | null {
  const d = fold(department);
  if (!d) return null;
  if (/reten|evas|cancel|tranc/.test(d)) {
    return agents.find((a) => /reten|evas/i.test(a.name)) ?? null;
  }
  if (/acolh/.test(d)) {
    return agents.find((a) => /acolh/i.test(a.name)) ?? null;
  }
  if (/atend|sac|suporte/.test(d)) {
    return (
      agents.find((a) => /atend/i.test(a.name) && !/reten/i.test(a.name)) ??
      null
    );
  }
  return findAgent(agents, department);
}

function applyHandoff(
  agents: AgentRow[],
  handoff: { kind: "ai_agent" | "department" | "human" | null; name: string },
): { next: AgentRow | null; skip: string | null; switchedTo: string | null } {
  if (handoff.kind === "ai_agent") {
    const dest = findAgent(agents, handoff.name);
    if (dest) return { next: dest, skip: null, switchedTo: dest.name };
    return { next: null, skip: null, switchedTo: `unresolved:${handoff.name}` };
  }
  if (handoff.kind === "department") {
    const dest = mapDepartmentToAgent(agents, handoff.name);
    if (dest) return { next: dest, skip: null, switchedTo: dest.name };
    return {
      next: null,
      skip: `tool_department:${handoff.name}`,
      switchedTo: null,
    };
  }
  if (handoff.kind === "human") {
    return {
      next: null,
      skip: `tool_human:${handoff.name}`,
      switchedTo: null,
    };
  }
  return { next: null, skip: null, switchedTo: null };
}

function replayPhone(c: FixtureCase): string {
  const raw = c.contact?.phone?.trim();
  if (raw && /\d/.test(raw)) return raw;
  return `+55119${c.id.replace(/\D/g, "").padStart(8, "0").slice(-8)}`;
}

/**
 * Contact + linha no relatório de matriculados. Sem isso consultar_matricula
 * devolve "Sem contato" / found:false e o agente só pede cadastro.
 */
async function ensureReplayStudent(
  organizationId: string,
  c: FixtureCase,
): Promise<{ contactId: string; seededRecord: boolean }> {
  const name = (c.contact?.name || c.label || `Aluno ${c.id}`).trim();
  const phone = replayPhone(c);
  const externalId = `replay-${c.id}`;
  const digits = canonicalPhone(phone);

  let contact = await prismaBase.contact.findFirst({
    where: { organizationId, externalId },
    select: { id: true, phone: true, email: true },
  });
  if (!contact) {
    // prismaBase: seed de replay. createContact dispara ActivityEvent e o
    // banco DEV pode estar atrás do schema (sourceIsReconstructed).
    const max = await prismaBase.contact.aggregate({
      where: { organizationId },
      _max: { number: true },
    });
    const e164 =
      phone.startsWith("+") ? phone : digits ? `+55${digits}` : phone;
    contact = await prismaBase.contact.create({
      data: {
        organizationId,
        number: (max._max.number ?? 0) + 1,
        name,
        phone: e164,
        externalId,
        source: "replay-agent-runs",
      },
      select: { id: true, phone: true, email: true },
    });
  }

  const existing = await lookupStudent(organizationId, {
    phone: contact.phone ?? phone,
    email: contact.email,
    cpf: null,
  });
  if (existing.length) return { contactId: contact.id, seededRecord: false };

  await prismaBase.studentAcademicRecord.create({
    data: {
      organizationId,
      nome: name,
      phone: digits,
      rgm: `R${c.id}`,
      curso: "Pedagogia",
      polo: "EAD",
      serie: "1",
      instituicao: "Cruzeiro do Sul Virtual",
      situacao: "EM CURSO",
      tipoMatricula: "MATRICULA",
      emailAcademico: `replay.${c.id}@aluno.replay.local`,
      dataMatricula: new Date("2026-02-01T00:00:00.000Z"),
      raw: { replay: true, caseId: c.id },
    },
  });
  return { contactId: contact.id, seededRecord: true };
}

/** Marca do sandbox: usada para achar e para limpar o que o replay criou. */
const SANDBOX_CHANNEL = "replay_sandbox";

/**
 * Conversa sandbox com id real, para `executeOrchestratedHandoff` e o
 * assign rodarem de verdade. Sem conversationId o runner nunca chega na
 * atribuição — o harness testava só o que a tool devolvia.
 */
async function ensureReplayConversation(args: {
  organizationId: string;
  contactId: string;
  caseId: string;
  assignedToId: string;
}): Promise<string> {
  const externalId = `replay-sandbox-${args.caseId}`;
  const existing = await prismaBase.conversation.findFirst({
    where: { organizationId: args.organizationId, externalId },
    select: { id: true },
  });
  if (existing) {
    await prismaBase.conversation.update({
      where: { id: existing.id },
      data: { assignedToId: args.assignedToId, status: "OPEN" },
    });
    return existing.id;
  }
  const max = await prismaBase.conversation.aggregate({
    where: { organizationId: args.organizationId },
    _max: { number: true },
  });
  const created = await prismaBase.conversation.create({
    data: {
      organizationId: args.organizationId,
      number: (max._max.number ?? 0) + 1,
      contactId: args.contactId,
      channel: SANDBOX_CHANNEL,
      externalId,
      inboxName: "Replay (sandbox de teste)",
      assignedToId: args.assignedToId,
    },
    select: { id: true },
  });
  return created.id;
}

/** Eventos que o handoff gravou nesta conversa depois de `since`. */
async function readHandoffEvents(
  conversationId: string,
  since: Date,
): Promise<NonNullable<TurnRecord["dbHandoff"]>> {
  const [conv, events] = await Promise.all([
    prismaBase.conversation.findUnique({
      where: { id: conversationId },
      select: { assignedToId: true, assignedTo: { select: { name: true } } },
    }),
    prismaBase.message.findMany({
      where: {
        conversationId,
        isPrivate: true,
        createdAt: { gte: since },
      },
      select: { content: true, createdAt: true },
      orderBy: { createdAt: "asc" },
    }),
  ]);
  return {
    conversationId,
    assignedToId: conv?.assignedToId ?? null,
    assignedToName: conv?.assignedTo?.name ?? null,
    events: events.map((e) => ({
      content: e.content ?? "",
      createdAt: e.createdAt.toISOString(),
    })),
  };
}

/** Remove o sandbox. Sem isto a org de teste acumula conversa a cada replay. */
async function cleanupReplayConversations(
  organizationId: string,
  conversationIds: string[],
): Promise<void> {
  if (conversationIds.length === 0) return;
  // Ordem importa: o que referencia a conversa/contato sai antes dela.
  const convs = await prismaBase.conversation.findMany({
    where: { id: { in: conversationIds }, channel: SANDBOX_CHANNEL },
    select: { id: true, contactId: true },
  });
  const ids = convs.map((c) => c.id);
  const contactIds = [
    ...new Set(convs.map((c) => c.contactId).filter((v): v is string => !!v)),
  ];
  if (ids.length === 0) return;

  // Deals (e o que pende neles) que o turno criou no contato de sandbox.
  const deals = contactIds.length
    ? await prismaBase.deal.findMany({
        where: { organizationId, contactId: { in: contactIds } },
        select: { id: true },
      })
    : [];
  const dealIds = deals.map((d) => d.id);
  if (dealIds.length) {
    await prismaBase.dealEvent.deleteMany({ where: { dealId: { in: dealIds } } });
  }
  if (contactIds.length) {
    await prismaBase.activity.deleteMany({
      where: { organizationId, contactId: { in: contactIds } },
    });
  }
  await prismaBase.message.deleteMany({
    where: { conversationId: { in: ids } },
  });
  await prismaBase.conversation.deleteMany({
    where: { id: { in: ids }, channel: SANDBOX_CHANNEL },
  });
  if (dealIds.length) {
    await prismaBase.deal.deleteMany({ where: { id: { in: dealIds } } });
  }
  // O contato de replay é reaproveitado entre rodadas (e tem o registro
  // acadêmico fake pendurado nele). Não apaga: zera a atribuição para não
  // sobrar dono de um handoff de teste.
  if (contactIds.length) {
    await prismaBase.contact.updateMany({
      where: { organizationId, id: { in: contactIds } },
      data: { assignedToId: null },
    });
  }
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL ausente");
    process.exit(1);
  }

  const fixturesArg = arg("--fixtures");
  const fixturePath = fixturesArg ? resolve(fixturesArg) : null;
  const lote = arg("--lote", "1");
  const orgSlug = arg("--org", process.env.ORG_SLUG ?? "teste-dev");
  const startNeedle = arg(
    "--start",
    process.env.REPLAY_START_AGENT ?? "Joseph",
  );
  const onlyCase = arg("--case");
  const limitRaw = arg("--limit");
  const outPath = arg("--out", "replay-agent-runs.out.json");
  const delayMs = Number(arg("--delay", "0")) || 0;
  // Handoff de verdade: conversa sandbox com id real e tools sem simulação.
  const realHandoff = process.argv.includes("--real-handoff");
  const keepSandbox = process.argv.includes("--keep-sandbox");
  const sandboxConversationIds: string[] = [];

  let cases = loadFixtures(fixturePath, lote);
  if (onlyCase) cases = cases.filter((c) => c.id === onlyCase);
  const limit = Number(limitRaw);
  if (Number.isFinite(limit) && limit > 0) cases = cases.slice(0, limit);
  if (!cases.length) {
    console.error("nenhum caso para rodar");
    process.exit(1);
  }

  const org = await prismaBase.organization.findFirst({
    where: { slug: orgSlug },
    select: { id: true, slug: true, name: true },
  });
  if (!org) {
    console.error(`org slug=${orgSlug} não encontrada`);
    process.exit(1);
  }

  if (realHandoff) {
    // Fail-closed: o modo só roda em org marcada como de teste. A marca é
    // config da organização, não slug no código — produção nunca liga a
    // chave e o script aborta antes de tocar em qualquer linha.
    const flag = await prismaBase.organizationSetting.findFirst({
      where: { organizationId: org.id, key: REPLAY_SANDBOX_SETTING_KEY },
      select: { value: true },
    });
    if (flag?.value?.trim().toLowerCase() !== "true") {
      console.error(
        `--real-handoff recusado: org ${org.slug} não está marcada como org de teste ` +
          `(defina ${REPLAY_SANDBOX_SETTING_KEY}=true em organization_settings).`,
      );
      process.exit(1);
    }
    // Liga os guards de efeito colateral (SSE, distribuição, envio,
    // automação, atribuição a humano) antes do primeiro turno.
    enableReplaySandbox(org.id);
  }

  const dbAgents = await prismaBase.aIAgentConfig.findMany({
    where: { organizationId: org.id, active: true },
    select: {
      id: true,
      userId: true,
      archetype: true,
      inboxPolicy: true,
      verticalPack: true,
      user: { select: { name: true } },
    },
  });
  const agents: AgentRow[] = dbAgents.map((a) => ({
    id: a.id,
    userId: a.userId,
    archetype: a.archetype,
    inboxPolicy: a.inboxPolicy,
    verticalPack: a.verticalPack,
    name: a.user?.name ?? a.id,
  }));

  const start = findAgent(agents, startNeedle);
  if (!start) {
    console.error(
      `agente inicial "${startNeedle}" não encontrado. ativos:`,
      agents.map((a) => a.name).join(", "),
    );
    process.exit(1);
  }

  console.log(
    JSON.stringify({
      org: { id: org.id, slug: org.slug },
      start: {
        id: start.id,
        name: start.name,
        archetype: start.archetype,
        announceAiTransfer: normalizeInboxPolicy(
          start.inboxPolicy,
          start.verticalPack,
        ).announceAiTransfer,
      },
      agents: agents.map((a) => a.name),
      lote,
      cases: cases.map((c) => c.id),
    }),
  );

  const records: TurnRecord[] = [];

  await runWithContext(
    {
      organizationId: org.id,
      userId: start.userId,
      isSuperAdmin: false,
      actor: { type: "SYSTEM", label: "replay-agent-runs", ref: start.id },
    },
    async () => {
      for (const c of cases) {
        let current = start;
        const history: HistoryTurn[] = [];
        let skipReason: string | null = null;
        const identity = await ensureReplayStudent(org.id, c);
        const conversationId = realHandoff
          ? await ensureReplayConversation({
              organizationId: org.id,
              contactId: identity.contactId,
              caseId: c.id,
              assignedToId: start.userId,
            })
          : null;
        if (conversationId) sandboxConversationIds.push(conversationId);
        const cap = c.turns.length >= 10 ? " (teto 10)" : "";
        console.log("");
        console.log(
          `===== CASE ${c.id} ${c.label ?? ""} | ${c.turns.length} inbound${cap} =====`,
        );
        c.turns.forEach((t, i) => console.log(`  t${i} ${fixtureTurnInbound(t)}`));

        for (let i = 0; i < c.turns.length; i++) {
          const inbound = fixtureTurnInbound(c.turns[i]!);
          const speaker = current;

          if (skipReason) {
            records.push({
              caseId: c.id,
              turnIndex: i,
              at: new Date().toISOString(),
              inbound,
              agentId: speaker.id,
              agentName: speaker.name,
              llmInvoked: false,
              runId: null,
              status: null,
              text: "",
              tools: [],
              rule: null,
              switchedTo: null,
              skipped: skipReason,
            });
            logTurn(records[records.length - 1]!);
            continue;
          }

          const policy = normalizeInboxPolicy(
            speaker.inboxPolicy,
            speaker.verticalPack,
          );
          const ruleHit = evaluateMessageRules(inbound, policy.messageRules);
          const deptDest =
            ruleHit?.rule.action === "transfer_department"
              ? mapDepartmentToAgent(agents, ruleHit.rule.department ?? "")
              : null;
          const alreadyOnDeptDesk =
            ruleHit?.rule.action === "transfer_department" &&
            (!deptDest || deptDest.id === speaker.id);

          if (
            ruleHit &&
            ruleHit.rule.action !== "answer_with_knowledge" &&
            !alreadyOnDeptDesk &&
            !(
              speaker.archetype === "COORDENADOR" &&
              (ruleHit.rule.action === "assign_owner" ||
                ruleHit.rule.action === "transfer_human" ||
                ruleHit.rule.action === "transfer_department")
            )
          ) {
            let switchedTo: string | null = null;
            if (ruleHit.rule.action === "transfer_department") {
              const dest = mapDepartmentToAgent(
                agents,
                ruleHit.rule.department ?? "",
              );
              if (dest && dest.id !== speaker.id) {
                current = dest;
                switchedTo = dest.name;
              } else {
                skipReason = `rule_department:${ruleHit.rule.department ?? "?"}`;
              }
            } else if (ruleHit.rule.action === "transfer_human") {
              skipReason = "rule_human";
            } else if (ruleHit.rule.action === "assign_owner") {
              const extra = ruleHit.rule as {
                ownerUserId?: string | null;
                ownerLabel?: string | null;
              };
              const dest = findAgent(
                agents,
                extra.ownerUserId ?? extra.ownerLabel ?? "",
              );
              if (dest && dest.id !== speaker.id) {
                current = dest;
                switchedTo = dest.name;
              } else {
                skipReason = `rule_owner:${extra.ownerLabel ?? extra.ownerUserId ?? "?"}`;
              }
            }

            const text =
              ruleHit.rule.action === "fixed_reply"
                ? (ruleHit.rule.message ?? "")
                : `[regra] ${ruleHit.rule.label} → ${ruleHit.rule.action}`;
            history.push({ role: "user", content: inbound });
            if (text) history.push({ role: "assistant", content: text });

            records.push({
              caseId: c.id,
              turnIndex: i,
              at: new Date().toISOString(),
              inbound,
              agentId: speaker.id,
              agentName: speaker.name,
              llmInvoked: false,
              runId: null,
              status: "RULE",
              text,
              tools: [],
              rule: {
                action: ruleHit.rule.action,
                label: ruleHit.rule.label,
                department: ruleHit.rule.department,
              },
              switchedTo,
              skipped: null,
            });
            logTurn(records[records.length - 1]!);
            if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
            continue;
          }

          const turnStartedAt = new Date();
          const result = await runAgent({
            agentId: speaker.id,
            // Com conversa sandbox as tools de efeito executam de verdade;
            // sem ela, `inbox_test` simula (era o único modo do harness).
            source: conversationId ? "inbox" : "inbox_test",
            userMessage: inbound,
            history,
            historyLimit: MAX_HISTORY,
            contactId: identity.contactId,
            conversationId: conversationId ?? undefined,
          });
          const dbHandoff = conversationId
            ? await readHandoffEvents(conversationId, turnStartedAt)
            : null;

          history.push({ role: "user", content: inbound });
          if (result.text?.trim()) {
            history.push({ role: "assistant", content: result.text });
          }

          const applied = applyHandoff(agents, inspectHandoff(result.toolCalls));
          if (result.routing?.toAgentId) {
            const routed = agents.find((a) => a.id === result.routing!.toAgentId);
            if (routed) current = routed;
          } else if (applied.next && applied.next.id !== speaker.id) {
            current = applied.next;
          }
          if (applied.skip) skipReason = applied.skip;

          records.push({
            caseId: c.id,
            turnIndex: i,
            inbound,
            agentId: speaker.id,
            agentName: speaker.name,
            llmInvoked: true,
            runId: result.runId,
            status: result.status,
            text: result.text ?? "",
            tools: result.toolCalls,
            rule: ruleHit
              ? {
                  action: ruleHit.rule.action,
                  label: ruleHit.rule.label,
                  department: ruleHit.rule.department,
                }
              : null,
            switchedTo:
              result.routing && result.routing.toAgentId !== result.routing.fromAgentId
                ? current.name
                : applied.switchedTo,
            skipped: null,
            handoff: result.routing
              ? {
                  fromAgentId: result.routing.fromAgentId,
                  toAgentId: result.routing.toAgentId,
                  by: result.routing.by,
                }
              : null,
            dbHandoff,
          });
          logTurn(records[records.length - 1]!);

          if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        }
      }
    },
  );

  if (realHandoff && !keepSandbox) {
    await cleanupReplayConversations(org.id, sandboxConversationIds);
    console.log(`sandbox limpo (${sandboxConversationIds.length} conversas)`);
  } else if (realHandoff) {
    console.log(
      `sandbox preservado (--keep-sandbox): channel=${SANDBOX_CHANNEL}, ${sandboxConversationIds.length} conversas`,
    );
  }

  if (realHandoff) disableReplaySandbox();

  const report = {
    org: { id: org.id, slug: org.slug, name: org.name },
    realHandoff,
    // Cada efeito que teria saído do sandbox (envio, SSE, distribuição,
    // automação, dono humano) e foi recusado.
    sandboxBlocked: realHandoff ? blockedEffects() : [],
    startedAs: { id: start.id, name: start.name },
    at: new Date().toISOString(),
    turns: records,
  };

  writeFileSync(resolve(outPath), JSON.stringify(report, null, 2), "utf8");
  const txtPath = transcriptPathFor(outPath);
  writeFileSync(resolve(txtPath), formatTranscript(cases, records), "utf8");
  console.log(`wrote ${outPath} (${records.length} turns)`);
  console.log(`wrote ${txtPath} (transcrição completa)`);

  const qa = scoreReplay(records, cases);
  const qaText = formatQaReport(qa);
  console.log(qaText);
  const qaPath = outPath.replace(/\.json$/i, "") + ".qa.json";
  writeFileSync(
    resolve(qaPath),
    JSON.stringify({ fail: qa.fail, warn: qa.warn, findings: qa.findings }, null, 2),
    "utf8",
  );
  console.log(`wrote ${qaPath}`);
  if (qa.fail > 0 && process.argv.includes("--qa-continue") === false) {
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prismaBase.$disconnect();
  });
