/**
 * `#corrigir` pelo WhatsApp: quem está testando o agente v2 aponta o que a
 * resposta anterior errou (e o certo) sem sair da conversa.
 *
 * Quem pode: telefone na lista de números de teste (`allowedPhoneNumbers`)
 * de um agente v2 ativo — o mesmo critério do `#reset`. Para qualquer outro
 * número o texto segue como mensagem comum: nada revela o comando.
 *
 * O que faz:
 *  - `#corrigir <texto>`: grava a correção ligada à última resposta do
 *    agente nesta conversa, marca o turno (tela de testes e Feedback),
 *    confirma no WhatsApp e pede a sugestão de mudança para o rascunho. A
 *    correção passa a valer só nas conversas de teste (`corrections.ts`);
 *  - `#corrigir lista`: correções valendo nos testes do agente;
 *  - `#corrigir desfazer [nº]`: desfaz a última de quem pediu (ou a do nº);
 *  - `#corrigir` sozinho: explica o uso.
 * Não chama o modelo de atendimento, não mexe no estado da conversa e não
 * conta como turno do cliente. Nenhum domínio de cliente.
 */

import { prisma } from "@/lib/prisma";
import { getOrgIdOrNull } from "@/lib/request-context";
import { normalizePhoneDigits, phoneMatchesAllowlist } from "@/services/ai/phone-allowlist";
import { getLogger } from "@/lib/logger";

import {
  CORRECTION_LIMITS,
  activeTestCorrections,
  attachCorrectionToLog,
  createTestCorrection,
  draftCorrectionSuggestion,
  dropTestCorrection,
  lastPublishedVersion,
  listTestCorrections,
} from "./corrections";

const log = getLogger("ai-v2.correct");

export const V2_CORRECT_COMMAND = "#corrigir";
/** Toda resposta do comando começa assim: é como o histórico do agente a reconhece e ignora. */
export const V2_CORRECT_REPLY_PREFIX = "✏️ #corrigir";

export type V2CorrectCommand =
  | { kind: "add"; text: string }
  | { kind: "help" }
  | { kind: "list" }
  | { kind: "undo"; number: number | null };

