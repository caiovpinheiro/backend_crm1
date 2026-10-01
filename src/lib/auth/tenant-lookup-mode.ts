/**
 * `TENANT_LOOKUP_STRICT` (default desligado).
 *
 * Desligado: `POST /api/auth/tenant-lookup` responde o slug da empresa do
 * e-mail (o login no apex precisa dele para redirecionar ao subdomínio) —
 * a distinção existe/não existe continua observável, só fica cara
 * (limites por IP e por e-mail, piso de latência, resposta mínima).
 *
 * Ligado: a resposta é SEMPRE a mesma (`{ ok: true, slug: null, apex: true,
 * orgs: [] }`), sem consultar o banco. O login acontece no próprio host e a
 * empresa só é conhecida depois da senha correta (`organizationSlug` vem na
 * sessão). Custo: e-mail cadastrado em 2+ empresas não consegue entrar pelo
 * apex (precisa abrir o subdomínio da empresa), e o "esqueci a senha" no
 * apex depende de o frontend chamar `/api/auth/forgot-password` direto em
 * vez de redirecionar. Por isso é decisão de produto, não default.
 */
export function isTenantLookupStrict(): boolean {
  const raw = process.env.TENANT_LOOKUP_STRICT?.trim().toLowerCase();
  return raw === "true" || raw === "1";
}
