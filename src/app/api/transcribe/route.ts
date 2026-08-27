/**
 * POST /api/transcribe
 *
 * Transcreve um áudio usando Groq Whisper (whisper-large-v3-turbo).
 * Recebe a URL do áudio (gerada pelo frontend após resolveMediaUrl),
 * baixa os bytes e encaminha para a API do Groq.
 *
 * Body: { url: string }
 * Response: { transcript: string }
 */

import { NextResponse } from "next/server";
import path from "path";
import { readFile } from "fs/promises";
import { withOrgContext } from "@/lib/auth-helpers";
import { parseStoragePath, readStoredFile, mimeFromFilename } from "@/lib/storage/local";

const GROQ_TRANSCRIPTION_URL =
  "https://api.groq.com/openai/v1/audio/transcriptions";
const GROQ_MODEL = "whisper-large-v3-turbo";

/** Resolve a URL interna do backend para bytes do áudio. */
async function resolveAudioBytes(
  rawUrl: string,
  orgId: string,
): Promise<{ buffer: Buffer; mime: string; filename: string } | null> {
  // ── 1. Storage tenant-scoped: /api/storage/<orgId>/<bucket>/<file> ──
  // Vai pelo dispatcher (readStoredFile) — funciona nos dois backends
  // (disco local e S3/Spaces) sem saber qual está ativo.
  const storageParsed = parseStoragePath(rawUrl);
  if (storageParsed) {
    if (storageParsed.orgId !== orgId) return null; // cross-tenant guard
    const stored = await readStoredFile(
      storageParsed.orgId,
      storageParsed.bucket,
      storageParsed.fileName,
    );
    if (!stored) return null;
    return { buffer: stored.buffer, mime: stored.mimeType, filename: storageParsed.fileName };
  }

  // ── 2. Legacy /uploads/… (public/uploads no CWD do backend) ──────────
  if (rawUrl.startsWith("/uploads/")) {
    const safePath = rawUrl.replace(/\.\./g, "");
    const abs = path.join(process.cwd(), "public", safePath);
    try {
      const buffer = await readFile(abs);
      const filename = path.basename(abs);
      return { buffer, mime: mimeFromFilename(filename), filename };
    } catch {
      return null;
    }
  }

  // ── 3. Proxy Meta: /api/media/proxy?url=<encoded> ────────────────────
  if (rawUrl.startsWith("/api/media/proxy")) {
    const urlObj = new URL(rawUrl, "http://localhost");
    const target = urlObj.searchParams.get("url");
    if (!target) return null;
    try {
      const res = await fetch(target, {
        signal: AbortSignal.timeout(15_000),
        headers: { "User-Agent": "CRM-Transcribe/1.0" },
      });
      if (!res.ok) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      const mime = res.headers.get("content-type")?.split(";")[0] ?? "audio/ogg";
      const filename = `audio.${mime.split("/").pop() ?? "ogg"}`;
      return { buffer: buf, mime, filename };
    } catch {
      return null;
    }
  }

  return null;
}

export async function POST(request: Request) {
  return withOrgContext(async (session) => {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "GROQ_API_KEY não configurada no servidor." },
        { status: 503 },
      );
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "Body JSON inválido." }, { status: 400 });
    }

    const url = (body as Record<string, unknown>)?.url;
    if (typeof url !== "string" || !url) {
      return NextResponse.json(
        { error: "Campo 'url' é obrigatório." },
        { status: 400 },
      );
    }

    const orgId: string = (session.user as { organizationId?: string }).organizationId ?? "";
    const resolved = await resolveAudioBytes(url, orgId);
    if (!resolved) {
      return NextResponse.json(
        { error: "Não foi possível acessar o áudio." },
        { status: 404 },
      );
    }

    // Garante extensão de arquivo válida para o Groq (exige .mp3/.mp4/.ogg/.wav etc.)
    const ext = resolved.filename.includes(".")
      ? resolved.filename.split(".").pop()!
      : "ogg";
    const filename = `audio.${ext}`;

    // Monta o FormData para a API do Groq
    const form = new FormData();
    form.append(
      "file",
      new Blob([resolved.buffer], { type: resolved.mime }),
      filename,
    );
    form.append("model", GROQ_MODEL);
    form.append("language", "pt"); // português por padrão
    form.append("response_format", "json");

    let groqRes: Response;
    try {
      groqRes = await fetch(GROQ_TRANSCRIPTION_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: form,
        signal: AbortSignal.timeout(60_000),
      });
    } catch (err) {
      console.error("[transcribe] Groq fetch error:", err);
      return NextResponse.json(
        { error: "Timeout ao conectar com o Groq." },
        { status: 504 },
      );
    }

    if (!groqRes.ok) {
      const errBody = await groqRes.text().catch(() => "");
      console.error(`[transcribe] Groq error ${groqRes.status}:`, errBody);
      return NextResponse.json(
        { error: `Groq retornou ${groqRes.status}: ${errBody.slice(0, 200)}` },
        { status: 502 },
      );
    }

    const data = (await groqRes.json()) as { text?: string };
    const transcript = (data.text ?? "").trim();

    return NextResponse.json({ transcript });
  });
}
