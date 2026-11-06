import { NextResponse } from "next/server";

import { getLogger } from "@/lib/logger";
import {
  assertRemoteSupportEnabled,
  WidgetNotEnabledError,
} from "@/services/organization-widgets";

import { MeshCentralError } from "./meshcentral";
import { RemoteSupportError } from "./sessions";

const log = getLogger("remote-support");

/** Rotas do suporte remoto só fazem sentido dentro de uma organização. */
export function requireOrgId(orgId: string | null): NextResponse | null {
  if (!orgId) {
    return NextResponse.json({ message: "Organização obrigatória." }, { status: 403 });
  }
  return null;
}

/** Widget `remote_support` instalado na org? Sem ele, 403 (como a Distribuição). */
export async function requireRemoteSupportWidget(): Promise<NextResponse | null> {
  try {
    await assertRemoteSupportEnabled();
    return null;
  } catch (err) {
    if (err instanceof WidgetNotEnabledError) {
      return NextResponse.json(
        {
          message: "Suporte remoto não habilitado para esta organização.",
          code: "REMOTE_SUPPORT_NOT_ENABLED",
        },
        { status: 403 },
      );
    }
    throw err;
  }
}

export function remoteSupportFail(err: unknown): NextResponse {
  if (err instanceof RemoteSupportError) {
    return NextResponse.json({ message: err.message }, { status: err.status });
  }
  if (err instanceof MeshCentralError) {
    if (err.code === "NOT_CONFIGURED") {
      return NextResponse.json({ message: err.message }, { status: 503 });
    }
    log.warn("MeshCentral:", err);
    return err.code === "UNAVAILABLE"
      ? NextResponse.json(
          { message: "Servidor de suporte remoto indisponível. Tente de novo em instantes." },
          { status: 503 },
        )
      : NextResponse.json(
          { message: "O servidor de suporte remoto recusou a operação." },
          { status: 502 },
        );
  }
  log.error("Erro no suporte remoto:", err);
  return NextResponse.json({ message: "Erro interno no suporte remoto." }, { status: 500 });
}
