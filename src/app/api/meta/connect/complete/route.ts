import { NextResponse } from "next/server";

import { requireCan, runInSessionContext } from "@/lib/auth-helpers";
import { MetaConnectError } from "@/lib/meta-connect-state";
import { getLogger } from "@/lib/logger";
import { finishMetaConnect } from "@/services/meta-connect";

const log = getLogger("api/meta/connect/complete");

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export async function POST(request: Request) {
  const auth = await requireCan("settings:channels");
  if (!auth.ok) return auth.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { message: "JSON inválido.", code: "INVALID_JSON" },
      { status: 400 },
    );
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const state = text(b.state);
  const code = text(b.code);
  const wabaId = text(b.wabaId) || text(b.waba_id);
  const phoneNumberId = text(b.phoneNumberId) || text(b.phone_number_id);

  if (!state) {
    return NextResponse.json(
      { message: "Link de conexão inválido.", code: "STATE_INVALID" },
      { status: 400 },
    );
  }
  if (!code || !wabaId || !phoneNumberId) {
    return NextResponse.json(
      {
        message: "Código, WABA e número de telefone são obrigatórios.",
        code: "INVALID_BODY",
      },
      { status: 400 },
    );
  }

  try {
    const result = await runInSessionContext(auth.session, () =>
      finishMetaConnect(auth.session, { state, code, wabaId, phoneNumberId }),
    );
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof MetaConnectError) {
      return NextResponse.json(
        {
          message: err.message,
          code: err.code,
          ...(err.returnUrl ? { returnUrl: err.returnUrl } : {}),
        },
        { status: err.status },
      );
    }
    log.error({ err }, "meta connect complete failed");
    return NextResponse.json(
      { message: "Não foi possível concluir a conexão com a Meta.", code: "META_ERROR" },
      { status: 500 },
    );
  }
}
