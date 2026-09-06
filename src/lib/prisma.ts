import { Prisma } from "@prisma/client";

import { prismaBase } from "@/lib/prisma-base";
import {
  deepInjectOrgId,
  mergeWhere,
} from "@/lib/prisma-tenant-helpers";
import {
  NUMBERED_ORG_MODELS,
  rewriteNumericIdWhere,
} from "@/lib/public-id";
import {
  enterRequestContext,
  getRequestContext,
  type RequestContext,
} from "@/lib/request-context";

/**
 * Cliente Prisma com extension de organization-scope aplicada.
 *
 * Isolamento multi-tenant — camada 1 (aplicacao):
 *   - READ (find*, count, aggregate, groupBy): injeta where.organizationId
 *   - CREATE: injeta data.organizationId
 *   - UPDATE/DELETE: exige where.organizationId
 *   - UPSERT: injeta nos 3 (where, create, update)
 *
 * Comportamento conforme o RequestContext atual:
 *   a) Contexto com super-admin=true  -> bypass total (sem injection)
 *   b) Contexto com organizationId    -> injecao normal
 *   c) Sem contexto                   -> THROW — protege contra leak.
 *
 * Models que NAO recebem injection (listados como "global"):
 *   - Organization, User, SystemSetting, MetaPricingDailyMetric
 *   (User fica de fora pra nao quebrar login/jwt — paginas de /settings/team
 *    filtram por organizationId manualmente no where.)
 *
 * Se alguma rota precisa cruzar orgs (ex.: webhook que ainda nao resolveu
 * canal, script de manutencao, seed), importe `prismaBase` de
 * @/lib/prisma-base.
 */

