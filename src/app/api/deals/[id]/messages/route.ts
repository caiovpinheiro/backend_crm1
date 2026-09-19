/**
 * Envio de mensagem a partir de um Deal — porta de entrada das integrações.
 *
 * Existe porque enviar pelo CRM exigia um `conversationId`, que integrações
 * (node do n8n) não têm: elas conhecem o negócio. Antes era preciso encadear
 * `GET /api/deals/:id` → `GET /api/conversations?contactId=` → criar conversa
 * (essa última só por sessão, o que travava o fluxo). Aqui a resolução da
 * conversa acontece server-side, com a MESMA regra da automação
 * (`ensureWhatsAppConversationForContact`): reusa o ticket ativo do contato e
 * cria um novo no canal Meta padrão da org quando não existe.
 *
 * Autenticação híbrida (Bearer OU sessão). O envio em si vive em
 * `services/outbound-messaging`, compartilhado com o composer do inbox — as
 * regras de escopo de canal, reabertura de ticket, SSE e activity log são
 * exatamente as mesmas de uma mensagem enviada por um operador.
 *
 * Body:
 *   kind          "note" | "text" | "template"  (obrigatório)
 *   content       texto da nota ou da mensagem  (note | text)
 *   templateName  nome do template aprovado na WABA        (template)
 *   languageCode  idioma do template; default "pt_BR"      (template)
 *   variables     [{ component?, key, value, buttonIndex? }] — o servidor
 *                 monta o `components` da Cloud API; evita JSON manual
 *   components    escape hatch: array Cloud API pronto (ignora `variables`)
 *   bodyPreview   corpo do template; renderizado com as variáveis e usado
 *                 como texto da mensagem na timeline
 *   flowToken / flowActionData  — templates com botão Flow
 *   channelId     override do WhatsApp de saída (orgs com mais de um)
 *   stopAutomations  default true: encerra automações ativas do contato, como
 *                 faz a resposta de um operador. `false` mantém o salesbot.
 */

import { NextResponse } from "next/server";

import { authenticateApiRequest, runWithApiUserContext } from "@/lib/api-auth";
import {
  buildTemplateComponents,
  renderTemplatePreview,
  type TemplateVariableComponent,
  type TemplateVariableInput,
} from "@/lib/meta-whatsapp/build-template-components";
import { prisma } from "@/lib/prisma";
import { withOrgFromCtx } from "@/lib/prisma-helpers";
import { withRateLimit } from "@/lib/rate-limit";
import { createDealEvent } from "@/services/deals";
import {
  createInternalNoteOnConversation,
  sendInteractiveButtonsToConversation,
  sendInteractiveListToConversation,
  sendTemplateToConversation,
  sendTextToConversation,
  type OutboundActor,
  type OutboundButton,
  type OutboundListRow,
  type OutboundResult,
} from "@/services/outbound-messaging";
import { ensureWhatsAppConversationForContact } from "@/services/whatsapp-conversation";

type Ctx = { params: Promise<{ id: string }> };

const VALID_KINDS = ["note", "text", "template", "interactive", "list"] as const;
type MessageKind = (typeof VALID_KINDS)[number];

const VALID_COMPONENTS: TemplateVariableComponent[] = ["body", "header", "button"];

/**
 * Aceita `[{ id?, title, description? }]` (usada pelo node) ou lista curta
 * `["Opção 1","Opção 2"]` (chamadas manuais). Preserva a ordem — vira o
 * layout da lista no WhatsApp. IDs em branco viram `row_1..10` no service.
 */
function parseRows(raw: unknown): OutboundListRow[] {
  if (!Array.isArray(raw)) return [];
  const out: OutboundListRow[] = [];
  for (const entry of raw) {
    if (typeof entry === "string") {
      const title = entry.trim();
      if (title) out.push({ title });
      continue;
    }
    if (entry && typeof entry === "object") {
      const r = entry as Record<string, unknown>;
      const title = typeof r.title === "string" ? r.title.trim() : "";
      if (!title) continue;
      const id = typeof r.id === "string" && r.id.trim() ? r.id.trim() : null;
      const description =
        typeof r.description === "string" && r.description.trim()
          ? r.description.trim()
          : null;
      out.push({ title, id, description });
    }
  }
  return out;
}

/**
 * Aceita a lista `[{ id?, title }]` (usada pelo node) ou o formato curto
 * `["Sim","Não"]` (chamadas manuais). Preserva a ordem — a Meta usa a ordem
 * como layout dos botões. IDs em branco viram `btn_1..3` no service.
 */
function parseButtons(raw: unknown): OutboundButton[] {
  if (!Array.isArray(raw)) return [];
  const out: OutboundButton[] = [];
  for (const entry of raw) {
    if (typeof entry === "string") {
      const title = entry.trim();
      if (title) out.push({ title });
      continue;
    }
    if (entry && typeof entry === "object") {
      const r = entry as Record<string, unknown>;
      const title = typeof r.title === "string" ? r.title.trim() : "";
      if (!title) continue;
      const id =
        typeof r.id === "string" && r.id.trim()
          ? r.id.trim()
          : null;
      out.push({ id, title });
    }
  }
  return out;
}

