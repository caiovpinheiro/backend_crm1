import type { EmailAccount, EmailEncryption, EmailVisibility } from "@prisma/client";

import { can, loadAuthzContext } from "@/lib/authz";
import { encryptSecret, decryptSecret } from "@/lib/crypto/secrets";
import { getLogger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { withOrg } from "@/lib/prisma-helpers";
import { getOrgIdOrThrow, getRequestContext, runWithContext } from "@/lib/request-context";
import { testImapConnection, type EmailFieldError } from "@/services/email-imap";
import {
  ensureEmailOutlookColumns,
  isMissingEmailOutlookColumn,
} from "@/services/email-schema-ensure";
import { testSmtpConnection } from "@/services/email-smtp";

const ACCOUNT_PUBLIC_SELECT = {
  id: true,
  email: true,
  imapHost: true,
  imapPort: true,
  imapEncryption: true,
  smtpHost: true,
  smtpPort: true,
  smtpEncryption: true,
  visibility: true,
  groupInThreads: true,
  createContactsForReplies: true,
  ownerUserId: true,
  createdAt: true,
  lastSyncedAt: true,
} as const;

const log = getLogger("email-accounts");

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ENCRYPTIONS = new Set<EmailEncryption>(["NONE", "SSL_TLS", "STARTTLS"]);
const VISIBILITIES = new Set<EmailVisibility>(["SHARED", "PERSONAL"]);

export type ConnectEmailInput = {
  email: string;
  password: string;
  imapHost: string;
  imapPort: number;
  imapEncryption: EmailEncryption;
  smtpHost: string;
  smtpPort: number;
  smtpEncryption: EmailEncryption;
  visibility: EmailVisibility;
  groupInThreads: boolean;
  createContactsForReplies: boolean;
};

export type SerializedEmailAccount = {
  id: string;
  email: string;
  imapHost: string;
  imapPort: number;
  imapEncryption: EmailEncryption;
  smtpHost: string;
  smtpPort: number;
  smtpEncryption: EmailEncryption;
  visibility: EmailVisibility;
  groupInThreads: boolean;
  createContactsForReplies: boolean;
  ownerUserId: string | null;
  unreadCount: number;
  folderUnread: { inbox: number; sent: number; trash: number };
  oooEnabled: boolean;
  oooMessage: string | null;
  oooStartsAt: string | null;
  oooEndsAt: string | null;
  createdAt: string;
  lastSyncedAt: string | null;
};

export function isEmailFieldError(v: ConnectEmailInput | EmailFieldError): v is EmailFieldError {
  return "ok" in v && v.ok === false;
}

function readString(body: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = body[key];
    if (typeof value === "string") return value.trim();
  }
  return "";
}

function readRaw(body: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    if (key in body && body[key] !== undefined) return body[key];
  }
  return undefined;
}

export function parseConnectInput(body: Record<string, unknown>): ConnectEmailInput | EmailFieldError {
  const email = readString(body, "email").toLowerCase();
  if (!email || !EMAIL_RE.test(email)) {
    return { ok: false, field: "email", message: "Insira um endereço de e-mail válido." };
  }
  const password = typeof body.password === "string" ? body.password : "";
  if (!password) {
    return { ok: false, field: "password", message: "Senha do e-mail é obrigatória." };
  }
  const imapHost = readString(body, "imapHost", "imap_host");
  if (!imapHost) return { ok: false, field: "imap_host", message: "Servidor IMAP é obrigatório." };
  const smtpHost = readString(body, "smtpHost", "smtp_host");
  if (!smtpHost) return { ok: false, field: "smtp_host", message: "Servidor SMTP é obrigatório." };

  const imapPort = Number(readRaw(body, "imapPort", "imap_port"));
  if (!Number.isInteger(imapPort) || imapPort < 1 || imapPort > 65535) {
    return { ok: false, field: "imap_port", message: "Porta IMAP inválida." };
  }
  const smtpPort = Number(readRaw(body, "smtpPort", "smtp_port"));
  if (!Number.isInteger(smtpPort) || smtpPort < 1 || smtpPort > 65535) {
    return { ok: false, field: "smtp_port", message: "Porta SMTP inválida." };
  }

  let imapEncryption = readRaw(body, "imapEncryption", "imap_encryption") as EmailEncryption;
  if (!ENCRYPTIONS.has(imapEncryption)) {
    return { ok: false, field: "imap_encryption", message: "Criptografia IMAP inválida." };
  }
  let smtpEncryption = readRaw(body, "smtpEncryption", "smtp_encryption") as EmailEncryption;
  if (!ENCRYPTIONS.has(smtpEncryption)) {
    return { ok: false, field: "smtp_encryption", message: "Criptografia SMTP inválida." };
  }
  // 993/465 = TLS implícito (UOL Host, Gmail IMAP). 587 = STARTTLS.
  if (imapPort === 993) imapEncryption = "SSL_TLS";
  if (smtpPort === 465) smtpEncryption = "SSL_TLS";
  if (smtpPort === 587 && smtpEncryption === "SSL_TLS") smtpEncryption = "STARTTLS";
  const visibility = (readRaw(body, "visibility") as EmailVisibility) ?? "SHARED";
  if (!VISIBILITIES.has(visibility)) {
    return { ok: false, field: "visibility", message: "Visibilidade inválida." };
  }

  const groupInThreads = readRaw(body, "groupInThreads", "group_in_threads") !== false;
  const createContactsForReplies = readRaw(body, "createContactsForReplies", "create_contacts_for_replies") === true;

  return {
    email,
    password,
    imapHost,
    imapPort,
    imapEncryption,
    smtpHost,
    smtpPort,
    smtpEncryption,
    visibility,
    groupInThreads,
    createContactsForReplies,
  };
}

