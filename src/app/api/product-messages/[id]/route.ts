import { NextResponse } from "next/server";

import { authenticateApiRequest, runWithApiUserContext } from "@/lib/api-auth";
import { requirePermissionForUser } from "@/lib/authz/resource-policy";
import { prisma } from "@/lib/prisma";
import {
  isCourseLevel,
  isProductKind,
  type CourseLevelValue,
  type ProductKindValue,
} from "@/services/product-messages";

type Ctx = { params: Promise<{ id: string }> };

const MAX_CONTENT = 8000;

export async function PATCH(request: Request, ctx: Ctx) {
  const auth = await authenticateApiRequest(request);
  if (!auth.ok) return auth.response;
  return runWithApiUserContext(auth.user, async () => {
    const denied = await requirePermissionForUser(auth.user, "product:edit");
    if (denied) return denied;

    const { id } = await ctx.params;
    const current = await prisma.productMessageTemplate.findUnique({ where: { id } });
    if (!current) {
      return NextResponse.json({ message: "Mensagem não encontrada." }, { status: 404 });
    }

    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json({ message: "JSON inválido." }, { status: 400 });
    }

    const patch: {
      name?: string;
      content?: string;
      kind?: ProductKindValue;
      courseLevel?: CourseLevelValue | null;
      active?: boolean;
    } = {};

    if (typeof body.name === "string" && body.name.trim()) patch.name = body.name.trim().slice(0, 120);
    if (typeof body.content === "string") {
      const content = body.content.trim();
      if (!content) return NextResponse.json({ message: "Mensagem é obrigatória." }, { status: 400 });
      if (content.length > MAX_CONTENT) {
        return NextResponse.json({ message: "Mensagem passa de 8000 caracteres." }, { status: 400 });
      }
      patch.content = content;
    }
    if (typeof body.kind === "string") {
      if (!isProductKind(body.kind)) {
        return NextResponse.json({ message: "Tipo de produto inválido." }, { status: 400 });
      }
      patch.kind = body.kind;
    }
    if ("courseLevel" in body || patch.kind) {
      const kind = patch.kind ?? current.kind;
      if (kind !== "COURSE") {
        patch.courseLevel = null;
      } else if ("courseLevel" in body) {
        const raw = typeof body.courseLevel === "string" ? body.courseLevel.trim() : "";
        if (!raw) patch.courseLevel = null;
        else if (!isCourseLevel(raw)) {
          return NextResponse.json({ message: "Nível do curso inválido." }, { status: 400 });
        } else patch.courseLevel = raw;
      }
    }
    if (typeof body.active === "boolean") patch.active = body.active;

    const nextKind = patch.kind ?? current.kind;
    const nextLevel = patch.courseLevel !== undefined ? patch.courseLevel : current.courseLevel;
    const clash = await prisma.productMessageTemplate.findFirst({
      where: { kind: nextKind, courseLevel: nextLevel, NOT: { id } },
      select: { id: true },
    });
    if (clash) {
      return NextResponse.json(
        { message: "Já existe uma mensagem para esse tipo." },
        { status: 409 },
      );
    }

    const template = await prisma.productMessageTemplate.update({
      where: { id },
      data: patch,
    });
    return NextResponse.json({ template });
  });
}

export async function DELETE(request: Request, ctx: Ctx) {
  const auth = await authenticateApiRequest(request);
  if (!auth.ok) return auth.response;
  return runWithApiUserContext(auth.user, async () => {
    const denied = await requirePermissionForUser(auth.user, "product:edit");
    if (denied) return denied;

    const { id } = await ctx.params;
    const current = await prisma.productMessageTemplate.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!current) {
      return NextResponse.json({ message: "Mensagem não encontrada." }, { status: 404 });
    }
    await prisma.productMessageTemplate.delete({ where: { id } });
    return NextResponse.json({ ok: true });
  });
}
