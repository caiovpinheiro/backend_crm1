function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function wrap(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="pt-BR">
<body style="margin:0;padding:24px;background:#f4f4f5;font-family:system-ui,sans-serif;color:#18181b;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
    <tr><td align="center">
      <table role="presentation" width="560" cellspacing="0" cellpadding="0" style="max-width:560px;background:#fff;border-radius:12px;padding:32px;border:1px solid #e4e4e7;">
        <tr><td>
          <p style="margin:0 0 8px;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#71717a;">Bwipo</p>
          <h1 style="margin:0 0 16px;font-size:20px;">${escapeHtml(title)}</h1>
          ${bodyHtml}
          <p style="margin:24px 0 0;font-size:12px;color:#a1a1aa;">Se você não esperava este e-mail, ignore.</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

export function inviteEmail(input: {
  organizationName: string;
  inviteUrl: string;
  roleLabel: string;
}): { subject: string; text: string; html: string } {
  const org = input.organizationName;
  const subject = `Convite para ${org} no Bwipo`;
  const text = `Você foi convidado para ${org} no Bwipo como ${input.roleLabel}.\n\nAceite o convite:\n${input.inviteUrl}\n\nO link expira em 7 dias.`;
  const html = wrap(
    `Convite para ${org}`,
    `<p style="margin:0 0 16px;font-size:15px;line-height:1.5;">Você foi convidado como <strong>${escapeHtml(input.roleLabel)}</strong>.</p>
     <p style="margin:0 0 24px;"><a href="${escapeHtml(input.inviteUrl)}" style="display:inline-block;background:#18181b;color:#fff;text-decoration:none;padding:12px 20px;border-radius:999px;font-size:14px;">Aceitar convite</a></p>
     <p style="margin:0;font-size:13px;color:#71717a;word-break:break-all;">${escapeHtml(input.inviteUrl)}</p>`,
  );
  return { subject, text, html };
}

export function passwordResetEmail(input: {
  resetUrl: string;
}): { subject: string; text: string; html: string } {
  const subject = "Redefinir senha — Bwipo";
  const text = `Use o link abaixo para redefinir sua senha (válido por 30 minutos):\n\n${input.resetUrl}`;
  const html = wrap(
    "Redefinir senha",
    `<p style="margin:0 0 16px;font-size:15px;line-height:1.5;">O link vale por 30 minutos e só pode ser usado uma vez.</p>
     <p style="margin:0 0 24px;"><a href="${escapeHtml(input.resetUrl)}" style="display:inline-block;background:#18181b;color:#fff;text-decoration:none;padding:12px 20px;border-radius:999px;font-size:14px;">Criar nova senha</a></p>
     <p style="margin:0;font-size:13px;color:#71717a;word-break:break-all;">${escapeHtml(input.resetUrl)}</p>`,
  );
  return { subject, text, html };
}

export function welcomeEmail(input: {
  organizationName: string;
  loginUrl: string;
  name: string;
}): { subject: string; text: string; html: string } {
  const subject = `Bem-vindo ao ${input.organizationName} no Bwipo`;
  const text = `Olá ${input.name},\n\nSua conta em ${input.organizationName} está pronta.\n\nAcesse: ${input.loginUrl}`;
  const html = wrap(
    `Bem-vindo, ${input.name}`,
    `<p style="margin:0 0 16px;font-size:15px;line-height:1.5;">Sua conta em <strong>${escapeHtml(input.organizationName)}</strong> está pronta.</p>
     <p style="margin:0;"><a href="${escapeHtml(input.loginUrl)}" style="display:inline-block;background:#18181b;color:#fff;text-decoration:none;padding:12px 20px;border-radius:999px;font-size:14px;">Entrar no CRM</a></p>`,
  );
  return { subject, text, html };
}

export function verifyEmailTemplate(input: {
  code: string;
  organizationName?: string;
}): { subject: string; text: string; html: string } {
  const subject = "Confirme seu e-mail — Bwipo";
  const org = input.organizationName
    ? ` para ${input.organizationName}`
    : "";
  const text = `Seu código de verificação${org} é: ${input.code}\n\nEle expira em 30 minutos.`;
  const html = wrap(
    "Confirme seu e-mail",
    `<p style="margin:0 0 16px;font-size:15px;line-height:1.5;">Use o código abaixo${org ? escapeHtml(org) : ""}:</p>
     <p style="margin:0;font-size:32px;letter-spacing:.24em;font-weight:700;">${escapeHtml(input.code)}</p>
     <p style="margin:16px 0 0;font-size:13px;color:#71717a;">Expira em 30 minutos.</p>`,
  );
  return { subject, text, html };
}
