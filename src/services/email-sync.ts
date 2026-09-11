import { prisma } from "@/lib/prisma";
import { withOrg } from "@/lib/prisma-helpers";
import { getLogger } from "@/lib/logger";
import { getRequestContext, runWithContext } from "@/lib/request-context";
import { getContacts, createContact } from "@/services/contacts";
import {
  decryptAccountPassword,
} from "@/services/email-accounts";
import { fetchRecentInbox } from "@/services/email-imap";
import { applyRulesToEmail } from "@/services/email-rules";

const log = getLogger("email-sync");

function normalizeSubject(subject: string | null, groupInThreads: boolean, messageId: string) {
  if (!groupInThreads) return messageId;
  const cleaned = (subject ?? "")
    .replace(/^(re|fwd|enc|res|fw)\s*:\s*/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return cleaned || messageId;
}

export async function syncEmailAccount(
  accountId: string,
  organizationId?: string,
): Promise<{
  synced: number;
  skipped: number;
  errors: number;
}> {
  const account = await prisma.emailAccount.findFirst({ where: { id: accountId } });
  if (!account) return { synced: 0, skipped: 0, errors: 1 };

  const orgId = organizationId ?? account.organizationId;
  const password = decryptAccountPassword(account);
  const fetched = await fetchRecentInbox(
    {
      email: account.email,
      password,
      imapHost: account.imapHost,
      imapPort: account.imapPort,
      imapEncryption: account.imapEncryption,
    },
    80,
  );

  if (!fetched.ok) {
    log.warn({ accountId, field: fetched.field }, fetched.message);
    return { synced: 0, skipped: 0, errors: 1 };
  }

  const current = getRequestContext();
  return runWithContext(
    {
      organizationId: orgId,
      userId: current?.userId ?? account.ownerUserId ?? "SYSTEM",
      isSuperAdmin: current?.isSuperAdmin ?? false,
      actor: current?.actor ?? { type: "SYSTEM", label: "email-sync" },
    },
    async () => {
      let synced = 0;
      let skipped = 0;
      let errors = 0;

      for (const msg of fetched.messages) {
        try {
          const existing = await prisma.email.findUnique({
            where: { accountId_messageId: { accountId: account.id, messageId: msg.messageId } },
          });
          if (existing) {
            skipped += 1;
            continue;
          }

          let contactId: string | null = null;
          const match = await getContacts({ emailExact: msg.fromAddress, perPage: 1 });
          if (match.items[0]) {
            contactId = match.items[0].id;
          } else if (account.createContactsForReplies && msg.fromAddress) {
            const created = await createContact({
              name: msg.fromName || msg.fromAddress,
              email: msg.fromAddress,
              source: "email",
            });
            contactId = created.id;
          }

          const created = await prisma.email.create({
            data: withOrg(
              {
                accountId: account.id,
                folder: "INBOX" as const,
                threadId: normalizeSubject(msg.subject, account.groupInThreads, msg.messageId),
                messageId: msg.messageId,
                uid: msg.uid,
                fromAddress: msg.fromAddress,
                fromName: msg.fromName,
                toAddress: msg.toAddress,
                subject: msg.subject,
                bodyText: msg.bodyText,
                bodyHtml: msg.bodyHtml,
                contactId,
                isRead: msg.isRead,
                receivedAt: msg.receivedAt,
              },
              orgId,
            ),
          });
          await applyRulesToEmail(created);
          synced += 1;
        } catch (err) {
          errors += 1;
          log.warn({ err, accountId, messageId: msg.messageId }, "falha ao persistir e-mail");
        }
      }

      await prisma.emailAccount.update({
        where: { id: account.id },
        data: { lastSyncedAt: new Date() },
      });

      return { synced, skipped, errors };
    },
  );
}
