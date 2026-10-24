import { NextResponse } from "next/server";

import { requireCan, runInSessionContext } from "@/lib/auth-helpers";
import { MetaConnectError } from "@/lib/meta-connect-state";
import { getLogger } from "@/lib/logger";
import { previewMetaConnect } from "@/services/meta-connect";

const log = getLogger("api/meta/connect/preview");

export async function GET(request: Request) {
  const auth = await requireCan("settings:channels");
  if (!auth.ok) return auth.response;

  const state = new URL(request.url).searchParams.get("state")?.trim() ?? "";
  if (!state) {
    return NextResponse.json(
      { message: "Link de conexão inválido.", code: "STATE_INVALID" },
      { status: 400 },
    );
  }

  try {
    const result = await runInSessionContext(auth.session, () =>
      previewMetaConnect(auth.session, state),
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
    log.error({ err }, "meta connect preview failed");
    return NextResponse.json(
      { message: "Não foi possível validar a conexão.", code: "META_ERROR" },
      { status: 500 },
    );
  }
}
