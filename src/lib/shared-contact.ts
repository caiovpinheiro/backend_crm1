/** Contato compartilhado no WhatsApp. Não é um Contact do CRM. */

const MAX_CONTACTS = 20;
const MAX_PHONES = 8;
const MAX_EMAILS = 8;
const MAX_NAME = 160;
const MAX_PHONE = 40;
const MAX_EMAIL = 160;
const MAX_SHORT = 120;

export type SharedContactPhone = {
  phone: string;
  waId?: string | null;
  type?: string | null;
};

export type SharedContactEmail = {
  email: string;
  type?: string | null;
};

export type SharedContact = {
  name: string;
  firstName?: string | null;
  lastName?: string | null;
  phones: SharedContactPhone[];
  emails?: SharedContactEmail[];
  company?: string | null;
  title?: string | null;
};

function clip(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  const text = value.replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim();
  return text.length > max ? text.slice(0, max) : text;
}

function optional(value: unknown, max: number): string | null {
  const text = clip(value, max);
  return text || null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function joinName(parts: Array<string | null | undefined>): string {
  return parts.map((part) => (part ?? "").trim()).filter(Boolean).join(" ");
}

export function normalizeSharedContact(raw: unknown): SharedContact | null {
  const row = asRecord(raw);
  if (!row) return null;
  const phones = normalizePhones(row.phones);
  const emails = normalizeEmails(row.emails);
  const firstName = optional(row.firstName, MAX_SHORT);
  const lastName = optional(row.lastName, MAX_SHORT);
  const explicit = clip(row.name, MAX_NAME);
  const name =
    explicit ||
    joinName([firstName, lastName]) ||
    phones[0]?.phone ||
    emails[0]?.email ||
    "";
  if (!name && phones.length === 0 && emails.length === 0) return null;
  return {
    name: clip(name, MAX_NAME) || "Contato",
    firstName,
    lastName,
    phones,
    emails,
    company: optional(row.company, MAX_SHORT),
    title: optional(row.title, MAX_SHORT),
  };
}

function normalizePhones(raw: unknown): SharedContactPhone[] {
  if (!Array.isArray(raw)) return [];
  const phones: SharedContactPhone[] = [];
  for (const item of raw) {
    if (phones.length >= MAX_PHONES) break;
    const row = asRecord(item);
    const phone = clip(row?.phone, MAX_PHONE);
    if (!phone) continue;
    phones.push({
      phone,
      waId: optional(row?.waId, MAX_PHONE),
      type: optional(row?.type, 40),
    });
  }
  return phones;
}

function normalizeEmails(raw: unknown): SharedContactEmail[] {
  if (!Array.isArray(raw)) return [];
  const emails: SharedContactEmail[] = [];
  for (const item of raw) {
    if (emails.length >= MAX_EMAILS) break;
    const row = asRecord(item);
    const email = clip(row?.email, MAX_EMAIL);
    if (!looksLikeEmail(email)) continue;
    emails.push({ email, type: optional(row?.type, 40) });
  }
  return emails;
}

/** JSON do banco ou do SSE. Lixo vira null; a API continua respondendo. */
export function sharedContactsFromJson(raw: unknown): SharedContact[] | null {
  if (!Array.isArray(raw)) return null;
  const contacts: SharedContact[] = [];
  for (const item of raw) {
    if (contacts.length >= MAX_CONTACTS) break;
    const contact = normalizeSharedContact(item);
    if (contact) contacts.push(contact);
  }
  return contacts.length > 0 ? contacts : null;
}

export function formatSharedContactsText(contacts: SharedContact[]): string {
  if (contacts.length === 0) return "[Contato compartilhado]";
  if (contacts.length === 1) {
    const contact = contacts[0];
    const phone = contact.phones[0]?.phone;
    const label = contact.name.trim();
    if (phone && label && label !== phone) {
      return `Contato compartilhado: ${label} · ${phone}`;
    }
    return `Contato compartilhado: ${label || phone || "Contato"}`;
  }
  const labels = contacts
    .slice(0, 5)
    .map((contact) => contact.name.trim() || contact.phones[0]?.phone || "Contato");
  const more = contacts.length > 5 ? ` +${contacts.length - 5}` : "";
  return `Contatos compartilhados: ${labels.join(", ")}${more}`;
}

function metaName(raw: unknown): {
  name: string;
  firstName: string | null;
  lastName: string | null;
} {
  const row = asRecord(raw);
  const firstName = optional(row?.first_name, MAX_SHORT);
  const middleName = optional(row?.middle_name, MAX_SHORT);
  const lastName = optional(row?.last_name, MAX_SHORT);
  const formatted = clip(row?.formatted_name, MAX_NAME);
  const built = joinName([firstName, middleName, lastName]);
  return {
    name: formatted || built,
    firstName,
    lastName,
  };
}

/** Payload `messages[].contacts` da Cloud API. Item inválido é ignorado. */
export function parseMetaSharedContacts(raw: unknown): SharedContact[] {
  if (!Array.isArray(raw)) return [];
  const contacts: SharedContact[] = [];
  for (const item of raw) {
    if (contacts.length >= MAX_CONTACTS) break;
    const row = asRecord(item);
    if (!row) continue;
    const named = metaName(row.name);
    const org = asRecord(row.org);
    const phones = Array.isArray(row.phones)
      ? row.phones.map((phone) => {
          const entry = asRecord(phone);
          return {
            phone: clip(entry?.phone, MAX_PHONE),
            waId: optional(entry?.wa_id, MAX_PHONE),
            type: optional(entry?.type, 40),
          };
        })
      : [];
    const emails = Array.isArray(row.emails)
      ? row.emails.map((email) => {
          const entry = asRecord(email);
          return {
            email: clip(entry?.email, MAX_EMAIL),
            type: optional(entry?.type, 40),
          };
        })
      : [];
    const contact = normalizeSharedContact({
      name: named.name,
      firstName: named.firstName,
      lastName: named.lastName,
      phones,
      emails,
      company: optional(org?.company, MAX_SHORT),
      title: optional(org?.title, MAX_SHORT),
    });
    if (contact) contacts.push(contact);
  }
  return contacts;
}

function unescapeVcard(value: string): string {
  return value
    .replace(/\\n/gi, " ")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");
}

function unfoldVcard(vcard: string): string[] {
  const raw = vcard.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const lines: string[] = [];
  for (const line of raw) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && lines.length > 0) {
      lines[lines.length - 1] += line.slice(1);
      continue;
    }
    lines.push(line);
  }
  return lines;
}

