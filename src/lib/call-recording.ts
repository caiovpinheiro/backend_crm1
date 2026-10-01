"use client";

/**
 * call-recording
 * ──────────────
 * A WhatsApp Business Calling Cloud API da Meta **não grava chamadas**:
 * o webhook `terminate` nunca traz `recording_url`. Plataformas que
 * oferecem "gravação de WhatsApp" fazem isso do lado delas.
 *
 * Como as ligações outbound do CRM passam pelo browser do agente via
 * `RTCPeerConnection`, temos acesso aos dois streams (mic local + áudio
 * remoto). Este módulo mistura os dois usando Web Audio API e grava com
 * `MediaRecorder`. O blob resultante é enviado ao backend quando a chamada
 * termina, e vira a mensagem `whatsapp_call_recording` na timeline.
 *
 * Limitações conhecidas:
 * - Só funciona em chamadas iniciadas pelo chip (agente no browser).
 *   Chamadas atendidas fora do CRM não passam por aqui.
 * - Se a aba for fechada durante a chamada, o blob não é enviado
 *   (browser mata o MediaRecorder antes do upload).
 * - Codec do blob depende do browser (webm/opus no Chromium, mp4 em
 *   alguns Safari). O `<audio>` do front aceita todos.
 */

type MimeCandidate = {
  mime: string;
  ext: string;
};

const CANDIDATES: MimeCandidate[] = [
  { mime: "audio/webm;codecs=opus", ext: "webm" },
  { mime: "audio/webm", ext: "webm" },
  { mime: "audio/ogg;codecs=opus", ext: "ogg" },
  { mime: "audio/mp4", ext: "m4a" },
];

function pickSupportedMime(): MimeCandidate | null {
  if (typeof MediaRecorder === "undefined") return null;
  for (const c of CANDIDATES) {
    try {
      if (MediaRecorder.isTypeSupported(c.mime)) return c;
    } catch {
      /* ignore */
    }
  }
  // Último recurso: deixa o browser escolher (sem garantia de reprodutível).
  return { mime: "", ext: "webm" };
}

export type CallRecordingHandle = {
  startedAt: Date;
  ext: string;
  mime: string;
  stop: () => Promise<Blob | null>;
  /** Aborta a gravação descartando o que foi capturado. */
  abort: () => void;
};

/**
 * Inicia a gravação misturando local (microfone do agente) com remote
 * (áudio vindo do WhatsApp). Retorna handle com `stop()` que resolve o
 * blob — ou `null` se nada foi gravado ou o browser não suporta.
 */
export function startCallRecording(
  localStream: MediaStream,
  remoteStream: MediaStream,
): CallRecordingHandle | null {
  if (typeof window === "undefined") return null;
  if (typeof MediaRecorder === "undefined") return null;

  const AudioCtx =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!AudioCtx) return null;

  const picked = pickSupportedMime();
  if (!picked) return null;

  let audioCtx: AudioContext | null = null;
  let recorder: MediaRecorder | null = null;
  let mixed: MediaStream | null = null;
  const chunks: Blob[] = [];
  let aborted = false;

  try {
    audioCtx = new AudioCtx();
    const destination = audioCtx.createMediaStreamDestination();

    // Só conecta quando há tracks de áudio — evita exception
    // "The MediaStream does not contain any audio tracks" em alguns browsers.
    const wireStream = (s: MediaStream) => {
      if (!audioCtx) return;
      if (s.getAudioTracks().length === 0) return;
      try {
        const src = audioCtx.createMediaStreamSource(s);
        src.connect(destination);
      } catch {
        /* ignora source já consumido ou formato incompatível */
      }
    };
    wireStream(localStream);
    wireStream(remoteStream);

    mixed = destination.stream;
    if (mixed.getAudioTracks().length === 0) {
      audioCtx.close().catch(() => {});
      return null;
    }

    recorder = picked.mime
      ? new MediaRecorder(mixed, { mimeType: picked.mime })
      : new MediaRecorder(mixed);
    recorder.ondataavailable = (ev) => {
      if (ev.data && ev.data.size > 0) chunks.push(ev.data);
    };
    // Chunks a cada 1s mitigam perda se a aba for morta subitamente — se
    // a última chamada de `stop()` não chegar a rodar, pelo menos parte
    // do áudio já foi despachado via `dataavailable`.
    recorder.start(1000);
  } catch {
    try {
      audioCtx?.close();
    } catch {
      /* ignore */
    }
    return null;
  }

  const stop = async (): Promise<Blob | null> => {
    if (aborted) return null;
    const r = recorder;
    const ctx = audioCtx;
    recorder = null;
    audioCtx = null;
    if (!r) return null;

    const finalBlob = await new Promise<Blob | null>((resolve) => {
      const finalize = () => {
        if (chunks.length === 0) {
          resolve(null);
          return;
        }
        const blobType = picked.mime || chunks[0]?.type || "audio/webm";
        resolve(new Blob(chunks, { type: blobType }));
      };
      r.onstop = finalize;
      try {
        if (r.state === "recording" || r.state === "paused") {
          r.stop();
        } else {
          finalize();
        }
      } catch {
        finalize();
      }
    });

    try {
      mixed?.getTracks().forEach((t) => t.stop());
    } catch {
      /* ignore */
    }
    try {
      await ctx?.close();
    } catch {
      /* ignore */
    }

    return finalBlob;
  };

  const abort = () => {
    aborted = true;
    try {
      if (recorder?.state === "recording" || recorder?.state === "paused") {
        recorder.stop();
      }
    } catch {
      /* ignore */
    }
    recorder = null;
    try {
      mixed?.getTracks().forEach((t) => t.stop());
    } catch {
      /* ignore */
    }
    try {
      audioCtx?.close();
    } catch {
      /* ignore */
    }
    audioCtx = null;
  };

  return {
    startedAt: new Date(),
    ext: picked.ext,
    mime: picked.mime || "audio/webm",
    stop,
    abort,
  };
}

/**
 * Envia o blob gravado para o backend. Cria uma `Message` do tipo
 * `whatsapp_call_recording` na timeline com `mediaUrl` apontando para o
 * arquivo salvo. Falhas são silenciadas — a chamada em si não deve
 * mostrar erro pro agente por causa de upload que deu ruim.
 */
export async function uploadCallRecording(params: {
  conversationId: string;
  callId: string | null;
  blob: Blob;
  ext: string;
  startedAt: Date;
  endedAt: Date;
  direction?: "BUSINESS_INITIATED" | "USER_INITIATED";
}): Promise<void> {
  try {
    const form = new FormData();
    form.append(
      "file",
      new File([params.blob], `call-${params.callId ?? "unknown"}.${params.ext}`, {
        type: params.blob.type || "audio/webm",
      }),
    );
    if (params.callId) form.append("callId", params.callId);
    form.append("startedAt", params.startedAt.toISOString());
    form.append("endedAt", params.endedAt.toISOString());
    if (params.direction) form.append("direction", params.direction);

    await fetch(
      `/api/conversations/${params.conversationId}/whatsapp-calls/recording`,
      { method: "POST", body: form },
    );
  } catch (err) {
    // eslint-disable-next-line no-console -- código de cliente ("use client"); o logger é só de servidor
    console.warn("[call-recording] upload falhou:", err);
  }
}
