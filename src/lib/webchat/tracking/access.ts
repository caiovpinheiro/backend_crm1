/**
 * Webchat v2 — quem pode mandar contexto/eventos e de quem são os dados
 * (docs/decisoes/webchat-widget.md §9.3).
 *
 *  - Autenticação: o Bearer do visitante (o mesmo da v1) ou, só no
 *    `POST /events`, o `token` no corpo (`navigator.sendBeacon` não manda
 *    header). O token do corpo passa pelas mesmas checagens do Bearer.
 *  - Permissão: sessão com identify assinado válido (`identityVerifiedAt`)
 *    ou canal com `config.v2.context.anonymous`. Senão 403
 *    `TRACKING_DISABLED`.
 *  - Dono: o contato da sessão, se houver; senão o visitante anônimo
 *    (`sessionId`), que passa para o contato no identify
 *    (`adoptAnonymousVisitorData`).
 */
import type { NextResponse } from "next/server";

// prismaBase: a sessão do visitante não é tenant-scoped pelo contexto (a
// org sai do token já conferido) — mesmo papel que em `session.ts`.
import { prismaBase } from "@/lib/prisma-base";
import type { LiveContextOwner } from "@/lib/webchat/live-context";
import {
  authenticateWebchatVisitor,
  webchatError,
  type AuthenticatedVisitor,
} from "@/lib/webchat/session";
import { bearerFrom } from "@/lib/webchat/token";

/** Teto do token aceito no corpo (um JWT do widget tem ~300 chars). */
const MAX_BODY_TOKEN_CHARS = 4096;

/**
 * Autentica pelo Bearer ou, na falta dele, pelo `token` do corpo. O header
 * vence quando os dois vêm (o corpo nunca troca a sessão do header).
 */
export async function authenticateTrackingVisitor(
  request: Request,
  bodyToken?: unknown,
): Promise<{ ok: true; visitor: AuthenticatedVisitor } | { ok: false; response: NextResponse }> {
  if (
    !bearerFrom(request) &&
    typeof bodyToken === "string" &&
    bodyToken.length > 0 &&
    bodyToken.length <= MAX_BODY_TOKEN_CHARS &&
    !/\s/.test(bodyToken)
  ) {
    const headers = new Headers(request.headers);
    headers.set("authorization", `Bearer ${bodyToken}`);
    return authenticateWebchatVisitor(new Request(request.url, { method: request.method, headers }));
  }
  return authenticateWebchatVisitor(request);
}

export type TrackingAccess =
  | { ok: true; owner: LiveContextOwner; contactId: string | null; verified: boolean }
  | { ok: false; response: NextResponse };

/** Permissão de rastreio + dono dos dados (lê `identityVerifiedAt` na hora). */
export async function resolveTrackingAccess(visitor: AuthenticatedVisitor): Promise<TrackingAccess> {
  const { channel, session } = visitor;
  const row = await prismaBase.webchatSession.findUnique({
    where: { id: session.id },
    select: { identityVerifiedAt: true, contactId: true },
  });
  const verified = !!row?.identityVerifiedAt;
  if (!verified && !channel.v2.context.anonymous) {
    return {
      ok: false,
      response: webchatError(
        403,
        "TRACKING_DISABLED",
        "Contexto do site desligado para visitante não identificado.",
      ),
    };
  }
  // O identify pode ter trocado o contato depois que a sessão foi lida.
  const contactId = row?.contactId ?? session.contactId ?? null;
  return {
    ok: true,
    owner: contactId ? { contactId } : { sessionId: session.id },
    contactId,
    verified,
  };
}
