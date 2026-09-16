import { NextResponse } from "next/server";

import { authenticateApiRequest, runWithApiUserContext } from "@/lib/api-auth";
import { requirePermissionForUser } from "@/lib/authz/resource-policy";
import {
  CapabilityConfigError,
  UnknownCapabilityError,
  assertOverrideAllowed,
  OverrideNotAllowedError,
  validateCapabilityConfig,
  type CatalogCapabilityRow,
} from "@/lib/capabilities";
import { prisma } from "@/lib/prisma";
import { withOrgFromCtx } from "@/lib/prisma-helpers";

type RouteContext = { params: Promise<{ id: string }> };

const PRODUCT_KINDS = new Set(["PHYSICAL", "SERVICE", "COURSE", "JOB_OPENING"]);
const PLAN_INTERVALS = new Set(["MONTHLY", "QUARTERLY", "YEARLY"]);
const COURSE_MODES = new Set(["EAD", "IN_PERSON", "HYBRID"]);
const COURSE_LEVELS = new Set(["GRADUATION", "POSTGRADUATE"]);

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

type CapabilityDraft = {
  capabilityKey: string;
  mode: string;
  config: Record<string, unknown>;
  unitOverrides: Record<string, Record<string, unknown>> | null;
  enabled: boolean;
};

/**
 * Lê e valida o array `capabilities` do body do PUT de produto.
 * Cada item é validado pelo Zod do `mode` e checado contra a política de
 * override do catálogo (`assertOverrideAllowed`). Lança `NextResponse` em erro.
 */
function parseProductCapabilities(
  raw: unknown,
  catalogCapsByKey: Map<string, CatalogCapabilityRow>,
): CapabilityDraft[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) {
    throw NextResponse.json(
      { message: "`capabilities` deve ser uma lista." },
      { status: 400 },
    );
  }

  const drafts: CapabilityDraft[] = [];
  for (const item of raw) {
    const r = asRecord(item) ?? {};
    const key = typeof r.capabilityKey === "string" ? r.capabilityKey : "";
    const mode = typeof r.mode === "string" ? r.mode : "";
    const rawConfig = asRecord(r.config) ?? {};
    const unitOverrides =
      asRecord(r.unitOverrides) as Record<string, Record<string, unknown>> | null;
    const enabled = r.enabled !== false;

    // Política de override (LOCKED rejeita divergência) ANTES de validar.
    const catalogCap = catalogCapsByKey.get(key) ?? null;
    try {
      assertOverrideAllowed(catalogCap, {
        capabilityKey: key,
        mode,
        config: rawConfig,
        unitOverrides,
      });
    } catch (err) {
      if (err instanceof OverrideNotAllowedError) {
        throw NextResponse.json(
          { message: err.message, capabilityKey: err.capabilityKey, policy: err.policy },
          { status: 422 },
        );
      }
      throw err;
    }

    // Valida config pelo Zod do modo (config precisa carregar `mode`).
    try {
      const parsed = validateCapabilityConfig(key, { ...rawConfig, mode });
      drafts.push({
        capabilityKey: key,
        mode,
        config: parsed,
        unitOverrides,
        enabled,
      });
    } catch (err) {
      if (err instanceof UnknownCapabilityError) {
        throw NextResponse.json(
          { message: `Capacidade desconhecida: ${key}` },
          { status: 400 },
        );
      }
      if (err instanceof CapabilityConfigError) {
        throw NextResponse.json(
          { message: `Config inválida para "${key}".`, errors: err.flatten() },
          { status: 400 },
        );
      }
      throw err;
    }
  }
  return drafts;
}

export async function GET(request: Request, context: RouteContext) {
  const authResult = await authenticateApiRequest(request);
  if (!authResult.ok) return authResult.response;

  return runWithApiUserContext(authResult.user, async () => {
    const denied = await requirePermissionForUser(authResult.user, "product:view");
    if (denied) return denied;

    const { id } = await context.params;
    const product = await prisma.product.findUnique({
      where: { id },
      include: {
        customValues: {
          include: {
            customField: {
              select: { id: true, name: true, label: true, type: true, options: true },
            },
          },
        },
        offers: { include: { orgUnit: { select: { id: true, name: true } } } },
        inventoryPools: {
          select: { id: true, orgUnitId: true, consumeTrigger: true, allowNegative: true },
        },
        shipping: true,
        plans: { orderBy: { name: "asc" } },
        courseConfig: { include: { classes: { orderBy: { startsAt: "asc" } } } },
        stakeholders: {
          include: { contact: { select: { id: true, name: true, email: true, phone: true } } },
        },
        jobOpenings: { select: { id: true, title: true, status: true, poolId: true } },
      },
    });
    if (!product) {
      return NextResponse.json({ message: "Produto não encontrado." }, { status: 404 });
    }
    return NextResponse.json({ product });
  });
}

