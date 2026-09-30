import { NextResponse } from "next/server";
import type { Prisma } from "@prisma/client";
import { z } from "zod";

import { withOrgContext } from "@/lib/auth-helpers";
import { mergeDashboardLayoutData } from "@/lib/dashboard-layout-merge";
import { getLogger } from "@/lib/logger";
import { prisma } from "@/lib/prisma";
import { prismaBase } from "@/lib/prisma-base";
import { withOrgFromCtx } from "@/lib/prisma-helpers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const log = getLogger("api/dashboard/layout");

/**
 * Schema do payload de layout. Mantém validação solta pra permitir evoluir
 * o catálogo de widgets sem migration — widgets desconhecidos no backend
 * são aceitos (o client faz o filtro final). Apenas garante tipos básicos
 * e limita tamanhos pra evitar abuso (payload máximo ~16KB serializado).
 */
const gridItemSchema = z.object({
  i: z.string().min(1).max(64),
  x: z.number().int().min(0).max(50),
  y: z.number().int().min(0).max(500),
  w: z.number().int().min(1).max(12),
  h: z.number().int().min(1).max(50),
  minW: z.number().int().min(1).max(12).optional(),
  minH: z.number().int().min(1).max(50).optional(),
  maxW: z.number().int().min(1).max(12).optional(),
  maxH: z.number().int().min(1).max(50).optional(),
});

const payloadSchema = z.object({
  name: z.string().min(1).max(64).optional(),
  preset: z
    .enum(["default", "comercial", "atendimento", "equipe", "monitor", "custom"])
    .optional(),
  visibleWidgets: z.array(z.string().min(1).max(64)).max(50),
  layout: z.record(z.string().min(1).max(64), gridItemSchema),
  /** Flags extras do layout (tema, densidade, etc.). */
  meta: z.record(z.string(), z.unknown()).optional(),
});

type LayoutData = z.infer<typeof payloadSchema>;

const patchSchema = payloadSchema
  .partial()
  .strict()
  .refine(
    (value) =>
      value.name !== undefined ||
      value.preset !== undefined ||
      value.visibleWidgets !== undefined ||
      value.layout !== undefined ||
      value.meta !== undefined,
    { message: "Payload vazio." },
  );

const DEFAULT_NAME = "Padrão";
const MAX_LAYOUT_JSON_CHARS = 128_000;

function isRetryableWrite(err: unknown): boolean {
  const code = (err as { code?: string }).code;
  return code === "P2002" || code === "P2034";
}

/**
 * GET /api/dashboard/layout
 * Retorna o layout default do usuário. Sem registro, devolve 200 com
 * `{ layout: null }` — o client então usa o preset "default".
 */
export async function GET() {
  return withOrgContext(async (session) => {
    const userId = session.user.id;

    const record = await prisma.userDashboardLayout.findFirst({
      where: { userId, isDefault: true },
      orderBy: { updatedAt: "desc" },
    });

    if (!record) {
      return NextResponse.json({ layout: null }, { headers: { "Cache-Control": "no-store" } });
    }

    return NextResponse.json(
      {
        id: record.id,
        name: record.name,
        preset: record.preset,
        data: record.data,
        updatedAt: record.updatedAt.toISOString(),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  });
}

/**
 * PUT /api/dashboard/layout
 * Cria ou atualiza (upsert) o layout default do usuário. O body traz
 * o shape completo — substituição, não patch. Usamos um único registro
 * por usuário (nome "Padrão" + isDefault true) pra simplificar o contrato
 * de persistência enquanto o recurso de múltiplos layouts nomeados não
 * existe na UI.
 */
export async function PUT(request: Request) {
  return withOrgContext(async (session) => {
    const userId = session.user.id;

    // Super-admin EduIT (sem organizationId) nao tem layout proprio; o
    // dashboard /admin tem outro fluxo. Evita explodir withOrgFromCtx
    // mais abaixo com mensagem nao acionavel.
    if (!session.user.organizationId) {
      return NextResponse.json(
        { message: "Super-admin não persiste layout de dashboard." },
        { status: 400 },
      );
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { message: "JSON inválido." },
        { status: 400 },
      );
    }

    const parsed = payloadSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { message: "Payload inválido.", issues: parsed.error.issues.slice(0, 5) },
        { status: 400 },
      );
    }

    const data: LayoutData = parsed.data;
    const name = data.name?.trim() || DEFAULT_NAME;

    // O Prisma valida `Json` contra `InputJsonValue`, que não aceita
    // `Record<string, unknown>` diretamente. Como já validamos o payload
    // com zod logo acima, o cast aqui é seguro — todo conteúdo é serializável.
    const payload = {
      visibleWidgets: data.visibleWidgets,
      layout: data.layout,
      meta: data.meta ?? {},
    } as unknown as Prisma.InputJsonValue;

    // Bug 27/abr/26 (P2025): o schema tem `@@unique([userId, name])` GLOBAL
    // (sem organizationId). Quando usavamos `upsert`, a extension injetava
    // organizationId no where compound; se ja existia uma row pro mesmo
    // (userId, name) em OUTRA org (ex.: super-admin alternando, ou usuario
    // movido de org), o findUnique interno do Prisma nao casava → INSERT
    // batia unique conflict → P2025. Trocamos por find-then-update-or-create
    // explicito, com chaveamento por `id` no update — resolve o caso
    // cross-org tomando posse da row para a org atual.
    try {
      // Cross-org lookup intencional: o unique `(userId, name)` eh GLOBAL,
      // entao um mesmo usuario pode ter, no maximo, UM registro por nome —
      // independente de org. Usamos prismaBase pra ignorar o filtro do
      // applyOrgScope, achar o registro existente (mesmo que tenha sido
      // criado em outra org), e tomar posse dele pra org atual.
      // Seguro porque `userId` veio da sessao autenticada — usuario so
      // pode mexer em layout proprio.
      const existing = await prismaBase.userDashboardLayout.findFirst({
        where: { userId, name },
        select: { id: true },
      });

      let record;
      if (existing) {
        record = await prismaBase.userDashboardLayout.update({
          where: { id: existing.id },
          data: {
            preset: data.preset ?? "custom",
            data: payload,
            isDefault: true,
            organizationId: session.user.organizationId,
          },
        });
      } else {
        record = await prisma.userDashboardLayout.create({
          data: withOrgFromCtx({
            userId,
            name,
            isDefault: true,
            preset: data.preset ?? "custom",
            data: payload,
          }),
        });
      }

      return NextResponse.json({
        ok: true,
        id: record.id,
        updatedAt: record.updatedAt.toISOString(),
      });
    } catch (err) {
      log.error("Falha ao salvar layout de dashboard:", err);
      return NextResponse.json(
        { message: "Não foi possível salvar o layout." },
        { status: 500 },
      );
    }
  });
}

