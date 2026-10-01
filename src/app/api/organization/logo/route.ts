/**
 * POST /api/organization/logo
 * ────────────────────────────
 * Upload do ícone/logo da organização. Persiste em
 * `<STORAGE_ROOT>/<orgId>/branding/` e grava a URL pública em
 * `Organization.logoUrl` em um único passo (diferente do avatar de
 * perfil, a troca do ícone da empresa é aplicada imediatamente).
 *
 * DELETE /api/organization/logo
 * ─────────────────────────────
 * Remove o ícone (seta `logoUrl = null`). O arquivo em disco é deixado
 * como está — barato e evita race com URLs já em cache no client.
 *
 * Restrições:
 *  - Somente ADMIN/MANAGER (branding é configuração de gestão).
 *  - Apenas image/* validada por magic bytes, ≤ 4 MB.
 */

import { NextResponse } from "next/server";

import { requireManager } from "@/lib/auth-helpers";
import { extForMime, sniffImageMime } from "@/lib/file-sniff";
import { generateFileName, saveFile } from "@/lib/storage/local";
import { setOrganizationLogo } from "@/services/onboarding";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/organization/logo");

const MAX_LOGO_SIZE = 4 * 1024 * 1024;

export async function POST(request: Request) {
  const r = await requireManager();
  if (!r.ok) return r.response;
  const orgId = r.session.user.organizationId;
  if (!orgId) {
    return NextResponse.json(
      { message: "Ícone requer organização ativa." },
      { status: 400 },
    );
  }

  try {
    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return NextResponse.json(
        { message: "Erro ao processar upload." },
        { status: 400 },
      );
    }

    const raw = form.get("file");
    if (!raw || !(raw instanceof Blob)) {
      return NextResponse.json(
        { message: 'Envie a imagem no campo "file".' },
        { status: 400 },
      );
    }

    const file = raw as Blob;
    if (file.size > MAX_LOGO_SIZE) {
      return NextResponse.json(
        { message: `Imagem excede o limite de ${MAX_LOGO_SIZE / 1024 / 1024} MB.` },
        { status: 413 },
      );
    }

    const buffer = Buffer.from(await file.arrayBuffer());

    // Valida via magic bytes (não confia no Content-Type). Rejeita SVG
    // (vetor XSS) e qualquer coisa que não seja JPEG/PNG/WEBP/GIF.
    const sniffed = sniffImageMime(buffer);
    if (!sniffed) {
      return NextResponse.json(
        { message: "Envie uma imagem JPG, PNG, WEBP ou GIF." },
        { status: 415 },
      );
    }

    const ext = extForMime(sniffed);
    const fileName = generateFileName({ prefix: "logo", ext });
    const saved = await saveFile({ orgId, bucket: "branding", fileName, buffer });
    await setOrganizationLogo(orgId, saved.url);

    return NextResponse.json({ url: saved.url, mimeType: sniffed });
  } catch (error) {
    log.error({ err: error }, "[organization/logo] upload failed");
    return NextResponse.json(
      { message: "Erro ao salvar o ícone." },
      { status: 500 },
    );
  }
}

export async function DELETE() {
  const r = await requireManager();
  if (!r.ok) return r.response;
  const orgId = r.session.user.organizationId;
  if (!orgId) {
    return NextResponse.json(
      { message: "Ícone requer organização ativa." },
      { status: 400 },
    );
  }
  try {
    await setOrganizationLogo(orgId, null);
    return NextResponse.json({ ok: true });
  } catch (error) {
    log.error({ err: error }, "[organization/logo] delete failed");
    return NextResponse.json(
      { message: "Erro ao remover o ícone." },
      { status: 500 },
    );
  }
}
