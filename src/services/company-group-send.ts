/**
 * Passo de automação "Enviar para empresa" (`send_company_group`).
 *
 * Manda texto ou mídia para o(s) grupo(s) de WhatsApp vinculados à empresa,
 * pelo número QR (Baileys) que está no grupo, e grava cada envio no histórico
 * do grupo no CRM (tela Grupos), como se alguém tivesse mandado de lá.
 *
 * Empresa:
 *  - `fixed`: a escolhida no passo; um grupo específico ou todos os dela.
 *  - `deal_primary`: a principal (★) do negócio; todos os grupos dela ou só
 *    o vinculado por último.
 *
 * Sem empresa, sem grupo ou com o número QR desconectado o passo falha
 * (`CompanyGroupSendError`) e o executor segue pela saída "Caso ocorrer erro
 * no envio".
 */
import { prisma } from "@/lib/prisma";
import { enqueueBaileysOutbound } from "@/lib/queue";
import { getOrgIdOrThrow } from "@/lib/request-context";
import { groupAttachmentText } from "@/lib/whatsapp-group-attachment";
import { companyForMessages, primaryCompanyForDeal, type DealCompanyDto } from "@/services/deal-companies";
import { appendWhatsAppGroupMessage, deleteGroupMessage } from "@/services/whatsapp-groups";

export const SEND_COMPANY_GROUP_STEP = "send_company_group";

/** Assinatura padrão do passo (pode ser trocada no bloco). */
export const DEFAULT_COMPANY_GROUP_SIGNATURE = "DNA Work";

const MEDIA_TYPES = new Set(["image", "video", "audio", "document"]);

export type CompanyGroupStepConfig = {
  companyMode: "fixed" | "deal_primary";
  companyId: string;
  groupId: string;
  allGroups: boolean;
  contentType: "text" | "media";
  content: string;
  mediaType: "image" | "video" | "audio" | "document";
  mediaUrl: string;
  fileName: string;
  caption: string;
  signatureEnabled: boolean;
  signatureName: string;
};

