/**
 * GET  /api/dashboard/layout/import → backup pendente da última importação
 *      (`{ backup: { importedAt, source } | null }`), para "Desfazer importação".
 * POST /api/dashboard/layout/import → importa o arquivo exportado por outro
 *      gestor da MESMA organização. Substitui o dashboard do usuário logado e
 *      guarda o anterior para desfazer.
 */

import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { getLogger } from "@/lib/logger";
import {
  getDashboardImportBackup,
  importDashboardLayout,
  parseDashboardImportFile,
} from "@/services/dashboard-layout-transfer";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const log = getLogger("api/dashboard/layout/import");

export async function GET() {
  return withOrgContext(async (session) => {
    const backup = await getDashboardImportBackup(session.user.id);
    return NextResponse.json({ backup }, { headers: { "Cache-Control": "no-store" } });
  });
}

export async function POST(request: Request) {
  return withOrgContext(async (session) => {
    const organizationId = session.user.organizationId;
    if (!organizationId) {
      return NextResponse.json(
        { message: "Super-admin não importa dashboard." },
        { status: 400 },
      );
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { message: "Este arquivo não é um dashboard exportado do Bwipo." },
        { status: 400 },
      );
    }
    const parsed = parseDashboardImportFile(body, organizationId);
    if (!parsed.ok) {
      return NextResponse.json({ message: parsed.message }, { status: parsed.status });
    }
    try {
      const backup = await importDashboardLayout({
        userId: session.user.id,
        organizationId,
        preset: parsed.preset,
        data: parsed.data,
        source: parsed.source,
      });
      return NextResponse.json({ ok: true, backup });
    } catch (err) {
      log.error("Falha ao importar dashboard:", err);
      return NextResponse.json(
        { message: "Não foi possível importar o dashboard." },
        { status: 500 },
      );
    }
  });
}
