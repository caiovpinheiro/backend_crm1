/**
 * Contexto do último disparo (campanha / template WhatsApp) para o agente.
 *
 * A bolha no inbox muitas vezes grava só o rótulo
 * ("Modelo de mensagem enviado… Nome: calouros_agost0209") sem o corpo
 * que o aluno viu. Sem esse texto o LLM trata "como faço para ver?"
 * como conversa nova.
 *
 * Resolve o corpo em WhatsAppTemplateConfig (modelos da Meta / Configurações)
 * e, se faltar, em MessageTemplate (modelos internos).
 */

import { prisma } from "@/lib/prisma";
import { parseTemplateMeta } from "@/lib/whatsapp-outbound-template-label";

const LOOKBACK = 40;
const MAX_BODY_CHARS = 1800;

export type CampaignDispatchContext = {
  templateName: string;
  campaignLabel: string | null;
  body: string;
};

const STUB_RE =
  /modelo de mensagem enviado ao cliente|nome:\s*\S+|\[campanha:/i;

function looksLikeTemplateStub(content: string, messageType: string): boolean {
  if (messageType === "template") return true;
  const t = content.trim();
  if (!t) return false;
  return STUB_RE.test(t) && t.length < 400;
}

function parseNameFromContent(content: string): string | null {
  const meta = parseTemplateMeta(content);
  if (meta?.name) return meta.name.trim();
  const camp = content.match(/\[Campanha:\s*(.+?)\]/i);
  return camp?.[1]?.trim() || null;
}

function campaignLabelFromSender(senderName: string | null): string | null {
  if (!senderName) return null;
  const m = senderName.match(/^Campanha:\s*(.+)$/i);
  return m?.[1]?.trim() || null;
}

async function resolveTemplateBody(
  templateName: string,
  templateConfigId: string | null,
): Promise<string | null> {
  const name = templateName.trim();
  if (templateConfigId) {
    const byId = await prisma.whatsAppTemplateConfig.findUnique({
      where: { id: templateConfigId },
      select: { bodyPreview: true, metaTemplateName: true, label: true },
    });
    const preview = byId?.bodyPreview?.trim();
    if (preview) return preview;
  }
  if (name) {
    const byMeta = await prisma.whatsAppTemplateConfig.findFirst({
      where: { metaTemplateName: name },
      select: { bodyPreview: true },
      orderBy: { updatedAt: "desc" },
    });
    const preview = byMeta?.bodyPreview?.trim();
    if (preview) return preview;

    const internal = await prisma.messageTemplate.findFirst({
      where: { name: { equals: name, mode: "insensitive" } },
      select: { content: true },
      orderBy: { updatedAt: "desc" },
    });
    const body = internal?.content?.trim();
    if (body) return body;
  }
  return null;
}

function clip(text: string): string {
  const t = text.trim();
  if (t.length <= MAX_BODY_CHARS) return t;
  return `${t.slice(0, MAX_BODY_CHARS).trim()}…`;
}

export function formatCampaignDispatchBlock(
  ctx: CampaignDispatchContext | null,
): string {
  if (!ctx?.body) return "";
  const who = ctx.campaignLabel
    ? `campanha "${ctx.campaignLabel}"`
    : "um disparo automático";
  const named = ctx.templateName
    ? ` (modelo "${ctx.templateName}")`
    : "";
  return [
    "",
    "ÚLTIMO DISPARO PARA ESTE ALUNO (contexto obrigatório):",
    `O aluno recebeu ${who}${named} no WhatsApp, pouco antes desta resposta.`,
    "A mensagem atual dele quase sempre se refere A ESTE texto — não reinicie o atendimento nem pergunte 'o que você quer ver?'.",
    "Responda com base no conteúdo abaixo + na pergunta dele:",
    "---",
    clip(ctx.body),
    "---",
  ].join("\n");
}

/**
 * Hidrata o texto de uma bolha outbound de template/campanha para o
 * histórico do LLM (substitui o stub pelo corpo real).
 */
export async function hydrateOutboundTemplateContent(args: {
  content: string;
  messageType: string;
  templateConfigId: string | null;
  senderName: string | null;
}): Promise<string> {
  const content = args.content ?? "";
  if (!looksLikeTemplateStub(content, args.messageType) && !args.templateConfigId) {
    return content;
  }
  const name = parseNameFromContent(content) ?? "";
  const body = await resolveTemplateBody(name, args.templateConfigId);
  if (!body) return content;
  const campaign = campaignLabelFromSender(args.senderName);
  const title = campaign
    ? `Disparo da campanha "${campaign}"`
    : name
      ? `Disparo do modelo "${name}"`
      : "Disparo automático enviado ao aluno";
  return `${title} (o aluno viu este texto no WhatsApp):\n${clip(body)}`;
}

function slugAlnum(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** `calouros0209` casa `calouros_agost0209` (mesmo prefixo + sufixo numérico). */
function tagMatchesTemplate(tag: string, candidate: string): boolean {
  const t = slugAlnum(tag);
  const c = slugAlnum(candidate);
  if (!t || !c) return false;
  if (c.includes(t) || t.includes(c)) return true;
  const letters = tag.replace(/\d+$/g, "").replace(/[^a-zA-Z]/g, "").toLowerCase();
  const digits = tag.match(/\d+$/)?.[0] ?? "";
  return letters.length >= 4 && digits.length >= 3 && c.includes(letters) && c.includes(digits);
}

async function resolveFromCampaignRecipient(
  contactId: string,
): Promise<CampaignDispatchContext | null> {
  const rec = await prisma.campaignRecipient.findFirst({
    where: {
      contactId,
      status: { in: ["SENT", "DELIVERED", "READ"] },
    },
    orderBy: [{ sentAt: "desc" }, { createdAt: "desc" }],
    select: {
      campaign: {
        select: { name: true, templateName: true, textContent: true },
      },
    },
  });
  const campaign = rec?.campaign;
  if (!campaign) return null;
  const name = campaign.templateName?.trim() || campaign.name;
  const body =
    (await resolveTemplateBody(name, null)) ??
    campaign.textContent?.trim() ??
    null;
  if (!body) return null;
  return { templateName: name, campaignLabel: campaign.name, body };
}

async function resolveFromContactTags(
  contactId: string | null,
): Promise<CampaignDispatchContext | null> {
  if (!contactId) return null;
  const rows = await prisma.tagOnContact.findMany({
    where: { contactId },
    select: { tag: { select: { name: true } } },
    take: 30,
  });
  const names = rows
    .map((r) => r.tag.name.trim())
    .filter((n) => n.length >= 4);
  const ranked = [...names].sort((a, b) => {
    const score = (n: string) =>
      /calouro|prova|matric|acesso|inaugur/i.test(n) ? 0 : 1;
    return score(a) - score(b) || b.length - a.length;
  });
  const configs = await prisma.whatsAppTemplateConfig.findMany({
    where: { hiddenAt: null },
    select: { bodyPreview: true, metaTemplateName: true, label: true },
    orderBy: { updatedAt: "desc" },
    take: 80,
  });
  for (const name of ranked) {
    const exact = await resolveTemplateBody(name, null);
    if (exact) {
      return { templateName: name, campaignLabel: name, body: exact };
    }
    const hit = configs.find(
      (c) =>
        tagMatchesTemplate(name, c.metaTemplateName) ||
        tagMatchesTemplate(name, c.label),
    );
    const preview = hit?.bodyPreview?.trim();
    if (hit && preview) {
      return {
        templateName: hit.metaTemplateName,
        campaignLabel: name,
        body: preview,
      };
    }
  }
  return null;
}

export async function loadLastCampaignDispatchContext(
  conversationId: string | null,
  contactId?: string | null,
): Promise<CampaignDispatchContext | null> {
  if (!conversationId && !contactId) return null;
  if (conversationId) {
  const msgs = await prisma.message.findMany({
    where: { conversationId, direction: "out" },
    orderBy: { createdAt: "desc" },
    take: LOOKBACK,
    select: {
      content: true,
      messageType: true,
      templateConfigId: true,
      senderName: true,
    },
  });

  for (const m of msgs) {
    const isCampaign =
      m.messageType === "template" ||
      !!m.templateConfigId ||
      /^Campanha:/i.test(m.senderName ?? "") ||
      looksLikeTemplateStub(m.content ?? "", m.messageType);
    if (!isCampaign) continue;

    const name = parseNameFromContent(m.content ?? "") ?? "";
    const body =
      (await resolveTemplateBody(name, m.templateConfigId)) ??
      (looksLikeTemplateStub(m.content ?? "", m.messageType)
        ? null
        : m.content.trim());
    if (!body) continue;
    return {
      templateName: name,
      campaignLabel: campaignLabelFromSender(m.senderName),
      body,
    };
  }
  }
  if (contactId) {
    const fromCampaign = await resolveFromCampaignRecipient(contactId);
    if (fromCampaign) return fromCampaign;
  }
  return resolveFromContactTags(contactId ?? null);
}
