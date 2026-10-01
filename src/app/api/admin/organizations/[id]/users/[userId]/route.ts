/**
 * Admin: exclui (anonimiza) um usuario de uma organizacao.
 *
 * Usa o flow de "erase" do LGPD (src/services/lgpd.ts) — NAO faz hard
 * delete, porque o User aparece como FK em audit_logs, messages,
 * deals, conversations, notes etc. Hard delete quebraria a auditoria
 * ("alguem fez X mas nao sabemos quem"). Anonimizacao mantem
 * integridade e cumpre LGPD Art. 18 VI.
 *
 * Pos-erase:
 *   - hashedPassword = NULL  -> login impossivel
 *   - email = "erased+<id>@anon.local"
 *   - name = "Usuario removido"
 *   - phone, avatarUrl, signature, closingMessage = NULL
 *   - mfaSecret, mfaEnabledAt = NULL + delete backup codes
 *   - apiTokens deletados
 *   - webPushSubscriptions deletadas
 *   - aiAgentConfig.systemPromptOverride redactado
 *
 * Protecoes:
 *   - Super-admin only.
 *   - User precisa pertencer a essa org (tenant safety; apesar de
 *     super-admin, evita acidente).
 *   - NAO permite excluir a si mesmo.
 *   - NAO permite excluir o ultimo ADMIN ativo da org (deixa sempre
 *     pelo menos 1 caminho de acesso). Super-admins da EduIT na lista
 *     nao contam — eles tem outra org-less route de acesso.
 */

import { NextResponse } from "next/server";

import { requireSuperAdmin } from "@/lib/auth-helpers";
import { prismaBase } from "@/lib/prisma-base";
import { requestErase } from "@/services/lgpd";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/admin/organizations/[id]/users/[userId]");

type Ctx = { params: Promise<{ id: string; userId: string }> };

export async function DELETE(_req: Request, ctx: Ctx) {
  const r = await requireSuperAdmin();
  if (!r.ok) return r.response;

  const { id: organizationId, userId } = await ctx.params;
  const actor = r.session.user;
  const actorId = (actor as { id?: string }).id ?? "";
  const actorEmail = (actor as { email?: string | null }).email ?? "?";

  if (actorId === userId) {
    return NextResponse.json(
      { message: "Voce nao pode excluir a si mesmo." },
      { status: 400 },
    );
  }

  const target = await prismaBase.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      organizationId: true,
      role: true,
      isErased: true,
      isSuperAdmin: true,
    },
  });

  if (!target) {
    return NextResponse.json(
      { message: "Usuario nao encontrado." },
      { status: 404 },
    );
  }

  if (target.organizationId !== organizationId) {
    return NextResponse.json(
      { message: "Usuario nao pertence a essa organizacao." },
      { status: 400 },
    );
  }

  if (target.isErased) {
    return NextResponse.json(
      { message: "Usuario ja foi excluido anteriormente." },
      { status: 409 },
    );
  }

  if (target.role === "ADMIN" && !target.isSuperAdmin) {
    const otherActiveAdmins = await prismaBase.user.count({
      where: {
        organizationId,
        role: "ADMIN",
        isErased: false,
        isSuperAdmin: false,
        id: { not: userId },
      },
    });
    if (otherActiveAdmins === 0) {
      return NextResponse.json(
        {
          message:
            "Esse e o ultimo Admin ativo da organizacao. Promova outro membro a Admin antes de excluir.",
        },
        { status: 400 },
      );
    }
  }

  try {
    await requestErase({
      userId,
      organizationId,
      requestedById: actorId,
      reason: `Excluido via /admin/organizations/${organizationId} por super-admin ${actorEmail}`,
    });
    return NextResponse.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Erro ao excluir usuario.";
    log.error({ err }, "[admin/users DELETE] falhou");
    return NextResponse.json({ message: msg }, { status: 500 });
  }
}
