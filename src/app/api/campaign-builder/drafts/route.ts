import { NextResponse } from "next/server";

import { campaignBuilderDraftSchema, saveDraftRequestSchema } from "@/features/campaign-builder/schema";
import { authenticateApiRequest, runWithApiUserContext } from "@/lib/api-auth";
import { isFeatureEnabled } from "@/lib/feature-flags";
import { createDraft, getDraftById, updateDraft } from "@/services/campaign-builder";

async function assertBuilderEnabled(organizationId: string | null) {
  if (!organizationId) throw new Error("Organização não encontrada.");
  const enabled = await isFeatureEnabled("campaign_builder_v2", organizationId);
  if (!enabled) {
    throw new Error("FEATURE_DISABLED");
  }
}

export async function GET(request: Request) {
  const authResult = await authenticateApiRequest(request);
  if (!authResult.ok) return authResult.response;

  return runWithApiUserContext(authResult.user, async () => {
    try {
      await assertBuilderEnabled(authResult.user.organizationId);
      const { searchParams } = new URL(request.url);
      const id = searchParams.get("id");
      if (!id) {
        return NextResponse.json(
          { error: { code: "DRAFT_ID_REQUIRED", message: "Informe o id do rascunho." } },
          { status: 400 },
        );
      }
      const draft = await getDraftById(id, {
        id: authResult.user.id,
        role: authResult.user.role,
      });
      if (!draft) {
        return NextResponse.json(
          { error: { code: "DRAFT_NOT_FOUND", message: "Rascunho não encontrado." } },
          { status: 404 },
        );
      }
      return NextResponse.json({ data: draft });
    } catch (error) {
      if (error instanceof Error && error.message === "FEATURE_DISABLED") {
        return NextResponse.json(
          { error: { code: "FEATURE_DISABLED", message: "campaign_builder_v2 desabilitada." } },
          { status: 403 },
        );
      }
      if (error instanceof Error && error.message === "FORBIDDEN_DRAFT_ACCESS") {
        return NextResponse.json(
          { error: { code: "FORBIDDEN", message: "Sem permissão para acessar este rascunho." } },
          { status: 403 },
        );
      }
      return NextResponse.json(
        { error: { code: "DRAFT_GET_ERROR", message: error instanceof Error ? error.message : "Falha ao carregar rascunho." } },
        { status: 500 },
      );
    }
  });
}

export async function POST(request: Request) {
  const authResult = await authenticateApiRequest(request);
  if (!authResult.ok) return authResult.response;

  return runWithApiUserContext(authResult.user, async () => {
    try {
      await assertBuilderEnabled(authResult.user.organizationId);
      const body = (await request.json()) as { patch?: unknown };
      const parsed = campaignBuilderDraftSchema.partial().safeParse(body.patch ?? {});
      if (!parsed.success) {
        return NextResponse.json(
          { error: { code: "INVALID_DRAFT_PAYLOAD", message: "Payload inválido.", details: parsed.error.flatten() } },
          { status: 400 },
        );
      }
      if (!parsed.data.useLastConversationChannel && !parsed.data.channelId) {
        return NextResponse.json(
          { error: { code: "CHANNEL_REQUIRED", message: "Canal é obrigatório para criar rascunho." } },
          { status: 400 },
        );
      }

      const orgId = authResult.user.organizationId;
      if (!orgId) {
        return NextResponse.json(
          { error: { code: "ORG_REQUIRED", message: "Organização obrigatória para criar rascunho." } },
          { status: 400 },
        );
      }

      const created = await createDraft(orgId, authResult.user.id, parsed.data);
      return NextResponse.json({ data: created }, { status: 201 });
    } catch (error) {
      if (error instanceof Error && error.message === "FEATURE_DISABLED") {
        return NextResponse.json(
          { error: { code: "FEATURE_DISABLED", message: "campaign_builder_v2 desabilitada." } },
          { status: 403 },
        );
      }
      return NextResponse.json(
        { error: { code: "DRAFT_CREATE_ERROR", message: error instanceof Error ? error.message : "Falha ao criar rascunho." } },
        { status: 500 },
      );
    }
  });
}

export async function PATCH(request: Request) {
  const authResult = await authenticateApiRequest(request);
  if (!authResult.ok) return authResult.response;

  return runWithApiUserContext(authResult.user, async () => {
    try {
      await assertBuilderEnabled(authResult.user.organizationId);
      const body = await request.json();
      const parsed = saveDraftRequestSchema.safeParse(body);
      if (!parsed.success || !parsed.data.id) {
        return NextResponse.json(
          { error: { code: "INVALID_PATCH", message: "Informe id e patch válidos.", details: parsed.success ? undefined : parsed.error.flatten() } },
          { status: 400 },
        );
      }
      const updated = await updateDraft(parsed.data.id, parsed.data.patch, {
        id: authResult.user.id,
        role: authResult.user.role,
      });
      return NextResponse.json({ data: updated });
    } catch (error) {
      if (error instanceof Error && error.message === "FEATURE_DISABLED") {
        return NextResponse.json(
          { error: { code: "FEATURE_DISABLED", message: "campaign_builder_v2 desabilitada." } },
          { status: 403 },
        );
      }
      if (error instanceof Error && error.message === "FORBIDDEN_DRAFT_ACCESS") {
        return NextResponse.json(
          { error: { code: "FORBIDDEN", message: "Sem permissão para alterar este rascunho." } },
          { status: 403 },
        );
      }
      if (error instanceof Error && error.message === "DRAFT_NOT_FOUND") {
        return NextResponse.json(
          { error: { code: "DRAFT_NOT_FOUND", message: "Rascunho não encontrado." } },
          { status: 404 },
        );
      }
      return NextResponse.json(
        { error: { code: "DRAFT_PATCH_ERROR", message: error instanceof Error ? error.message : "Falha ao atualizar rascunho." } },
        { status: 500 },
      );
    }
  });
}
