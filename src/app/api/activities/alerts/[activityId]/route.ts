import { NextResponse } from "next/server";

import { authenticateApiRequest, runWithApiUserContext } from "@/lib/api-auth";
import {
  applyActivityAlertAction,
  type AlertKind,
} from "@/services/activity-alerts";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/activities/alerts/[activityId]");

type RouteContext = { params: Promise<{ activityId: string }> };

function parseBody(raw: unknown):
  | { ok: true; action: "dismiss" }
  | { ok: true; action: "snooze"; kind: AlertKind }
  | { ok: false; message: string } {
  if (!raw || typeof raw !== "object") {
    return { ok: false, message: "Body inválido." };
  }
  const body = raw as Record<string, unknown>;
  if ("userId" in body) {
    return { ok: false, message: "userId não é aceito no body." };
  }
  if (body.action === "dismiss") {
    return { ok: true, action: "dismiss" };
  }
  if (body.action === "snooze") {
    if (body.kind !== "PRE_DUE" && body.kind !== "DUE") {
      return { ok: false, message: "kind deve ser PRE_DUE ou DUE." };
    }
    return { ok: true, action: "snooze", kind: body.kind };
  }
  return { ok: false, message: 'action deve ser "dismiss" ou "snooze".' };
}

export async function POST(request: Request, context: RouteContext) {
  try {
    const authResult = await authenticateApiRequest(request);
    if (!authResult.ok) return authResult.response;

    return await runWithApiUserContext(authResult.user, async () => {
      if (!authResult.user.organizationId) {
        return NextResponse.json({ message: "Organização não encontrada." }, { status: 400 });
      }

      const { activityId } = await context.params;
      if (!activityId) {
        return NextResponse.json({ message: "ID inválido." }, { status: 400 });
      }

      let raw: unknown;
      try {
        raw = await request.json();
      } catch {
        return NextResponse.json({ message: "Body inválido." }, { status: 400 });
      }

      const parsed = parseBody(raw);
      if (!parsed.ok) {
        return NextResponse.json({ message: parsed.message }, { status: 400 });
      }

      const result = await applyActivityAlertAction(
        authResult.user.id,
        authResult.user.organizationId,
        activityId,
        parsed.action === "dismiss"
          ? { action: "dismiss" }
          : { action: "snooze", kind: parsed.kind },
      );

      if (!result.ok) {
        return NextResponse.json({ message: result.message }, { status: result.status });
      }

      return NextResponse.json({ ok: true });
    });
  } catch (e) {
    log.error({ err: e }, "POST falhou");
    return NextResponse.json({ message: "Erro ao atualizar alerta." }, { status: 500 });
  }
}
