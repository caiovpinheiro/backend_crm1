/**
 * GET /api/users/[id]/effective-permissions
 *
 * Retorna as permissões efetivas do usuário no contexto da organização.
 * Usado pelo frontend (use-my-permissions.ts / useCan) para controle de
 * acesso no cliente.
 *
 * Estrutura de retorno:
 *   { permissions, channelGrants, stageGrants, roles, groups }
 *
 * - ADMIN / super-admin recebem permissions = ["*"] (acesso total).
 * - Usuário consulta as próprias permissões; ADMIN da mesma org vê as de colegas.
 * - Super-admin sem org ativa pode auditar outra org (plataforma). Com org
 *   ativa, `userOrgFilter` restringe à sessão — igual às rotas de Equipe.
 */

import { NextResponse } from "next/server";

import { agentPermissionWhere } from "@/lib/agent-permission-where";
import { withOrgContext, userOrgFilter } from "@/lib/auth-helpers";
import { can, loadAuthzContext } from "@/lib/authz";
import { getScopeGrants } from "@/lib/authz/scope-grants";
import { listAllowedChannelIdsForUser } from "@/lib/authz/scope-grants-shared";
import { prisma } from "@/lib/prisma";
import { prismaBase } from "@/lib/prisma-base";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  return withOrgContext(async (session) => {
    try {
      const { id } = await ctx.params;

      const requesterId = session.user.id;
      const requesterCtx = await loadAuthzContext({
        userId: requesterId,
        organizationId: session.user.organizationId,
        isSuperAdmin: session.user.isSuperAdmin,
      });
      const canAuditOthers = can(requesterCtx, "settings:permissions");
      if (requesterId !== id && !canAuditOthers) {
        return NextResponse.json({ message: "Acesso negado." }, { status: 403 });
      }

      const user = await prismaBase.user.findFirst({
        where: { id, ...userOrgFilter(session) },
        select: {
          id: true,
          role: true,
          organizationId: true,
          isSuperAdmin: true,
        },
      });

      if (!user) {
        return NextResponse.json(
          { message: "Usuário não encontrado." },
          { status: 404 },
        );
      }

      const authzCtx = await loadAuthzContext({
        userId: user.id,
        organizationId: user.organizationId,
        isSuperAdmin: user.isSuperAdmin ?? false,
      });

      // Super-admin ou admin recebem "*" para que useCan() funcione no client.
      // Para outros usuários, retornamos as permissions efetivas do Set.
      let permissions: string[];
      if (authzCtx.isSuperAdmin || authzCtx.isAdmin) {
        permissions = ["*"];
      } else if (authzCtx.permissions.size > 0) {
        permissions = Array.from(authzCtx.permissions);
      } else {
        // Fallback: se não há assignments ainda (usuário criado antes do seed de RBAC),
        // deriva permissões do campo User.role legado.
        const legacyRole = user.role;
        if (legacyRole === "ADMIN") {
          permissions = ["*"];
        } else if (legacyRole === "MANAGER") {
          // MANAGER preset — retorna uma lista representativa das ações principais.
          permissions = [
            "pipeline:view", "pipeline:create", "pipeline:edit", "pipeline:delete", "pipeline:manage_stages",
            "contact:view", "contact:create", "contact:edit", "contact:delete", "contact:export", "contact:import",
            "deal:view", "deal:create", "deal:edit", "deal:delete", "deal:transfer_owner", "deal:change_stage",
            "conversation:view", "conversation:claim", "conversation:reassign_others", "conversation:resolve",
            "automation:view", "automation:create", "automation:edit", "automation:publish",
            "distribution:view", "distribution:manage", "distribution:execute",
            "report:view", "report:export",
            "settings:team", "settings:branding", "settings:channels", "settings:custom_fields",
            "tag:view", "tag:create", "tag:edit",
            "task:view", "task:create", "task:edit", "task:complete_others",
          ];
        } else {
          // MEMBER
          permissions = [
            "pipeline:view",
            "contact:view", "contact:create", "contact:edit",
            "deal:view", "deal:create", "deal:edit", "deal:change_stage",
            "conversation:view", "conversation:claim", "conversation:resolve",
            "tag:view",
            "task:view", "task:create", "task:edit",
            "report:view",
            "distribution:view",
          ];
        }
      }

      // Roles atribuídas ao usuário na organização.
      const assignments = await prisma.userRoleAssignment.findMany({
        where: {
          userId: id,
        },
        select: {
          role: { select: { id: true, name: true, systemPreset: true } },
        },
      });

      const roles = assignments.map((a) => ({
        id: a.role.id,
        name: a.role.name,
        systemPreset: a.role.systemPreset,
      }));

      // Canais efetivos: união dos grants (user + roles), com deny aplicado.
      // Lê grants da org do user-alvo. Super-admin sem org ativa pode auditar
      // user de outra org; com org na sessão, o alvo já passou por userOrgFilter.
      const grants = await getScopeGrants(user.organizationId ?? null);
      const allowedIds = listAllowedChannelIdsForUser({
        grants,
        role: user.role,
        userId: id,
        roleIds: roles.map((r) => r.id),
      });
      let channelGrants: { id: string; name: string }[] = [];
      if (allowedIds && allowedIds.length > 0) {
        const chs = await prisma.channel.findMany({
          where: {
            id: { in: allowedIds },
          },
          select: { id: true, name: true },
        });
        channelGrants = chs.map((c) => ({ id: c.id, name: c.name }));
      }

      // Bloco F: AgentPermission.canConfigureFieldVisibility → settings:custom_fields.
      // Sempre filtra pela org do usuário já validado (tabela NÃO é global).
      if (!permissions.includes("*") && !permissions.includes("settings:custom_fields")) {
        try {
          const agentPerm = await prisma.agentPermission.findFirst({
            where: agentPermissionWhere(id, user.organizationId),
            select: { canConfigureFieldVisibility: true },
          });
          if (agentPerm?.canConfigureFieldVisibility === true) {
            permissions = [...permissions, "settings:custom_fields"];
          }
        } catch {
          // Tabela/coluna pode não existir ainda — ignore.
        }
      }

      return NextResponse.json({
        permissions,
        channelGrants,
        stageGrants: [],
        roles,
        groups: [],
      });
    } catch (e) {
      return NextResponse.json(
        { message: e instanceof Error ? e.message : "Erro." },
        { status: 500 },
      );
    }
  });
}
