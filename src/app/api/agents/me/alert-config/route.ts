import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import {
  DEFAULT_INBOX_ALERT_CONFIG,
  getEffectiveInboxAlertConfig,
} from "@/lib/inbox-alert-config";
import { prisma } from "@/lib/prisma";

export const dynamic = "force-dynamic";

/**
 * Config efetiva de alertas do inbox do usuário logado + os departamentos
 * de que ele é membro (o cliente decide "fila minha" com eles). Ver
 * `lib/inbox-alert-config.ts`.
 */
export async function GET() {
  return withOrgContext(async (session) => {
    const organizationId = session.user.organizationId;
    if (!organizationId) {
      return NextResponse.json({
        config: DEFAULT_INBOX_ALERT_CONFIG,
        departmentIds: [],
      });
    }
    const rows = await prisma.departmentMember.findMany({
      where: { userId: session.user.id, organizationId },
      select: { departmentId: true },
    });
    const departmentIds = rows.map((r) => r.departmentId);
    const config = await getEffectiveInboxAlertConfig({
      organizationId,
      userId: session.user.id,
      memberDepartmentIds: departmentIds,
    });
    return NextResponse.json({ config, departmentIds });
  });
}
