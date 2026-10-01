import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import { requirePermission } from "@/lib/authz";
import { parseKommoBot } from "@/lib/kommo-bot-parser";
import { createAutomation, updateAutomation } from "@/services/automations";
import type { Prisma } from "@prisma/client";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/automations/import-kommo");

// Bug 27/abr/26: este endpoint chamava `auth()` direto e os services
// `createAutomation` / `updateAutomation` chamam `getOrgIdOrThrow()`
// SINCRONO. Mesma classe de bug do POST /api/automations principal.
// Migrado para withOrgContext.

function remapIds(config: Record<string, unknown>, idMap: Map<string, string>): Record<string, unknown> {
  const result = { ...config };

  const stringFields = [
    "_nextStepId", "_trueGotoStepId", "_falseGotoStepId",
    "timeoutGotoStepId", "elseGotoStepId", "_answeredGotoStepId",
    "targetStepId", "gotoStepId", "nextStepId", "receivedGotoStepId",
    "failureGotoStepId",
  ];

  for (const field of stringFields) {
    if (typeof result[field] === "string" && result[field] !== "") {
      result[field] = idMap.get(result[field] as string) ?? result[field];
    }
  }

  if (Array.isArray(result.buttons)) {
    result.buttons = (result.buttons as { text: string; gotoStepId: string }[]).map((btn) => ({
      ...btn,
      gotoStepId: idMap.get(btn.gotoStepId) ?? btn.gotoStepId,
    }));
  }

  if (Array.isArray(result._branches)) {
    result._branches = (result._branches as { conditions: unknown[]; gotoStepId: string }[]).map((br) => ({
      ...br,
      gotoStepId: idMap.get(br.gotoStepId) ?? br.gotoStepId,
    }));
  }

  return result;
}

type ParsedImport = {
  name: string;
  triggerType: string;
  triggerConfig: Record<string, unknown>;
  steps: Array<{ id: string; type: string; config: Record<string, unknown> }>;
  source: "kommo" | "native";
};

function parseNativeExport(json: Record<string, unknown>): ParsedImport {
  const name = typeof json.name === "string" && json.name.trim() ? json.name.trim() : "Automação importada";
  const triggerType =
    typeof json.triggerType === "string" && json.triggerType.trim()
      ? json.triggerType.trim()
      : "message_received";
  const triggerConfig =
    typeof json.triggerConfig === "object" && json.triggerConfig !== null && !Array.isArray(json.triggerConfig)
      ? (json.triggerConfig as Record<string, unknown>)
      : {};
  const rawSteps = Array.isArray(json.steps) ? (json.steps as unknown[]) : [];
  const steps = rawSteps
    .map((raw, idx) => {
      if (typeof raw !== "object" || raw === null) return null;
      const s = raw as Record<string, unknown>;
      const type = typeof s.type === "string" ? s.type.trim() : "";
      if (!type) return null;
      const idRaw = typeof s.id === "string" && s.id.trim() ? s.id.trim() : `import_step_${idx + 1}`;
      const config =
        typeof s.config === "object" && s.config !== null && !Array.isArray(s.config)
          ? (s.config as Record<string, unknown>)
          : {};
      return { id: idRaw, type, config };
    })
    .filter((s): s is { id: string; type: string; config: Record<string, unknown> } => Boolean(s));
  if (steps.length === 0) {
    throw new Error("JSON de automação inválido: nenhum passo encontrado.");
  }
  return {
    name,
    triggerType,
    triggerConfig,
    steps,
    source: "native",
  };
}

function parseImportPayload(json: Record<string, unknown>): ParsedImport {
  // Formato Kommo legado
  if (json.model && typeof json.model === "object") {
    const parsed = parseKommoBot(json);
    return {
      name: parsed.name,
      triggerType: parsed.triggerType,
      triggerConfig: parsed.triggerConfig as Record<string, unknown>,
      steps: parsed.steps.map((s) => ({
        id: s.id,
        type: s.type,
        config: s.config as Record<string, unknown>,
      })),
      source: "kommo",
    };
  }
  // Formato nativo exportado pelo próprio CRM (Exportar JSON)
  if (Array.isArray(json.steps) && typeof json.triggerType === "string") {
    return parseNativeExport(json);
  }
  throw new Error(
    "JSON inválido: esperado export do Kommo (campo model) ou export nativo de automação (steps + triggerType).",
  );
}

export async function POST(request: Request) {
  return withOrgContext(async (session) => {
    const denied = await requirePermission(session.user, "automation:create");
    if (denied) return denied;
    try {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return NextResponse.json({ message: "JSON inválido." }, { status: 400 });
      }

      if (!body || typeof body !== "object") {
        return NextResponse.json({ message: "Corpo inválido." }, { status: 400 });
      }

      const json = body as Record<string, unknown>;

      let parsed: ParsedImport;
      try {
        parsed = parseImportPayload(json);
      } catch (err) {
        log.error({ err }, "[import-kommo] Parse error");
        return NextResponse.json(
          { message: `Erro ao parsear bot: ${err instanceof Error ? err.message : String(err)}` },
          { status: 400 },
        );
      }

      const automation = await createAutomation({
        name: parsed.name,
        description:
          parsed.source === "kommo"
            ? `Importado do Kommo (${parsed.steps.length} passos)`
            : `Importado de JSON (${parsed.steps.length} passos)`,
        triggerType: parsed.triggerType,
        triggerConfig: parsed.triggerConfig as Prisma.InputJsonValue,
        active: false,
        steps: parsed.steps.map((s) => ({
          type: s.type,
          config: s.config as Prisma.InputJsonValue,
        })),
      });

      const idMap = new Map<string, string>();
      for (let i = 0; i < parsed.steps.length; i++) {
        const tempId = parsed.steps[i].id;
        const realId = automation.steps[i]?.id;
        if (tempId && realId) {
          idMap.set(tempId, realId);
        }
      }

      // BUG 27/abr: nao propagavamos `s.id` aqui. O updateAutomation do
      // service deleta todos os steps e recria. Sem id explicito, Prisma
      // gera cuids novos via `@default(cuid())` e os refs remappeados
      // (recem-feitos com idMap apontando pros ids "reais") viram pernas
      // mortas — mesmo sintoma do save normal. Preservar `s.id` mantem a
      // topologia do fluxo importado intacta.
      const remappedSteps = automation.steps.map((s: typeof automation.steps[number]) => {
        const cfg = (typeof s.config === "object" && s.config !== null && !Array.isArray(s.config))
          ? { ...(s.config as Record<string, unknown>) }
          : {};
        return {
          id: s.id,
          type: s.type,
          config: remapIds(cfg, idMap) as Prisma.InputJsonValue,
        };
      });

      const updated = await updateAutomation(automation.id, {
        steps: remappedSteps,
      });

      return NextResponse.json(
        {
          message:
            parsed.source === "kommo"
              ? `Bot "${parsed.name}" importado com sucesso! ${parsed.steps.length} passos criados.`
              : `Automação "${parsed.name}" importada com sucesso! ${parsed.steps.length} passos criados.`,
          automationId: updated.id,
          stepCount: parsed.steps.length,
          source: parsed.source,
        },
        { status: 201 },
      );
    } catch (e) {
      log.error({ err: e }, "[import-kommo] falhou");
      return NextResponse.json({ message: "Erro ao importar bot." }, { status: 500 });
    }
  });
}
