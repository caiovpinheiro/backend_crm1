/**
 * Modo de teste do agente, por conversa, ligado por comando no WhatsApp.
 *
 * Problema que isto resolve: hoje não existe jeito de conversar com o agente
 * em produção sem virar cobaia. Qualquer teste que chegue numa ferramenta de
 * efeito transfere de verdade, muda o responsável e suja o inbox — então o
 * operador testa no playground (que não tem inbound real, nem regra de
 * assunto, nem fila) ou não testa.
 *
 * Com o modo ligado o turno roda IGUAL à produção — LLM, base de
 * conhecimento, regras de assunto — mas nenhuma ferramenta de efeito executa
 * (`EFFECT_TOOLS`, a lista canônica em `effect-claims.ts`), a conversa não
 * entra em fila humana e `assignedToId` não muda. O modelo recebe de volta um
 * resultado dizendo que a chamada foi SIMULADA, e o operador recebe um
 * diagnóstico separado com o que teria acontecido.
 *
 * ## Segurança
 *
 * O comando só existe para telefone de usuário DA MESMA organização com
 * permissão `ai_agent:edit`. Para qualquer outro telefone o texto é uma
 * mensagem comum e segue para o agente — nunca respondemos "comando não
 * autorizado", porque isso revelaria que o comando existe.
 *
 * Não há lista solta em env: a autorização é derivada dos usuários da org
 * (`User.phone`) mais a permission. Cadastrar telefone e permissão já é
 * fluxo de operação; uma env a mais seria um segundo lugar para esquecer.
 *
 * ## Onde vive o estado
 *
 * Em Postgres (`Conversation.aiTestModeUntil` / `aiTestModeById`), não em
 * Redis. O `cache` deste projeto degrada para um Map de processo quando o
 * Redis pisca (circuit breaker), e perder o estado do modo significa executar
 * DE VERDADE a transferência que o operador estava simulando — falha aberta
 * justamente no recurso cuja razão de existir é não sofrer o efeito. Em
 * Postgres o estado sobrevive a restart de worker, vale para todas as
 * instâncias, expira por comparação de timestamp na leitura (sem depender de
 * eviction de chave) e chega de graça no lookup de conversa que o
 * inbox-handler já faz.
 */

import { checkPermission } from "@/lib/authz";
import { phoneMatchVariants } from "@/lib/phone";
import { prisma } from "@/lib/prisma";
import { getOrgIdOrNull } from "@/lib/request-context";
import { normalizePhoneDigits } from "@/services/ai/phone-allowlist";

/** Janela do modo. Ninguém deixa conversa real presa em teste por esquecimento. */
export const TEST_MODE_TTL_MINUTES = 30;

/** Permission que autoriza ligar o modo. Quem edita o agente pode testá-lo. */
export const TEST_MODE_PERMISSION = "ai_agent:edit" as const;

export type AiTestCommand = "start" | "stop";

/** Os comandos, como o operador digita. Curtos e em pt-BR. */
export const AI_TEST_COMMANDS: Record<AiTestCommand, string> = {
  start: "#iniciar",
  stop: "#fim",
};

function fold(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .trim();
}

/**
 * O texto é um comando de teste?
 *
 * Exige o `#` e a primeira palavra inteira — "#iniciar" liga o modo, "queria
 * iniciar uma matrícula" é conversa. Aceita pontuação final.
 */
export function parseAiTestCommand(
  raw: string | null | undefined,
): AiTestCommand | null {
  const text = fold(raw ?? "").replace(/[.!?\s]+$/, "");
  if (!text.startsWith("#")) return null;
  const head = text.split(/\s+/)[0];
  for (const [command, literal] of Object.entries(AI_TEST_COMMANDS) as Array<
    [AiTestCommand, string]
  >) {
    if (head === literal) return command;
  }
  return null;
}

// ── Estado ──────────────────────────────────────────────────

export type TestModeState = {
  activeUntil: Date;
  byUserId: string | null;
};

/** Linha de conversa com o mínimo para decidir. */
export type TestModeColumns = {
  aiTestModeUntil?: Date | null;
  aiTestModeById?: string | null;
};

/**
 * Modo ativo NESTE instante. A expiração é comparação de timestamp na
 * leitura: nenhum cron precisa passar limpando, e um worker que acorda depois
 * da janela já lê o modo como desligado.
 */