export async function testEmailAccountConnection(
  input: ConnectEmailInput,
): Promise<{ ok: true } | EmailFieldError> {
  const imap = await testImapConnection(input);
  if (!imap.ok) return imap;
  const smtp = await testSmtpConnection(input);
  if (!smtp.ok) return smtp;
  return { ok: true };
}

export async function resolveEmailAccess(user: {
  id: string;
  organizationId: string | null;
  isSuperAdmin: boolean;
}) {
  const ctx = await loadAuthzContext({
    userId: user.id,
    organizationId: user.organizationId,
    isSuperAdmin: user.isSuperAdmin,
  });
  return {
    userId: user.id,
    canViewShared: can(ctx, "email_account:view"),
    canViewOwn: can(ctx, "email_account:view_own"),
    canConnect: can(ctx, "email_account:connect"),
  };
}

export function accountAccessWhere(opts: {
  userId: string;
  canViewShared: boolean;
  canViewOwn: boolean;
}) {
  const or: Array<{ visibility: EmailVisibility; ownerUserId?: string }> = [];
  if (opts.canViewShared) or.push({ visibility: "SHARED" });
  if (opts.canViewOwn) or.push({ visibility: "PERSONAL", ownerUserId: opts.userId });
  if (or.length === 0) return { id: "__none__" };
  return { OR: or };
}

type AccountPublicRow = {
  id: string;
  email: string;
  imapHost: string;
  imapPort: number;
  imapEncryption: EmailEncryption;
  smtpHost: string;
  smtpPort: number;
  smtpEncryption: EmailEncryption;
  visibility: EmailVisibility;
  groupInThreads: boolean;
  createContactsForReplies: boolean;
  ownerUserId: string | null;
  oooEnabled?: boolean;
  oooMessage?: string | null;
  oooStartsAt?: Date | null;
  oooEndsAt?: Date | null;
  createdAt: Date;
  lastSyncedAt: Date | null;
};

function serializeBase(acc: AccountPublicRow): Omit<SerializedEmailAccount, "unreadCount" | "folderUnread"> {
  return {
    id: acc.id,
    email: acc.email,
    imapHost: acc.imapHost,
    imapPort: acc.imapPort,
    imapEncryption: acc.imapEncryption,
    smtpHost: acc.smtpHost,
    smtpPort: acc.smtpPort,
    smtpEncryption: acc.smtpEncryption,
    visibility: acc.visibility,
    groupInThreads: acc.groupInThreads,
    createContactsForReplies: acc.createContactsForReplies,
    ownerUserId: acc.ownerUserId,
    oooEnabled: acc.oooEnabled ?? false,
    oooMessage: acc.oooMessage ?? null,
    oooStartsAt: acc.oooStartsAt?.toISOString() ?? null,
    oooEndsAt: acc.oooEndsAt?.toISOString() ?? null,
    createdAt: acc.createdAt.toISOString(),
    lastSyncedAt: acc.lastSyncedAt?.toISOString() ?? null,
  };
}

