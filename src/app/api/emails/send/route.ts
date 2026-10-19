import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth-helpers";
import { getAccessibleAccount, resolveEmailAccess } from "@/services/email-accounts";
import type { SmtpMailAttachment } from "@/services/email-smtp-payload";
import { sendEmail } from "@/services/emails";

export const dynamic = "force-dynamic";

/** Limites de anexo — espelhados no frontend (`compose-attachments.tsx`). */
const MAX_ATTACHMENTS = 10;
const MAX_ATTACHMENT_BYTES = 16 * 1024 * 1024;
const MAX_ATTACHMENTS_TOTAL_BYTES = 25 * 1024 * 1024;

const BODY_FIELDS = ["accountId", "to", "subject", "bodyText", "bodyHtml", "inReplyTo"] as const;

function isFileLike(v: unknown): v is Blob & { name?: string } {
  return (
    v instanceof Blob ||
    (typeof v === "object" &&
      v !== null &&
      typeof (v as Blob).arrayBuffer === "function" &&
      typeof (v as Blob).size === "number")
  );
}

/** Nome seguro para o cabeçalho MIME: sem caminho, sem CR/LF/aspas, tamanho limitado. */
function safeFilename(name: string | undefined, index: number): string {
  const base = (name ?? "").split(/[\\/]/).pop()?.replace(/[\r\n\t"]+/g, " ").trim() ?? "";
  return (base || `anexo-${index + 1}`).slice(0, 180);
}

type ParsedBody = { fields: Record<string, unknown>; attachments: SmtpMailAttachment[] };

/**
 * JSON (sem anexo, como sempre) ou multipart/form-data: campos de texto com
 * os mesmos nomes + um ou mais `attachments` (arquivos). Anexo vazio é
 * ignorado; acima dos limites responde 413.
 */
async function parseSendBody(request: Request): Promise<ParsedBody | NextResponse> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("multipart/form-data")) {
    try {
      return { fields: (await request.json()) as Record<string, unknown>, attachments: [] };
    } catch {
      return NextResponse.json({ message: "JSON inválido." }, { status: 400 });
    }
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ message: "Formulário inválido." }, { status: 400 });
  }

  const fields: Record<string, unknown> = {};
  for (const key of BODY_FIELDS) {
    const value = form.get(key);
    if (typeof value === "string") fields[key] = value;
  }

  // Loop em vez de `.filter(isFileLike)`: o type guard não estreita
  // FormDataEntryValue (string | File) para Blob no overload do filter.
  const raws: Array<Blob & { name?: string }> = [];
  for (const value of form.getAll("attachments")) {
    if (isFileLike(value) && value.size > 0) raws.push(value);
  }
  if (raws.length > MAX_ATTACHMENTS) {
    return NextResponse.json({ message: `No máximo ${MAX_ATTACHMENTS} anexos por e-mail.` }, { status: 413 });
  }
  const attachments: SmtpMailAttachment[] = [];
  let total = 0;
  for (const [index, raw] of raws.entries()) {
    const filename = safeFilename(raw.name, index);
    if (raw.size > MAX_ATTACHMENT_BYTES) {
      return NextResponse.json({ message: `O anexo "${filename}" passa de 16 MB.` }, { status: 413 });
    }
    total += raw.size;
    if (total > MAX_ATTACHMENTS_TOTAL_BYTES) {
      return NextResponse.json({ message: "Os anexos somam mais de 25 MB." }, { status: 413 });
    }
    attachments.push({
      filename,
      content: Buffer.from(await raw.arrayBuffer()),
      contentType: raw.type || "application/octet-stream",
    });
  }
  return { fields, attachments };
}

export async function POST(request: Request) {
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const access = await resolveEmailAccess(r.session.user);
  if (!access.canViewShared && !access.canViewOwn) {
    return NextResponse.json({ message: "Acesso negado.", required: "email_account:view" }, { status: 403 });
  }

  const parsed = await parseSendBody(request);
  if (parsed instanceof NextResponse) return parsed;
  const { fields: body, attachments } = parsed;

  const accountId = typeof body.accountId === "string" ? body.accountId : "";
  const to = typeof body.to === "string" ? body.to.trim() : "";
  const subject = typeof body.subject === "string" ? body.subject : "";
  if (!accountId || !to || !subject.trim()) {
    return NextResponse.json({ message: "accountId, to e subject são obrigatórios." }, { status: 400 });
  }

  const account = await getAccessibleAccount(accountId, access);
  if (!account) {
    return NextResponse.json({ message: "Conta não encontrada." }, { status: 404 });
  }

  try {
    const sent = await sendEmail({
      accountId,
      to,
      subject,
      bodyText: typeof body.bodyText === "string" ? body.bodyText : undefined,
      bodyHtml: typeof body.bodyHtml === "string" ? body.bodyHtml : undefined,
      inReplyTo: typeof body.inReplyTo === "string" ? body.inReplyTo : undefined,
      attachments: attachments.length ? attachments : undefined,
    });
    return NextResponse.json(sent, { status: 201 });
  } catch (e) {
    return NextResponse.json(
      { message: e instanceof Error ? e.message : "Erro ao enviar e-mail." },
      { status: 400 },
    );
  }
}
