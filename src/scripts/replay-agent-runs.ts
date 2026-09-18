/**
 * Replay em lote: falas do aluno → runAgent, troca de agente pela tool.
 *
 * Não cria conversa WhatsApp. transfer_* falha com "sem conversa"; o harness
 * lê os ARGS da tool e passa o próximo turno para o destino.
 *
 * Local:
 *   npx tsx src/scripts/replay-agent-runs.ts --org teste-dev --start Joseph
 *
 * EasyPanel (/app, depois do deploy — a imagem não tem src/ nem tsx):
 *   node dist/workers/replay-agent-runs.js --org teste-dev --start Joseph
 *
 * Env: DATABASE_URL; opcional ORG_SLUG / REPLAY_START_AGENT.
 * prismaBase: script fora de RequestContext até achar a org; o loop usa
 * runWithContext + runAgent (prisma scoped).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import bundledFixtures from "./fixtures/joseph-replay-cases.json";
import { evaluateMessageRules } from "@/lib/ai-agents/message-rules";
import { normalizeInboxPolicy } from "@/lib/ai-agents/steering";
import { prismaBase } from "@/lib/prisma-base";
import { runWithContext } from "@/lib/request-context";
import { runAgent, type RunResult } from "@/services/ai/runner";

type FixtureCase = { id: string; label: string; turns: string[] };
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

function clip(s: string, n = 240): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= n ? t : t.slice(0, n) + "…";
}

function loadFixtures(path: string | null): FixtureCase[] {
  const raw = (
    path
      ? (JSON.parse(readFileSync(path, "utf8")) as FixtureFile)
      : (bundledFixtures as FixtureFile)
  );
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

function inspectHandoff(calls: RunResult["toolCalls"]): {
  kind: "ai_agent" | "department" | "human" | null;
  name: string;
} {
  for (const c of calls) {
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

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL ausente");
    process.exit(1);
  }

  const fixturesArg = arg("--fixtures");
  const fixturePath = fixturesArg ? resolve(fixturesArg) : null;
  const orgSlug = arg("--org", process.env.ORG_SLUG ?? "teste-dev");
  const startNeedle = arg(
    "--start",
    process.env.REPLAY_START_AGENT ?? "Joseph",
  );
  const onlyCase = arg("--case");
  const limitRaw = arg("--limit");
  const outPath = arg("--out", "replay-agent-runs.out.json");
  const delayMs = Number(arg("--delay", "0")) || 0;

  let cases = loadFixtures(fixturePath);
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
      start: { id: start.id, name: start.name, archetype: start.archetype },
      agents: agents.map((a) => a.name),
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

        for (let i = 0; i < c.turns.length; i++) {
          const inbound = c.turns[i] ?? "";
          const speaker = current;

          if (skipReason) {
            records.push({
              caseId: c.id,
              turnIndex: i,
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
            continue;
          }

          const policy = normalizeInboxPolicy(
            speaker.inboxPolicy,
            speaker.verticalPack,
          );
          const ruleHit = evaluateMessageRules(inbound, policy.messageRules);

          if (ruleHit && ruleHit.rule.action !== "answer_with_knowledge") {
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
            if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
            continue;
          }

          const result = await runAgent({
            agentId: speaker.id,
            source: "playground",
            userMessage: inbound,
            history: history.slice(-10),
          });

          history.push({ role: "user", content: inbound });
          if (result.text?.trim()) {
            history.push({ role: "assistant", content: result.text });
          }

          const applied = applyHandoff(agents, inspectHandoff(result.toolCalls));
          if (applied.next && applied.next.id !== speaker.id) {
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
            switchedTo: applied.switchedTo,
            skipped: null,
          });

          if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
        }
      }
    },
  );

  const report = {
    org: { id: org.id, slug: org.slug, name: org.name },
    startedAs: { id: start.id, name: start.name },
    at: new Date().toISOString(),
    turns: records,
  };

  for (const r of records) {
    const tools = r.tools.map((t) => t.name).join(",") || "-";
    console.log(
      [
        r.caseId,
        `t${r.turnIndex}`,
        r.agentName,
        r.skipped ? `SKIP ${r.skipped}` : r.status,
        r.switchedTo ? `→ ${r.switchedTo}` : "",
        tools,
        clip(r.inbound, 60),
        clip(r.text, 80),
      ]
        .filter(Boolean)
        .join(" | "),
    );
  }

  writeFileSync(resolve(outPath), JSON.stringify(report, null, 2), "utf8");
  console.log(`wrote ${outPath}`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prismaBase.$disconnect();
  });