/** Só vale no começo da mensagem: "quero #corrigir meu cadastro" é mensagem comum. */
export function parseV2CorrectCommand(raw: string | null | undefined): V2CorrectCommand | null {
  const text = (raw ?? "").trim();
  const m = text.match(/^#corrigir(?=$|[\s:,.\-–—])[\s:,.\-–—]*([\s\S]*)$/i);
  if (!m) return null;
  const rest = m[1].trim();
  if (!rest) return { kind: "help" };
  const bare = rest.toLowerCase().replace(/[.!?]+$/, "").trim();
  if (bare === "lista" || bare === "listar") return { kind: "list" };
  const undo = bare.match(/^desfazer(?:\s+(?:n[ºo°.]?\s*)?(\d{1,6}))?$/);
  if (undo) return { kind: "undo", number: undo[1] ? Number(undo[1]) : null };
  return { kind: "add", text: rest };
}

export function isV2CorrectCommand(raw: string | null | undefined): boolean {
  return parseV2CorrectCommand(raw) !== null;
}

/** Mensagem que o próprio comando mandou (confirmação, lista, ajuda). */
export function isV2CorrectReply(content: string | null | undefined): boolean {
  return (content ?? "").trimStart().startsWith(V2_CORRECT_REPLY_PREFIX);
}

type TestAgent = { agentConfigId: string; userId: string };
type LogRow = { id: string; agentId: string; prompt: string; inboundText: string; reply: string | null };

function phoneInList(phone: string | null | undefined, list: unknown): boolean {
  const items = Array.isArray(list) ? list.filter((p): p is string => typeof p === "string") : [];
  if (items.length === 0 || !phone) return false;
  const set = new Set(items.map((p) => normalizePhoneDigits(p)).filter(Boolean));
  return phoneMatchesAllowlist(phone, set);
}

/** Agentes v2 ativos em que este telefone é número de teste. Vazio = o comando não vale. */
async function testAgentsForPhone(orgId: string, phone: string | null): Promise<TestAgent[]> {
  if (!phone) return [];
  const agents = await (prisma as unknown as {
    aIAgentConfig: {
      findMany: (args: unknown) => Promise<Array<{ id: string; userId: string; simpleConfig: unknown }>>;
    };
  }).aIAgentConfig.findMany({
    where: { organizationId: orgId, engine: "simple", active: true },
    select: { id: true, userId: true, simpleConfig: true },
    orderBy: { createdAt: "asc" },
  });
  return agents
    .filter((a) => phoneInList(phone, (a.simpleConfig as { allowedPhoneNumbers?: unknown } | null)?.allowedPhoneNumbers))
    .map((a) => ({ agentConfigId: a.id, userId: a.userId }));
}

/**
 * Última resposta do agente nesta conversa, depois do último `#reset`.
 * É ela que o `#corrigir` corrige.
 */
async function lastAnsweredTurn(conversationId: string): Promise<LogRow | null> {
  const rows = await (prisma as unknown as {
    aISimpleTurnLog: { findMany: (args: unknown) => Promise<LogRow[]> };
  }).aISimpleTurnLog.findMany({
    where: { conversationId },
    select: { id: true, agentId: true, prompt: true, inboundText: true, reply: true },
    orderBy: { createdAt: "desc" },
    take: 8,
  });
  for (const r of rows) {
    if (r.prompt === "reset") return null;
    if (r.reply?.trim()) return r;
  }
  return null;
}

const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

const HELP = `${V2_CORRECT_REPLY_PREFIX} — escreva na mesma mensagem o que o agente errou e qual é o certo. Exemplo: #corrigir o prazo é de 10 dias, não 5.\nOutros: #corrigir lista · #corrigir desfazer`;

export async function handleV2CorrectCommand(input: {
  conversationId: string;
  contactId: string;
  messageId?: string | null;
  channel: "meta" | "baileys" | "messaging";
  userMessage: string;
}): Promise<boolean> {
  const command = parseV2CorrectCommand(input.userMessage);
  if (!command) return false;
  const orgId = getOrgIdOrNull();
  if (!orgId) return false;

  const contact = await prisma.contact.findUnique({
    where: { id: input.contactId },
    select: { phone: true },
  });
  const candidates = await testAgentsForPhone(orgId, contact?.phone ?? null);
  // Fora das listas de números de teste o comando não existe.
  if (candidates.length === 0) return false;

  // Webhook repetido não grava nem confirma duas vezes.
  if (input.messageId) {
    const { cache } = await import("@/lib/cache");
    if (!(await cache.tryClaim(`ai:v2-correct:${input.messageId}`, 600))) return true;
  }

  // O agente corrigido é o que respondeu por último nesta conversa — com
  // vários agentes em teste no mesmo número, não é necessariamente o primeiro.
  const turn = await lastAnsweredTurn(input.conversationId).catch(() => null);
  const turnAgent = turn ? candidates.find((a) => a.agentConfigId === turn.agentId) : undefined;
  const agent = turnAgent ?? candidates[0];
  const target = turnAgent ? turn : null;

  const { sendAgentMessage } = await import("@/services/ai/send-agent-message");
  const reply = async (text: string) => {
    await sendAgentMessage({
      conversationId: input.conversationId,
      contactId: input.contactId,
      agentUserId: agent.userId,
      autonomyMode: "AUTONOMOUS",
      text,
      channel: input.channel === "messaging" ? "meta" : input.channel,
      kind: "text",
      bypassAssigneeCheck: true,
      bypassDuplicateGuard: true,
    }).catch(() => null);
  };

  if (command.kind === "help") {
    await reply(HELP);
    return true;
  }

  if (command.kind === "list") {
    const active = await activeTestCorrections(orgId, agent.agentConfigId);
    await reply(
      active.length === 0
        ? `${V2_CORRECT_REPLY_PREFIX} — nenhuma correção valendo nos testes deste agente.`
        : [
            `${V2_CORRECT_REPLY_PREFIX} — correções valendo nos testes deste agente (${active.length}):`,
            ...active.map((c) => `nº ${c.number}${c.status === "applied" ? " (no rascunho)" : ""}: ${clip(c.text, 160)}`),
          ].join("\n"),
    );
    return true;
  }

  if (command.kind === "undo") {
    const pending = await listTestCorrections(orgId, agent.agentConfigId, ["pending"]);
    const chosen = command.number !== null
      ? pending.find((c) => c.number === command.number)
      : pending.find((c) => c.contactId === input.contactId);
    if (!chosen) {
      await reply(
        command.number !== null
          ? `${V2_CORRECT_REPLY_PREFIX} — não achei a correção nº ${command.number} pendente. Veja as que estão valendo com #corrigir lista.`
          : `${V2_CORRECT_REPLY_PREFIX} — você não tem correção pendente para desfazer.`,
      );
      return true;
    }
    const undone = await dropTestCorrection({ organizationId: orgId, agentId: agent.agentConfigId, id: chosen.id, userId: null, to: "undone" });
    await reply(
      undone
        ? `${V2_CORRECT_REPLY_PREFIX} — correção nº ${chosen.number} desfeita. Ela não vale mais nos testes.`
        : `${V2_CORRECT_REPLY_PREFIX} — a correção nº ${chosen.number} já tinha sido decidida.`,
    );
    log.info({ conversationId: input.conversationId, agentId: agent.agentConfigId, number: chosen.number }, "[ai-v2] #corrigir desfazer");
    return true;
  }

  if (!target) {
    await reply(`${V2_CORRECT_REPLY_PREFIX} — não achei uma resposta do agente nesta conversa para corrigir. Mande o comando logo depois da resposta errada.`);
    return true;
  }

  const active = await activeTestCorrections(orgId, agent.agentConfigId);
  if (active.length >= CORRECTION_LIMITS.maxActive) {
    await reply(`${V2_CORRECT_REPLY_PREFIX} — já são ${active.length} correções valendo nos testes deste agente. Aplique ou descarte algumas na tela de testes antes de mandar outra.`);
    return true;
  }

  const text = command.text.replace(/\s+/g, " ").trim();
  const correction = await createTestCorrection({
    organizationId: orgId,
    agentId: agent.agentConfigId,
    conversationId: input.conversationId,
    contactId: input.contactId,
    logId: target.id,
    question: target.inboundText ?? "",
    reply: target.reply ?? "",
    text,
    agentVersion: await lastPublishedVersion(agent.agentConfigId).catch(() => null),
  });
  await attachCorrectionToLog(target.id, correction).catch((err) => {
    log.warn({ err, logId: target.id }, "[ai-v2] #corrigir: turno não marcado");
  });

  const cut = text.length > CORRECTION_LIMITS.textChars ? ` (guardei os primeiros ${CORRECTION_LIMITS.textChars} caracteres)` : "";
  await reply(
    `${V2_CORRECT_REPLY_PREFIX} — correção nº ${correction.number} anotada sobre a resposta "${clip(target.reply ?? "", 60)}"${cut}. Já vale nos testes deste agente; a versão publicada não muda.\nPara desfazer: #corrigir desfazer`,
  );

  // Sugestão para o rascunho: depois da confirmação, sem segurar a mensagem.
  // Se falhar, a tela oferece gerar de novo.
  void draftCorrectionSuggestion({ organizationId: orgId, agentId: agent.agentConfigId, id: correction.id }).catch((err) => {
    log.warn({ err, correctionId: correction.id }, "[ai-v2] #corrigir: sugestão não gerada");
  });

  log.info({ conversationId: input.conversationId, agentId: agent.agentConfigId, number: correction.number }, "[ai-v2] #corrigir");
  return true;
}
