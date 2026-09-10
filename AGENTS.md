# AGENTS — backend CRM EduIT

Playbook deste repo. **Este repositório é a fonte de verdade.** UI: `frontend_crm1` (`:3000`). Este repo é API + Prisma + workers (`:3001`). Mudou uma regra → atualize este arquivo.

Histórico de decisões técnicas: `docs/history/backend-decisions.md` (arquivado — consulte manualmente só quando precisar de contexto histórico; não é contexto cotidiano).

## Comportamento do Agent

- Faça a menor alteração necessária para cumprir cada tarefa.
- Comece pelos arquivos diretamente relacionados ao pedido.
- Não faça auditoria ampla do repositório sem necessidade.
- Não leia históricos apenas para obter contexto adicional.
- Não investigue subsistemas não relacionados à tarefa.
- Não expanda o escopo por conta própria.
- Não faça refatorações amplas sem solicitação.
- Não crie documentação adicional sem solicitação.
- Não abra navegador para validar alterações salvo quando solicitado explicitamente.
- Não use Browser, Computer Use ou screenshots salvo quando solicitado explicitamente.
- Para tarefas de backend, priorize leitura direcionada do código e validações diretamente relacionadas ao que foi alterado.
- Não tente validar visualmente mudanças de backend.
- Não registre automaticamente cada alteração realizada em arquivos de documentação histórica.

## Antes de código

1. Contrato HTTP muda **aqui primeiro**. Frontend só consome.
2. Handler: `requireAuth()` + `requirePermission(user, "recurso:acao")`.
3. Banco: `prisma` de `@/lib/prisma` (injeta `organizationId`). Sem contexto → throw. `prismaBase` só webhook sem org, seed, admin, script — com comentário.
4. Permission nova: entrar em `src/lib/authz/permissions.ts` **antes** de `can()`.
5. Trabalho pesado (Meta, mídia, campanha, CSV, automação) → BullMQ. HTTP valida, persiste, enfileira.
6. Não expanda o escopo com refatorações, documentação adicional ou criação de novos testes sem solicitação. Faça a menor alteração necessária. Quando código for alterado, execute apenas validações técnicas diretamente relacionadas à mudança. Plano curto se >3 arquivos.

## Nunca

- Inventar model `Lead` (é Deal) ou `Group` (stub; filial = `OrgUnit`).
- Recriar deal no inbound se o contato já tem WON/LOST (`src/services/auto-deals.ts`).
- Encerrar conversa ao mover etapa (`moveDeal`).
- Processar webhook Meta / send Graph / parse XLSX no `route.ts`.
- Renomear permission (deprecar + chave nova).
- `ENABLE RLS` não está em prod — não remova a extension Prisma “porque tem RLS”.
- `Channel.pipelineId` / `search_text` — ADRs, **não implementados**.
- Migrate no worker. Só `APP_MODE=api` migra no boot.

## Handler

```ts
export async function GET() {
 const r = await requireAuth();
 if (!r.ok) return r.response;
 const denied = await requirePermission(r.session.user, "deal:view");
 if (denied) return denied;
 // RequestContext ativo. Use prisma (scoped).
}
```

Erro: `{ message: string }` (403 de authz também manda `required`). Middleware de `/api/*` devolve JSON, nunca HTML redirect.

ID na URL: CUID **ou** número por org (`src/lib/public-id.ts`, `idOrNumberWhere`). Não assumir CUID.

Mutou Role/assignment → `invalidateAuthzForOrg` / `invalidateAuthzForUser`.

Job de worker: payload com `organizationId` + `runWithContext` antes de `prisma`. Ator `AUTOMATION` | `SYSTEM` | `AI` | `INTEGRATION`.

## Onde está a verdade

| Assunto | Arquivo |
|---------|---------|
| Permissions | `src/lib/authz/permissions.ts` |
| `can` / cache | `src/lib/authz/index.ts` |
| Auth HTTP | `src/lib/auth-helpers.ts` |
| Prisma tenant | `src/lib/prisma.ts` |
| Contexto | `src/lib/request-context.ts` |
| IDs numéricos | `src/lib/public-id.ts` |
| Filas | `src/lib/queue.ts` |
| Inbox acesso | `src/lib/conversation-access.ts` |
| Auto-deal | `src/services/auto-deals.ts` |
| Move de card | `src/services/deals.ts` → `moveDeal` |
| Tenant | `docs/tenant-subdomain.md` |

## Filas (`APP_MODE`)

| Fila | Worker |
|------|--------|
| `meta-webhook-events` | `worker-meta-webhook` |
| `meta-outbound` / `meta-attach` | `worker-whatsapp` |
| `automation-jobs` | `worker-automation` (`depth` anti-loop) |
| `campaign-dispatch` / `campaign-send` | `worker-campaigns` |
| `leads-bulk` | `worker-leads` (deals/conversas, não model Lead) |
| `import-etl` | `worker-etl` |
| `distribution-drain` / `distribution-execute` | `worker-distribution` |

API pública (n8n): `APP_MODE=api-public`, Bearer `eduit_…`. Não misturar com cookie de sessão.

## Produção (não quebrar)

- Health: `/api/health`. Métricas: `/api/metrics`.
- Inbox “mudo”: worker Meta + Redis + SSE (CORS/cookie). Não “consertar” no frontend primeiro.
- Pool de DB por processo. Não apontar todos os workers para o pool da API.
- Rate limit de sessão existe — debounce no FE; não desligar o limiter.
- Super-admin (`isSuperAdmin`) é o único sem `organizationId`.

## Conceitos

- `Organization` = tenant · `OrgUnit` = filial/CNPJ · `Company` = cliente B2B · `Group` = não usar.
- Deal não tem `pipelineId`; funil vem do `Stage`.
- “Lead” no jargão = Deal.
- Inbound cai no pipeline `isDefault` (canal → funil ainda não existe).
