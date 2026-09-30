/**
 * Máscaras de dados pessoais para logs (SEC2-5 / LGPD).
 *
 * Logs vão para agregadores (Loki/Better Stack) com retenção e acesso
 * diferentes do banco. Telefone e e-mail completos NÃO devem sair em
 * texto claro — logue IDs e, quando precisar de um vestígio pra
 * correlação, use estas máscaras (`***1234`, `jo***@ex***.com`).
 */

/** Mantém só os 4 últimos dígitos: `+55 11 91234-5678` → `***5678`. */
export function maskPhone(value: string | null | undefined): string {
  if (value == null) return "";
  const digits = String(value).replace(/\D+/g, "");
  if (!digits) return "***";
  if (digits.length <= 4) return `***${digits}`;
  return `***${digits.slice(-4)}`;
}

/**
 * Mantém as 2 primeiras letras do usuário e a 1ª do domínio + TLD:
 * `joao.silva@exemplo.com.br` → `jo***@e***.com.br`.
 */
export function maskEmail(value: string | null | undefined): string {
  if (value == null) return "";
  const raw = String(value).trim();
  if (!raw) return "";
  const at = raw.lastIndexOf("@");
  if (at <= 0) return `${raw.slice(0, 2)}***`;
  const local = raw.slice(0, at);
  const domain = raw.slice(at + 1);
  const localMasked = `${local.slice(0, 2)}***`;
  const dot = domain.indexOf(".");
  const domainMasked =
    dot > 0 ? `${domain.slice(0, 1)}***${domain.slice(dot)}` : `${domain.slice(0, 1)}***`;
  return `${localMasked}@${domainMasked}`;
}
