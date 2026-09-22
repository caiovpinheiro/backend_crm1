import { NextResponse } from "next/server";

import { auth } from "@/lib/auth";
import { convertToMp3, guessInputExt } from "@/lib/audio-convert";
import {
  fetchAuthorizedAudioBuffer,
  MediaTooLargeError,
} from "@/lib/fetch-authorized-audio";

export async function GET(request: Request) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ message: "Não autorizado." }, { status: 401 });
  }
  const orgId = (session.user as { organizationId?: string | null }).organizationId ?? "";
  if (!orgId) {
    return NextResponse.json({ message: "Não autorizado." }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const rawUrl = searchParams.get("url");
  const desiredName = (searchParams.get("name") || "audio").replace(/[^\w\-]+/g, "-");

  if (!rawUrl) {
    return NextResponse.json({ message: "URL ausente." }, { status: 400 });
  }

  try {
    const { buffer, contentType } = await fetchAuthorizedAudioBuffer(rawUrl, {
      userId: session.user.id,
      organizationId: orgId,
      isSuperAdmin: Boolean(session.user.isSuperAdmin),
      role: (session.user as { role?: string | null }).role ?? null,
    });

    const baseMime = contentType.split(";")[0].trim();
    if (baseMime === "audio/mpeg") {
      const fileName = `${desiredName}.mp3`;
      return new Response(new Uint8Array(buffer), {
        status: 200,
        headers: {
          "Content-Type": "audio/mpeg",
          "Content-Length": String(buffer.length),
          "Content-Disposition": `attachment; filename="${fileName}"`,
          "Cache-Control": "private, max-age=3600",
        },
      });
    }

    const inputExt = guessInputExt(baseMime);
    const mp3 = await convertToMp3(buffer, inputExt === "bin" ? "webm" : inputExt);

    if (!mp3) {
      const fileName = `${desiredName}.${inputExt === "bin" ? "ogg" : inputExt}`;
      return new Response(new Uint8Array(buffer), {
        status: 200,
        headers: {
          "Content-Type": baseMime,
          "Content-Length": String(buffer.length),
          "Content-Disposition": `attachment; filename="${fileName}"`,
          "X-Audio-Conversion": "failed-fallback-original",
          "Cache-Control": "private, no-store",
        },
      });
    }

    const fileName = `${desiredName}.mp3`;
    return new Response(new Uint8Array(mp3), {
      status: 200,
      headers: {
        "Content-Type": "audio/mpeg",
        "Content-Length": String(mp3.length),
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "X-Audio-Conversion": "ok",
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch (err) {
    if (err instanceof MediaTooLargeError) {
      return NextResponse.json({ message: err.message }, { status: 413 });
    }
    console.error("[audio-mp3] Error:", err);
    const message = err instanceof Error ? err.message : "Erro desconhecido.";
    return NextResponse.json({ message }, { status: 502 });
  }
}
