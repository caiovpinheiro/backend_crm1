/**
 * Mensagem padrão ao encaminhar um produto.
 * O modelo é da org (tipo + nível de curso). O texto usa {{variavel}}.
 */
import { prisma } from "@/lib/prisma";

export const PRODUCT_KINDS = ["PHYSICAL", "SERVICE", "COURSE", "JOB_OPENING"] as const;
export const COURSE_LEVELS = ["GRADUATION", "POSTGRADUATE"] as const;

export type ProductKindValue = (typeof PRODUCT_KINDS)[number];
export type CourseLevelValue = (typeof COURSE_LEVELS)[number];

export type MessageVariable = {
  key: string;
  label: string;
  sample: string;
};

const KIND_LABEL: Record<ProductKindValue, string> = {
  PHYSICAL: "Físico",
  SERVICE: "Serviço",
  COURSE: "Curso",
  JOB_OPENING: "Vaga",
};

const LEVEL_LABEL: Record<CourseLevelValue, string> = {
  GRADUATION: "Graduação",
  POSTGRADUATE: "Pós-Graduação",
};

const MODE_LABEL: Record<string, string> = {
  EAD: "EAD",
  IN_PERSON: "Presencial",
  HYBRID: "Semi-Presencial",
};

/** Rótulo da modalidade do curso (EAD, Presencial, Semi-Presencial). */
export function formatCourseMode(mode: string | null | undefined): string {
  if (!mode) return "";
  return MODE_LABEL[mode] ?? "";
}

const BASE_VARIABLES: MessageVariable[] = [
  { key: "nome", label: "Nome", sample: "Administração" },
  { key: "descricao", label: "Descrição", sample: "Curso na modalidade EAD." },
  { key: "sku", label: "SKU / código", sample: "ADM-EAD" },
  { key: "preco", label: "Preço", sample: "164,70" },
  { key: "preco_promocional", label: "Preço com desconto", sample: "115,29" },
  { key: "desconto", label: "Desconto (%)", sample: "30" },
  { key: "quantidade", label: "Quantidade", sample: "1" },
  { key: "unidade", label: "Unidade", sample: "un" },
  { key: "tipo", label: "Tipo", sample: "Curso" },
];

const COURSE_VARIABLES: MessageVariable[] = [
  { key: "nivel", label: "Nível", sample: "Graduação" },
  { key: "grau", label: "Grau", sample: "Bacharelado" },
  { key: "modalidade", label: "Modalidade", sample: "EAD" },
  { key: "duracao", label: "Duração", sample: "8 semestres" },
  { key: "grade", label: "Grade curricular", sample: "https://exemplo.com/grade.pdf" },
  { key: "parcelas", label: "Parcelas", sample: "12" },
];

export function isProductKind(v: string): v is ProductKindValue {
  return (PRODUCT_KINDS as readonly string[]).includes(v);
}

export function isCourseLevel(v: string): v is CourseLevelValue {
  return (COURSE_LEVELS as readonly string[]).includes(v);
}

function slug(raw: string): string {
  return raw
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function money(value: number): string {
  if (!Number.isFinite(value)) return "";
  return value.toFixed(2).replace(".", ",");
}

type PricingOption = {
  price: number;
  discountPercent: number | null;
  installments: number | null;
  months: number | null;
};

function parsePositiveInt(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && Number.isInteger(n) && n > 0 ? n : null;
}

function pricingOptions(raw: unknown, fallbackPrice: number): PricingOption[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((item) => {
    const o = item && typeof item === "object" ? (item as Record<string, unknown>) : {};
    const discount = o.discountPercent;
    return {
      price: Number(o.price) || fallbackPrice || 0,
      discountPercent:
        discount === null || discount === undefined || discount === "" ? null : Number(discount),
      installments: parsePositiveInt(o.installments),
      months: parsePositiveInt(o.months),
    };
  });
}

function formatGraduationSemesters(semester: number): string {
  return Number(semester) === 1 ? "1 semestre" : `${semester} semestres`;
}

/** Texto de duração do curso: pós em meses, graduação em semestres. */
export function formatCourseDuration(args: {
  level: string | null | undefined;
  semester: number | null | undefined;
  pricingOptions: unknown;
  unitPrice: number;
  discount: number;
  catalogPrice?: number;
}): string {
  const level = args.level && isCourseLevel(args.level) ? args.level : null;
  const options = pricingOptions(args.pricingOptions, args.catalogPrice ?? args.unitPrice);
  const matched =
    level === "POSTGRADUATE" ? matchOption(options, args.unitPrice, args.discount) : null;
  if (level === "POSTGRADUATE" && matched?.months != null) return `${matched.months} meses`;
  const semester = args.semester;
  if (semester != null && Number.isFinite(Number(semester)) && Number(semester) > 0) {
    return level === "POSTGRADUATE" ? `${semester} meses` : formatGraduationSemesters(semester);
  }
  return "";
}

function matchOption(
  options: PricingOption[],
  unitPrice: number,
  discount: number,
): PricingOption | null {
  if (options.length === 0) return null;
  const exact = options.find(
    (o) =>
      Math.abs(o.price - unitPrice) < 0.005 &&
      Math.abs((o.discountPercent ?? 0) - discount) < 0.005,
  );
  if (exact) return exact;
  return options.find((o) => Math.abs(o.price - unitPrice) < 0.005) ?? options[0] ?? null;
}

export async function listMessageVariables(args: {
  kind: ProductKindValue;
  courseLevel?: CourseLevelValue | null;
}): Promise<MessageVariable[]> {
  const vars = [...BASE_VARIABLES];
  if (args.kind === "COURSE") vars.push(...COURSE_VARIABLES);
  const fields = await prisma.customField.findMany({
    where: { entity: "product" },
    select: { name: true, label: true },
    orderBy: { label: "asc" },
  });
  const seen = new Set(vars.map((v) => v.key));
  for (const field of fields) {
    const key = `campo.${slug(field.name || field.label)}`;
    if (!key || key === "campo." || seen.has(key)) continue;
    seen.add(key);
    vars.push({ key, label: field.label || field.name, sample: "" });
  }
  return vars;
}

export function renderProductMessage(content: string, values: Record<string, string>): string {
  return content.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_, raw: string) => {
    const key = raw.toLowerCase();
    return values[key] ?? "";
  });
}

