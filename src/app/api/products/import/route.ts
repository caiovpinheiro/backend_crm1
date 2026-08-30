import type { ProductKind } from "@prisma/client";
import { NextResponse } from "next/server";

import { authenticateApiRequest, runWithApiUserContext } from "@/lib/api-auth";
import {
  readDelimiterFlag,
  readUpdateExistingFlag,
  readUploadedTable,
} from "@/lib/import-helpers";
import { prisma } from "@/lib/prisma";
import { withOrgFromCtx } from "@/lib/prisma-helpers";

const MAX_ROWS = 20_000;

const KINDS = new Set<ProductKind>([
  "PHYSICAL",
  "SERVICE",
  "COURSE",
  "JOB_OPENING",
]);

const KIND_ALIASES: Record<string, ProductKind> = {
  physical: "PHYSICAL",
  fisico: "PHYSICAL",
  fisica: "PHYSICAL",
  produto: "PHYSICAL",
  product: "PHYSICAL",
  service: "SERVICE",
  servico: "SERVICE",
  servicos: "SERVICE",
  course: "COURSE",
  curso: "COURSE",
  job_opening: "JOB_OPENING",
  jobopening: "JOB_OPENING",
  vaga: "JOB_OPENING",
  vagas: "JOB_OPENING",
};

const KEY_ALIASES: Record<string, string> = {
  nome: "name",
  name: "name",
  sku: "sku",
  id: "id",
  descricao: "description",
  description: "description",
  tipo: "kind",
  kind: "kind",
  type: "type",
  preco: "price",
  price: "price",
  unidade: "unit",
  unit: "unit",
  ativo: "is_active",
  is_active: "is_active",
  estoque: "stock",
  stock: "stock",
  controlar_estoque: "track_stock",
  track_stock: "track_stock",
};

function parseBool(v: string | undefined, fallback = false): boolean {
  if (v == null) return fallback;
  const s = v.trim().toLowerCase();
  if (s === "") return fallback;
  return s === "true" || s === "1" || s === "sim" || s === "yes";
}

function parseNum(v: string | undefined, fallback = 0): number {
  if (v == null || v.trim() === "") return fallback;
  const n = Number(v.replace(/\s/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : fallback;
}

function parseKind(raw: string | undefined): ProductKind | undefined {
  if (!raw) return undefined;
  const key = raw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "_");
  if (KINDS.has(key as ProductKind)) return key as ProductKind;
  return KIND_ALIASES[key.toLowerCase()];
}

function remapRow(row: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(row)) {
    out[KEY_ALIASES[k] ?? k] = v;
  }
  return out;
}

function resolveKindAndType(
  kindRaw: string | undefined,
  typeRaw: string | undefined,
): { kind?: ProductKind; type?: "PRODUCT" | "SERVICE" } {
  const kind = parseKind(kindRaw);
  const type =
    typeRaw?.trim().toUpperCase() === "SERVICE"
      ? "SERVICE"
      : typeRaw?.trim().toUpperCase() === "PRODUCT"
        ? "PRODUCT"
        : undefined;

  if (kind) {
    return {
      kind,
      type: kind === "SERVICE" ? "SERVICE" : "PRODUCT",
    };
  }
  if (type === "SERVICE") return { kind: "SERVICE", type };
  if (type === "PRODUCT") return { kind: "PHYSICAL", type };
  return {};
}

/**
 * POST /api/products/import
 * CSV/XLSX do catálogo. Upsert por id, depois sku.
 */
