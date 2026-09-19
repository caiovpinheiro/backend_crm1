/**
 * Dump de auditoria dos agentes IA de uma organização — SOMENTE LEITURA.
 *
 * Roda dentro do container (EasyPanel) e escreve um JSON com a config de
 * cada agente e os últimos runs com o trace de mensagens. PII de contato
 * sai mascarada e nenhum segredo é lido: a chave OpenAI do agente não
 * entra no select.
 *
 * EasyPanel (/app, depois do deploy):
 *   node dist/workers/dump-agent-audit.js --org teste-dev
 *   node dist/workers/dump-agent-audit.js --org teste-dev --runs 50 --out /tmp/agent-audit.json
 *
 * Local:
 *   npx tsx src/scripts/dump-agent-audit.ts --org teste-dev
 *
 * prismaBase: script fora de RequestContext (resolve a org pelo slug).
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { normalizeInboxPolicy } from "@/lib/ai-agents/steering";
import { prismaBase } from "@/lib/prisma-base";

function arg(flag: string, fallback = ""): string {
  const i = process.argv.indexOf(flag);
  if (i < 0) return fallback;
  return process.argv[i + 1] ?? fallback;
}

/** Mantém o formato reconhecível e remove o dado: "Maria Silva" → "Ma*** S***". */
function maskName(v?: string | null): string | null {
  const s = v?.trim();
  if (!s) return null;
  return s
    .split(/\s+/)
    .map((w) => (w.length <= 2 ? `${w[0] ?? ""}*` : `${w.slice(0, 2)}***`))
    .join(" ");
}

function maskPhone(v?: string | null): string | null {
  const digits = (v ?? "").replace(/\D/g, "");
  if (!digits) return null;
  return `***${digits.slice(-4)}`;
}

function maskEmail(v?: string | null): string | null {
  const s = v?.trim();
  if (!s || !s.includes("@")) return s ? "***" : null;
  const [user, domain] = s.split("@");
  return `${user.slice(0, 2)}***@${domain}`;
}

const CPF_RE = /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g;
const PHONE_RE = /\b\+?\d{2}\s?\(?\d{2}\)?\s?9?\d{4}[-\s]?\d{4}\b/g;
const EMAIL_RE = /\b[\w.+-]+@[\w.-]+\.\w{2,}\b/g;
/** Nada de token/chave no arquivo, mesmo que um prompt tenha colado um. */
const SECRET_RE =
  /\b(sk-[A-Za-z0-9_-]{16,}|eduit_[A-Za-z0-9_-]{8,}|EAA[A-Za-z0-9]{20,}|Bearer\s+[A-Za-z0-9._-]{16,})/g;

function maskText<T>(value: T): T {
  if (typeof value === "string") {
    return value
      .replace(SECRET_RE, "[REDACTED]")
      .replace(CPF_RE, "[CPF]")
      .replace(EMAIL_RE, "[EMAIL]")
      .replace(PHONE_RE, "[PHONE]") as unknown as T;
  }
  if (Array.isArray(value)) return value.map(maskText) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = maskText(v);
    }
    return out as unknown as T;
  }
  return value;
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL ausente");
    process.exit(1);
  }

  const orgSlug = arg("--org", process.env.ORG_SLUG ?? "teste-dev");
  const runLimit = Number(arg("--runs", "30")) || 30;
  const outPath = arg("--out", "/tmp/agent-audit.json");

  const org = await prismaBase.organization.findFirst({
    where: { slug: orgSlug },
    select: { id: true, slug: true, name: true },
  });
  if (!org) {
    console.error(`org slug=${orgSlug} não encontrada`);
    process.exit(1);
  }

  const agents = await prismaBase.aIAgentConfig.findMany({
    where: { organizationId: org.id },
    select: {
      id: true,
      userId: true,
      active: true,
      archetype: true,
      model: true,
      temperature: true,
      autonomyMode: true,
      enabledTools: true,
      toolConfig: true,
      inboxPolicy: true,
      steeringRules: true,
      systemPromptTemplate: true,
      systemPromptOverride: true,
      verticalPack: true,
      user: { select: { name: true } },
    },
  });

  const agentDump = agents.map((a) => {
    const policy = normalizeInboxPolicy(a.inboxPolicy, a.verticalPack);
    return maskText({
      id: a.id,
      userId: a.userId,
      userName: a.user?.name ?? null,
      active: a.active,
      archetype: a.archetype,
      model: a.model,
      temperature: a.temperature,
      autonomyMode: a.autonomyMode,
      verticalPack: a.verticalPack,
      enabledTools: a.enabledTools,
      toolConfig: a.toolConfig,
      inboxPolicy: a.inboxPolicy,
      // Campo do roteamento do coordenador, já normalizado: o JSON cru
      // pode não ter a chave (agente salvo antes do P1-A).
      routingScope: policy.routingScope,
      steeringRules: a.steeringRules,
      systemPromptTemplate: a.systemPromptTemplate,
      systemPromptOverride: a.systemPromptOverride,
    });
  });

  const runs = await prismaBase.aIAgentRun.findMany({
    where: { organizationId: org.id },
    orderBy: { createdAt: "desc" },
    take: runLimit,
    select: {
      id: true,
      agentId: true,
      source: true,
      status: true,
      outcome: true,
      confidence: true,
      handoffReason: true,
      conversationId: true,
      contactId: true,
      createdAt: true,
      responsePreview: true,
      messages: {
        select: {
          id: true,
          role: true,
          content: true,
          toolName: true,
          toolData: true,
          systemPromptSnapshot: true,
          createdAt: true,
        },
        orderBy: { createdAt: "asc" },
      },
    },
  });

  const contactIds = [
    ...new Set(runs.map((r) => r.contactId).filter((v): v is string => !!v)),
  ];
  const contacts = contactIds.length
    ? await prismaBase.contact.findMany({
        where: { id: { in: contactIds } },
        select: { id: true, name: true, phone: true, email: true },
      })
    : [];

  const dump = {
    generatedAt: new Date().toISOString(),
    org: { id: org.id, slug: org.slug, name: org.name },
    agents: agentDump,
    runs: runs.map((r) => maskText({ ...r, createdAt: r.createdAt.toISOString() })),
    contacts: contacts.map((c) => ({
      id: c.id,
      name: maskName(c.name),
      phone: maskPhone(c.phone),
      email: maskEmail(c.email),
    })),
  };

  writeFileSync(resolve(outPath), JSON.stringify(dump, null, 2), "utf8");
  console.log(
    `wrote ${outPath} (${agentDump.length} agentes, ${runs.length} runs, ${contacts.length} contatos)`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prismaBase.$disconnect();
  });
