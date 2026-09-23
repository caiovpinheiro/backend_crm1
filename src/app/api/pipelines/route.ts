import { Prisma } from "@prisma/client";
import { NextResponse } from "next/server";

import { authenticateApiRequest, runWithApiUserContext } from "@/lib/api-auth";
import { canViewPipeline, canViewStage, loadAuthzContext } from "@/lib/authz";
import { listAllowedPipelineIds, requirePermissionForUser } from "@/lib/authz/resource-policy";
import { createPipeline, getPipelines } from "@/services/pipelines";

/** Prisma nem sempre mantém `instanceof` após o bundle; usa também `code` e mensagem. */
function prismaFailureMessage(e: unknown): string | null {
  const msg = e instanceof Error ? e.message : String(e);
  const code =
    e &&
    typeof e === "object" &&
    "code" in e &&
    typeof (e as { code: unknown }).code === "string"
      ? (e as { code: string }).code
      : undefined;

  if (code === "P1001") {
    return "Base de dados inacessível. Verifique DATABASE_URL (porta 5433 com docker compose do CRM), se o container crm_postgres está Up e execute: npx prisma migrate deploy && npm run db:seed";
  }
  if (code === "P1000" || code === "P1003") {
    return "Credenciais ou nome da base incorretos em DATABASE_URL.";
  }
  if (code === "P2021") {
    return "Tabelas em falta. Na pasta do projeto: npx prisma migrate deploy";
  }

  if (e instanceof Prisma.PrismaClientInitializationError) {
    return "Não foi possível inicializar o Prisma. Confirme DATABASE_URL e reinicie o servidor (npm run dev) após alterar o .env.";
  }

  if (/Can't reach database server|ECONNREFUSED|P1001/i.test(msg)) {
    return "PostgreSQL não responde. Suba o CRM: docker compose up -d e use DATABASE_URL com a porta publicada (ex.: 5433).";
  }
  if (/relation .* does not exist|table .* does not exist/i.test(msg)) {
    return "Esquema desatualizado. Execute: npx prisma migrate deploy";
  }
  // Coluna nova no schema (ex.: pipelines.lossReasonRequired) sem migrate deploy.
  if (
    /column .* does not exist|Unknown column|does not exist in the current database/i.test(
      msg,
    )
  ) {
    return "Esquema desatualizado (coluna ausente). Execute: npx prisma migrate deploy";
  }

  return null;
}

export async function GET(request: Request) {
  try {
    const authResult = await authenticateApiRequest(request);
    if (!authResult.ok) return authResult.response;

    return await runWithApiUserContext(authResult.user, async () => {
    const denied = await requirePermissionForUser(authResult.user, "pipeline:view");
    if (denied) return denied;
    const allowedPipelineIds = await listAllowedPipelineIds(authResult.user);
    const pipelines = await getPipelines({ allowedPipelineIds });
    const authz = await loadAuthzContext({
      userId: authResult.user.id,
      organizationId: authResult.user.organizationId,
      isSuperAdmin: authResult.user.isSuperAdmin,
    });
    const visible = pipelines
      .filter((p) => canViewPipeline(authz, p.id))
      .map((p) => ({
        ...p,
        stages: p.stages.filter((s) => canViewStage(authz, s.id)),
      }))
      .filter((p) => p.stages.length > 0);
    return NextResponse.json(visible);
    });
  } catch (e) {
    console.error(e);
    const hint = prismaFailureMessage(e);
    return NextResponse.json(
      { message: hint ?? "Erro ao listar pipelines." },
      { status: hint ? 503 : 500 },
    );
  }
}

export async function POST(request: Request) {
  try {
    const authResult = await authenticateApiRequest(request);
    if (!authResult.ok) return authResult.response;

    return await runWithApiUserContext(authResult.user, async () => {
    const denied = await requirePermissionForUser(authResult.user, "pipeline:create");
    if (denied) return denied;
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ message: "JSON inválido." }, { status: 400 });
    }

    if (!body || typeof body !== "object") {
      return NextResponse.json({ message: "Corpo inválido." }, { status: 400 });
    }

    const b = body as Record<string, unknown>;
    if (typeof b.name !== "string" || b.name.trim().length < 1) {
      return NextResponse.json({ message: "Nome é obrigatório." }, { status: 400 });
    }

    try {
      const pipeline = await createPipeline({ name: b.name });
      return NextResponse.json(pipeline, { status: 201 });
    } catch (err: unknown) {
      if (err instanceof Error && err.message === "INVALID_NAME") {
        return NextResponse.json({ message: "Nome inválido." }, { status: 400 });
      }
      throw err;
    }
    });
  } catch (e: unknown) {
    console.error(e);
    return NextResponse.json({ message: "Erro ao criar pipeline." }, { status: 500 });
  }
}
