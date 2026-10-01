import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { requirePermission } from "@/lib/authz";
import { createAutomation, getAutomations } from "@/services/automations";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/automations");

// Bug 27/abr/26: usavamos `auth()` direto. createAutomation chama
// `getOrgIdOrThrow()` SINCRONO em src/services/automations.ts (linha 227)
// — o que dispara ANTES do fallback de cookie da Prisma extension agir.
// UI exibia 500 generico ("Erro ao criar automacao") em
// POST /api/automations. Migrado para withOrgContext (mesmo pattern dos
// outros 26 endpoints corrigidos). GET tambem envolvido por consistencia
// e porque getAutomations chama prisma.automation.findMany — funciona
// hoje pelo fallback de cookie, mas explicitar elimina o debito.

function parseIntParam(v: string | null, fallback: number) {
  if (v === null || v === "") return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function parseBoolParam(v: string | null): boolean | undefined {
  if (v === null || v === "") return undefined;
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  return undefined;
}

export async function GET(request: Request) {
  return withOrgContext(async (session) => {
    const denied = await requirePermission(session.user, "automation:view");
    if (denied) return denied;
    try {
      const { searchParams } = new URL(request.url);
      const active = parseBoolParam(searchParams.get("active"));
      const search = searchParams.get("search") ?? undefined;
      const page = parseIntParam(searchParams.get("page"), 1);
      const perPage = parseIntParam(searchParams.get("perPage"), 20);
      const triggerType = searchParams.get("triggerType")?.trim() || undefined;

      const result = await getAutomations({ active, search, page, perPage, triggerType });
      return NextResponse.json(result);
    } catch (e) {
      log.error({ err: e }, "GET falhou");
      return NextResponse.json({ message: "Erro ao listar automações." }, { status: 500 });
    }
  });
}

export async function POST(request: Request) {
  return withOrgContext(async (session) => {
    const denied = await requirePermission(session.user, "automation:create");
    if (denied) return denied;
    try {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return NextResponse.json({ message: "JSON inválido." }, { status: 400 });
      }

      if (!body || typeof body !== "object") {
        return NextResponse.json({ message: "Corpo inválido." }, { status: 400 });
      }

      const b = body as Record<string, unknown>;

      if (typeof b.name !== "string" || b.name.trim().length < 1) {
        return NextResponse.json({ message: "Nome é obrigatório." }, { status: 400 });
      }
      if (typeof b.triggerType !== "string" || !b.triggerType.trim()) {
        return NextResponse.json({ message: "triggerType é obrigatório." }, { status: 400 });
      }
      if (b.triggerConfig === undefined) {
        return NextResponse.json({ message: "triggerConfig é obrigatório." }, { status: 400 });
      }

      // steps é opcional no wizard de criação — o builder adiciona depois
      const steps = Array.isArray(b.steps) ? b.steps : [];
      for (const step of steps) {
        if (!step || typeof step !== "object") {
          return NextResponse.json({ message: "Passo de automação inválido." }, { status: 400 });
        }
        const s = step as Record<string, unknown>;
        if (typeof s.type !== "string" || !s.type.trim()) {
          return NextResponse.json({ message: "Cada passo precisa de type." }, { status: 400 });
        }
        if (s.config === undefined) {
          return NextResponse.json({ message: "Cada passo precisa de config." }, { status: 400 });
        }
      }

      try {
        const automation = await createAutomation({
          name: b.name,
          description:
            b.description === null
              ? null
              : typeof b.description === "string"
                ? b.description
                : undefined,
          triggerType: b.triggerType,
          triggerConfig: b.triggerConfig as Parameters<typeof createAutomation>[0]["triggerConfig"],
          active: typeof b.active === "boolean" ? b.active : undefined,
          allowManualRun:
            typeof b.allowManualRun === "boolean" ? b.allowManualRun : undefined,
          // BUG 27/abr: o `id` de cada step NAO estava sendo propagado pro
          // service. Resultado: o canvas envia `[{ id: "uuid_a", type, config }]`
          // onde o `config` interno referencia outros steps por esses uuids
          // (`receivedGotoStepId`, `nextStepId`, `buttons[].gotoStepId`,
          // `branches[].nextStepId` ...), mas o service gerava cuids novos
          // via `@default(cuid())`. Os configs ficavam apontando pra ids
          // mortos e `stepIds.has(target)` no `buildEdges` filtrava todas
          // as pernas do fluxo — sintoma reportado pelo operador como "as
          // pernas estao ficando perdidas depois de salvar". `s.id` precisa
          // sobreviver round-trip pra preservar a topologia do grafo.
          steps: steps.map((s) => ({
            id: typeof (s as Record<string, unknown>).id === "string" && (s as Record<string, unknown>).id ? (s as Record<string, unknown>).id as string : undefined,
            type: (s as Record<string, unknown>).type as string,
            config: (s as Record<string, unknown>).config as Parameters<typeof createAutomation>[0]["steps"][number]["config"],
          })),
        });
        return NextResponse.json(automation, { status: 201 });
      } catch (err: unknown) {
        if (err instanceof Error && err.message === "INVALID_NAME") {
          return NextResponse.json({ message: "Nome inválido." }, { status: 400 });
        }
        if (err instanceof Error && err.message === "INVALID_TRIGGER_CONFIG") {
          return NextResponse.json(
            { message: "Horas antes do encerramento devem ser maiores que 0 e menores que 24." },
            { status: 400 },
          );
        }
        throw err;
      }
    } catch (e: unknown) {
      log.error({ err: e }, "POST falhou");
      return NextResponse.json({ message: "Erro ao criar automação." }, { status: 500 });
    }
  });
}
