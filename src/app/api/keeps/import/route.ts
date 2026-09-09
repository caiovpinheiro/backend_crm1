import { NextResponse } from "next/server";

import { requireAuth } from "@/lib/auth-helpers";
import { requirePermission } from "@/lib/authz";
import { importGoogleKeepZip } from "@/services/keeps/import-google-keep";
import { KeepError } from "@/services/keeps/keeps";

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

export async function POST(request: Request) {
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const denied = await requirePermission(r.session.user, "keep:create");
  if (denied) return denied;
  const orgId = r.session.user.organizationId;
  if (!orgId) {
    return NextResponse.json({ message: "Organização obrigatória." }, { status: 403 });
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ message: "Formulário inválido." }, { status: 400 });
  }
  const file = form.get("file");
  if (!isFileLike(file)) {
    return NextResponse.json({ message: "ZIP obrigatório." }, { status: 400 });
  }
  const fileName = file.name || "keep.zip";
  if (!fileName.toLowerCase().endsWith(".zip")) {
    return NextResponse.json({ message: "Envie um arquivo .zip." }, { status: 400 });
  }
  const mime = (file.type || "").split(";")[0].trim().toLowerCase();
  if (mime && mime !== "application/zip" && mime !== "application/x-zip-compressed" && mime !== "application/octet-stream") {
    return NextResponse.json({ message: "Tipo MIME inválido para ZIP." }, { status: 415 });
  }
  const buffer = Buffer.from(await file.arrayBuffer());

  try {
    const result = await importGoogleKeepZip({
      orgId,
      userId: r.session.user.id,
      fileName,
      buffer,
    });
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    if (err instanceof KeepError) {
      return NextResponse.json({ message: err.message }, { status: err.status });
    }
    throw err;
  }
}
