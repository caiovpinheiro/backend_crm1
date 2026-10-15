/**
 * Rede de segurança da versão de CARD do board (gate C, 15/10/2026).
 *
 * O ETag do board (`lib/cache/board-etag.ts`) só muda quando a versão de
 * card sobe. Os escritores principais já sobem a versão do funil na hora
 * (`invalidateBoardData` / `invalidateBoardsForPipelines` /
 * `syncBoardsAfterDealChanges`: criar, mover, editar, ganhar/perder, excluir,
 * dono, tags do negócio). Muitos outros mexem em dado que aparece no card e
 * não sabiam do board: tarefas (`pendingActivities`), produtos, tag
 * renomeada, nome/foto do contato e do dono, etapas, campo nativo gravado por
 * automação/IA/Flow, distribuição, merge de contatos… — antes o TTL de 45 s
 * do valor em cache escondia isso; com 304 o card ficaria velho.
 *
 * Aqui fica o bump centralizado desses escritores: a extension do `prisma`
 * (`lib/prisma.ts`) avisa cada escrita e, se o model/campo aparece no card,
 * agenda a troca da versão de card da ORG (`invalidateOrgBoards`):
 *
 *   - na hora E de novo `BOARD_CARD_WRITE_BUMP_DELAY_MS` depois: a escrita
 *     pode estar dentro de uma transação ainda não commitada, e quem ler o
 *     banco no meio guardaria o dado antigo sob a versão nova — o segundo
 *     bump tira essa chave de circulação;
 *   - coalescida por org no processo: uma rajada (lote, importação) vira no
 *     máximo esses dois bumps por janela.
 *
 * Fica de fora o que escreve por `prismaBase` (webhooks/workers sem contexto
 * de org, ex.: nome do contato vindo do WhatsApp): o balde de 15 min do ETag
 * cobre. Mensagem (`Contact.lastMessageAt`, conversas, mensagens) não conta.
 *
 * Sem import estático do cache: `prisma.ts` é importado por quase tudo e o
 * cache puxa Redis/métricas (ciclo/TDZ no `next build`, ver `prisma.ts`).
 */
import { getRequestContext } from "@/lib/request-context";

/** Atraso do bump depois da escrita (passa do commit da transação). */
export const BOARD_CARD_WRITE_BUMP_DELAY_MS = 2_000;

type Args = Record<string, unknown> | undefined;

const WRITE_OPERATIONS: ReadonlySet<string> = new Set([
  "create",
  "createMany",
  "createManyAndReturn",
  "update",
  "updateMany",
  "updateManyAndReturn",
  "upsert",
  "delete",
  "deleteMany",
]);

function isDelete(operation: string): boolean {
  return operation === "delete" || operation === "deleteMany";
}

/**
 * Campos ALTERADOS num registro que já existe (`data` do update; ramo
 * `update` do upsert). Criação fica de fora: contato/usuário/produto/tag
 * novos ainda não estão em card nenhum (o negócio novo sobe a versão pelo
 * próprio `Deal`).
 */
function updatedKeys(operation: string, args: Args): Set<string> {
  const keys = new Set<string>();
  const add = (data: unknown) => {
    const rows = Array.isArray(data) ? data : [data];
    for (const row of rows) {
      if (row && typeof row === "object") for (const k of Object.keys(row)) keys.add(k);
    }
  };
  if (operation === "upsert") add(args?.update);
  else if (operation.startsWith("update")) add(args?.data);
  return keys;
}

function touches(keys: Set<string>, fields: readonly string[]): boolean {
  return fields.some((f) => keys.has(f));
}

/** Campos do contato que o card mostra (não `lastMessageAt` & cia). */
const CONTACT_CARD_FIELDS = ["name", "email", "phone", "avatarUrl"] as const;
/** Dono do card: nome, foto e tipo (humano/IA). */
const USER_CARD_FIELDS = ["name", "avatarUrl", "type"] as const;
const PRODUCT_CARD_FIELDS = ["name", "type"] as const;
const TAG_CARD_FIELDS = ["name", "color"] as const;

/**
 * A escrita muda algo que aparece num card do board (ou em que coluna ele
 * está)? Model ausente da lista = não.
 */
export function isBoardCardWrite(model: string, operation: string, args: Args): boolean {
  if (!WRITE_OPERATIONS.has(operation)) return false;
  switch (model) {
    // Qualquer escrita: o card espalha os campos do negócio (inclusive
    // `updatedAt`, que decide o `isRotting`) e mostra tags/produtos/tarefas.
    case "Deal":
    case "TagOnDeal":
    case "DealProduct":
    case "Activity":
    case "Stage":
      return true;
    case "Contact":
      return isDelete(operation) || touches(updatedKeys(operation, args), CONTACT_CARD_FIELDS);
    case "User":
      return isDelete(operation) || touches(updatedKeys(operation, args), USER_CARD_FIELDS);
    case "Product":
      return isDelete(operation) || touches(updatedKeys(operation, args), PRODUCT_CARD_FIELDS);
    case "Tag":
      return isDelete(operation) || touches(updatedKeys(operation, args), TAG_CARD_FIELDS);
    default:
      return false;
  }
}

const pending = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Chamado pela extension do `prisma` antes de cada operação. Barato: sem
 * I/O no caminho da escrita; o bump sai num timer.
 */
export function noteBoardCardWrite(model: string | undefined, operation: string, args: unknown): void {
  try {
    if (!model || !isBoardCardWrite(model, operation, args as Args)) return;
    const orgId = getRequestContext()?.organizationId;
    if (!orgId) return;
    scheduleOrgBoardCardBump(orgId);
  } catch {
    /* nunca atrapalha a escrita */
  }
}

function bumpOrgBoards(orgId: string): void {
  void import("@/lib/cache/keys")
    .then(({ invalidateOrgBoards }) => invalidateOrgBoards(orgId))
    .catch(() => {
      /* best-effort: o balde de 15 min do ETag cobre */
    });
}

/**
 * Troca a versão de card de todos os boards da org: uma vez na hora (quem
 * fez a escrita e recarrega o board logo depois já vê o ETag novo) e outra
 * `BOARD_CARD_WRITE_BUMP_DELAY_MS` depois (passa do commit: quem leu o banco
 * no meio da transação e guardou o valor antigo sob a versão nova perde a
 * chave). Escritas da org dentro da janela não geram bump a mais.
 */
export function scheduleOrgBoardCardBump(orgId: string): void {
  if (pending.has(orgId)) return;
  bumpOrgBoards(orgId);
  const timer = setTimeout(() => {
    pending.delete(orgId);
    bumpOrgBoards(orgId);
  }, BOARD_CARD_WRITE_BUMP_DELAY_MS);
  timer.unref?.();
  pending.set(orgId, timer);
}

/** Só testes: bumps agendados e ainda não executados. */
export function pendingBoardCardBumpsForTests(): string[] {
  return [...pending.keys()];
}

/** Só testes: cancela os bumps agendados. */
export function resetBoardCardWritesForTests(): void {
  for (const timer of pending.values()) clearTimeout(timer);
  pending.clear();
}