export async function listEmailAccounts(opts: {
  userId: string;
  canViewShared: boolean;
  canViewOwn: boolean;
}): Promise<SerializedEmailAccount[]> {
  await ensureEmailOutlookColumns();
  const where = accountAccessWhere(opts);
  let accounts: AccountPublicRow[];
  try {
    accounts = await prisma.emailAccount.findMany({
      where,
      orderBy: { createdAt: "desc" },
      select: {
        ...ACCOUNT_PUBLIC_SELECT,
        oooEnabled: true,
        oooMessage: true,
        oooStartsAt: true,
        oooEndsAt: true,
      },
    });
  } catch (e) {
    if (!isMissingEmailOutlookColumn(e)) throw e;
    const rows = await prisma.emailAccount.findMany({
      where,
      orderBy: { createdAt: "desc" },
      select: ACCOUNT_PUBLIC_SELECT,
    });
    accounts = rows.map((row) => ({
      ...row,
      oooEnabled: false,
      oooMessage: null,
      oooStartsAt: null,
      oooEndsAt: null,
    }));
  }
  if (accounts.length === 0) return [];

  const unread = await prisma.email.groupBy({
    by: ["accountId", "folder"],
    where: {
      accountId: { in: accounts.map((a) => a.id) },
      isRead: false,
      customFolderId: null,
    },
    _count: { _all: true },
  });

  const byAccount = new Map<string, { inbox: number; sent: number; trash: number }>();
  for (const row of unread) {
    const cur = byAccount.get(row.accountId) ?? { inbox: 0, sent: 0, trash: 0 };
    if (row.folder === "INBOX") cur.inbox = row._count._all;
    if (row.folder === "SENT") cur.sent = row._count._all;
    if (row.folder === "TRASH") cur.trash = row._count._all;
    byAccount.set(row.accountId, cur);
  }

  return accounts.map((acc) => {
    const folderUnread = byAccount.get(acc.id) ?? { inbox: 0, sent: 0, trash: 0 };
    return {
      ...serializeBase(acc),
      unreadCount: folderUnread.inbox,
      folderUnread,
    };
  });
}

export async function connectEmailAccount(
  input: ConnectEmailInput,
  actorUserId: string,
  organizationId: string,
): Promise<{ ok: true; account: SerializedEmailAccount } | EmailFieldError> {
  const tested = await testEmailAccountConnection(input);
  if (!tested.ok) {
    log.warn({ field: tested.field, email: input.email, message: tested.message }, "falha ao testar conexão de e-mail");
    return tested;
  }

  // IMAP/SMTP (imapflow/nodemailer) usam callbacks que derrubam o ALS.
  // Recoloca o tenant e grava organizationId no payload — withOrgFromCtx
  // depois do teste voltava a falhar no redeploy.
  const current = getRequestContext();
  return runWithContext(
    {
      organizationId,
      userId: current?.userId ?? actorUserId,
      isSuperAdmin: current?.isSuperAdmin ?? false,
      actor: current?.actor ?? { type: "HUMAN", label: actorUserId },
    },
    async () => {
      const existing = await prisma.emailAccount.findFirst({
        where: { email: input.email },
      });
      if (existing) {
        return { ok: false, field: "email", message: "Esta conta já está conectada nesta organização." };
      }

      const created = await prisma.emailAccount.create({
        data: withOrg(
          {
            email: input.email,
            passwordEncrypted: encryptSecret(input.password),
            imapHost: input.imapHost,
            imapPort: input.imapPort,
            imapEncryption: input.imapEncryption,
            smtpHost: input.smtpHost,
            smtpPort: input.smtpPort,
            smtpEncryption: input.smtpEncryption,
            visibility: input.visibility,
            groupInThreads: input.groupInThreads,
            createContactsForReplies: input.createContactsForReplies,
            ownerUserId: input.visibility === "PERSONAL" ? actorUserId : null,
          },
          organizationId,
        ),
      });

      log.info({ accountId: created.id, email: created.email }, "conta de e-mail conectada");

      return {
        ok: true,
        account: {
          ...serializeBase(created),
          unreadCount: 0,
          folderUnread: { inbox: 0, sent: 0, trash: 0 },
        },
      };
    },
  );
}

export async function listAccessibleAccountIds(opts: {
  userId: string;
  canViewShared: boolean;
  canViewOwn: boolean;
}): Promise<string[]> {
  const rows = await prisma.emailAccount.findMany({
    where: accountAccessWhere(opts),
    select: { id: true },
  });
  return rows.map((r) => r.id);
}

export async function getAccessibleAccount(
  id: string,
  opts: { userId: string; canViewShared: boolean; canViewOwn: boolean },
) {
  return prisma.emailAccount.findFirst({
    where: { id, ...accountAccessWhere(opts) },
  });
}

export function decryptAccountPassword(account: EmailAccount): string {
  return decryptSecret(account.passwordEncrypted);
}

export async function disconnectEmailAccount(id: string): Promise<boolean> {
  const orgId = getOrgIdOrThrow();
  const result = await prisma.emailAccount.deleteMany({
    where: { id, organizationId: orgId },
  });
  return result.count > 0;
}
