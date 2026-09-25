/**
 * Allowlist de telefones para o Agente IA (resposta + 1º atendimento).
 *
 * Produção geral: por padrão TODOS os telefones são atendidos (`open`).
 *
 * Restringir de novo (teste):
 *   AI_REPLY_PHONE_ALLOWLIST=11970617878
 *
 * Lista custom (vírgula/espaço):
 *   AI_REPLY_PHONE_ALLOWLIST=11970617878,11999999999
 *
 * Forçar aberto explicitamente:
 *   AI_REPLY_PHONE_ALLOWLIST=*
 */

import { getOrgSetting } from "@/lib/org-settings";
import { prisma } from "@/lib/prisma";

function logAi(event: string, payload: Record<string, unknown>) {
  console.info(
    "[ai-attend]",
    JSON.stringify({ event, ts: new Date().toISOString(), ...payload }),
  );
}

/** Normaliza para dígitos BR comparáveis (remove +55 / zeros à esquerda). */
export function normalizePhoneDigits(raw: string | null | undefined): string {
  if (!raw) return "";
  let d = String(raw).replace(/\D/g, "");
  if (!d) return "";
  if (d.startsWith("55") && d.length >= 12) d = d.slice(2);
  while (d.startsWith("0") && d.length > 11) d = d.slice(1);
  return d;
}

function parseAllowlistRaw(raw: string | null | undefined): {
  mode: "open" | "restricted";
  phones: string[];
} {
  const v = (raw ?? "").trim();
  // Default produção: aberto.
  if (!v) {
    return { mode: "open", phones: [] };
  }
  const lower = v.toLowerCase();
  if (lower === "*" || lower === "all" || lower === "off" || lower === "disabled") {
    return { mode: "open", phones: [] };
  }
  const phones = v
    .split(/[,;\s]+/)
    .map((p) => normalizePhoneDigits(p))
    .filter((p) => p.length >= 8);
  if (phones.length === 0) {
    return { mode: "open", phones: [] };
  }
  return { mode: "restricted", phones };
}

/**
 * Resolve allowlist: env AI_REPLY_PHONE_ALLOWLIST > org setting
 * `ai.replyPhoneAllowlist` > default aberto (produção).
 */
export async function resolveAiPhoneAllowlist(): Promise<{
  mode: "open" | "restricted";
  phones: Set<string>;
}> {
  const fromEnv = process.env.AI_REPLY_PHONE_ALLOWLIST;
  if (fromEnv != null && String(fromEnv).trim() !== "") {
    const parsed = parseAllowlistRaw(fromEnv);
    return { mode: parsed.mode, phones: new Set(parsed.phones) };
  }
  try {
    const fromOrg = await getOrgSetting("ai.replyPhoneAllowlist");
    if (fromOrg != null && fromOrg.trim() !== "") {
      const parsed = parseAllowlistRaw(fromOrg);
      return { mode: parsed.mode, phones: new Set(parsed.phones) };
    }
  } catch {
    /* fora de RequestContext */
  }
  return { mode: "open", phones: new Set() };
}

export function phoneMatchesAllowlist(
  phone: string | null | undefined,
  allow: Set<string>,
): boolean {
  const n = normalizePhoneDigits(phone);
  if (!n) return false;
  if (allow.has(n)) return true;
  for (const p of allow) {
    if (!p) continue;
    if (n === p) return true;
    if (n.endsWith(p) || p.endsWith(n)) return true;
  }
  return false;
}

/**
 * @returns true se a IA pode atender este contato.
 * Em modo restricted, sem telefone no contato = bloqueado.
 */
export async function isContactAllowedForAi(
  contactId: string,
): Promise<boolean> {
  const { mode, phones } = await resolveAiPhoneAllowlist();
  if (mode === "open") return true;

  const contact = await prisma.contact.findUnique({
    where: { id: contactId },
    select: {
      phone: true,
      whatsappJid: true,
      whatsappUsername: true,
    },
  });
  if (!contact) {
    logAi("phone_allowlist_block", { contactId, reason: "contact_not_found" });
    return false;
  }

  const candidates = [
    contact.phone,
    contact.whatsappJid?.split("@")[0] ?? null,
    contact.whatsappUsername,
  ];
  for (const c of candidates) {
    if (phoneMatchesAllowlist(c, phones)) return true;
  }

  logAi("phone_allowlist_block", {
    contactId,
    phone: contact.phone ?? null,
    reason: "not_in_allowlist",
    allowlist: [...phones],
  });
  return false;
}
