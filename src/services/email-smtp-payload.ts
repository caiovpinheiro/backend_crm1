/**
 * Monta o envelope/corpo do e-mail enviado pelas contas conectadas
 * (Nodemailer `sendMail`). Puro (sem I/O) para ser testável.
 *
 * Decisões de entregabilidade (17/10/2026): os testes de envio caíam no
 * Spam do Gmail e vinham com "parece que esta mensagem está em inglês".
 * Além do DKIM/DMARC do domínio (fora do CRM), três sinais vinham do
 * próprio envio: `From` só com o endereço (sem nome de exibição), nenhum
 * idioma declarado e HTML sem `lang`. Aqui: `From` com nome quando houver,
 * `Content-Language: pt-BR` e `<html lang="pt-BR">` garantido no HTML.
 */

export const EMAIL_CONTENT_LANGUAGE = "pt-BR";

export type SmtpMailInput = {
  to: string;
  subject: string;
  text?: string;
  html?: string;
  inReplyTo?: string;
};

export type SmtpMailPayload = {
  from: string | { name: string; address: string };
  to: string;
  subject: string;
  text: string;
  html?: string;
  headers: Record<string, string>;
  inReplyTo?: string;
  references?: string;
};

export function isBlankHtml(html?: string): boolean {
  if (!html?.trim()) return true;
  return (
    html
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/\s+/g, " ")
      .trim() === ""
  );
}

export function textFromHtml(html?: string): string {
  if (!html) return "";
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}

/**
 * Garante `lang` no HTML: fragmento (sem `<html>`) é embrulhado num
 * documento mínimo; documento com `<html>` sem `lang` recebe o atributo;
 * documento que já declara `lang` fica como está (respeita o autor).
 */
export function ensureHtmlLang(html: string, lang = EMAIL_CONTENT_LANGUAGE): string {
  const htmlTag = html.match(/<html\b[^>]*>/i);
  if (!htmlTag) {
    return `<!DOCTYPE html><html lang="${lang}"><body>${html}</body></html>`;
  }
  if (/\slang\s*=/i.test(htmlTag[0])) return html;
  // Preserva a caixa da tag original (<HTML> continua <HTML>).
  return html.replace(htmlTag[0], htmlTag[0].replace(/^<html\b/i, (tag) => `${tag} lang="${lang}"`));
}

/** Nome de exibição seguro para o `From` (vazio/espaços = sem nome). */
function cleanFromName(name?: string | null): string | undefined {
  const trimmed = name?.replace(/[\r\n]+/g, " ").trim();
  return trimmed ? trimmed : undefined;
}

export function buildSmtpMailPayload(
  sender: { email: string; fromName?: string | null },
  mail: SmtpMailInput,
): SmtpMailPayload {
  const text = mail.text?.trim() || textFromHtml(mail.html) || undefined;
  const html = isBlankHtml(mail.html) ? undefined : ensureHtmlLang(mail.html as string);
  const fromName = cleanFromName(sender.fromName);
  const replyRef = mail.inReplyTo
    ? mail.inReplyTo.includes("<")
      ? mail.inReplyTo
      : `<${mail.inReplyTo}>`
    : undefined;
  return {
    from: fromName ? { name: fromName, address: sender.email } : sender.email,
    to: mail.to,
    subject: mail.subject,
    text: text ?? " ",
    ...(html ? { html } : {}),
    headers: { "Content-Language": EMAIL_CONTENT_LANGUAGE },
    ...(replyRef ? { inReplyTo: replyRef, references: replyRef } : {}),
  };
}
