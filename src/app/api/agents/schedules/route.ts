import { NextResponse } from "next/server";
import { requireAuth, userOrgFilter } from "@/lib/auth-helpers";
import { prisma } from "@/lib/prisma";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/agents/schedules");

const COVERAGE_USER_SELECT = {
  id: true,
  name: true,
  email: true,
  role: true,
  avatarUrl: true,
  schedule: true,
  agentStatus: {
    select: { status: true, availableForVoiceCalls: true, updatedAt: true },
  },
  departmentMemberships: {
    select: {
      department: { select: { id: true, name: true, color: true } },
    },
  },
} as const;

export async function GET() {
  const r = await requireAuth();
  if (!r.ok) return r.response;

  const where = { type: "HUMAN" as const, ...userOrgFilter(r.session) };

  try {
    const users = await prisma.user.findMany({
      where,
      select: {
        ...COVERAGE_USER_SELECT,
        distributionResponsibles: {
          select: { participates: true, visibleInCoverage: true },
          take: 1,
        },
      },
      orderBy: { name: "asc" },
    });
    return NextResponse.json(
      users.map(({ departmentMemberships, distributionResponsibles, ...u }) => ({
        ...u,
        departments: departmentMemberships.map((m) => m.department),
        participates: distributionResponsibles[0]?.participates ?? true,
        visibleInCoverage: distributionResponsibles[0]?.visibleInCoverage ?? true,
      })),
    );
  } catch (e) {
    log.warn(
      { err: e },
      "[agents/schedules] sem visibleInCoverage — fallback (aplique a migration 20260814220000).",
    );
    const users = await prisma.user.findMany({
      where,
      select: {
        ...COVERAGE_USER_SELECT,
        distributionResponsibles: {
          select: { participates: true },
          take: 1,
        },
      },
      orderBy: { name: "asc" },
    });
    return NextResponse.json(
      users.map(({ departmentMemberships, distributionResponsibles, ...u }) => ({
        ...u,
        departments: departmentMemberships.map((m) => m.department),
        participates: distributionResponsibles[0]?.participates ?? true,
        visibleInCoverage: true,
      })),
    );
  }
}
