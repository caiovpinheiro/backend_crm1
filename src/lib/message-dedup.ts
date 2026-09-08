/**
 * Dedup de mensagem inbound por `externalId`.
 *
 * A garantia agora é do banco: `messages_organizationId_externalId_key`
 * (migration `20260906260000_messages_external_id_unique`). Os ingests
 * continuam fazendo o `findFirst` antes do create — ele resolve o caso
 * comum (reentrega da Meta segundos depois) sem gerar erro no Postgres —
 * mas a corrida real (worker Meta em concurrency 4 lendo "não existe" ao
 * mesmo tempo) só é fechada pelo unique.
 *
 * Quando o unique rejeita, o create perdedor é a duplicata: quem venceu
 * já gravou a linha e já disparou os efeitos (IA, SSE, unread). Ignorar
 * é o comportamento correto — e é o mesmo que o `findFirst` fazia.
 */

/**
 * `true` quando o erro é P2002 no unique de (organizationId, externalId)
 * de `messages`. Outros P2002 (ex.: `organizationId, number`) NÃO entram
 * aqui — eles têm tratamento próprio (retry de número) e engolir seria
 * perder mensagem.
 */
export function isMessageExternalIdUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: string; meta?: { target?: string[] | string } };
  if (e.code !== "P2002") return false;
  const target = e.meta?.target;
  const hit = (s: string) => s.includes("externalId");
  if (Array.isArray(target)) return target.some(hit);
  if (typeof target === "string") return hit(target);
  // Sem `meta.target` (acontece com alguns drivers/adapters) não temos como
  // distinguir o unique — assume que é o de externalId apenas se o caller
  // estiver criando mensagem inbound, o que é o único uso desta helper.
  return target === undefined;
}

/**
 * Executa o create e devolve `null` quando o unique de externalId rejeitou
 * (= a mensagem já existe). Qualquer outro erro sobe.
 */
export async function createMessageDedup<T>(
  create: () => Promise<T>,
): Promise<T | null> {
  try {
    return await create();
  } catch (err) {
    if (isMessageExternalIdUniqueViolation(err)) return null;
    throw err;
  }
}
