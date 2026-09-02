/**
 * GET /api/storage/<organizationId>/<bucket>/<fileName>
 *
 * Gateway autenticado para arquivos persistidos pelo módulo
 * `src/lib/storage/local.ts`. Garante isolamento multi-tenant: a
 * sessão atual precisa ter `organizationId === <organizationId>`
 * (ou ser super-admin) — caso contrário responde 404 (sem revelar
 * existência do arquivo).
 *
 * O endpoint legacy `/api/uploads/[...path]` continua funcionando até
 * o backfill mover todos os arquivos pra layout novo (PR 1.3 backfill).
 *
 * @see docs/storage-tenancy.md
 */
import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { applyBrowserApiCors } from "@/lib/browser-api-cors";
import {
  isStorageReuseBucket,
  mimeFromFilename,
  parseStoragePath,
  readStoredFile,
  readStoredFileRange,
  reuseFileNameAliases,
  statStoredFile,
} from "@/lib/storage/local";
import { persistLegacyBytesToActiveDriver } from "@/lib/storage/migrate-from-legacy";
import { tryUpstreamFallback } from "@/lib/storage/upstream-fallback";

type RouteContext = { params: Promise<{ path: string[] }> };

function withStorageCors(request: Request, res: Response): Response {
  applyBrowserApiCors(request, res);
  return res;
}

/** Worker sem cookie: mesmo segredo dos crons. Não aceita `?secret=` (vaza em log). */
function hasCronSecret(request: Request): boolean {
  const expected = process.env.CRON_SECRET?.trim();
  if (!expected) return false;
  const provided = (request.headers.get("authorization") ?? "")
    .replace(/^Bearer\s+/i, "")
    .trim();
  return provided.length > 0 && provided === expected;
}

