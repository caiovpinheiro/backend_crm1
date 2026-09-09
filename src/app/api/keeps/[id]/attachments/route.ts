import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth-helpers";
import { requirePermission } from "@/lib/authz";
import { buildPublicUrl } from "@/lib/storage/local";
import { addKeepAttachment, KeepError } from "@/services/keeps/keeps";

export const dynamic = "force-dynamic";

function isFileLike(v: unknown): v is Blob & { name?: string } {
  return (
    v instanceof Blob ||
    (typeof v === "object" &&
      v !== null &&
      typeof (v as Blob).arrayBuffer === "function" &&
      typeof (v as Blob).size === "number")
  );
}

export async function POST(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const denied = await requirePermission(r.session.user, "keep:edit");
  if (denied) return denied;
  const orgId = r.session.user.organizationId;
  if (!orgId) {
    return NextResponse.json({ message: "Organização obrigatória." }, { status: 403 });
  }
  const { id } = await ctx.params;

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ message: "Formulário inválido." }, { status: 400 });
  }
  const file = form.get("file");
  if (!isFileLike(file)) {
    return NextResponse.json({ message: "Arquivo obrigatório." }, { status: 400 });
  }
  const fileName = (file.name || "arquivo").slice(0, 180);
  const mimeType = (file.type || "application/octet-stream").split(";")[0].trim();
  const buffer = Buffer.from(await file.arrayBuffer());

  try {
    const att = await addKeepAttachment({
      orgId,
      userId: r.session.user.id,
      noteId: id,
      fileName,
      mimeType,
      buffer,
    });
    return NextResponse.json(
      {
        attachment: {
          id: att.id,
          fileName: att.fileName,
          mimeType: att.mimeType,
          fileSize: att.fileSize,
          url: buildPublicUrl(orgId, "keeps", att.storageKey),
          createdAt: att.createdAt.toISOString(),
        },
      },
      { status: 201 },
    );
  } catch (err) {
    if (err instanceof KeepError) {
      return NextResponse.json({ message: err.message }, { status: err.status });
    }
    throw err;
  }
}
