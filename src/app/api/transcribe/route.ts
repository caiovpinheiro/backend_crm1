/**
 * POST /api/transcribe
 *
 * Transcreve um áudio usando Groq Whisper (whisper-large-v3-turbo).
 * Body: { url: string }
 * Response: { transcript: string }
 */

import { NextResponse } from "next/server";

import { withOrgContext } from "@/lib/auth-helpers";
import {
  fetchAuthorizedAudioBuffer,
  MediaTooLargeError,
} from "@/lib/fetch-authorized-audio";

const GROQ_TRANSCRIPTION_URL =
  "https://api.groq.com/openai/v1/audio/transcriptions";
const GROQ_MODEL = "whisper-large-v3-turbo";

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
    if (!orgId) {
      return NextResponse.json({ error: "Não autorizado." }, { status: 401 });
    }

    let resolved: { buffer: Buffer; mime: string; filename: string };
    try {
      const fetched = await fetchAuthorizedAudioBuffer(url, {
        userId: session.user.id,
        organizationId: orgId,
        isSuperAdmin: Boolean(session.user.isSuperAdmin),
        role: (session.user as { role?: string | null }).role ?? null,
      });
      const filename = "audio.ogg";
      resolved = {
        buffer: fetched.buffer,
        mime: fetched.contentType,
        filename,
      };
    } catch (err) {
      if (err instanceof MediaTooLargeError) {
        return NextResponse.json({ error: err.message }, { status: 413 });
      }
      return NextResponse.json(
        { error: "Não foi possível acessar o áudio." },
        { status: 404 },
      );
    }

    const ext = resolved.filename.includes(".")
      ? resolved.filename.split(".").pop()!
      : "ogg";
    const filename = `audio.${ext}`;

    const form = new FormData();
    form.append(
      "file",
      new Blob([resolved.buffer], { type: resolved.mime }),
      filename,
    );
    form.append("model", GROQ_MODEL);
    form.append("language", "pt");
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