const SCOPED_MODELS = new Set<Prisma.ModelName>([
  "Contact",
  "Company",
  "ContactPhoneChange",
  "Tag",
  "CustomField",
  "ContactCustomFieldValue",
  "DealCustomFieldValue",
  "ProductCustomFieldValue",
  "Pipeline",
  "Stage",
  "Deal",
  "DealProduct",
  "DealEvent",
  "DealStageDailySnapshot",
  "ActivityEvent",
  "Product",
  // Produtos multi-tipo (ledger + ofertas + unidades). Todos tenant-scoped.
  "OrgUnit",
  "ProductOffer",
  "InventoryPool",
  "InventoryMovement",
  "ProductShipping",
  "ProductPlan",
  "CourseConfig",
  "CourseClass",
  "JobOpening",
  "ProductStakeholder",
  // Catálogo por capacidades (PRD catalogo-capacidades). Todos tenant-scoped.
  "Catalog",
  "CatalogCapability",
  "ProductCapability",
  "CapacitySlot",
  "ShippingRange",
  "StakeholderRule",
  "DealLink",
  // Cotas de desconto (PRD Cotas — Fase 1). Todos tenant-scoped.
  "DiscountQuota",
  "QuotaConsumptionPolicy",
  "DealQuota",
  "QuotaMovement",
  "Activity",
  "ActivityComment",
  "ActivityCommentRevision",
  "ActivityAlertState",
  "Note",
  "Conversation",
  "Message",
  "SupportTicket",
  "SupportTicketMessage",
  "TeamChatRoom",
  "TeamChatMember",
  "TeamChatMessage",
  "TeamChatNote",
  "DemandBoard",
  "DemandStage",
  "DemandItem",
  "DemandItemAssignee",
  "DemandComment",
  "DemandVote",
  "DemandEvent",
  "WhatsappCallEvent",
  "ScheduledWhatsappCall",
  "ScheduledMessage",
  "Automation",
  "AutomationStep",
  "AutomationLog",
  "AutomationContext",
  "Channel",
  "BaileysAuthKey",
  "QuickReply",
  "MessageTemplate",
  "WhatsAppTemplateConfig",
  // Flow: só a definição tem organizationId; screens/campos/mappings
  // ligam-se por flowId — não entram em SCOPED_MODELS (evita inject inválido).
  "WhatsappFlowDefinition",
  "DistributionRule",
  "DistributionMember",
  "DistributionResponsible",
  "DistributionLog",
  "DistributionPending",
  // Department / DepartmentMember — SEM isso, findMany() vazava depts de
  // outras orgs (ex.: handoff IA resolvia "Atendimento" da EduIT dentro
  // da Cruzeiro EaD e gravava departmentId cross-tenant).
  "Department",
  "DepartmentMember",
  "Segment",
  "Campaign",
  "CampaignRecipient",
  "LossReason",
  "PipelineLossReason",
  "Tabulation",
  "ApiToken",
  "IntegrationWebhook",
  "MobileLayoutConfig",
  "UserDashboardLayout",
  "WebPushSubscription",
  "AgentSchedule",
  "AgentStatus",
  "AgentPresenceLog",
  "SystemUsageSession",
  "SystemActivitySession",
  "AIAgentConfig",
  "AIAgentConfigAudit",
  "AIAgentKnowledgeDoc",
  "AIAgentKnowledgeChunk",
  "AIAgentRun",
  "AIAgentMessage",
  "OrganizationInvite",
  // Authz Foundation (Fase 1) — esses 3 modelos sao tenant-scoped.
  // Sem isso, prisma.role.findMany() leakaria roles de OUTROS tenants
  // pra um Admin tentando listar permissoes da propria org.
  "Role",
  "UserRoleAssignment",
  "OrganizationSetting",
  "OrganizationWidget",
  "SavedFilter",
  // BulkOperation tem organizationId NOT NULL no schema. Sem entrar
  // aqui:
  //   - prisma.bulkOperation.create() falha porque organizationId
  //     nao eh injetado e o Prisma rejeita o data (callsites em
  //     /api/deals/bulk e /api/deals/bulk/custom-fields confiam na
  //     extension pra inject — nao passam organizationId no payload).
  //   - prisma.bulkOperation.findUnique({ where: { id } }) em
  //     /api/bulk-operations/[id] retornaria operations de QUALQUER
  //     org (data leak cross-tenant) porque o where nao receberia
  //     o filtro automatico de organizationId.
  // Worker (leads-worker + jobs/leads/*) usa prismaBase e ja escopa
  // manualmente — esses callsites nao mudam.
  "BulkOperation",
  // Favoritos de mensagem por agente (marcador pessoal, tipo "salvos" do
  // WhatsApp). organizationId NOT NULL — mesma razao do BulkOperation
  // acima: sem entrar aqui, create() falha (nao injeta) e findMany()
  // leakaria favoritos de outra org.
  "FavoriteMessage",
  // Favoritos + contador de uso dos atalhos "/" por agente. organizationId
  // NOT NULL — mesma razao do FavoriteMessage: sem entrar aqui create() nao
  // injeta org e findMany() leakaria preferencias de outra org.
  "AgentMessageShortcut",
]);

type AnyArgs = Record<string, unknown>;

/**
 * Implementacao das helpers (mergeWhere, mergeData, deepInjectOrgId)
 * vive em @/lib/prisma-tenant-helpers — ficou separado pra ser
 * testavel sem precisar de DB rodando. Importadas no topo do arquivo.
 *
 * Doc do deepInjectOrgId: injeta `organizationId` recursivamente em
 * nested writes (`create`, `createMany.data`, `connectOrCreate.create`,
 * `upsert.create/update`, `update.data`). NAO toca em `where`, `connect`,
 * `disconnect`, `set`, `delete`. Se alguma relation apontar pra um
 * model nao-scoped (ex.: User), o Prisma rejeita com "Unknown arg
 * organizationId" — nesse caso o caller deve usar `prismaBase`.
 *
 * Bug-history: a versao "checked input" (`organization: { connect }`)
 * quebrava callsites com FKs escalares (`conversationId`, `contactId`,
 * etc) misturadas. Resolvido voltando pra `organizationId` escalar
 * (unchecked input) — convencao do projeto.
 */

const globalForPrisma = globalThis as unknown as {
  prismaScoped: ReturnType<typeof extend> | undefined;
};

