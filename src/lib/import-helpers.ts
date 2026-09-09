import { parseCsv, type CsvDelimiter, detectDelimiter } from "@/lib/csv-parse";
import { prisma } from "@/lib/prisma";
import { getOrgIdOrThrow } from "@/lib/request-context";

/**
 * Lookups case-insensitive por e-mail/nome que USAM os índices funcionais
 * `lower(email)` / `lower(name)` (ver prisma/manual/20260716_import_perf_indexes.sql).
 *
 * Por que raw: o Prisma `mode: "insensitive"` gera `ILIKE`, que NÃO aproveita
 * um btree em `lower(col)`. Comparando `lower(col) = lower($1)` explicitamente,
 * o planner passa a usar o índice funcional — decisivo nos lookups por linha
 * do import (60k+), que antes viravam varredura sequencial na tabela
 * compartilhada entre tenants.
 *
 * Escopo multi-tenant: filtra `organizationId` explícito (raw não passa pela
 * extension do Prisma). Roda dentro de RequestContext (rota) ou
 * withSystemContext (worker), ambos populando `getOrgIdOrThrow()`.
 */
export async function findContactIdByEmailCI(email: string): Promise<string | null> {
  const trimmed = email.trim();
  if (!trimmed) return null;
  const orgId = getOrgIdOrThrow();
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM contacts
    WHERE "organizationId" = ${orgId} AND lower(email) = lower(${trimmed})
    ORDER BY "createdAt" DESC
    LIMIT 1
  `;
  return rows[0]?.id ?? null;
}

export async function findUserIdByEmailCI(email: string): Promise<string | null> {
  const trimmed = email.trim();
  if (!trimmed) return null;
  const rows = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM users
    WHERE lower(email) = lower(${trimmed})
    LIMIT 1
  `;
  return rows[0]?.id ?? null;
}

/**
 * Lê o conteúdo de um arquivo enviado via multipart e devolve headers + rows.
 * Suporta CSV (qualquer delimitador) e XLSX/XLSM/XLS/ODS via SheetJS.
 *
 * @param file Arquivo recebido em FormData
 * @param explicitDelimiter Se informado, força o delimitador. Caso contrário, detecta.
 */
export async function readUploadedTable(
  file: File,
  explicitDelimiter?: CsvDelimiter,
): Promise<{ headers: string[]; rows: Record<string, string>[] }> {
  const buffer = Buffer.from(await file.arrayBuffer());
  return readTableFromBuffer(buffer, file.name, explicitDelimiter);
}

/**
 * Variante de `readUploadedTable` que recebe um Buffer + nome do arquivo.
 * Usada pelo etl-worker, que lê o arquivo do storage (volume) e não tem um
 * objeto `File` do FormData. Detecta XLSX/CSV pela extensão do nome.
 */
export async function readTableFromBuffer(
  buffer: Buffer,
  fileName: string,
  explicitDelimiter?: CsvDelimiter,
): Promise<{ headers: string[]; rows: Record<string, string>[] }> {
  const name = fileName.toLowerCase();
  // `.xlsm` é xlsx com macro: mesmo container OOXML, o SheetJS lê igual.
  // As macros ficam num stream separado que nem chegamos a abrir.
  const isSpreadsheet =
    name.endsWith(".xlsx") ||
    name.endsWith(".xlsm") ||
    name.endsWith(".xls") ||
    name.endsWith(".ods");

  if (isSpreadsheet) {
    const XLSX = await import("xlsx");
    const buf = buffer;
    const wb = XLSX.read(buf, { type: "buffer" });
    const firstSheetName = wb.SheetNames[0];
    if (!firstSheetName) return { headers: [], rows: [] };
    const ws = wb.Sheets[firstSheetName];
    if (!ws) return { headers: [], rows: [] };

    const data = XLSX.utils.sheet_to_json<unknown[]>(ws, {
      header: 1,
      raw: false,
      defval: "",
    });
    if (data.length === 0) return { headers: [], rows: [] };

    const headerRow = (data[0] ?? []) as unknown[];
    const headers = headerRow.map((h) =>
      String(h ?? "").trim().toLowerCase().replace(/\s+/g, "_").replace(/-/g, "_"),
    );

    const rows: Record<string, string>[] = [];
    for (let r = 1; r < data.length; r++) {
      const arr = (data[r] ?? []) as unknown[];
      if (arr.every((v) => v === null || v === undefined || String(v).trim() === "")) continue;
      const obj: Record<string, string> = {};
      for (let c = 0; c < headers.length; c++) {
        obj[headers[c]] = String(arr[c] ?? "").trim();
      }
      rows.push(obj);
    }
    return { headers, rows };
  }

  const text = buffer.toString("utf-8");
  const delimiter = explicitDelimiter ?? detectDelimiter(text);
  return parseCsv(text, delimiter);
}

