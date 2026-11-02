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
import { readBrandingImageUpload } from "@/lib/branding-image-upload";
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
    const upload = await readBrandingImageUpload(request, MAX_LOGO_SIZE);
    if (!upload.ok) {
      return NextResponse.json({ message: upload.message }, { status: upload.status });
    }
    const { buffer, mimeType: sniffed, ext } = upload;

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
