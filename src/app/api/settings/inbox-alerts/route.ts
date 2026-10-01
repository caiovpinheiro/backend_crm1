import { NextResponse } from "next/server";
import { z } from "zod";

import { withOrgContext } from "@/lib/auth-helpers";
import {
  DEFAULT_INBOX_ALERT_CONFIG,
  INBOX_TAB_AUDIENCE_KEY,
  inboxAlertConfigSchema,
  inboxTabAudienceSchema,
  inboxAlertDepartmentKey,
  inboxAlertUserKey,
  invalidateOrgInboxAlertConfigs,
  loadOrgInboxAlertConfigs,
  withInboxAlertDefaults,
} from "@/lib/inbox-alert-config";
import { deleteOrgSetting, setOrgSetting } from "@/lib/org-settings";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/**
 * Alertas do inbox por departamento e por usuário (Configurações >
 * Notificações). Só ADMIN (e super-admin) lê e grava.
 *
 * GET → `{ defaults, departments: [{ id, name, config|null }],
 *          users: [{ id, name, email, departmentIds, config|null }] }`
 * PUT `{ scope: "department"|"user", id, config|null }` — `null` volta a
 * herdar (apaga a chave).
 * PUT `{ scope: "org", tabAudience: "owner"|"department"|"all"|null }` —
 * público do aviso na aba para a org; `null` volta à coluna "Aba" por tipo.
 * GET devolve também `tabAudience`.
 */

function isAdmin(user: { role?: string | null; isSuperAdmin?: boolean }) {
  return user.role === "ADMIN" || Boolean(user.isSuperAdmin);
}

export async function GET() {
  return withOrgContext(async (session) => {
    if (!isAdmin(session.user)) {
      return NextResponse.json({ message: "Acesso negado." }, { status: 403 });
    }
    const organizationId = session.user.organizationId;
    if (!organizationId) {
      return NextResponse.json({ message: "Sem organização." }, { status: 400 });
    }

    const [departments, users, members, configs] = await Promise.all([
      prisma.department.findMany({
        where: { organizationId },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
      }),
      prisma.user.findMany({
        where: { organizationId, type: "HUMAN", isErased: false },
        select: { id: true, name: true, email: true },
        orderBy: { name: "asc" },
      }),
      prisma.departmentMember.findMany({
        where: { organizationId },
        select: { userId: true, departmentId: true },
      }),
      loadOrgInboxAlertConfigs(organizationId),
    ]);

    const deptsByUser = new Map<string, string[]>();
    for (const m of members) {
      const list = deptsByUser.get(m.userId) ?? [];
      list.push(m.departmentId);
      deptsByUser.set(m.userId, list);
    }

    return NextResponse.json({
      defaults: DEFAULT_INBOX_ALERT_CONFIG,
      tabAudience: configs.tabAudience,
      departments: departments.map((d) => ({
        ...d,
        config: configs.departments.get(d.id) ?? null,
      })),
      users: users.map((u) => ({
        ...u,
        departmentIds: deptsByUser.get(u.id) ?? [],
        config: configs.users.get(u.id) ?? null,
      })),
    });
  });
}

const putSchema = z.object({
  scope: z.enum(["department", "user"]),
  id: z.string().min(1),
  config: inboxAlertConfigSchema.nullable(),
});

const putOrgSchema = z.object({
  scope: z.literal("org"),
  tabAudience: inboxTabAudienceSchema.nullable(),
});

export async function PUT(req: Request) {
  return withOrgContext(async (session) => {
    if (!isAdmin(session.user)) {
      return NextResponse.json({ message: "Acesso negado." }, { status: 403 });
    }
    const organizationId = session.user.organizationId;
    if (!organizationId) {
      return NextResponse.json({ message: "Sem organização." }, { status: 400 });
    }
    const body: unknown = await req.json().catch(() => null);
    const orgParsed = putOrgSchema.safeParse(body);
    if (orgParsed.success) {
      const { tabAudience } = orgParsed.data;
      if (tabAudience) await setOrgSetting(INBOX_TAB_AUDIENCE_KEY, tabAudience);
      else await deleteOrgSetting(INBOX_TAB_AUDIENCE_KEY);
      await invalidateOrgInboxAlertConfigs(organizationId);
      return NextResponse.json({ ok: true, tabAudience });
    }
    const parsed = putSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ message: "Dados inválidos." }, { status: 400 });
    }
    const { scope, id } = parsed.data;
    const config = parsed.data.config ? withInboxAlertDefaults(parsed.data.config) : null;

    // O alvo tem que ser da org (a chave leva o id cru).
    const exists =
      scope === "department"
        ? await prisma.department.findFirst({
            where: { id, organizationId },
            select: { id: true },
          })
        : await prisma.user.findFirst({
            where: { id, organizationId, type: "HUMAN", isErased: false },
            select: { id: true },
          });
    if (!exists) {
      return NextResponse.json({ message: "Não encontrado." }, { status: 404 });
    }

    const key = scope === "department" ? inboxAlertDepartmentKey(id) : inboxAlertUserKey(id);
    if (config) await setOrgSetting(key, JSON.stringify(config));
    else await deleteOrgSetting(key);
    await invalidateOrgInboxAlertConfigs(organizationId);

    return NextResponse.json({ ok: true, config });
  });
}
