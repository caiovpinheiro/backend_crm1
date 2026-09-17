import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth-helpers";
import { requirePermission } from "@/lib/authz";
import { parseKeepColorFilter } from "@/services/keeps/colors";
import { keepFail } from "@/services/keeps/keep-http";
import {
  createKeepNote,
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
  const colors = parseKeepColorFilter(url.searchParams.getAll("color"));

  try {
    const { rows, usedColors, hasUncolored } = await listKeepNotes({
      userId: r.session.user.id,
      folder,
      q,
      colors,
    });
    const orgId = r.session.user.organizationId!;
    return NextResponse.json({
      items: rows.map((n) => serializeKeepNote(n, orgId)),
      usedColors,
      hasUncolored,
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
      categoryId:
        body.categoryId === null
          ? null
          : typeof body.categoryId === "string"
            ? body.categoryId
            : undefined,
    });
    return NextResponse.json(
      { note: serializeKeepNote(note, r.session.user.organizationId!) },
      { status: 201 },
    );
  } catch (err) {
    return keepFail(err);
  }
}