export async function GET(request: Request, context: RouteContext) {
  const cronOk = hasCronSecret(request);
  const session = cronOk ? null : await auth();
  if (!cronOk && !session?.user) {
    return withStorageCors(
      request,
      NextResponse.json({ message: "Não autorizado." }, { status: 401 }),
    );
  }

  const { path: segments } = await context.params;
  const joined = (segments ?? []).join("/");
  const parsed = parseStoragePath(joined);
  if (!parsed) {
    return withStorageCors(
      request,
      NextResponse.json({ message: "Caminho inválido." }, { status: 400 }),
    );
  }

  if (cronOk) {
    if (!isStorageReuseBucket(parsed.bucket)) {
      return withStorageCors(
        request,
        NextResponse.json({ message: "Arquivo não encontrado." }, { status: 404 }),
      );
    }
  } else {
    // Multi-tenancy enforcement: só super-admin atravessa orgs.
    const sUser = session!.user as {
      organizationId?: string | null;
      isSuperAdmin?: boolean;
    };
    const sessionOrgId = sUser.organizationId ?? null;
    const isSuperAdmin = Boolean(sUser.isSuperAdmin);

    if (!isSuperAdmin && sessionOrgId !== parsed.orgId) {
      // 404 (e não 403) pra não confirmar existência.
      return withStorageCors(
        request,
        NextResponse.json({ message: "Arquivo não encontrado." }, { status: 404 }),
      );
    }
  }

  // 16/jul/26 — Suporte a HTTP Range. Sem isso, `<video controls>` do
  // HTML5 nao inicia a reproducao (Safari/iOS falham sempre; Chrome
  // tolera arquivos pequenos e trava em vídeos maiores). Estrategia:
  //  1. `statStoredFile()` pra descobrir tamanho antes de ler (fs.stat
  //     no driver local; HeadObject no driver s3).
  //  2. Se o request trouxer `Range: bytes=start-end`, responde 206
  //     com apenas o slice via `readStoredFileRange()` — no driver s3 o
  //     Range é repassado ao GetObject, então vídeo de 50MB nunca é
  //     carregado inteiro na RAM em nenhum dos backends.
  //  3. Sem Range, mantem o comportamento antigo (200 + full body),
  //     preservando imagem/audio/doc.
  // A validacao de auth ja foi feita acima; aqui e' so I/O + headers.
  const fileStat = await statStoredFile(parsed.orgId, parsed.bucket, parsed.fileName);

  if (fileStat) {
    const total = fileStat.size;
    const mimeType = mimeFromFilename(parsed.fileName);
    const rangeHeader = request.headers.get("range");

    if (rangeHeader) {
      // Formato aceito: `bytes=<start>-<end?>`. Multi-range (RFC 7233)
      // nao e' usado por <video>/<audio> — nao suportamos pra simplificar.
      const m = /^bytes=(\d+)-(\d*)$/.exec(rangeHeader.trim());
      if (m) {
        const start = Number(m[1]);
        const end = m[2] ? Math.min(Number(m[2]), total - 1) : total - 1;

        if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= total) {
          return withStorageCors(
            request,
            new Response(null, {
              status: 416,
              headers: {
                "Content-Range": `bytes */${total}`,
                "Accept-Ranges": "bytes",
              },
            }),
          );
        }

        const chunk = await readStoredFileRange(
          parsed.orgId,
          parsed.bucket,
          parsed.fileName,
          start,
          end,
        );
        if (chunk) {
          return withStorageCors(
            request,
            new Response(new Uint8Array(chunk.buffer), {
              status: 206,
              headers: {
                "Content-Type": mimeType,
                "Content-Length": String(chunk.buffer.length),
                "Content-Range": `bytes ${start}-${end}/${total}`,
                "Accept-Ranges": "bytes",
                "Cache-Control": "private, max-age=300",
                "X-Storage-Tenant": parsed.orgId,
              },
            }),
          );
        }
        // Corrida: o arquivo sumiu entre o stat e o read (ou erro
        // transitório no backend) — cai no fluxo full-body/404 abaixo.
      }
      // Range malformado: cai no fluxo full-body abaixo (comportamento
      // permissivo — alguns clients mandam ranges esquisitos).
    }
  }

  const file = await readStoredFile(parsed.orgId, parsed.bucket, parsed.fileName);
  if (file) {
    return withStorageCors(
      request,
      new Response(new Uint8Array(file.buffer), {
        status: 200,
        headers: {
          "Content-Type": file.mimeType,
          "Content-Length": String(file.size),
          "Cache-Control": "private, max-age=300",
          "Accept-Ranges": "bytes",
          "X-Storage-Tenant": parsed.orgId,
        },
      }),
    );
  }

  const aliasReads = reuseFileNameAliases(parsed.fileName)
    .filter((name) => name !== parsed.fileName)
    .map((name) => readStoredFile(parsed.orgId, parsed.bucket, name));
  const aliasHits = aliasReads.length ? await Promise.all(aliasReads) : [];
  const aliasFile = aliasHits.find((hit) => hit != null);
  if (aliasFile) {
    return withStorageCors(
      request,
      new Response(new Uint8Array(aliasFile.buffer), {
        status: 200,
        headers: {
          "Content-Type": aliasFile.mimeType,
          "Content-Length": String(aliasFile.size),
          "Cache-Control": "private, max-age=300",
          "Accept-Ranges": "bytes",
          "X-Storage-Tenant": parsed.orgId,
        },
      }),
    );
  }

  const fallback = await tryUpstreamFallback(request, joined);
  if (fallback) {
    if (fallback.status === 200 && fallback.body) {
      const buf = Buffer.from(await fallback.arrayBuffer());
      void persistLegacyBytesToActiveDriver(
        {
          orgId: parsed.orgId,
          bucket: parsed.bucket,
          fileName: parsed.fileName,
        },
        buf,
      ).catch((err) => {
        console.warn("[storage] write-through do fallback falhou:", err);
      });
      const headers = new Headers(fallback.headers);
      return withStorageCors(
        request,
        new Response(new Uint8Array(buf), {
          status: 200,
          headers,
        }),
      );
    }
    return withStorageCors(request, fallback);
  }

  return withStorageCors(
    request,
    NextResponse.json({ message: "Arquivo não encontrado." }, { status: 404 }),
  );
}