export async function POST(request: Request) {
  try {
    const authResult = await authenticateApiRequest(request);
    if (!authResult.ok) return authResult.response;

    return await runWithApiUserContext(authResult.user, async () => {
      const role = (authResult.user as { role?: string }).role;
      if (role !== "ADMIN" && role !== "MANAGER") {
        return NextResponse.json(
          { message: "Apenas administradores e gerentes podem importar dados." },
          { status: 403 },
        );
      }

      const formData = await request.formData();
      const file = formData.get("file");
      if (!(file instanceof File)) {
        return NextResponse.json(
          { message: 'Envie o arquivo CSV no campo "file".' },
          { status: 400 },
        );
      }

      const delimiter = readDelimiterFlag(formData);
      const updateExisting = readUpdateExistingFlag(formData);
      const { headers, rows } = await readUploadedTable(file, delimiter);

      if (headers.length === 0) {
        return NextResponse.json(
          { message: "CSV vazio ou inválido." },
          { status: 400 },
        );
      }
      if (rows.length > MAX_ROWS) {
        return NextResponse.json(
          { message: `Limite de ${MAX_ROWS} linhas por importação.` },
          { status: 400 },
        );
      }

      const mappedHeaders = new Set(headers.map((h) => KEY_ALIASES[h] ?? h));
      if (
        !mappedHeaders.has("name") &&
        !mappedHeaders.has("sku") &&
        !mappedHeaders.has("id")
      ) {
        return NextResponse.json(
          {
            message:
              'CSV inválido: inclua ao menos uma coluna "name", "sku" ou "id".',
          },
          { status: 400 },
        );
      }

      const cfDefs = await prisma.customField.findMany({
        where: { entity: "product" },
        select: { id: true, name: true },
      });
      const cfByName = new Map(cfDefs.map((f) => [f.name, f.id]));

      const failed: { row: number; message: string }[] = [];
      let created = 0;
      let updated = 0;
      let skipped = 0;

      for (let i = 0; i < rows.length; i++) {
        const row = remapRow(rows[i]!);
        const rowNumber = i + 2;

        const id = row.id?.trim() || "";
        const sku = row.sku?.trim() || "";
        const name = row.name?.trim() || "";

        let targetId: string | null = null;
        try {
          if (id) {
            const found = await prisma.product.findFirst({
              where: { id },
              select: { id: true },
            });
            if (found) targetId = found.id;
          }
          if (!targetId && sku) {
            const found = await prisma.product.findFirst({
              where: { sku },
              select: { id: true },
            });
            if (found) targetId = found.id;
          }
        } catch {
          failed.push({
            row: rowNumber,
            message: "Erro ao localizar produto existente.",
          });
          continue;
        }

        const { kind, type } = resolveKindAndType(row.kind, row.type);

        try {
          let productId: string;

          if (targetId) {
            if (!updateExisting) {
              skipped += 1;
              continue;
            }
            const data: Record<string, unknown> = {};
            if (name) data.name = name;
            if ("description" in row)
              data.description = row.description?.trim() || null;
            if ("sku" in row) data.sku = sku || null;
            if ("price" in row) data.price = parseNum(row.price);
            if ("unit" in row) data.unit = row.unit?.trim() || "un";
            if ("is_active" in row) data.isActive = parseBool(row.is_active, true);
            if (kind) data.kind = kind;
            if (type) data.type = type;
            const effType = type ?? undefined;
            if ("track_stock" in row) {
              const track = parseBool(row.track_stock);
              data.trackStock = effType === "SERVICE" ? false : track;
            }
            if ("stock" in row) data.stock = parseNum(row.stock);
            if (data.type === "SERVICE" || data.kind === "SERVICE") {
              data.trackStock = false;
              data.stock = 0;
            }
            const up = await prisma.product.update({
              where: { id: targetId },
              data,
            });
            productId = up.id;
            updated += 1;
          } else {
            if (!name) {
              failed.push({
                row: rowNumber,
                message: 'Sem produto correspondente e sem "name" para criar.',
              });
              continue;
            }
            const finalKind = kind ?? "PHYSICAL";
            const finalType = type ?? (finalKind === "SERVICE" ? "SERVICE" : "PRODUCT");
            const track =
              finalType === "SERVICE" ? false : parseBool(row.track_stock);
            const cr = await prisma.product.create({
              data: withOrgFromCtx({
                name,
                description: row.description?.trim() || null,
                sku: sku || null,
                price: parseNum(row.price),
                unit:
                  finalType === "SERVICE"
                    ? "serviço"
                    : row.unit?.trim() || "un",
                type: finalType,
                kind: finalKind,
                isActive: parseBool(row.is_active, true),
                trackStock: track,
                stock: track ? parseNum(row.stock) : 0,
              }),
            });
            productId = cr.id;
            created += 1;
          }

          for (const [slug, fieldId] of cfByName) {
            const col = `cf_${slug}`;
            if (!(col in row) && !(col in (rows[i] ?? {}))) continue;
            const value = (row[col] ?? rows[i]?.[col] ?? "").trim();
            if (value) {
              await prisma.productCustomFieldValue.upsert({
                where: {
                  productId_customFieldId: {
                    productId,
                    customFieldId: fieldId,
                  },
                },
                update: { value },
                create: withOrgFromCtx({
                  productId,
                  customFieldId: fieldId,
                  value,
                }),
              });
            } else {
              await prisma.productCustomFieldValue.deleteMany({
                where: { productId, customFieldId: fieldId },
              });
            }
          }
        } catch (e: unknown) {
          const code =
            typeof e === "object" && e !== null && "code" in e
              ? String((e as { code: string }).code)
              : "";
          const msg =
            code === "P2002"
              ? "SKU duplicado nesta organização."
              : "Erro ao salvar produto.";
          failed.push({ row: rowNumber, message: msg });
        }
      }

      return NextResponse.json(
        { created, updated, skipped, failed, totalRows: rows.length },
        { status: 201 },
      );
    });
  } catch (e) {
    console.error(e);
    return NextResponse.json(
      { message: "Erro ao importar produtos." },
      { status: 500 },
    );
  }
}