/**
 * Faz upsert da Tag por (organizationId, name) e retorna o id.
 * Reutiliza a tag se já existir.
 */
export async function upsertImportTag(
  organizationId: string,
  name: string,
): Promise<string> {
  const trimmed = name.trim();
  if (!trimmed) throw new Error("Nome da tag vazio.");
  const tag = await prisma.tag.upsert({
    where: { organizationId_name: { organizationId, name: trimmed } },
    update: {},
    create: { organizationId, name: trimmed },
    select: { id: true },
  });
  return tag.id;
}

/** Associa a tag ao contato. Idempotente. */
export async function attachTagToContact(contactId: string, tagId: string): Promise<void> {
  await prisma.tagOnContact.upsert({
    where: { contactId_tagId: { contactId, tagId } },
    update: {},
    create: { contactId, tagId },
  });
}

/** Associa a tag ao negócio. Idempotente. */
export async function attachTagToDeal(dealId: string, tagId: string): Promise<void> {
  await prisma.tagOnDeal.upsert({
    where: { dealId_tagId: { dealId, tagId } },
    update: {},
    create: { dealId, tagId },
  });
}

/**
 * Lê e valida o flag updateExisting de um FormData.
 * Default: true (compat com comportamento anterior).
 * Aceita: "false" / "0" / "no" => false. Resto => true.
 */
export function readUpdateExistingFlag(formData: FormData): boolean {
  const raw = formData.get("updateExisting");
  if (raw === null) return true;
  const s = String(raw).trim().toLowerCase();
  return !(s === "false" || s === "0" || s === "no");
}

/**
 * Modo de importação, escolhido no wizard (apenas deals por ora):
 *   "create"  → só cria leads novos; linhas que casam com um lead existente
 *               (por chave técnica: id / deal_number / external_id) são
 *               IGNORADAS (não duplica nem atualiza).
 *   "update"  → só atualiza leads existentes (casa por external_id / chave
 *               técnica); linhas sem correspondência são ignoradas.
 *   "upsert"  → cria e atualiza (comportamento histórico).
 */
export type ImportMode = "create" | "update" | "upsert";

/**
 * Lê o modo de importação do FormData. Retorna `null` quando ausente — o
 * caller decide o fallback (ex.: derivar de `updateExisting` para manter
 * compatibilidade com clientes antigos).
 */
export function readImportModeFlag(formData: FormData): ImportMode | null {
  const raw = formData.get("importMode");
  if (raw === null) return null;
  const s = String(raw).trim().toLowerCase();
  if (s === "create" || s === "update" || s === "upsert") return s;
  return null;
}

/** Lê o delimitador opcional do FormData. */
export function readDelimiterFlag(formData: FormData): CsvDelimiter | undefined {
  const raw = formData.get("delimiter");
  if (raw === null) return undefined;
  const s = String(raw);
  if (s === "," || s === ";" || s === "\t") return s;
  return undefined;
}

/** Lê o nome da tag opcional do FormData. */
export function readTagFlag(formData: FormData): string | undefined {
  const raw = formData.get("tag");
  if (raw === null) return undefined;
  const s = String(raw).trim();
  return s.length > 0 ? s : undefined;
}