export function readTestMode(
  conversation: TestModeColumns | null | undefined,
  now: Date = new Date(),
): TestModeState | null {
  const until = conversation?.aiTestModeUntil ?? null;
  if (!until) return null;
  if (until.getTime() <= now.getTime()) return null;
  return { activeUntil: until, byUserId: conversation?.aiTestModeById ?? null };
}

export async function startTestMode(args: {
  conversationId: string;
  userId: string;
  now?: Date;
}): Promise<TestModeState> {
  const now = args.now ?? new Date();
  const activeUntil = new Date(now.getTime() + TEST_MODE_TTL_MINUTES * 60_000);
  await prisma.conversation.update({
    where: { id: args.conversationId },
    data: { aiTestModeUntil: activeUntil, aiTestModeById: args.userId },
  });
  return { activeUntil, byUserId: args.userId };
}

export async function stopTestMode(conversationId: string): Promise<void> {
  await prisma.conversation.update({
    where: { id: conversationId },
    data: { aiTestModeUntil: null, aiTestModeById: null },
  });
}

// ── Autorização por telefone ────────────────────────────────

export type TestModeOperator = { userId: string; name: string };

/**
 * Usuário da organização corrente cujo telefone cadastrado é o telefone deste
 * contato E que tem permissão de editar agente.
 *
 * `null` = ninguém. O chamador trata a mensagem como texto comum; NÃO
 * responde nada sobre comando.
 *
 * A busca é sempre dentro da org do contexto (`prisma` scoped + filtro
 * explícito), então o telefone de um operador da org A nunca liga o modo numa
 * conversa da org B mesmo que o mesmo número exista nas duas.
 */
export async function resolveTestModeOperator(
  contactId: string,
): Promise<TestModeOperator | null> {
  const orgId = getOrgIdOrNull();
  if (!orgId) return null;

  const contact = await prisma.contact.findUnique({
    where: { id: contactId },
    select: { phone: true, whatsappJid: true, whatsappUsername: true },
  });
  if (!contact) return null;

  const candidates = new Set(
    [
      contact.phone,
      contact.whatsappJid?.split("@")[0] ?? null,
      contact.whatsappUsername,
    ]
      .map((c) => normalizePhoneDigits(c))
      .filter((d) => d.length >= 10),
  );
  if (candidates.size === 0) return null;

  // Operadores da org com telefone cadastrado. A lista é pequena (equipe), e
  // comparar em memória evita depender do formato exato gravado no perfil —
  // "(35) 99982-1871" e "5535999821871" precisam casar.
  const users = await prisma.user.findMany({
    where: {
      organizationId: orgId,
      type: "HUMAN",
      phone: { not: null },
    },
    select: { id: true, name: true, phone: true },
  });

  for (const user of users) {
    const variants = new Set(
      [
        normalizePhoneDigits(user.phone),
        ...phoneMatchVariants(user.phone).map((v) => normalizePhoneDigits(v)),
      ].filter(Boolean),
    );
    const matched = [...candidates].some((c) => variants.has(c));
    if (!matched) continue;

    const allowed = await checkPermission(
      { userId: user.id, organizationId: orgId, isSuperAdmin: false },
      TEST_MODE_PERMISSION,
    );
    if (!allowed) continue;
    return { userId: user.id, name: user.name };
  }

  return null;
}

// ── Cópia das respostas de comando ──────────────────────────

function clock(at: Date): string {
  return at.toLocaleTimeString("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: "America/Sao_Paulo",
  });
}

export function testModeStartedMessage(state: TestModeState): string {
  return `🧪 Modo de teste ligado: transferência, fila, negócio, etapa, template e encerramento estão desligados. Expira às ${clock(state.activeUntil)} (${TEST_MODE_TTL_MINUTES} min) ou com ${AI_TEST_COMMANDS.stop}.`;
}

export function testModeStoppedMessage(): string {
  return "🧪 Modo de teste desligado. A conversa voltou ao comportamento normal.";
}

// ── Comando vindo do WhatsApp ───────────────────────────────

function logTest(event: string, payload: Record<string, unknown>) {
  console.info(
    "[ai-test]",
    JSON.stringify({ event, ts: new Date().toISOString(), ...payload }),
  );
}

export type HandleTestCommandInput = {
  conversationId: string;
  contactId: string;
  command: AiTestCommand;
  channel: "meta" | "baileys" | "messaging";
  /** Id da Message — claim contra webhook repetido. */
  messageId?: string | null;
};

