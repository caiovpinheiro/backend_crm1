/**
 * POST /api/profile/avatar
 * ─────────────────────────
 * Upload da foto de perfil do usuário autenticado. Persiste em
 * `public/uploads/avatars/` (mesmo padrão das mídias de automação) e
 * retorna a URL pública relativa para ser gravada em `User.avatarUrl`
 * via PUT /api/profile (evita race: o cliente recebe a URL, atualiza o
 * próprio estado e só dispara o salvamento do form quando o operador
 * clica em "Salvar").
 *
 * Restrições de segurança:
 *  - Apenas image/* com tamanho ≤ 4 MB (avatar é pequeno; 4 MB já cobre
 *    fotos de celular em alta qualidade e mantém o disco enxuto).
 *  - Nome de arquivo aleatório prefixado pelo userId para facilitar
 *    auditoria e evitar colisões.
 */

import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { extForMime, sniffImageMime } from "@/lib/file-sniff";
import { generateFileName, saveFile } from "@/lib/storage/local";
import { getLogger } from "@/lib/logger";

const log = getLogger("api/profile/avatar");

const MAX_AVATAR_SIZE = 4 * 1024 * 1024;

export async function POST(request: Request) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ message: "Não autorizado." }, { status: 401 });
    }
    const orgId = (session.user as { organizationId?: string | null }).organizationId ?? null;
    if (!orgId) {
      return NextResponse.json(
        { message: "Avatar requer organização ativa." },
        { status: 400 },
      );
    }

    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      return NextResponse.json(
        { message: "Erro ao processar upload." },
        { status: 400 },
      );
    }

    const raw = form.get("file");
    if (!raw || !(raw instanceof Blob)) {
      return NextResponse.json(
        { message: 'Envie a imagem no campo "file".' },
        { status: 400 },
      );
    }

    const file = raw as Blob & { name?: string };

    if (file.size > MAX_AVATAR_SIZE) {
      return NextResponse.json(
        {
          message: `Imagem excede o limite de ${MAX_AVATAR_SIZE / 1024 / 1024} MB.`,
        },
        { status: 413 },
      );
    }

    const buffer = Buffer.from(await file.arrayBuffer());

    // Defesa em profundidade: valida via magic bytes em vez de confiar
    // no Content-Type do cliente. Rejeita SVG (vetor XSS) e qualquer
    // formato que não seja JPEG/PNG/WEBP/GIF.
    const sniffed = sniffImageMime(buffer);
    if (!sniffed) {
      return NextResponse.json(
        { message: "Envie uma imagem JPG, PNG, WEBP ou GIF." },
        { status: 415 },
      );
    }

    const mime = sniffed;
    const ext = extForMime(sniffed);
    const safeName = generateFileName({
      prefix: `u${session.user.id.slice(0, 8)}`,
      ext,
    });

    // PR 1.3: avatares passam a viver em `<STORAGE_ROOT>/<orgId>/avatars/`.
    const saved = await saveFile({
      orgId,
      bucket: "avatars",
      fileName: safeName,
      buffer,
    });
    return NextResponse.json({ url: saved.url, mimeType: mime });
  } catch (error) {
    log.error({ err: error }, "[profile/avatar] upload failed");
    return NextResponse.json(
      { message: "Erro ao salvar a imagem." },
      { status: 500 },
    );
  }
}