/**
 * Aceita tanto a lista explícita (`[{ key, value }]`, usada pelo node) quanto
 * o mapa curto (`{ "1": "João" }`), conveniente em chamadas manuais.
 */
function parseVariables(raw: unknown): TemplateVariableInput[] {
  if (Array.isArray(raw)) {
    const out: TemplateVariableInput[] = [];
    for (const entry of raw) {
      if (!entry || typeof entry !== "object") continue;
      const r = entry as Record<string, unknown>;
      const key = typeof r.key === "string" ? r.key.trim() : "";
      if (!key) continue;
      const component =
        typeof r.component === "string" &&
        VALID_COMPONENTS.includes(r.component as TemplateVariableComponent)
          ? (r.component as TemplateVariableComponent)
          : "body";
      out.push({
        component,
        key,
        value: r.value == null ? "" : String(r.value),
        ...(typeof r.buttonIndex === "number" ? { buttonIndex: r.buttonIndex } : {}),
      });
    }
    return out;
  }
  if (raw && typeof raw === "object") {
    return Object.entries(raw as Record<string, unknown>).map(([key, value]) => ({
      component: "body" as const,
      key,
      value: value == null ? "" : String(value),
    }));
  }
  return [];
}

/**
 * Nota quando o contato não tem (e não pode ter) conversa de WhatsApp — sem
 * telefone, ou org sem canal Meta conectado. Mantém a nota visível na aba
 * "Notas" do deal em vez de falhar o passo do workflow.
 */
async function createDealOnlyNote(args: {
  dealId: string;
  contactId: string | null;
  actor: OutboundActor;
  content: string;
}): Promise<NextResponse> {
  const note = await prisma.note.create({
    data: withOrgFromCtx({
      content: args.content,
      dealId: args.dealId,
      contactId: args.contactId ?? undefined,
      userId: args.actor.id,
    }),
    include: { user: { select: { id: true, name: true } } },
  });

  createDealEvent(args.dealId, args.actor.id, "NOTE_ADDED", {
    noteId: note.id,
    preview: args.content.slice(0, 200),
    source: "deal_messages_endpoint",
    isPrivate: true,
  }).catch(() => {});

  return NextResponse.json(
    {
      kind: "note",
      dealId: args.dealId,
      conversationId: null,
      note,
      mirroredToInbox: false,
      warning:
        "Nota registrada apenas no negócio: o contato não tem conversa de WhatsApp e não foi possível abrir uma (sem telefone ou sem canal Meta conectado).",
    },
    { status: 201 },
  );
}

function toResponse(kind: MessageKind, dealId: string, result: OutboundResult): NextResponse {
  if (!result.ok) {
    return NextResponse.json({ message: result.message }, { status: result.status });
  }
  return NextResponse.json(
    {
      kind,
      dealId,
      conversationId: result.conversationId,
      message: result.message,
      ...(result.reopenedConversationId
        ? { reopenedConversationId: result.reopenedConversationId }
        : {}),
      ...(result.metaError ? { metaError: result.metaError } : {}),
    },
    { status: 201 },
  );
}