/**
 * Fallback: resolve o ctx diretamente do cookie da request atual quando
 * o handler nao envolveu explicitamente em withOrgContext. Necessario
 * porque `AsyncLocalStorage.enterWith` chamado em `auth()` / helpers so
 * propaga pra DESCENDENTES do frame do wrapper, nao pro caller — e
 * refatorar ~130 route handlers pra usar runWithContext explicito nao eh
 * viavel no escopo atual.
 *
 * Funciona so em request scope do Next.js (next/headers so responde la).
 * Em worker/webhook/cron, retorna null — esses fluxos ja usam
 * `withSystemContext` / `withWebhookContext` / prismaBase.
 *
 * Decode usa a mesma chave que o NextAuth (AUTH_SECRET / NEXTAUTH_SECRET)
 * e o nome-padrao dos cookies do next-auth v5 (authjs.session-token,
 * com prefixo __Secure- quando o cookie foi emitido via HTTPS).
 */
async function resolveCtxFromNextCookie(): Promise<RequestContext | null> {
  try {
    const headersMod = (await import("next/headers")) as {
      cookies: () => Promise<{ get: (n: string) => { value: string } | undefined }>;
    };
    const cookieStore = await headersMod.cookies();

    // Guard: fora de request scope o cookieStore pode ser um objeto
    // inválido sem o método .get (causa "e.get is not a function").
    if (!cookieStore || typeof cookieStore.get !== "function") {
      return null;
    }

    const secureName = "__Secure-authjs.session-token";
    const insecureName = "authjs.session-token";
    const raw =
      cookieStore.get(secureName)?.value ??
      cookieStore.get(insecureName)?.value;
    if (!raw) return null;

    const secret =
      process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET ?? "";
    if (!secret) return null;

    const jwtMod = (await import("@auth/core/jwt")) as {
      decode: (p: {
        token: string;
        secret: string;
        salt: string;
      }) => Promise<Record<string, unknown> | null>;
    };
    // o NextAuth v5 usa o nome do cookie como salt pra derivar a chave
    const cookieName =
      cookieStore.get(secureName)?.value ? secureName : insecureName;
    const decoded = await jwtMod.decode({
      token: raw,
      secret,
      salt: cookieName,
    });
    if (!decoded || typeof decoded.id !== "string") return null;

    return {
      organizationId:
        (decoded.organizationId as string | null | undefined) ?? null,
      userId: decoded.id,
      isSuperAdmin: Boolean(decoded.isSuperAdmin),
    };
  } catch {
    // fora de request scope (worker, cron, etc) ou cookie invalido
    return null;
  }
}

/** Tabela do contador — ver model `OrgNumberCounter` no schema. */
const NUMBER_COUNTER_TABLE = "org_number_counters";

type NumberedTableMeta = {
  table: string;
  orgColumn: string;
  numberColumn: string;
};

const numberedTableMetaCache = new Map<Prisma.ModelName, NumberedTableMeta>();

/**
 * Identificador para interpolação via `Prisma.raw`. Os nomes só vêm do DMMF
 * (nunca de input), mas validamos de todo jeito: `Prisma.raw` não escapa
 * nada, então um nome inesperado aqui viraria injeção de SQL.
 */
function quoteIdentifier(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(
      `[prisma] identificador rejeitado para SQL cru: ${JSON.stringify(name)}`,
    );
  }
  return `"${name}"`;
}

/**
 * Resolve nome real de tabela/colunas no banco a partir dos metadados do
 * client. Model name != table name: quase todo model usa `@@map`
 * (`Conversation` -> `conversations`, `CustomField` -> `custom_fields`).
 * Lança se o model não existir ou não tiver as colunas esperadas — melhor
 * estourar no primeiro create do que montar SQL contra tabela errada.
 */
function numberedTableMeta(model: Prisma.ModelName): NumberedTableMeta {
  const cached = numberedTableMetaCache.get(model);
  if (cached) return cached;

  const dm = Prisma.dmmf.datamodel.models.find((m) => m.name === model);
  if (!dm) {
    throw new Error(`[prisma] model ${model} nao encontrado no DMMF.`);
  }
  const org = dm.fields.find((f) => f.name === "organizationId");
  const num = dm.fields.find((f) => f.name === "number");
  if (!org || !num) {
    throw new Error(
      `[prisma] model ${model} esta em NUMBERED_ORG_MODELS mas nao tem ` +
        `os campos organizationId + number.`,
    );
  }

  const meta: NumberedTableMeta = {
    table: dm.dbName ?? dm.name,
    orgColumn: org.dbName ?? org.name,
    numberColumn: num.dbName ?? num.name,
  };
  numberedTableMetaCache.set(model, meta);
  return meta;
}