export class CompanyGroupSendError extends Error {
  readonly name = "CompanyGroupSendError";
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

export function readCompanyGroupConfig(cfg: Record<string, unknown>): CompanyGroupStepConfig {
  const mediaType = str(cfg.mediaType);
  return {
    companyMode: cfg.companyMode === "deal_primary" ? "deal_primary" : "fixed",
    companyId: str(cfg.companyId),
    groupId: str(cfg.groupId),
    allGroups: cfg.allGroups === true,
    contentType: cfg.contentType === "media" ? "media" : "text",
    content: typeof cfg.content === "string" ? cfg.content : "",
    mediaType: (MEDIA_TYPES.has(mediaType) ? mediaType : "image") as CompanyGroupStepConfig["mediaType"],
    mediaUrl: str(cfg.mediaUrl),
    fileName: str(cfg.uploadedFileName),
    caption: typeof cfg.caption === "string" ? cfg.caption : "",
    signatureEnabled: cfg.signatureEnabled === true,
    signatureName: str(cfg.signatureName) || DEFAULT_COMPANY_GROUP_SIGNATURE,
  };
}

/** `*Nome*: texto` — mesmo formato da assinatura do inbox; não duplica. */
export function signText(text: string, name: string): string {
  const sig = name.trim();
  if (!sig || !text.trim()) return text;
  const s = sig.toLowerCase();
  const lower = text.toLowerCase();
  if (lower.startsWith(`*${s}*`) || lower.startsWith(`*${s}:*`) || lower.startsWith(`${s}:`)) return text;
  return `*${sig}*: ${text}`;
}

const MIME_BY_EXT: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp",
  mp4: "video/mp4", mov: "video/quicktime", "3gp": "video/3gpp",
  ogg: "audio/ogg", opus: "audio/ogg", mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav",
  pdf: "application/pdf", doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

function guessMime(nameOrUrl: string, mediaType: string): string {
  const ext = nameOrUrl.split("?")[0]!.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXT[ext] ?? (mediaType === "document" ? "application/octet-stream" : `${mediaType}/*`);
}

type TargetGroup = {
  id: string;
  jid: string;
  name: string;
  channel: { id: string; phoneNumber: string | null; status: string; provider: string };
};

const GROUP_SELECT = {
  id: true,
  jid: true,
  name: true,
  customName: true,
  channel: { select: { id: true, phoneNumber: true, status: true, provider: true } },
} as const;

type GroupRow = {
  id: string;
  jid: string;
  name: string;
  customName: string | null;
  channel: TargetGroup["channel"];
};

const isConnected = (g: Pick<TargetGroup, "channel">) =>
  g.channel.provider === "BAILEYS_MD" && g.channel.status === "CONNECTED";

function toTarget(g: GroupRow): TargetGroup {
  return { id: g.id, jid: g.jid, name: g.customName?.trim() || g.name, channel: g.channel };
}

/**
 * O mesmo grupo pode existir em dois números QR (duas linhas, mesmo jid):
 * fica uma por jid, preferindo a de número conectado.
 */
function uniqueByJid(groups: TargetGroup[]): TargetGroup[] {
  const byJid = new Map<string, TargetGroup>();
  for (const g of groups) {
    const prev = byJid.get(g.jid);
    if (!prev || (!isConnected(prev) && isConnected(g))) byJid.set(g.jid, g);
  }
  return [...byJid.values()];
}

export type ResolvedCompanyTarget = {
  company: DealCompanyDto["company"];
  groups: TargetGroup[];
};

/** Empresa e grupos de destino. Lança `CompanyGroupSendError` quando não há. */
export async function resolveCompanyGroupTargets(
  cfg: CompanyGroupStepConfig,
  dealId: string | null,
): Promise<ResolvedCompanyTarget> {
  let company: DealCompanyDto["company"] | null = null;
  if (cfg.companyMode === "deal_primary") {
    if (!dealId) throw new CompanyGroupSendError("sem negócio no contexto para achar a empresa principal");
    company = await primaryCompanyForDeal(dealId);
    if (!company) throw new CompanyGroupSendError("o negócio não tem empresa vinculada");
  } else {
    if (!cfg.companyId) throw new CompanyGroupSendError("nenhuma empresa escolhida no passo");
    company = await companyForMessages(cfg.companyId);
    if (!company) throw new CompanyGroupSendError("a empresa escolhida no passo não existe mais");
  }

  let rows: GroupRow[];
  if (cfg.companyMode === "fixed" && !cfg.allGroups) {
    if (!cfg.groupId) throw new CompanyGroupSendError(`nenhum grupo escolhido para ${company.name}`);
    rows = await prisma.whatsAppGroup.findMany({
      where: { id: cfg.groupId, companyId: company.id },
      select: GROUP_SELECT,
    });
    if (rows.length === 0) {
      throw new CompanyGroupSendError(`o grupo escolhido não está mais vinculado a ${company.name}`);
    }
  } else if (cfg.allGroups) {
    rows = await prisma.whatsAppGroup.findMany({
      where: { companyId: company.id },
      orderBy: { name: "asc" },
      select: GROUP_SELECT,
    });
  } else {
    // Principal do negócio sem "todos": o grupo vinculado por último.
    // Os duplicados por número QR (mesmo jid) entram para escolher o conectado.
    const latest = await prisma.whatsAppGroup.findFirst({
      where: { companyId: company.id },
      orderBy: [{ companyLinkedAt: { sort: "desc", nulls: "last" } }, { createdAt: "desc" }],
      select: { jid: true },
    });
    rows = latest
      ? await prisma.whatsAppGroup.findMany({
          where: { companyId: company.id, jid: latest.jid },
          select: GROUP_SELECT,
        })
      : [];
  }

  const groups = uniqueByJid(rows.map(toTarget));
  if (groups.length === 0) throw new CompanyGroupSendError(`${company.name} não tem grupo de WhatsApp vinculado`);
  return { company, groups };
}

export type CompanyGroupSendResult = {
  companyName: string;
  sent: string[];
  /** Grupos pulados (número QR desconectado) quando outros saíram. */
  skipped: string[];
};

/**
 * Envia para os grupos. `interpolate` resolve as variáveis (contato,
 * negócio, `{{empresa.*}}` da empresa de destino) — vem do executor.
 */
export async function sendToCompanyGroups(input: {
  cfg: CompanyGroupStepConfig;
  target: ResolvedCompanyTarget;
  interpolate: (text: string) => Promise<string>;
  senderName: string;
}): Promise<CompanyGroupSendResult> {
  const { cfg, target } = input;
  const sign = (t: string) => (cfg.signatureEnabled ? signText(t, cfg.signatureName) : t);

  let text = "";
  let caption = "";
  if (cfg.contentType === "text") {
    text = sign((await input.interpolate(cfg.content)).trim());
    if (!text) throw new CompanyGroupSendError("mensagem vazia");
  } else {
    if (!cfg.mediaUrl) throw new CompanyGroupSendError("nenhum arquivo escolhido");
    caption = cfg.caption.trim() ? sign((await input.interpolate(cfg.caption)).trim()) : "";
  }

  const connected = target.groups.filter(isConnected);
  const skipped = target.groups.filter((g) => !isConnected(g)).map((g) => g.name);
  if (connected.length === 0) {
    throw new CompanyGroupSendError(
      `o número QR do grupo ${target.groups.map((g) => `"${g.name}"`).join(", ")} está desconectado`,
    );
  }

  const organizationId = getOrgIdOrThrow();
  const fileName =
    cfg.fileName || decodeURIComponent(cfg.mediaUrl.split("?")[0]!.split("/").pop() || "") || "arquivo";
  const mime = cfg.contentType === "media" ? guessMime(cfg.fileName || cfg.mediaUrl, cfg.mediaType) : null;
  const sent: string[] = [];
  const failed: string[] = [];

  for (const g of connected) {
    const phone = g.channel.phoneNumber;
    let messageId: string | null = null;
    try {
      const msg = await appendWhatsAppGroupMessage({
        organizationId,
        groupId: g.id,
        fromJid: phone ? `${phone.replace(/\D/g, "")}@s.whatsapp.net` : "me",
        fromName: input.senderName,
        fromPhone: phone,
        fromMe: true,
        ...(cfg.contentType === "text"
          ? { text }
          : {
              text: groupAttachmentText(cfg.mediaType, fileName, caption),
              messageType: cfg.mediaType,
              mediaUrl: cfg.mediaUrl,
              mimeType: mime,
              fileName,
            }),
      });
      messageId = msg?.id ?? null;
    } catch {
      // Histórico é secundário: o envio segue mesmo sem a linha no CRM.
    }

    const job = await enqueueBaileysOutbound(
      cfg.contentType === "text"
        ? {
            channelId: g.channel.id,
            to: g.jid,
            content: text,
            messageType: "text",
            ...(messageId ? { groupMessageId: messageId } : {}),
          }
        : {
            channelId: g.channel.id,
            to: g.jid,
            // Documento: o worker usa `content` como nome do arquivo.
            content: cfg.mediaType === "document" ? fileName : caption,
            mediaUrl: cfg.mediaUrl,
            messageType: cfg.mediaType,
            ...(mime ? { mime } : {}),
            originalName: fileName,
            ...(messageId ? { groupMessageId: messageId } : {}),
          },
    );
    if (job) {
      sent.push(g.name);
    } else {
      failed.push(g.name);
      if (messageId) await deleteGroupMessage(messageId).catch(() => {});
    }
  }

  if (sent.length === 0) {
    throw new CompanyGroupSendError(`fila de envio indisponível (${failed.join(", ")})`);
  }
  return { companyName: target.company.name, sent, skipped: [...skipped, ...failed] };
}

export type CompanyGroupOption = { id: string; name: string; connected: boolean };

/** Grupos da empresa para o seletor do passo (um por jid; o conectado vence). */
export async function listCompanyGroupOptions(companyId: string): Promise<CompanyGroupOption[]> {
  const rows: GroupRow[] = await prisma.whatsAppGroup.findMany({
    where: { companyId },
    orderBy: { name: "asc" },
    select: GROUP_SELECT,
  });
  return uniqueByJid(rows.map(toTarget))
    .map((g) => ({ id: g.id, name: g.name, connected: isConnected(g) }))
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
}
