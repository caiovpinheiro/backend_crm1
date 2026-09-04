import { NextResponse } from "next/server";

import type { AppUserRole } from "@/lib/auth-types";
import { prisma } from "@/lib/prisma";

type SessionLike = { user?: { id?: string; role?: AppUserRole } } | null;

/** Importação em massa: apenas ADMIN e MANAGER. */
export function assertImportPermission(session: SessionLike): NextResponse | null {
  if (!session?.user?.id) {
    return NextResponse.json({ message: "Não autorizado." }, { status: 401 });
  }
  const role = session.user.role;
  if (role !== "ADMIN" && role !== "MANAGER") {
    return NextResponse.json(
      { message: "Apenas administradores e gerentes podem importar dados." },
      { status: 403 },
    );
  }
  return null;
}

/**
 * Tipos de BulkOperation considerados "import de arquivo" para o rate limit
 * de 1 import ativo por org (M6). Estenda com DEAL_IMPORT quando o import de
 * deals migrar para o fluxo assíncrono.
 */
const ACTIVE_IMPORT_TYPES = [
  "CONTACT_IMPORT",
  "DEAL_IMPORT",
  "ACADEMIC_IMPORT",
  "COMPANY_IMPORT",
] as const;

/**
 * M6 — permite apenas 1 importação de arquivo ATIVA (PENDING/PROCESSING) por
 * org por vez. Evita que múltiplas cargas concorrentes (ex.: várias fatias de
 * CSV disparadas em sequência) multipliquem a pressão no Postgres compartilhado.
 *
 * DEVE rodar DEPOIS de `enterRequestContext` (usa o `prisma` scoped, que filtra
 * por organizationId automaticamente). Retorna 409 se já houver import ativo.
 */
export async function assertNoActiveImport(): Promise<NextResponse | null> {
  const active = await prisma.bulkOperation.findFirst({
    where: {
      type: { in: [...ACTIVE_IMPORT_TYPES] },
      status: { in: ["PENDING", "PROCESSING"] },
    },
    select: { id: true, type: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });
  if (active) {
    return NextResponse.json(
      {
        message:
          "Já existe uma importação em andamento nesta organização. Aguarde a atual concluir antes de iniciar outra.",
        operationId: active.id,
      },
      { status: 409 },
    );
  }
  return null;
}