/**
 * Reserva `count` números sequenciais para (model, org) e devolve o
 * primeiro da faixa.
 *
 * Por que não é mais `MAX(number) + 1` (stress test staging, 23/08):
 *   - custo: a extension de scope traduz `aggregate({_max})` para
 *     `SELECT MAX(number) FROM (SELECT number FROM t WHERE org=$1 OFFSET $2)`.
 *     O `OFFSET` mata o Index Only Scan Backward — 344ms lendo 78k linhas
 *     contra 0,3ms na forma direta. Eram 27k chamadas/180s.
 *   - corrida: ler o MAX e inserir são statements distintos, então N workers
 *     concorrentes leem o mesmo número. Deu 27k P2002 em
 *     `(organizationId, number)` numa janela de 180s.
 *
 * A alocação virou UM statement. `ON CONFLICT DO UPDATE` serializa no row
 * lock do contador (granularidade org+model: orgs e models distintos não se
 * bloqueiam), então duas chamadas concorrentes nunca recebem a mesma faixa.
 *
 * Advisory lock foi descartado de propósito: `pg_advisory_xact_lock` só
 * solta no fim da transaction, e aqui a leitura roda em `prismaBase` (fora
 * da transaction do caller, que a extension nem consegue alcançar — o
 * callback `query()` do `$allOperations` já está preso ao client de origem).
 * O lock seria liberado antes do INSERT e não protegeria nada. Com o
 * contador a atomicidade é do statement, então não depende de transaction.
 *
 * `GREATEST(lastNumber, MAX(number))` é rede de segurança: se alguém inserir
 * `number` por fora do contador (seed, SQL manual, backfill), o contador se
 * realinha em vez de reemitir número já usado. O `MAX` aqui é a forma rápida
 * (sem OFFSET), então custa ~0,3ms.
 *
 * Efeito colateral aceito: a faixa é consumida mesmo se o INSERT do caller
 * falhar depois (o contador não participa da transaction dele). Isso abre
 * buracos na numeração, o que já acontecia antes via retry. Numeração é
 * identificador público, não contagem.
 */
export async function allocateOrgNumber(
  model: Prisma.ModelName,
  orgId: string,
  count = 1,
): Promise<number> {
  const { table, orgColumn, numberColumn } = numberedTableMeta(model);
  const n = Math.max(1, Math.trunc(count));

  const counter = Prisma.raw(quoteIdentifier(NUMBER_COUNTER_TABLE));
  const rows = await prismaBase.$queryRaw<
    Array<{ next_number: bigint | number | string }>
  >`
    WITH atual AS (
      SELECT COALESCE(MAX(${Prisma.raw(quoteIdentifier(numberColumn))}), 0) AS max_num
        FROM ${Prisma.raw(quoteIdentifier(table))}
       WHERE ${Prisma.raw(quoteIdentifier(orgColumn))} = ${orgId}
    )
    INSERT INTO ${counter} ("organizationId", "model", "lastNumber", "updatedAt")
    SELECT ${orgId}, ${model}, atual.max_num + ${n}::int, now() FROM atual
    ON CONFLICT ("organizationId", "model") DO UPDATE
       SET "lastNumber" =
             GREATEST(${counter}."lastNumber", excluded."lastNumber" - ${n}::int)
             + ${n}::int,
           "updatedAt" = now()
    RETURNING "lastNumber" - ${n}::int + 1 AS next_number
  `;

  const first = Number(rows[0]?.next_number ?? 0);
  if (!Number.isFinite(first) || first < 1) {
    throw new Error(
      `[prisma] allocateOrgNumber(${model}) nao retornou numero valido.`,
    );
  }
  return first;
}

