import { NextResponse } from "next/server";

import { requireCan, runInSessionContext } from "@/lib/auth-helpers";
import { MetaConnectError } from "@/lib/meta-connect-state";
import { getLogger } from "@/lib/logger";
import { startMetaConnect } from "@/services/meta-connect";

const log = getLogger("api/meta/connect/start");

export async function POST(request: Request) {
  const auth = await requireCan("settings:channels");
  if (!auth.ok) return auth.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    body = {};
  }
  const b = (body ?? {}) as Record<string, unknown>;
  const name = typeof b.name === "string" ? b.name : undefined;
  const channelId = typeof b.channelId === "string" ? b.channelId : undefined;

  try {
    const result = await runInSessionContext(auth.session, () =>
      startMetaConnect(auth.session, { name, channelId }),
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
    log.error({ err }, "meta connect start failed");
    return NextResponse.json(
      { message: "Não foi possível iniciar a conexão com a Meta.", code: "META_ERROR" },
      { status: 500 },
    );
  }
}
