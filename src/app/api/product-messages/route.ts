import { NextResponse } from "next/server";

import { authenticateApiRequest, runWithApiUserContext } from "@/lib/api-auth";
import { requirePermissionForUser } from "@/lib/authz/resource-policy";
import { prisma } from "@/lib/prisma";
import { withOrgFromCtx } from "@/lib/prisma-helpers";
import {
  isCourseLevel,
  isProductKind,
  type CourseLevelValue,
  type ProductKindValue,
} from "@/services/product-messages";

const MAX_CONTENT = 8000;

function parseScope(body: Record<string, unknown>): {
  kind: ProductKindValue;
  courseLevel: CourseLevelValue | null;
} | { error: string } {
  const kind = typeof body.kind === "string" ? body.kind : "";
  if (!isProductKind(kind)) return { error: "Tipo de produto inválido." };
  if (kind !== "COURSE") return { kind, courseLevel: null };
  const raw = typeof body.courseLevel === "string" ? body.courseLevel.trim() : "";
  if (!raw) return { kind, courseLevel: null };
  if (!isCourseLevel(raw)) return { error: "Nível do curso inválido." };
  return { kind, courseLevel: raw };
}

export async function GET(request: Request) {
  const auth = await authenticateApiRequest(request);
  if (!auth.ok) return auth.response;
  return runWithApiUserContext(auth.user, async () => {
    const denied = await requirePermissionForUser(auth.user, "product:view");
    if (denied) return denied;

    const url = new URL(request.url);
    const kind = url.searchParams.get("kind")?.trim() ?? "";
    const where: Record<string, unknown> = {};
    if (kind && isProductKind(kind)) where.kind = kind;

    const templates = await prisma.productMessageTemplate.findMany({
      where,
      orderBy: [{ kind: "asc" }, { courseLevel: "asc" }, { name: "asc" }],
    });
    return NextResponse.json({ templates });
  });
}

export async function POST(request: Request) {
  const auth = await authenticateApiRequest(request);
  if (!auth.ok) return auth.response;
  return runWithApiUserContext(auth.user, async () => {
    const denied = await requirePermissionForUser(auth.user, "product:edit");
    if (denied) return denied;

    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json({ message: "JSON inválido." }, { status: 400 });
    }

    const name = typeof body.name === "string" ? body.name.trim() : "";
    const content = typeof body.content === "string" ? body.content.trim() : "";
    if (!name) return NextResponse.json({ message: "Nome é obrigatório." }, { status: 400 });
    if (!content) return NextResponse.json({ message: "Mensagem é obrigatória." }, { status: 400 });
    if (content.length > MAX_CONTENT) {
      return NextResponse.json({ message: "Mensagem passa de 8000 caracteres." }, { status: 400 });
    }

    const scope = parseScope(body);
    if ("error" in scope) return NextResponse.json({ message: scope.error }, { status: 400 });

    const clash = await prisma.productMessageTemplate.findFirst({
      where: { kind: scope.kind, courseLevel: scope.courseLevel },
      select: { id: true },
    });
    if (clash) {
      return NextResponse.json(
        { message: "Já existe uma mensagem para esse tipo." },
        { status: 409 },
      );
    }

    const created = await prisma.productMessageTemplate.create({
      data: withOrgFromCtx({
        name: name.slice(0, 120),
        kind: scope.kind,
        courseLevel: scope.courseLevel,
        content,
        active: body.active !== false,
      }),
    });
    return NextResponse.json({ template: created }, { status: 201 });
  });
}
