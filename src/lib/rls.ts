/**
 * Row-Level Security (RLS) helpers — PR 1.4 (multi-tenancy hardening).
 *
 * A migration `20260501000001_multi_tenancy_rls` criou policies em todas
 * as tabelas tenant-scoped baseadas em duas GUCs (Grand Unified
 * Configuration parameters) Postgres:
 *
 *   - `app.organization_id`  — texto, id da org corrente
 *   - `app.is_super_admin`   — boolean, bypass total
 *
 * Estas GUCs sao lidas pelas funcoes SQL `current_organization_id()` e
 * `current_is_super_admin()`, que por sua vez sao usadas nas USING/WITH
 * CHECK clauses das policies.
 *
 * O **estado atual** (cf. `docs/rls-activation.md`):
 *
 *   1. Policies criadas — sim.
 *   2. RLS habilitado nas tabelas (`ALTER TABLE ... ENABLE`) — NAO,
 *      ainda nao ativado em prod. Vamos ativar via migration controlada
 *      quando o smoke-test em staging passar.
 *   3. App seta as GUCs em cada request — somente quando o caller usa
 *      `withRlsSession()` desta lib (uso opcional, defesa em
 *      profundidade). Quando RLS nao esta ENABLE, setar as GUCs e no-op.
 *
 * **Quando usar `withRlsSession`?**
 *
 *   - Testes automatizados de isolamento cross-tenant (PR 1.5): o teste
 *     habilita RLS na tabela alvo e roda queries via wrapper pra
 *     verificar que policies bloqueiam leakage.
 *   - Codigo executando como role nao-superuser (futuro): em producao
 *     queremos rodar como `app_runtime` que NAO tem BYPASSRLS, e nesse
 *     cenario TODA query precisa estar dentro de `withRlsSession` pra
 *     que as policies vejam o orgId.
 *
 * **Quando NAO usar:**
 *
 *   - Codigo normal de request hoje. A Prisma Extension app-layer ja
 *     filtra por organizationId — RLS e a SEGUNDA camada de defesa.
 *
 * Implementacao:
 *
 *   `withRlsSession` abre uma transacao e executa `SET LOCAL` para as
 *   GUCs antes de invocar o callback. `SET LOCAL` so vale durante a
 *   transacao, garantindo que conexoes do pool nao "vazem" GUCs entre
 *   requests/clientes.
 */
import { prismaBase } from "@/lib/prisma-base";
import type { Prisma } from "@prisma/client";

export type RlsSessionOptions = {
  organizationId: string | null;
  isSuperAdmin?: boolean;
};

/**
 * Tipo do client dentro de `prismaBase.$transaction(...)`.
 */
export type RlsTx = Prisma.TransactionClient;

/**
 * Define as GUCs `app.organization_id` e `app.is_super_admin` na
 * transacao corrente. Usa `set_config(name, value, true)` — o terceiro
 * argumento `true` significa LOCAL (escopo: transacao atual).
 *
 * Aceita `null`/`undefined` para limpar (necessario em alguns testes
 * onde queremos validar que policies bloqueiam quem nao tem GUC).
 */
export async function setRlsGucs(
  tx: RlsTx,
  opts: RlsSessionOptions,
): Promise<void> {
  const orgId = opts.organizationId ?? "";
  const sa = opts.isSuperAdmin ? "true" : "false";
  // Usamos $executeRawUnsafe pq parametros bind nao sao aceitos em
  // SET. set_config aceita parametros — preferimos ele.
  await tx.$executeRaw`SELECT set_config('app.organization_id', ${orgId}, true)`;
  await tx.$executeRaw`SELECT set_config('app.is_super_admin', ${sa}, true)`;
}

/**
 * Executa `fn` dentro de uma transacao com as GUCs `app.organization_id`
 * e `app.is_super_admin` setadas via SET LOCAL. As policies de RLS
 * conseguem ler essas GUCs via `current_organization_id()` /
 * `current_is_super_admin()` SQL functions.
 *
 * Use em testes de isolamento e em codigo que vai rodar como role
 * nao-superuser sem BYPASSRLS.
 *
 * Roda sobre `prismaBase` (sem extension app-layer) deliberadamente,
 * pra que o teste valide APENAS o efeito do RLS — sem injection
 * automatica de organizationId pelo lado do app.
 */
export async function withRlsSession<T>(
  opts: RlsSessionOptions,
  fn: (tx: RlsTx) => Promise<T>,
): Promise<T> {
  return prismaBase.$transaction(async (tx) => {
    await setRlsGucs(tx, opts);
    return fn(tx);
  });
}

/**
 * Habilita RLS em uma tabela (ENABLE + FORCE). FORCE garante que ate
 * o owner da tabela seja submetido as policies — necessario porque o
 * usuario que roda as migrations costuma ser o owner.
 *
 * Idempotente. Use em testes ou na migration de "go-live".
 */
export async function enableRlsOnTable(
  tx: RlsTx,
  tableName: string,
): Promise<void> {
  // Whitelist conservadora: apenas snake_case com letras/numeros/underline.
  if (!/^[a-z][a-z0-9_]*$/.test(tableName)) {
    throw new Error(`enableRlsOnTable: nome de tabela invalido "${tableName}"`);
  }
  await tx.$executeRawUnsafe(`ALTER TABLE ${tableName} ENABLE ROW LEVEL SECURITY`);
  await tx.$executeRawUnsafe(`ALTER TABLE ${tableName} FORCE ROW LEVEL SECURITY`);
}

/**
 * Lista de tabelas que receberam policy `tenant_isolation` na migration
 * 20260501000001_multi_tenancy_rls. Usada por testes e pelo script de
 * ativacao gradual.
 */
export const RLS_PROTECTED_TABLES = [
  "contacts",
  "contact_phone_changes",
  "companies",
  "tags",
  "custom_fields",
  "contact_custom_field_values",
  "deal_custom_field_values",
  "product_custom_field_values",
  "pipelines",
  "stages",
  "deals",
  "deal_products",
  "deal_events",
  "products",
  "activities",
  "notes",
  "conversations",
  "messages",
  "whatsapp_call_events",
  "scheduled_whatsapp_calls",
  "scheduled_messages",
  "automations",
  "automation_steps",
  "automation_logs",
  "automation_contexts",
  "channels",
  "baileys_auth_keys",
  "quick_replies",
  "message_templates",
  "whatsapp_template_configs",
  "whatsapp_flow_definitions",
  "whatsapp_flow_screens",
  "whatsapp_flow_fields",
  "whatsapp_flow_field_mappings",
  "distribution_rules",
  "distribution_members",
  "segments",
  "campaigns",
  "campaign_recipients",
  "loss_reasons",
  "api_tokens",
  "mobile_layout_config",
  "user_dashboard_layouts",
  "web_push_subscriptions",
  "agent_schedules",
  "agent_statuses",
  "agent_presence_logs",
  "ai_agent_configs",
  "ai_agent_knowledge_docs",
  "ai_agent_knowledge_chunks",
  "ai_agent_runs",
  "ai_agent_messages",
  "organization_invites",
  "email_accounts",
  "emails",
  "email_custom_folders",
  "email_rules",
] as const;

export type RlsProtectedTable = (typeof RLS_PROTECTED_TABLES)[number];