export async function resolveProductMessageTemplate(args: {
  kind: ProductKindValue;
  courseLevel?: CourseLevelValue | null;
}) {
  const level = args.kind === "COURSE" ? args.courseLevel ?? null : null;
  const rows = await prisma.productMessageTemplate.findMany({
    where: {
      kind: args.kind,
      active: true,
      OR: level ? [{ courseLevel: level }, { courseLevel: null }] : [{ courseLevel: null }],
    },
    orderBy: { updatedAt: "desc" },
  });
  if (level) {
    const specific = rows.find((row) => row.courseLevel === level);
    if (specific) return specific;
  }
  return rows.find((row) => row.courseLevel == null) ?? null;
}

export async function renderProductMessageForProduct(args: {
  productId: string;
  unitPrice?: number | null;
  discount?: number | null;
  quantity?: number | null;
}): Promise<{
  templateId: string | null;
  templateName: string | null;
  text: string | null;
  gradeUrl: string | null;
  gradeFileName: string | null;
  gradeMime: string | null;
}> {
  const product = await prisma.product.findUnique({
    where: { id: args.productId },
    select: {
      id: true,
      name: true,
      description: true,
      sku: true,
      price: true,
      unit: true,
      kind: true,
      courseConfig: {
        select: {
          level: true,
          grau: true,
          mode: true,
          semester: true,
          pricingOptions: true,
          gradeUrl: true,
          gradeFileName: true,
          gradeMime: true,
        },
      },
      customValues: {
        select: {
          value: true,
          customField: { select: { name: true, label: true } },
        },
      },
    },
  });
  const gradeUrl = product?.courseConfig?.gradeUrl?.trim() || null;
  const gradeFileName = product?.courseConfig?.gradeFileName?.trim() || null;
  const gradeMime = product?.courseConfig?.gradeMime?.trim() || null;
  if (!product || !isProductKind(product.kind)) {
    return { templateId: null, templateName: null, text: null, gradeUrl, gradeFileName, gradeMime };
  }

  const level =
    product.kind === "COURSE" && product.courseConfig?.level && isCourseLevel(product.courseConfig.level)
      ? product.courseConfig.level
      : null;
  const template = await resolveProductMessageTemplate({ kind: product.kind, courseLevel: level });
  if (!template) {
    return { templateId: null, templateName: null, text: null, gradeUrl, gradeFileName, gradeMime };
  }

  const base = args.unitPrice != null && Number.isFinite(args.unitPrice) ? args.unitPrice : Number(product.price) || 0;
  const discount = Math.min(100, Math.max(0, args.discount ?? 0));
  const qty = args.quantity != null && Number.isFinite(args.quantity) && args.quantity > 0 ? args.quantity : 1;
  const promo = base * (1 - discount / 100);
  const options = pricingOptions(product.courseConfig?.pricingOptions, Number(product.price) || 0);
  const matched = level === "POSTGRADUATE" ? matchOption(options, base, discount) : null;
  const duration = formatCourseDuration({
    level,
    semester: product.courseConfig?.semester ?? null,
    pricingOptions: product.courseConfig?.pricingOptions,
    unitPrice: base,
    discount,
    catalogPrice: Number(product.price) || 0,
  });

  const values: Record<string, string> = {
    nome: product.name ?? "",
    descricao: product.description?.trim() ?? "",
    sku: product.sku?.trim() ?? "",
    preco: money(base),
    preco_promocional: money(promo),
    desconto: discount > 0 ? String(discount) : "",
    quantidade: String(qty),
    unidade: product.unit?.trim() || "un",
    tipo: KIND_LABEL[product.kind],
    nivel: level ? LEVEL_LABEL[level] : "",
    grau: product.courseConfig?.grau?.trim() ?? "",
    modalidade: product.courseConfig?.mode ? MODE_LABEL[product.courseConfig.mode] ?? product.courseConfig.mode : "",
    duracao: duration,
    grade: gradeUrl ?? "",
    parcelas: matched?.installments != null ? String(matched.installments) : "",
  };

  for (const row of product.customValues) {
    const keys = [slug(row.customField.name), slug(row.customField.label)].filter(Boolean);
    for (const key of keys) values[`campo.${key}`] = row.value ?? "";
  }

  return {
    templateId: template.id,
    templateName: template.name,
    text: renderProductMessage(template.content, values).trim() || null,
    gradeUrl,
    gradeFileName,
    gradeMime,
  };
}