/**
 * Executa o comando quando o telefone é de um operador autorizado.
 *
 * @returns `true` quando o comando foi consumido (o ingest para aqui).
 *          `false` quando NÃO houve autorização — e aí o texto segue como
 *          mensagem comum para o agente. Nunca respondemos nada indicando
 *          que um comando existe: um cliente que digite "/teste" recebe o
 *          atendimento normal, e não uma recusa que entregaria o recurso.
 */
export async function handleAiTestCommand(
  input: HandleTestCommandInput,
): Promise<boolean> {
  const operator = await resolveTestModeOperator(input.contactId);
  if (!operator) return false;

  // Webhook repetido não pode ligar o modo duas vezes nem mandar duas
  // confirmações. Chave própria: o claim do fluxo normal de inbound não deve
  // ser consumido por um comando que nem vai virar turno.
  if (input.messageId) {
    const { cache } = await import("@/lib/cache");
    const fresh = await cache.tryClaim(
      `ai:test-cmd:${input.messageId}`,
      600,
    );
    if (!fresh) return true;
  }

  const conversation = await prisma.conversation.findUnique({
    where: { id: input.conversationId },
    select: {
      id: true,
      aiTestModeUntil: true,
      aiTestModeById: true,
      assignedToId: true,
      assignedTo: { select: { id: true, type: true } },
    },
  });
  if (!conversation) return true;

  const current = readTestMode(conversation);

  if (input.command === "stop") {
    if (current) await stopTestMode(input.conversationId);
    await replyAsAgent(input, conversation, testModeStoppedMessage());
    logTest("stopped", {
      conversationId: input.conversationId,
      userId: operator.userId,
    });
    return true;
  }

  const state = await startTestMode({
    conversationId: input.conversationId,
    userId: operator.userId,
  });
  // Sem agente na conversa o teste não teria com quem falar. Atribuir aqui é
  // ação explícita do operador autorizado — não é efeito do agente — e nunca
  // tira a conversa de um humano.
  const attached = await attachAiAgentIfFree(conversation);
  await replyAsAgent(
    input,
    { ...conversation, assignedTo: attached ?? conversation.assignedTo },
    attached
      ? testModeStartedMessage(state)
      : `${testModeStartedMessage(state)}\n\n⚠️ Esta conversa está com um atendente humano — o agente não vai responder até ela voltar para a IA.`,
  );
  logTest("started", {
    conversationId: input.conversationId,
    userId: operator.userId,
    until: state.activeUntil.toISOString(),
    agentUserId: attached?.id ?? null,
  });
  return true;
}

type ConversationAssignee = { id: string; type: string } | null;

/**
 * Coloca a conversa com o agente IA da org quando ela está livre (ou já é da
 * IA). Conversa com humano é devolvida como está — o teste não rouba chat.
 */
async function attachAiAgentIfFree(conversation: {
  id: string;
  assignedToId: string | null;
  assignedTo: ConversationAssignee;
}): Promise<ConversationAssignee> {
  if (conversation.assignedTo?.type === "AI") return conversation.assignedTo;
  if (conversation.assignedTo?.type === "HUMAN") return null;

  const orgId = getOrgIdOrNull();
  if (!orgId) return null;
  const agent = await prisma.user.findFirst({
    where: {
      organizationId: orgId,
      type: "AI",
      aiAgentConfig: { active: true, autonomyMode: "AUTONOMOUS" },
    },
    select: { id: true, type: true },
    orderBy: { createdAt: "asc" },
  });
  if (!agent) return null;

  await prisma.conversation.update({
    where: { id: conversation.id },
    data: { assignedToId: agent.id },
  });
  return agent;
}

/** Resposta do comando sai pelo agente — é a bolha que o operador espera. */
async function replyAsAgent(
  input: HandleTestCommandInput,
  conversation: { assignedTo: ConversationAssignee },
  text: string,
): Promise<void> {
  const agentUserId =
    conversation.assignedTo?.type === "AI" ? conversation.assignedTo.id : null;
  if (!agentUserId) {
    logTest("reply_skipped_no_agent", {
      conversationId: input.conversationId,
    });
    return;
  }
  const { sendAgentMessage } = await import("@/services/ai/piloting-actions");
  await sendAgentMessage({
    conversationId: input.conversationId,
    contactId: input.contactId,
    agentUserId,
    autonomyMode: "AUTONOMOUS",
    text,
    channel: input.channel === "messaging" ? "meta" : input.channel,
    kind: "text",
    bypassAssigneeCheck: true,
  }).catch(() => null);
}