function isNumberUniqueViolation(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: string; meta?: { target?: string[] | string } };
  if (e.code !== "P2002") return false;
  const t = e.meta?.target;
  if (Array.isArray(t)) return t.some((x) => String(x).includes("number"));
  return typeof t === "string" && t.includes("number");
}

function extend(base: typeof prismaBase = prismaBase) {
  return base.$extends({
    name: "organization-scope",
    query: {
      $allModels: {
        async $allOperations({ args, query, operation, model }) {
          if (!SCOPED_MODELS.has(model as Prisma.ModelName)) {
            return query(args);
          }
          let ctx: RequestContext | undefined = getRequestContext();
          if (!ctx) {
            const resolved = await resolveCtxFromNextCookie();
            if (resolved) {
              enterRequestContext(resolved);
              ctx = resolved;
            }
          }
          if (!ctx) {
            throw new Error(
              `[prisma] ${model}.${operation} chamado fora de RequestContext. ` +
                `Envolva o handler em withOrgContext/withApiAuthContext/withWebhookContext, ` +
                `ou use prismaBase (@/lib/prisma-base) para cross-org.`,
            );
          }
          // super-admin:
          //   - sem organizationId no ctx → bypass total (ex.: painel
          //     /admin/organizations operando cross-org)
          //   - COM organizationId → continua injetando. Motivo: o
          //     admin@eduit.com eh super-admin mas tambem membro da
          //     org EduIT, e ao acessar a UI padrao do CRM (dashboard,
          //     pipelines, etc.) todas as writes precisam sair
          //     escopadas. Bypass nesse caso quebraria `pipeline.create`
          //     (org obrigatoria no schema).
          if (ctx.isSuperAdmin && !ctx.organizationId) {
            return query(args);
          }
          if (!ctx.organizationId) {
            throw new Error(
              `[prisma] ${model}.${operation} exige organizationId mas o contexto esta vazio.`,
            );
          }
          const orgId = ctx.organizationId;
          const a = (args ?? {}) as AnyArgs;

          const numbered = NUMBERED_ORG_MODELS.has(model as Prisma.ModelName);

          switch (operation) {
            case "findUnique":
            case "findUniqueOrThrow":
            case "findFirst":
            case "findFirstOrThrow":
            case "findMany":
            case "count":
            case "aggregate":
            case "groupBy":
            case "updateMany":
            case "deleteMany":
            case "update":
            case "delete": {
              a.where = mergeWhere(a.where, orgId);
              if (
                numbered &&
                (operation === "findUnique" ||
                  operation === "findUniqueOrThrow" ||
                  operation === "findFirst" ||
                  operation === "findFirstOrThrow" ||
                  operation === "update" ||
                  operation === "delete")
              ) {
                a.where = rewriteNumericIdWhere(
                  a.where as Record<string, unknown> | undefined,
                  orgId,
                );
              }
              if (operation === "update" && a.data) {
                a.data = deepInjectOrgId(a.data, orgId) as Record<
                  string,
                  unknown
                >;
              }
              break;
            }
            case "create": {
              a.data = deepInjectOrgId(a.data, orgId) as Record<
                string,
                unknown
              >;
              if (
                numbered &&
                a.data &&
                typeof a.data === "object" &&
                (a.data as { number?: unknown }).number == null
              ) {
                (a.data as { number: number }).number =
                  await allocateOrgNumber(model as Prisma.ModelName, orgId);
              }
              break;
            }
            case "createMany":
            case "createManyAndReturn": {
              const raw = a.data;
              const inject = (d: unknown) =>
                deepInjectOrgId(d, orgId) as Record<string, unknown>;
              if (Array.isArray(raw)) {
                a.data = raw.map(inject);
              } else if (raw && typeof raw === "object") {
                a.data = inject(raw);
              }
              if (numbered) {
                const rows = Array.isArray(a.data) ? a.data : [a.data];
                const missing = rows.filter(
                  (d) => d && typeof d === "object" && d.number == null,
                );
                if (missing.length > 0) {
                  // Reserva a faixa inteira num statement: pedir 1 número e
                  // incrementar em memória devolvia números já emitidos para
                  // outro createMany concorrente.
                  let n = await allocateOrgNumber(
                    model as Prisma.ModelName,
                    orgId,
                    missing.length,
                  );
                  for (const d of missing) {
                    d.number = n++;
                  }
                }
              }
              break;
            }
            case "upsert": {
              a.where = mergeWhere(a.where, orgId);
              if (numbered) {
                a.where = rewriteNumericIdWhere(
                  a.where as Record<string, unknown> | undefined,
                  orgId,
                );
              }
              if (a.create) {
                a.create = deepInjectOrgId(a.create, orgId) as Record<
                  string,
                  unknown
                >;
                if (
                  numbered &&
                  (a.create as { number?: unknown }).number == null
                ) {
                  (a.create as { number: number }).number =
                    await allocateOrgNumber(model as Prisma.ModelName, orgId);
                }
              }
              if (a.update) {
                a.update = deepInjectOrgId(a.update, orgId) as Record<
                  string,
                  unknown
                >;
              }
              break;
            }
            default:
              // Operação não mapeada em model scoped NUNCA pode passar
              // sem filtro de tenant — falha ruidosa em vez de leak silencioso.
              throw new Error(
                `[prisma] operação "${operation}" não mapeada na extension de ` +
                  `organization-scope (model ${model}). Mapeie explicitamente ` +
                  `ou use prismaBase (@/lib/prisma-base).`,
              );
          }

          // Retry mantido como rede de segurança: `allocateOrgNumber` já é
          // atômico, mas ainda existem call sites que atribuem `number` por
          // conta própria (ex.: `withConversationNumberRetry`) e podem
          // colidir com a faixa emitida pelo contador.
          if (
            numbered &&
            (operation === "create" ||
              operation === "createMany" ||
              operation === "createManyAndReturn" ||
              operation === "upsert")
          ) {
            let lastErr: unknown;
            for (let attempt = 0; attempt < 5; attempt++) {
              try {
                return await query(a);
              } catch (err) {
                lastErr = err;
                if (!isNumberUniqueViolation(err)) throw err;
                if (operation === "create" && a.data) {
                  (a.data as { number: number }).number =
                    await allocateOrgNumber(model as Prisma.ModelName, orgId);
                } else if (operation === "upsert" && a.create) {
                  (a.create as { number: number }).number =
                    await allocateOrgNumber(model as Prisma.ModelName, orgId);
                } else {
                  throw err;
                }
              }
            }
            throw lastErr;
          }

          return query(a);
        },
      },
    },
  });
}