export async function PUT(request: Request, context: RouteContext) {
  const authResult = await authenticateApiRequest(request);
  if (!authResult.ok) return authResult.response;

  return runWithApiUserContext(authResult.user, async () => {
    const denied = await requirePermissionForUser(authResult.user, "product:edit");
    if (denied) return denied;

    const { id } = await context.params;

    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json({ message: "JSON inválido." }, { status: 400 });
    }

    const data: Record<string, unknown> = {};
    if (typeof body.name === "string" && body.name.trim()) data.name = body.name.trim();
    if (typeof body.description === "string") data.description = body.description.trim() || null;
    if (typeof body.sku === "string") data.sku = body.sku.trim() || null;
    if (typeof body.price === "number" || typeof body.price === "string") {
      data.price = Number(body.price) || 0;
    }
    if (typeof body.unit === "string") data.unit = body.unit.trim() || "un";
    if (typeof body.isActive === "boolean") data.isActive = body.isActive;
    if (body.imageUrl !== undefined) {
      if (body.imageUrl === null || body.imageUrl === "") {
        data.imageUrl = null;
        data.imageMime = null;
        data.imageName = null;
      } else if (typeof body.imageUrl === "string") {
        data.imageUrl = body.imageUrl.trim();
        data.imageMime =
          typeof body.imageMime === "string" && body.imageMime.trim()
            ? body.imageMime.trim()
            : null;
        data.imageName =
          typeof body.imageName === "string" && body.imageName.trim()
            ? body.imageName.trim().slice(0, 180)
            : null;
      }
    }
    if (typeof body.type === "string") {
      const t = body.type.toUpperCase();
      if (t === "PRODUCT" || t === "SERVICE") data.type = t;
    }
    if (typeof body.kind === "string") {
      const k = body.kind.toUpperCase();
      if (PRODUCT_KINDS.has(k)) data.kind = k;
    }

    // catalogId: aceita string (vincula), null (desvincula). Valida pertença.
    if (body.catalogId !== undefined) {
      if (body.catalogId === null || body.catalogId === "") {
        data.catalogId = null;
      } else if (typeof body.catalogId === "string") {
        const catalog = await prisma.catalog.findUnique({
          where: { id: body.catalogId.trim() },
          select: { id: true },
        });
        if (!catalog) {
          return NextResponse.json({ message: "Catálogo não encontrado." }, { status: 400 });
        }
        data.catalogId = catalog.id;
      }
    }

    // Resolve o catálogo efetivo (novo do body ou o atual do produto) para
    // aplicar a política de override nas capabilities enviadas.
    const current = await prisma.product.findUnique({
      where: { id },
      select: { id: true, catalogId: true },
    });
    if (!current) {
      return NextResponse.json({ message: "Produto não encontrado." }, { status: 404 });
    }
    const effectiveCatalogId =
      (data.catalogId as string | null | undefined) !== undefined
        ? (data.catalogId as string | null)
        : current.catalogId;

    // Valida capabilities (se enviadas) ANTES de qualquer escrita.
    let capabilityDrafts: CapabilityDraft[] | null = null;
    if (body.capabilities !== undefined) {
      const catalogCaps = effectiveCatalogId
        ? await prisma.catalogCapability.findMany({
            where: { catalogId: effectiveCatalogId },
          })
        : [];
      const byKey = new Map<string, CatalogCapabilityRow>(
        catalogCaps.map((c) => [
          c.capabilityKey,
          {
            capabilityKey: c.capabilityKey,
            mode: c.mode,
            config: c.config as Record<string, unknown>,
            overridePolicy: c.overridePolicy,
            enabled: c.enabled,
          },
        ]),
      );
      try {
        capabilityDrafts = parseProductCapabilities(body.capabilities, byKey);
      } catch (err) {
        if (err instanceof NextResponse) return err;
        throw err;
      }
    }

    try {
      await prisma.product.update({ where: { id }, data });
    } catch {
      return NextResponse.json({ message: "Produto não encontrado." }, { status: 404 });
    }

    // Persiste capabilities do produto (reconcilia: upsert presentes,
    // remove ausentes). Já validadas + checadas contra a policy acima.
    if (capabilityDrafts) {
      const desiredKeys = new Set(capabilityDrafts.map((c) => c.capabilityKey));
      await prisma.productCapability.deleteMany({
        where: { productId: id, capabilityKey: { notIn: [...desiredKeys] } },
      });
      for (const c of capabilityDrafts) {
        await prisma.productCapability.upsert({
          where: {
            productId_capabilityKey: { productId: id, capabilityKey: c.capabilityKey },
          },
          update: {
            mode: c.mode,
            config: c.config as never,
            unitOverrides: (c.unitOverrides ?? undefined) as never,
            enabled: c.enabled,
          },
          create: withOrgFromCtx({
            productId: id,
            capabilityKey: c.capabilityKey,
            mode: c.mode,
            config: c.config as never,
            unitOverrides: (c.unitOverrides ?? undefined) as never,
            enabled: c.enabled,
          }),
        });
      }
    }

    // ── Blocos por kind (só quando enviados) ────────────────────────────
    const shipping = asRecord(body.shipping);
    if (shipping) {
      await prisma.productShipping.upsert({
        where: { productId: id },
        create: withOrgFromCtx({
          productId: id,
          weightGrams:
            shipping.weightGrams != null ? Number(shipping.weightGrams) || null : null,
          dimensions: (shipping.dimensions ?? null) as never,
          shippingPolicy: (shipping.shippingPolicy ?? null) as never,
        }),
        update: {
          weightGrams:
            shipping.weightGrams != null ? Number(shipping.weightGrams) || null : null,
          dimensions: (shipping.dimensions ?? null) as never,
          shippingPolicy: (shipping.shippingPolicy ?? null) as never,
        },
      });
    }

    if (Array.isArray(body.plans)) {
      await prisma.productPlan.deleteMany({ where: { productId: id } });
      for (const raw of body.plans) {
        const p = asRecord(raw);
        if (!p || typeof p.name !== "string" || !p.name.trim()) continue;
        const interval =
          typeof p.interval === "string" && PLAN_INTERVALS.has(p.interval.toUpperCase())
            ? p.interval.toUpperCase()
            : "MONTHLY";
        await prisma.productPlan.create({
          data: withOrgFromCtx({
            productId: id,
            name: p.name.trim(),
            interval: interval as never,
            amount: Number(p.amount) || 0,
            active: p.active !== false,
          }),
        });
      }
    }

    const course = asRecord(body.course);
    if (course) {
      const mode =
        typeof course.mode === "string" && COURSE_MODES.has(course.mode.toUpperCase())
          ? course.mode.toUpperCase()
          : "EAD";
      const levelRaw =
        typeof course.level === "string" ? course.level.trim().toUpperCase() : "";
      const level = COURSE_LEVELS.has(levelRaw) ? levelRaw : null;
      const grau =
        typeof course.grau === "string" && course.grau.trim()
          ? course.grau.trim()
          : null;
      const semesterNum =
        typeof course.semester === "number" || typeof course.semester === "string"
          ? Number(course.semester)
          : null;
      const semester =
        semesterNum != null &&
        Number.isFinite(semesterNum) &&
        Number.isInteger(semesterNum) &&
        semesterNum > 0
          ? semesterNum
          : null;
      const postSalePipelineId =
        typeof course.postSalePipelineId === "string" && course.postSalePipelineId.trim()
          ? course.postSalePipelineId.trim()
          : null;
      const pricingOptions: Array<{
        price: number;
        channel: string | null;
        discountPercent: number | null;
        installments: number | null;
        months: number | null;
      }> = [];
      if (Array.isArray(course.pricingOptions)) {
        for (const raw of course.pricingOptions) {
          const opt = asRecord(raw);
          if (!opt) continue;
          const priceNum = Number(opt.price);
          if (!Number.isFinite(priceNum) || priceNum < 0) continue;
          const ch =
            typeof opt.channel === "string" && opt.channel.trim()
              ? opt.channel.trim()
              : null;
          const dNum =
            typeof opt.discountPercent === "number" ||
            typeof opt.discountPercent === "string"
              ? Number(opt.discountPercent)
              : null;
          const dPct =
            dNum != null && Number.isFinite(dNum) && dNum >= 0 && dNum <= 100
              ? dNum
              : null;
          const instNum =
            typeof opt.installments === "number" ||
            typeof opt.installments === "string"
              ? Number(opt.installments)
              : null;
          const installments =
            instNum != null &&
            Number.isFinite(instNum) &&
            Number.isInteger(instNum) &&
            instNum > 0
              ? instNum
              : null;
          const monthsNum =
            typeof opt.months === "number" || typeof opt.months === "string"
              ? Number(opt.months)
              : null;
          const months =
            monthsNum != null &&
            Number.isFinite(monthsNum) &&
            Number.isInteger(monthsNum) &&
            monthsNum > 0
              ? monthsNum
              : null;
          pricingOptions.push({
            price: priceNum,
            channel: ch,
            discountPercent: dPct,
            installments,
            months,
          });
        }
      }
      // Espelho da 1ª opção (ou payload legado channel/discountPercent).
      const first = pricingOptions[0];
      const channel =
        first?.channel ??
        (typeof course.channel === "string" && course.channel.trim()
          ? course.channel.trim()
          : null);
      const discountPercentNum =
        first?.discountPercent != null
          ? Number(first.discountPercent)
          : typeof course.discountPercent === "number" ||
              typeof course.discountPercent === "string"
            ? Number(course.discountPercent)
            : null;
      const discountPercent =
        discountPercentNum != null &&
        Number.isFinite(discountPercentNum) &&
        discountPercentNum >= 0 &&
        discountPercentNum <= 100
          ? discountPercentNum
          : null;
      if (pricingOptions.length === 0 && (channel != null || discountPercent != null)) {
        pricingOptions.push({
          price: 0,
          channel,
          discountPercent,
          installments: null,
          months: null,
        });
      }
      // Pós: se semester não veio no payload, espelha months da 1ª cota.
      const semesterResolved =
        semester ??
        (pricingOptions[0]?.months != null ? pricingOptions[0].months : null);
      const cfg = await prisma.courseConfig.upsert({
        where: { productId: id },
        create: withOrgFromCtx({
          productId: id,
          mode: mode as never,
          level: level as never,
          grau,
          semester: semesterResolved,
          postSalePipelineId,
          channel,
          discountPercent,
          pricingOptions,
        }),
        update: {
          mode: mode as never,
          level: level as never,
          grau,
          semester: semesterResolved,
          postSalePipelineId,
          channel,
          discountPercent,
          pricingOptions,
        },
        select: { id: true },
      });
      if (Array.isArray(course.classes)) {
        await prisma.courseClass.deleteMany({ where: { courseConfigId: cfg.id } });
        for (const raw of course.classes) {
          const c = asRecord(raw);
          if (!c || typeof c.name !== "string" || !c.name.trim()) continue;
          await prisma.courseClass.create({
            data: withOrgFromCtx({
              courseConfigId: cfg.id,
              name: c.name.trim(),
              startsAt: c.startsAt ? new Date(String(c.startsAt)) : null,
              endsAt: c.endsAt ? new Date(String(c.endsAt)) : null,
              location: typeof c.location === "string" ? c.location.trim() || null : null,
              poolId: typeof c.poolId === "string" && c.poolId ? c.poolId : null,
            }),
          });
        }
      }
    }

    const product = await prisma.product.findUnique({
      where: { id },
      include: {
        shipping: true,
        plans: true,
        courseConfig: { include: { classes: true } },
        capabilities: {
          select: {
            id: true,
            capabilityKey: true,
            mode: true,
            config: true,
            unitOverrides: true,
            enabled: true,
          },
        },
      },
    });
    return NextResponse.json({ product });
  });
}

export async function DELETE(request: Request, context: RouteContext) {
  const authResult = await authenticateApiRequest(request);
  if (!authResult.ok) return authResult.response;

  return runWithApiUserContext(authResult.user, async () => {
    const denied = await requirePermissionForUser(authResult.user, "product:delete");
    if (denied) return denied;

    const { id } = await context.params;
    try {
      await prisma.product.update({ where: { id }, data: { isActive: false } });
      return NextResponse.json({ ok: true });
    } catch {
      return NextResponse.json({ message: "Produto não encontrado." }, { status: 404 });
    }
  });
}
