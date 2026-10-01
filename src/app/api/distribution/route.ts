import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import {
  createDistributionRule,
  getDistributionRules,
} from "@/services/lead-distribution";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/distribution");

const MODES = new Set(["ROUND_ROBIN", "RULE_BASED", "MANUAL"]);

export async function GET() {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ message: "Não autorizado." }, { status: 401 });
    }

    const rules = await getDistributionRules();
    return NextResponse.json(rules);
  } catch (e) {
    log.error({ err: e }, "GET falhou");
    return NextResponse.json(
      { message: "Erro ao listar regras de distribuição." },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const session = await auth();
    if (!session?.user) {
      return NextResponse.json({ message: "Não autorizado." }, { status: 401 });
    }

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
    const name = typeof b.name === "string" ? b.name.trim() : "";
    if (!name) {
      return NextResponse.json({ message: "Nome é obrigatório." }, { status: 400 });
    }

    const mode = b.mode;
    if (typeof mode !== "string" || !MODES.has(mode)) {
      return NextResponse.json({ message: "Modo inválido." }, { status: 400 });
    }

    let pipelineId: string | null | undefined;
    if (b.pipelineId === null || b.pipelineId === "" || b.pipelineId === undefined) {
      pipelineId = null;
    } else if (typeof b.pipelineId === "string") {
      pipelineId = b.pipelineId.trim() || null;
    } else {
      return NextResponse.json({ message: "Pipeline inválido." }, { status: 400 });
    }

    const memberUserIds = Array.isArray(b.memberUserIds)
      ? b.memberUserIds.filter((id): id is string => typeof id === "string")
      : [];

    const rule = await createDistributionRule({
      name,
      mode: mode as "ROUND_ROBIN" | "RULE_BASED" | "MANUAL",
      pipelineId,
      memberUserIds,
    });

    return NextResponse.json(rule, { status: 201 });
  } catch (e) {
    log.error({ err: e }, "POST falhou");
    return NextResponse.json(
      { message: "Erro ao criar regra de distribuição." },
      { status: 500 }
    );
  }
}
