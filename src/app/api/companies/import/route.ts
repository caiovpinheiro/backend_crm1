import { NextResponse } from "next/server";

import { authenticateApiRequest, runWithApiUserContext } from "@/lib/api-auth";
import { requirePermissionForUser } from "@/lib/authz/resource-policy";
import {
  readDelimiterFlag,
  readUpdateExistingFlag,
  readUploadedTable,
} from "@/lib/import-helpers";
import { prisma } from "@/lib/prisma";
import { createCompany, updateCompany } from "@/services/companies";

const MAX_ROWS = 10_000;

const KEY_ALIASES: Record<string, string> = {
  nome: "name",
  name: "name",
  dominio: "domain",
  domain: "domain",
  website: "domain",
  site: "domain",
  setor: "industry",
  industria: "industry",
  industry: "industry",
  porte: "size",
  size: "size",
  telefone: "phone",
  phone: "phone",
  endereco: "address",
  address: "address",
  cep: "cep",
  cidade: "city",
  city: "city",
  estado: "state",
  uf: "state",
  state: "state",
  notas: "notes",
  notes: "notes",
  observacoes: "notes",
};

function norm(h: string): string {
  return h
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

function cell(row: Record<string, string>, key: string): string {
  return (row[key] ?? "").trim();
}

/**
 * POST /api/companies/import
 * CSV remapeado (1 linha = 1 empresa). Casa por nome (case-insensitive).
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
      const denied = await requirePermissionForUser(
        authResult.user,
        "company:create",
      );
      if (denied) return denied;

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

      if (rows.length > MAX_ROWS) {
        return NextResponse.json(
          { message: `Limite de ${MAX_ROWS} linhas por importação.` },
          { status: 400 },
        );
      }

      const headerMap = new Map<string, string>();
      for (const h of headers) {
        const key = KEY_ALIASES[norm(h)] ?? KEY_ALIASES[h] ?? h;
        headerMap.set(h, key);
      }

      let created = 0;
      let updated = 0;
      let skipped = 0;
      const failed: { row: number; message: string }[] = [];

      for (let i = 0; i < rows.length; i++) {
        const raw = rows[i]!;
        const mapped: Record<string, string> = {};
        for (const [src, dest] of headerMap) {
          mapped[dest] = (raw[src] ?? "").trim();
        }

        const name = cell(mapped, "name");
        if (!name) {
          failed.push({ row: i + 2, message: "Nome é obrigatório." });
          continue;
        }

        try {
          const existing = await prisma.company.findFirst({
            where: { name: { equals: name, mode: "insensitive" } },
            select: { id: true },
          });

          const payload = {
            name,
            domain: cell(mapped, "domain") || null,
            industry: cell(mapped, "industry") || null,
            size: cell(mapped, "size") || null,
            phone: cell(mapped, "phone") || null,
            address: cell(mapped, "address") || null,
            cep: cell(mapped, "cep") || null,
            city: cell(mapped, "city") || null,
            state: cell(mapped, "state") || null,
            notes: cell(mapped, "notes") || null,
          };

          if (existing) {
            if (!updateExisting) {
              skipped += 1;
              continue;
            }
            await updateCompany(existing.id, payload);
            updated += 1;
          } else {
            await createCompany(payload);
            created += 1;
          }
        } catch (err) {
          failed.push({
            row: i + 2,
            message: err instanceof Error ? err.message : "Falha ao gravar.",
          });
        }
      }

      return NextResponse.json({ created, updated, skipped, failed });
    });
  } catch (e) {
    console.error("[companies/import]", e);
    return NextResponse.json(
      { message: "Erro ao importar empresas." },
      { status: 500 },
    );
  }
}