/**
 * PATCH /api/dashboard/layout
 * Merge parcial. `meta` substitui só as chaves enviadas (`negocios`, `service`,
 * `operator`, `ui`, `filters`, …). `visibleWidgets` e `layout` só mudam se
 * vierem no body. `organizationId` e `userId` vêm da sessão — o schema é
 * strict e recusa esses campos no body.
 */
export async function PATCH(request: Request) {
  return withOrgContext(async (session) => {
    const userId = session.user.id;

    if (!session.user.organizationId) {
      return NextResponse.json(
        { message: "Super-admin não persiste layout de dashboard." },
        { status: 400 },
      );
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ message: "JSON inválido." }, { status: 400 });
    }

    if (body && typeof body === "object") {
      if ("organizationId" in body || "userId" in body) {
        return NextResponse.json(
          { message: "organizationId e userId vêm da sessão." },
          { status: 400 },
        );
      }
      const raw = JSON.stringify(body);
      if (raw.length > MAX_LAYOUT_JSON_CHARS) {
        return NextResponse.json({ message: "Payload grande demais." }, { status: 400 });
      }
    }

    const parsed = patchSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { message: "Payload inválido.", issues: parsed.error.issues.slice(0, 5) },
        { status: 400 },
      );
    }

    const data = parsed.data;
    const name = data.name?.trim() || DEFAULT_NAME;
    const organizationId = session.user.organizationId;

    try {
      let record: { id: string; updatedAt: Date } | null = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          record = await prismaBase.$transaction(
            async (tx) => {
              // Unique (userId, name) é global. prismaBase + id da sessão:
              // o body não escolhe dono nem org.
              const existing = await tx.userDashboardLayout.findFirst({
                where: { userId, name },
              });
              const merged = mergeDashboardLayoutData(existing?.data, {
                visibleWidgets: data.visibleWidgets,
                layout: data.layout,
                meta: data.meta,
              }) as unknown as Prisma.InputJsonValue;

              if (existing) {
                return tx.userDashboardLayout.update({
                  where: { id: existing.id },
                  data: {
                    preset: data.preset ?? existing.preset,
                    data: merged,
                    isDefault: true,
                    organizationId,
                  },
                  select: { id: true, updatedAt: true },
                });
              }

              return tx.userDashboardLayout.create({
                data: {
                  userId,
                  name,
                  isDefault: true,
                  preset: data.preset ?? "custom",
                  organizationId,
                  data: merged,
                },
                select: { id: true, updatedAt: true },
              });
            },
            { isolationLevel: "Serializable" },
          );
          break;
        } catch (err) {
          if (attempt < 2 && isRetryableWrite(err)) continue;
          throw err;
        }
      }

      if (!record) {
        return NextResponse.json(
          { message: "Não foi possível salvar o layout." },
          { status: 500 },
        );
      }

      return NextResponse.json({
        ok: true,
        id: record.id,
        updatedAt: record.updatedAt.toISOString(),
      });
    } catch (err) {
      log.error("Falha ao mesclar layout de dashboard:", err);
      return NextResponse.json(
        { message: "Não foi possível salvar o layout." },
        { status: 500 },
      );
    }
  });
}

/**
 * DELETE /api/dashboard/layout
 * Reseta o layout do usuário (volta ao preset default). Remove TODOS os
 * registros do usuário — barato e previsível. Uso pelo botão "Resetar".
 */
export async function DELETE() {
  return withOrgContext(async (session) => {
    const userId = session.user.id;
    await prisma.userDashboardLayout.deleteMany({ where: { userId } });
    return NextResponse.json({ ok: true });
  });
}