/**
 * Aplica a extension de organization-scope a qualquer base client.
 * Exportado pra ser reaproveitado em `lib/prisma-replica.ts` (PR 5.2)
 * sem duplicar logica.
 */
export const applyOrgScope = extend;

export const prisma = globalForPrisma.prismaScoped ?? extend();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prismaScoped = prisma;
}

export type ScopedPrisma = typeof prisma;

// NOTA: `prismaReplica` (PR 5.2) NAO eh re-exportado aqui de proposito.
// Re-export criava ciclo `prisma.ts <-> prisma-replica.ts` que, depois
// que o PrismaClient passou a ser tratado como async module pelo
// webpack (chunk 2144 minificado), virava TDZ em "Collecting page
// data" do `next build`:
//   ReferenceError: Cannot access 'o' before initialization
//     at Object.zR (.next/server/chunks/2144.js:1:2302)
// Quem precisa do replica importa diretamente de `@/lib/prisma-replica`
// — o unico caller real eh `lib/analytics.ts::analyticsClient()`.

/**
 * Tipo do cliente dentro de prisma.$transaction((tx) => ...).
 * Por causa do extension, o `tx` nao e mais um Prisma.TransactionClient
 * puro, e sim a versao extendida sem os metodos terminadores. Quem
 * recebe um `tx` em assinatura de funcao deve usar `ScopedTx` em vez
 * de `Prisma.TransactionClient` para evitar TS2345 no callsite.
 */
export type ScopedTx = Omit<
  ScopedPrisma,
  "$connect" | "$disconnect" | "$on" | "$transaction" | "$use" | "$extends"
>;