export async function POST(request: Request, ctx: Ctx) {
  const authResult = await authenticateApiRequest(request);
  if (!authResult.ok) return authResult.response;

  const rl = await withRateLimit({
    route: "/api/deals/:id/messages",
    profile: "api.default",
    scope: "org",
    id: authResult.user.organizationId,
  });
  if (!rl.ok) return rl.response;

  return await runWithApiUserContext(authResult.user, async () => {
    try {
      const { id: dealId } = await ctx.params;
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;

      const kind = typeof body.kind === "string" ? (body.kind.trim() as MessageKind) : "text";
      if (!VALID_KINDS.includes(kind)) {
        return NextResponse.json(
          { message: `kind inválido. Use um de: ${VALID_KINDS.join(", ")}.` },
          { status: 400 },
        );
      }

      const deal = await prisma.deal.findUnique({
        where: { id: dealId },
        select: { id: true, contactId: true },
      });
      // 404 (não 403) para não vazar existência entre orgs — a Prisma
      // Extension já filtrou por organizationId.
      if (!deal) return NextResponse.json({ message: "Deal não encontrado." }, { status: 404 });

      const actor: OutboundActor = {
        id: authResult.user.id,
        name: authResult.user.name,
        email: authResult.user.email,
        role: authResult.user.role,
        organizationId: authResult.user.organizationId,
        isSuperAdmin: authResult.user.isSuperAdmin,
      };

      const content = typeof body.content === "string" ? body.content.trim() : "";
      if ((kind === "note" || kind === "text") && !content) {
        return NextResponse.json(
          { message: "content é obrigatório para nota e texto." },
          { status: 400 },
        );
      }

      if (!deal.contactId) {
        if (kind === "note") {
          return createDealOnlyNote({ dealId, contactId: null, actor, content });
        }
        return NextResponse.json(
          { message: "Negócio sem contato vinculado: não há para quem enviar." },
          { status: 400 },
        );
      }

      const ensured = await ensureWhatsAppConversationForContact(deal.contactId);
      if (!("conversationId" in ensured)) {
        if (kind === "note") {
          return createDealOnlyNote({ dealId, contactId: deal.contactId, actor, content });
        }
        const reason =
          ensured.status === "skipped_no_phone"
            ? "Contato sem telefone nem BSUID WhatsApp."
            : ensured.status === "skipped_no_channel"
              ? "Organização sem canal WhatsApp Meta conectado."
              : "Contato não encontrado.";
        return NextResponse.json(
          { message: `Não foi possível abrir conversa para o contato: ${reason}` },
          { status: 400 },
        );
      }

      const conversationId = ensured.conversationId;

      if (kind === "note") {
        return toResponse(
          kind,
          dealId,
          await createInternalNoteOnConversation({ conversationId, actor, content, dealId }),
        );
      }

      if (kind === "text") {
        return toResponse(
          kind,
          dealId,
          await sendTextToConversation({
            conversationId,
            actor,
            content,
            channelId: typeof body.channelId === "string" ? body.channelId : null,
            stopAutomations: body.stopAutomations !== false,
          }),
        );
      }

      if (kind === "interactive") {
        // `body.body` = texto principal exibido acima dos botões. Usamos o nome
        // `body` (padrão da Cloud API) para não conflitar com `content` (que já
        // é o campo dos kinds text/note).
        const interactiveBody = typeof body.body === "string" ? body.body : "";
        return toResponse(
          kind,
          dealId,
          await sendInteractiveButtonsToConversation({
            conversationId,
            actor,
            body: interactiveBody,
            buttons: parseButtons(body.buttons),
            header: typeof body.header === "string" ? body.header : null,
            footer: typeof body.footer === "string" ? body.footer : null,
            channelId: typeof body.channelId === "string" ? body.channelId : null,
            stopAutomations: body.stopAutomations !== false,
          }),
        );
      }

      if (kind === "list") {
        // Duas formas de entrada:
        //   - `rows` no top-level (+ `sectionTitle` opcional): vira uma seção só.
        //     É o caminho usado pelo node do n8n.
        //   - `sections` no top-level: passa direto, permitindo múltiplas
        //     seções. Escape hatch para integrações manuais.
        const listBody = typeof body.body === "string" ? body.body : "";
        const listButton = typeof body.button === "string" ? body.button : "";
        return toResponse(
          kind,
          dealId,
          await sendInteractiveListToConversation({
            conversationId,
            actor,
            body: listBody,
            button: listButton,
            rows: parseRows(body.rows),
            sectionTitle: typeof body.sectionTitle === "string" ? body.sectionTitle : null,
            sections: Array.isArray(body.sections)
              ? (body.sections as unknown[])
                  .map((s) => {
                    if (!s || typeof s !== "object") return null;
                    const sec = s as Record<string, unknown>;
                    const rows = parseRows(sec.rows);
                    if (rows.length === 0) return null;
                    return {
                      title: typeof sec.title === "string" ? sec.title : null,
                      rows,
                    };
                  })
                  .filter((s): s is { title: string | null; rows: OutboundListRow[] } => s !== null)
              : null,
            header: typeof body.header === "string" ? body.header : null,
            footer: typeof body.footer === "string" ? body.footer : null,
            channelId: typeof body.channelId === "string" ? body.channelId : null,
            stopAutomations: body.stopAutomations !== false,
          }),
        );
      }

      const templateName = typeof body.templateName === "string" ? body.templateName.trim() : "";
      if (!templateName) {
        return NextResponse.json(
          { message: "templateName é obrigatório para kind=template." },
          { status: 400 },
        );
      }

      const variables = parseVariables(body.variables);
      // `components` pronto tem precedência: quem já monta o payload da Cloud
      // API (casos raros, ex.: header de mídia) não deve ser sobrescrito.
      const components = Array.isArray(body.components)
        ? (body.components as unknown[])
        : buildTemplateComponents(variables);

      const rawPreview = typeof body.bodyPreview === "string" ? body.bodyPreview : null;

      return toResponse(
        kind,
        dealId,
        await sendTemplateToConversation({
          conversationId,
          actor,
          templateName,
          languageCode: typeof body.languageCode === "string" ? body.languageCode : null,
          components,
          // Sem `bodyPreview` explícito o service busca o corpo na Graph e
          // renderiza com as variáveis — o node só precisa do nome.
          bodyPreview: rawPreview ? renderTemplatePreview(rawPreview, variables) || null : null,
          templateVariables: variables,
          templateGraphId:
            typeof body.templateGraphId === "string" ? body.templateGraphId : null,
          flowToken: typeof body.flowToken === "string" ? body.flowToken : null,
          flowActionData:
            body.flowActionData &&
            typeof body.flowActionData === "object" &&
            !Array.isArray(body.flowActionData)
              ? (body.flowActionData as Record<string, unknown>)
              : null,
          channelId: typeof body.channelId === "string" ? body.channelId : null,
        }),
      );
    } catch (e) {
      console.error("[deals/:id/messages]", e);
      return NextResponse.json(
        { message: e instanceof Error ? e.message : "Erro ao enviar mensagem." },
        { status: 500 },
      );
    }
  });
}