function vcardParams(left: string): Record<string, string> {
  const params: Record<string, string> = {};
  const parts = left.split(";");
  for (const part of parts.slice(1)) {
    const eq = part.indexOf("=");
    if (eq === -1) {
      params.type = part;
      continue;
    }
    params[part.slice(0, eq).toLowerCase()] = part.slice(eq + 1);
  }
  return params;
}

/** Um vCard. Texto quebrado não lança; devolve o que der para ler. */
export function parseVcard(vcard: string, displayName?: string | null): SharedContact | null {
  if (typeof vcard !== "string" || !vcard.trim()) {
    const name = clip(displayName, MAX_NAME);
    return name ? normalizeSharedContact({ name, phones: [], emails: [] }) : null;
  }
  let formatted = "";
  let family = "";
  let given = "";
  let middle = "";
  const phones: SharedContactPhone[] = [];
  const emails: SharedContactEmail[] = [];
  let company: string | null = null;
  let title: string | null = null;

  try {
    for (const line of unfoldVcard(vcard)) {
      const colon = line.indexOf(":");
      if (colon <= 0) continue;
      const left = line.slice(0, colon);
      const value = unescapeVcard(line.slice(colon + 1)).trim();
      if (!value) continue;
      const key = left.split(";")[0]?.toUpperCase() ?? "";
      const params = vcardParams(left);
      if (key === "FN") formatted = value;
      if (key === "N") {
        const bits = value.split(";");
        family = bits[0] ?? "";
        given = bits[1] ?? "";
        middle = bits[2] ?? "";
      }
      if (key === "TEL" && phones.length < MAX_PHONES) {
        phones.push({
          phone: clip(value, MAX_PHONE),
          waId: optional(params.waid, MAX_PHONE),
          type: optional(params.type, 40),
        });
      }
      if (key === "EMAIL" && emails.length < MAX_EMAILS) {
        emails.push({
          email: clip(value, MAX_EMAIL),
          type: optional(params.type, 40),
        });
      }
      if (key === "ORG" && !company) company = optional(value.split(";")[0], MAX_SHORT);
      if (key === "TITLE" && !title) title = optional(value, MAX_SHORT);
    }
  } catch {
    return normalizeSharedContact({
      name: clip(displayName, MAX_NAME),
      phones: [],
      emails: [],
    });
  }

  const built = joinName([given, middle, family]);
  return normalizeSharedContact({
    name: clip(formatted, MAX_NAME) || built || clip(displayName, MAX_NAME),
    firstName: optional(given, MAX_SHORT),
    lastName: optional(family, MAX_SHORT),
    phones,
    emails,
    company,
    title,
  });
}

type BaileysContactNode = {
  displayName?: string;
  vcard?: string;
  contacts?: BaileysContactNode[];
};

/** `contactMessage` ou `contactsArrayMessage` do Baileys. */
export function parseBaileysSharedContacts(node: BaileysContactNode | null | undefined): SharedContact[] {
  if (!node) return [];
  const entries = Array.isArray(node.contacts) && node.contacts.length > 0 ? node.contacts : [node];
  const contacts: SharedContact[] = [];
  for (const entry of entries) {
    if (contacts.length >= MAX_CONTACTS) break;
    try {
      const contact = parseVcard(entry?.vcard ?? "", entry?.displayName ?? node.displayName);
      if (contact) contacts.push(contact);
    } catch {
      const fallback = normalizeSharedContact({
        name: clip(entry?.displayName, MAX_NAME),
        phones: [],
        emails: [],
      });
      if (fallback) contacts.push(fallback);
    }
  }
  return contacts;
}
