import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { requirePermission } from "@/lib/authz";
import { deleteAutomation, getAutomationById, updateAutomation } from "@/services/automations";

// Bug 27/abr/26: usavamos `auth()` direto. updateAutomation chama
// `getOrgIdOrThrow()` SINCRONO em src/services/automations.ts (linha 326)
// quando ha alteracao em steps. UI exibia 500 generico ("Erro ao
// atualizar automacao") em PUT /api/automations/[id]. Migrado para
// withOrgContext (mesmo pattern dos outros 26 endpoints corrigidos).
// GET e DELETE tambem envolvidos por consistencia e pra eliminar o
// debito tecnico de uma vez.

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_request: Request, context: RouteContext) {
  return withOrgContext(async (session) => {
    const denied = await requirePermission(session.user, "automation:view");
    if (denied) return denied;
    try {
      const { id } = await context.params;
      if (!id) {
        return NextResponse.json({ message: "ID inválido." }, { status: 400 });
      }

      const automation = await getAutomationById(id);
      if (!automation) {
        return NextResponse.json({ message: "Automação não encontrada." }, { status: 404 });
      }

      return NextResponse.json(automation);
    } catch (e) {
      console.error(e);
      return NextResponse.json({ message: "Erro ao buscar automação." }, { status: 500 });
    }
  });
}

export async function PUT(request: Request, context: RouteContext) {
  return withOrgContext(async (session) => {
    const denied = await requirePermission(session.user, "automation:edit");
    if (denied) return denied;
    try {
      const { id } = await context.params;
      if (!id) {
        return NextResponse.json({ message: "ID inválido." }, { status: 400 });
      }

      const existing = await getAutomationById(id);
      if (!existing) {
        return NextResponse.json({ message: "Automação não encontrada." }, { status: 404 });
      }

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

      if (b.name !== undefined && (typeof b.name !== "string" || b.name.trim().length < 1)) {
        return NextResponse.json({ message: "Nome inválido." }, { status: 400 });
      }

      if (b.steps !== undefined) {
        if (!Array.isArray(b.steps)) {
          return NextResponse.json({ message: "steps deve ser um array." }, { status: 400 });
        }
        for (const step of b.steps) {
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
      }

      const payload: Parameters<typeof updateAutomation>[1] = {};

      if (typeof b.name === "string") payload.name = b.name;
      if (b.description !== undefined) {
        payload.description =
          b.description === null ? null : typeof b.description === "string" ? b.description : undefined;
      }
      if (typeof b.triggerType === "string") payload.triggerType = b.triggerType;
      if (b.triggerConfig !== undefined) {
        payload.triggerConfig = b.triggerConfig as Parameters<typeof updateAutomation>[1]["triggerConfig"];
      }
      if (typeof b.active === "boolean") payload.active = b.active;
      if (typeof b.allowManualRun === "boolean") payload.allowManualRun = b.allowManualRun;
      if (Array.isArray(b.steps)) {
        payload.steps = (b.steps as { id?: string; type: string; config: unknown }[]).map((s) => ({
          id: typeof s.id === "string" ? s.id : undefined,
          type: s.type,
          config: s.config as NonNullable<Parameters<typeof updateAutomation>[1]["steps"]>[number]["config"],
        }));
      }

      if (Object.keys(payload).length === 0) {
        return NextResponse.json({ message: "Nenhum campo para atualizar." }, { status: 400 });
      }

      try {
        const automation = await updateAutomation(id, payload);
        return NextResponse.json(automation);
      } catch (err: unknown) {
        if (err instanceof Error) {
          if (err.message === "NOT_FOUND") {
            return NextResponse.json({ message: "Automação não encontrada." }, { status: 404 });
          }
          if (err.message === "INVALID_NAME") {
            return NextResponse.json({ message: "Nome inválido." }, { status: 400 });
          }
          if (err.message === "INVALID_TRIGGER_CONFIG") {
            return NextResponse.json(
              { message: "Horas antes do encerramento devem ser maiores que 0 e menores que 24." },
              { status: 400 },
            );
          }
          if (err.message === "MISSING_CHANNEL_ON_FIRST_MESSAGE_STEP") {
            return NextResponse.json(
              {
                message:
                  "Selecione o canal do primeiro passo de mensagem — a organização tem mais de um canal conectado.",
                code: "MISSING_CHANNEL_ON_FIRST_MESSAGE_STEP",
              },
              { status: 400 },
            );
          }
        }
        throw err;
      }
    } catch (e: unknown) {
      console.error(e);
      if (typeof e === "object" && e !== null && "code" in e && (e as { code: string }).code === "P2025") {
        return NextResponse.json({ message: "Automação não encontrada." }, { status: 404 });
      }
      return NextResponse.json({ message: "Erro ao atualizar automação." }, { status: 500 });
    }
  });
}

/** Alias REST: o editor v2 renomeia via PATCH; o handler PUT já aceita update parcial. */
export const PATCH = PUT;

export async function DELETE(_request: Request, context: RouteContext) {
  return withOrgContext(async (session) => {
    const denied = await requirePermission(session.user, "automation:delete");
    if (denied) return denied;
    try {
      const { id } = await context.params;
      if (!id) {
        return NextResponse.json({ message: "ID inválido." }, { status: 400 });
      }

      const existing = await getAutomationById(id);
      if (!existing) {
        return NextResponse.json({ message: "Automação não encontrada." }, { status: 404 });
      }

      await deleteAutomation(id);
      return NextResponse.json({ ok: true });
    } catch (e: unknown) {
      console.error(e);
      if (typeof e === "object" && e !== null && "code" in e && (e as { code: string }).code === "P2025") {
        return NextResponse.json({ message: "Automação não encontrada." }, { status: 404 });
      }
      return NextResponse.json({ message: "Erro ao excluir automação." }, { status: 500 });
    }
  });
}
