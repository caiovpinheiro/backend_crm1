import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth-helpers";
import { requirePermission } from "@/lib/authz";
import {
  createKeepNote,
  KeepError,
  listKeepNotes,
  serializeKeepNote,
  type KeepFolder,
} from "@/services/keeps/keeps";

export const dynamic = "force-dynamic";

function orgIdOrDeny(orgId: string | null) {
  if (!orgId) {
    return NextResponse.json({ message: "Organização obrigatória." }, { status: 403 });
  }
  return null;
}

function keepFail(err: unknown) {
  if (err instanceof KeepError) {
    return NextResponse.json({ message: err.message }, { status: err.status });
  }
  const prismaCode =
    typeof err === "object" && err && "code" in err ? String((err as { code?: string }).code) : "";
  if (prismaCode === "P2021") {
    return NextResponse.json(
      { message: "Tabelas do Bwipo Keeps ainda não existem neste banco. Rode a migration." },
      { status: 503 },
    );
  }
  const message = err instanceof Error ? err.message : "Erro ao salvar a nota.";
  return NextResponse.json({ message }, { status: 500 });
}

export async function GET(request: Request) {
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const denied = await requirePermission(r.session.user, "keep:view");
  if (denied) return denied;
  const orgDeny = orgIdOrDeny(r.session.user.organizationId);
  if (orgDeny) return orgDeny;

  const url = new URL(request.url);
  const folderRaw = url.searchParams.get("folder") ?? "notes";
  const folder: KeepFolder =
    folderRaw === "archive" || folderRaw === "trash" ? folderRaw : "notes";
  const q = url.searchParams.get("q") ?? undefined;

  try {
    const items = await listKeepNotes({
      userId: r.session.user.id,
      folder,
      q,
    });
    const orgId = r.session.user.organizationId!;
    return NextResponse.json({
      items: items.map((n) => serializeKeepNote(n, orgId)),
    });
  } catch (err) {
    return keepFail(err);
  }
}

export async function POST(request: Request) {
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const denied = await requirePermission(r.session.user, "keep:create");
  if (denied) return denied;
  const orgDeny = orgIdOrDeny(r.session.user.organizationId);
  if (orgDeny) return orgDeny;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ message: "JSON inválido." }, { status: 400 });
  }

  try {
    const note = await createKeepNote({
      orgId: r.session.user.organizationId!,
      userId: r.session.user.id,
      title: typeof body.title === "string" ? body.title : "",
      content: body.content,
    });
    return NextResponse.json(
      { note: serializeKeepNote(note, r.session.user.organizationId!) },
      { status: 201 },
    );
  } catch (err) {
    return keepFail(err);
  }
}
