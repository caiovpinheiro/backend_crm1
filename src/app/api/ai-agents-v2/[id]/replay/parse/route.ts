import { NextResponse } from "next/server";

import { requireAuth, requirePermission, runInSessionContext } from "@/lib/auth-helpers";
import { IMPORT_LIMITS, parseTranscript, transcriptTextFromFile } from "@/services/ai-v2/replay-import";

const MAX_FILE_BYTES = 20 * 1024 * 1024;

type Parsed = {
  name: string;
  text: string;
  messages: number;
  participants: Array<{ name: string; messages: number }>;
  teamGuess: string[];
  error?: string;
};

function describe(name: string, text: string): Parsed {
  const clipped = text.slice(0, IMPORT_LIMITS.maxChars);
  const parsed = parseTranscript(clipped);
  return {
    name,
    text: clipped,
    messages: parsed.messages.length,
    participants: parsed.participants,
    teamGuess: parsed.teamGuess,
    error: parsed.messages.length === 0
      ? "Não encontrei mensagens. Use a exportação do WhatsApp (.txt ou .zip) ou linhas no formato \"Nome: mensagem\"."
      : undefined,
  };
}

/**
 * Lê conversas anexadas (arquivos .txt/.zip da exportação do WhatsApp, ou
 * texto colado) e devolve quem participa, para a tela marcar a equipe.
 * Nada é gravado aqui.
 */
export async function POST(request: Request) {
  const r = await requireAuth();
  if (!r.ok) return r.response;
  const denied = await requirePermission(r.session.user, "settings:ai");
  if (denied) return denied;
  return runInSessionContext(r.session, async () => {    try {
      const out: Parsed[] = [];
      if ((request.headers.get("content-type") ?? "").includes("multipart/form-data")) {
        const form = await request.formData();
        const files = form.getAll("files").filter((f): f is File => f instanceof File).slice(0, IMPORT_LIMITS.maxTranscripts);
        for (const file of files) {
          if (file.size > MAX_FILE_BYTES) {
            out.push({ name: file.name, text: "", messages: 0, participants: [], teamGuess: [], error: "Arquivo acima de 20 MB." });
            continue;
          }
          try {
            out.push(describe(file.name, transcriptTextFromFile(file.name, new Uint8Array(await file.arrayBuffer()))));
          } catch (err) {
            out.push({ name: file.name, text: "", messages: 0, participants: [], teamGuess: [], error: err instanceof Error ? err.message : "Não consegui ler o arquivo." });
          }
        }
      } else {
        const body = ((await request.json().catch(() => ({}))) ?? {}) as { name?: unknown; text?: unknown };
        const text = typeof body.text === "string" ? body.text : "";
        out.push(describe(typeof body.name === "string" && body.name.trim() ? body.name.trim() : "Conversa colada", text));
      }
      return NextResponse.json({ transcripts: out, limits: IMPORT_LIMITS });
    } catch (err) {
      console.error("[POST /api/ai-agents-v2/[id]/replay/parse]", err);
      return NextResponse.json({ message: "Não consegui ler as conversas anexadas." }, { status: 500 });
    }
  });
}
