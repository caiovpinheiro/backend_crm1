/**
 * Lê env em runtime no processo Node.
 *
 * `process.env.FOO` estático o Next/webpack substitui no `next build`
 * pelo valor de FOO **na hora do build**. No EasyPanel isso congela
 * `undefined` pra qualquer chave que não existia no build — o painel
 * pode ter SMTP_HOST e o bundle continua vendo vazio até um rebuild.
 *
 * `globalThis.process.env[name]` não é congelável pelo DefinePlugin.
 */
export function runtimeEnv(name: string): string | undefined {
  const env = (
    globalThis as { process?: { env?: Record<string, string | undefined> } }
  ).process?.env;
  if (!env) return undefined;
  const v = env[name];
  if (typeof v !== "string") return undefined;
  const trimmed = v.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}
